// yt-dlp / ffmpeg wrapper (chunk C1). Public signatures are a contract; see PLAN.md.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

export interface TrackInfo {
  /** YouTube video id. */
  id: string;
  title: string;
  channel: string;
  /** Seconds; null for livestreams/unknown. */
  duration: number | null;
  thumbnail: string | null;
  /** Canonical watch URL: https://www.youtube.com/watch?v=<id> */
  url: string;
}

const SINGLE_TIMEOUT_MS = 30_000;
const PLAYLIST_TIMEOUT_MS = 60_000;
const PLAYLIST_MAX = 200;
const STDERR_TAIL_BYTES = 4096;

/** yt-dlp needs a JS runtime for YouTube; deno is the only default, so always point it at this node. */
function jsRuntimeArgs(): string[] {
  return ['--js-runtimes', `node:${process.execPath}`];
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be spawned at all (ENOENT etc.). */
  spawnError: NodeJS.ErrnoException | null;
}

/** Runs a command to completion with a timeout. Never rejects. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        spawnError,
      });
    };

    let child;
    try {
      child = spawn(cmd, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      spawnError = e as NodeJS.ErrnoException;
      finish(null);
      return;
    }

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', (e) => {
      spawnError = e as NodeJS.ErrnoException;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      // 'close' normally follows; make sure we settle even if it doesn't.
      setTimeout(() => finish(null), 1000).unref();
    }, timeoutMs);
  });
}

/** Last `ERROR:` line of yt-dlp stderr, cleaned of the `ERROR: ` and `[extractor] id: ` prefixes. */
function ytdlpErrorLine(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('ERROR:')) {
      let msg = line.slice('ERROR:'.length).trim();
      msg = msg.replace(/^(?:\[[^\]]+\]\s+\S+:\s+)+/, '').trim();
      return msg || null;
    }
  }
  return null;
}

function ytdlpFailureMessage(r: RunResult, timeoutMs: number): string {
  if (r.spawnError) {
    return r.spawnError.code === 'ENOENT'
      ? 'yt-dlp was not found on PATH. Install it (winget install yt-dlp.yt-dlp / brew install yt-dlp).'
      : `Could not start yt-dlp: ${r.spawnError.message}`;
  }
  if (r.timedOut) return `yt-dlp timed out after ${Math.round(timeoutMs / 1000)} s`;
  return ytdlpErrorLine(r.stderr) ?? `yt-dlp exited with code ${r.code}`;
}

function runYtdlp(args: string[], timeoutMs: number): Promise<RunResult> {
  return run('yt-dlp', [...jsRuntimeArgs(), ...args], timeoutMs);
}

// ---------------------------------------------------------------------------
// checkBinaries
// ---------------------------------------------------------------------------

const INSTALL_HELP: Record<'yt-dlp' | 'ffmpeg', string> = {
  'yt-dlp':
    'yt-dlp was not found or could not be run.\n' +
    '  Windows: winget install yt-dlp.yt-dlp\n' +
    '  macOS:   brew install yt-dlp\n' +
    '  Then make sure `yt-dlp` is on your PATH (open a new terminal after installing).',
  ffmpeg:
    'ffmpeg was not found or could not be run.\n' +
    '  Windows: winget install Gyan.FFmpeg\n' +
    '  macOS:   brew install ffmpeg\n' +
    '  Then make sure `ffmpeg` is on your PATH (open a new terminal after installing).',
};

/** Verifies yt-dlp and ffmpeg are runnable. Throws an Error with install instructions if not. */
export async function checkBinaries(): Promise<{ ytdlp: string; ffmpeg: string }> {
  const [y, f] = await Promise.all([
    run('yt-dlp', ['--version'], 15_000),
    run('ffmpeg', ['-version'], 15_000),
  ]);
  const problems: string[] = [];
  const firstLine = (s: string): string => s.split(/\r?\n/)[0]?.trim() ?? '';
  const yOk = !y.spawnError && !y.timedOut && y.code === 0 && firstLine(y.stdout) !== '';
  const fOk = !f.spawnError && !f.timedOut && f.code === 0 && firstLine(f.stdout) !== '';
  if (!yOk) problems.push(INSTALL_HELP['yt-dlp']);
  if (!fOk) problems.push(INSTALL_HELP.ffmpeg);
  if (problems.length > 0) throw new Error(problems.join('\n\n'));
  return { ytdlp: firstLine(y.stdout), ffmpeg: firstLine(f.stdout) };
}

