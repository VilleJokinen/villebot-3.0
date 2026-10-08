// CONTRACT STUB — replaced by chunk C1. Signatures are fixed; see PLAN.md.
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

/** Verifies yt-dlp and ffmpeg are runnable. Throws an Error with install instructions if not. */
export async function checkBinaries(): Promise<{ ytdlp: string; ffmpeg: string }> {
  throw new Error('not implemented');
}

/** ytsearch<limit>: flat search. */
export async function search(query: string, limit = 10): Promise<TrackInfo[]> {
  throw new Error('not implemented');
}

/**
 * Turns user input into tracks. Video URL → [track]; playlist URL (or watch URL with list=) → all entries;
 * anything else → first search result. Throws Error with a user-facing message when nothing is found.
 */
export async function resolve(input: string): Promise<TrackInfo[]> {
  throw new Error('not implemented');
}

/**
 * yt-dlp bestaudio piped into ffmpeg. `stream` is raw PCM s16le, 48 kHz, stereo (StreamType.Raw).
 * Emits 'error' (Error) once if yt-dlp or ffmpeg fails before kill() was called. kill() is idempotent
 * and terminates both child processes.
 */
export class AudioStream extends EventEmitter<{ error: [Error] }> {
  readonly stream!: Readable;
  constructor(url: string) {
    super();
    throw new Error('not implemented');
  }
  kill(): void {}
}