// ---------------------------------------------------------------------------
// JSON -> TrackInfo
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseJsonLines(stdout: string): Json[] {
  const items: Json[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t) as unknown;
      if (obj && typeof obj === 'object') items.push(obj as Json);
    } catch {
      /* skip garbage lines */
    }
  }
  return items;
}

const YT_ID = /^[\w-]{11}$/;

function toTrack(j: Json): TrackInfo | null {
  const id = str(j.id);
  if (!id) return null;
  const extractor = str(j.extractor_key) ?? str(j.ie_key);
  const isYouTube = (extractor === null || /^youtube/i.test(extractor)) && YT_ID.test(id);

  const title = str(j.title) ?? id;
  const channel = str(j.channel) ?? str(j.uploader) ?? '';
  const duration = typeof j.duration === 'number' && Number.isFinite(j.duration) ? j.duration : null;

  // YouTube: the predictable hqdefault.jpg beats yt-dlp's signed/webp variants for <img> and embeds.
  let thumbnail: string | null = isYouTube ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  if (!thumbnail && Array.isArray(j.thumbnails)) {
    for (let i = j.thumbnails.length - 1; i >= 0; i--) {
      const u = str((j.thumbnails[i] as Json | null)?.url);
      if (u) {
        thumbnail = u;
        break;
      }
    }
  }
  if (!thumbnail) thumbnail = str(j.thumbnail);

  const url = isYouTube
    ? `https://www.youtube.com/watch?v=${id}`
    : (str(j.webpage_url) ?? str(j.original_url) ?? str(j.url));
  if (!url) return null;

  return { id, title, channel, duration, thumbnail, url };
}

function isHiddenEntry(t: TrackInfo): boolean {
  return t.title === '[Private video]' || t.title === '[Deleted video]';
}

// ---------------------------------------------------------------------------
// search / resolve
// ---------------------------------------------------------------------------

/** ytsearch<limit>: flat search. */
export async function search(query: string, limit = 10): Promise<TrackInfo[]> {
  const q = query.trim();
  if (!q) return [];
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 1));
  const r = await runYtdlp(
    [`ytsearch${n}:${q}`, '--flat-playlist', '--dump-json', '--no-warnings'],
    SINGLE_TIMEOUT_MS,
  );
  const tracks = parseJsonLines(r.stdout)
    .map(toTrack)
    .filter((t): t is TrackInfo => t !== null);
  if (tracks.length === 0 && (r.code !== 0 || r.spawnError || r.timedOut)) {
    throw new Error(ytdlpFailureMessage(r, SINGLE_TIMEOUT_MS));
  }
  return tracks.slice(0, n);
}

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

function parseHttpUrl(input: string): URL | null {
  if (!/^https?:\/\//i.test(input)) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isPlaylistUrl(u: URL): boolean {
  if (!YT_HOSTS.has(u.hostname.toLowerCase()) || u.hostname.toLowerCase() === 'youtu.be') return false;
  if (u.pathname.startsWith('/playlist')) return true;
  // /watch?list=X with no video id can only mean the playlist.
  return u.pathname === '/watch' && u.searchParams.has('list') && !u.searchParams.has('v');
}

/**
 * Turns user input into tracks. Video URL → [track]; playlist URL → all entries;
 * anything else → first search result. Throws Error with a user-facing message when nothing is found.
 */
export async function resolve(input: string): Promise<TrackInfo[]> {
  const text = input.trim();
  if (!text) throw new Error('Nothing to play: empty input.');

  const url = parseHttpUrl(text);
  if (!url) {
    const found = await search(text, 1);
    if (found.length === 0) throw new Error(`No results found for "${text}".`);
    return [found[0]];
  }

  if (isPlaylistUrl(url)) {
    const r = await runYtdlp(
      ['--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', String(PLAYLIST_MAX), text],
      PLAYLIST_TIMEOUT_MS,
    );
    const tracks = parseJsonLines(r.stdout)
      .map(toTrack)
      .filter((t): t is TrackInfo => t !== null && !isHiddenEntry(t))
      .slice(0, PLAYLIST_MAX);
    if (tracks.length === 0) {
      if (r.code !== 0 || r.spawnError || r.timedOut) {
        throw new Error(ytdlpFailureMessage(r, PLAYLIST_TIMEOUT_MS));
      }
      throw new Error('That playlist has no playable videos.');
    }
    return tracks;
  }

  const r = await runYtdlp(
    ['--dump-json', '--no-playlist', '--skip-download', '--no-warnings', text],
    SINGLE_TIMEOUT_MS,
  );
  const tracks = parseJsonLines(r.stdout)
    .map(toTrack)
    .filter((t): t is TrackInfo => t !== null);
  if (tracks.length === 0) {
    if (r.code !== 0 || r.spawnError || r.timedOut) {
      throw new Error(ytdlpFailureMessage(r, SINGLE_TIMEOUT_MS));
    }
    throw new Error('Could not find a playable video at that URL.');
  }
  return [tracks[0]];
}

// ---------------------------------------------------------------------------
// AudioStream
// ---------------------------------------------------------------------------

function tailAppend(prev: string, chunk: Buffer): string {
  const next = prev + chunk.toString('utf8');
  return next.length > STDERR_TAIL_BYTES ? next.slice(next.length - STDERR_TAIL_BYTES) : next;
}

function lastNonEmptyLine(s: string): string | null {
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return null;
}

/**
 * yt-dlp bestaudio piped into ffmpeg. `stream` is raw PCM s16le, 48 kHz, stereo (StreamType.Raw).
 * Emits 'error' (Error) once if yt-dlp or ffmpeg fails before kill() was called. kill() is idempotent
 * and terminates both child processes.
 */
export class AudioStream extends EventEmitter<{ error: [Error] }> {
  readonly stream: Readable;

  private killed = false;
  private failed = false;
  private readonly ytdlp;
  private readonly ffmpeg;
  private ytStderr = '';
  private ffStderr = '';
  /** undefined = still running. */
  private ytCode: number | null | undefined;
  private ffCode: number | null | undefined;
  private failTimer: NodeJS.Timeout | undefined;

  constructor(url: string) {
    super();

    this.ytdlp = spawn(
      'yt-dlp',
      [...jsRuntimeArgs(), '-f', 'bestaudio/best', '--no-playlist', '-q', '--no-warnings', '-o', '-', url],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.ffmpeg = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.stream = this.ffmpeg.stdout;

    const noop = (): void => {};
    // Swallow EPIPE / ECONNRESET etc. on every stdio stream; real failures are reported via process events.
    for (const s of [
      this.ytdlp.stdout,
      this.ytdlp.stderr,
      this.ffmpeg.stdin,
      this.ffmpeg.stdout,
      this.ffmpeg.stderr,
    ]) {
      s.on('error', noop);
    }

    this.ytdlp.stderr.on('data', (c: Buffer) => {
      this.ytStderr = tailAppend(this.ytStderr, c);
    });
    this.ffmpeg.stderr.on('data', (c: Buffer) => {
      this.ffStderr = tailAppend(this.ffStderr, c);
    });

    this.ytdlp.stdout.pipe(this.ffmpeg.stdin);

    this.ytdlp.on('error', (e) => this.onSpawnError('yt-dlp', e as NodeJS.ErrnoException));
    this.ffmpeg.on('error', (e) => this.onSpawnError('ffmpeg', e as NodeJS.ErrnoException));
    this.ytdlp.on('close', (code) => {
      this.ytCode = code ?? -1;
      this.evaluate();
    });
    this.ffmpeg.on('close', (code) => {
      this.ffCode = code ?? -1;
      this.evaluate();
    });
  }

  private onSpawnError(which: 'yt-dlp' | 'ffmpeg', e: NodeJS.ErrnoException): void {
    try {
      if (this.killed || this.failed) return;
      const msg =
        e.code === 'ENOENT'
          ? `${which} was not found on PATH. Install it and make sure it is on PATH.`
          : `Could not start ${which}: ${e.message}`;
      this.fail(new Error(msg));
    } catch (err) {
      console.error('[ytdlp]', err);
    }
  }

  /** Decides whether the current process states amount to a failure. Called on every process close. */
  private evaluate(): void {
    try {
      if (this.killed || this.failed) return;

      const ytMsg = ytdlpErrorLine(this.ytStderr);
      const ytBad = this.ytCode !== undefined && this.ytCode !== 0;
      const ffBad = this.ffCode !== undefined && this.ffCode !== 0;
      const ffMsg = (): string => lastNonEmptyLine(this.ffStderr) ?? `ffmpeg exited with code ${this.ffCode}`;
      const ytGeneric = (): string => ytMsg ?? lastNonEmptyLine(this.ytStderr) ?? `yt-dlp exited with code ${this.ytCode}`;

      if (ytBad && ytMsg && !/broken pipe/i.test(ytMsg)) {
        this.fail(new Error(ytMsg));
      } else if (ytBad && ffBad) {
        this.fail(new Error(ytMsg && !/broken pipe/i.test(ytMsg) ? ytMsg : ffMsg()));
      } else if (ytBad && this.ffCode === 0) {
        // ffmpeg finished cleanly, so yt-dlp's complaint (if any) is a post-hoc download problem.
        this.fail(new Error(ytGeneric()));
      } else if (ffBad && this.ytCode === 0) {
        this.fail(new Error(ffMsg()));
      } else if (ffBad && this.ytCode === undefined) {
        // ffmpeg died first; give yt-dlp a moment to report its own (usually more useful) error.
        if (!this.failTimer) {
          this.failTimer = setTimeout(() => {
            try {
              if (this.killed || this.failed) return;
              this.fail(new Error(ffMsg()));
            } catch (err) {
              console.error('[ytdlp]', err);
            }
          }, 3000);
        }
      } else if (ytBad && this.ffCode === undefined) {
        // yt-dlp died without a clear message; ffmpeg will see EOF and exit shortly, wait for it.
        if (!this.failTimer) {
          this.failTimer = setTimeout(() => {
            try {
              if (this.killed || this.failed) return;
              this.fail(new Error(ytGeneric()));
            } catch (err) {
              console.error('[ytdlp]', err);
            }
          }, 3000);
        }
      }
    } catch (err) {
      console.error('[ytdlp]', err);
    }
  }

  private fail(err: Error): void {
    if (this.killed || this.failed) return;
    this.failed = true;
    if (this.failTimer) clearTimeout(this.failTimer);
    // Tear everything down so nothing lingers after a failure.
    this.teardown();
    if (this.listenerCount('error') > 0) {
      try {
        this.emit('error', err);
      } catch (e) {
        console.error('[ytdlp] error listener threw:', e);
      }
    } else {
      console.error('[ytdlp] AudioStream error with no listener:', err.message);
    }
  }

  private teardown(): void {
    try {
      this.ytdlp.stdout.unpipe(this.ffmpeg.stdin);
    } catch {
      /* ignore */
    }
    for (const p of [this.ytdlp, this.ffmpeg]) {
      try {
        if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    for (const s of [
      this.ffmpeg.stdin,
      this.ytdlp.stdout,
      this.ytdlp.stderr,
      this.ffmpeg.stderr,
    ]) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    // Leave ffmpeg.stdout (the public `stream`) to the consumer when failing, so already-buffered data can drain.
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    if (this.failTimer) clearTimeout(this.failTimer);
    this.teardown();
    try {
      this.ffmpeg.stdout.destroy();
    } catch {
      /* ignore */
    }
  }
}
