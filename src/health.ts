import { EventEmitter } from 'node:events';
import { cpus } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { PlayerManager } from './player/PlayerManager.js';

/** busy: the host can't keep up with the 20 ms voice timer. download: audio arrives slower than it plays. */
export type HealthIssue = 'busy' | 'download';

export interface Health {
  /** null when audio is fine. */
  issue: HealthIssue | null;
  /** Human-readable reason, e.g. "voice timer up to 120 ms late, CPU at 97%". Empty when fine. */
  detail: string;
}

const WINDOW_MS = 5_000;
/** Consecutive bad windows before warning (one hiccup is not worth a notification). */
const BAD_WINDOWS = 2;
/** Consecutive good windows before the warning is cleared, so a borderline host doesn't flap. */
const GOOD_WINDOWS = 6;
/**
 * The voice library sends a packet every 20 ms from a timer on this event loop. Listeners' jitter buffers
 * absorb some lateness; past this (99th percentile over a window) it is heard as stutter. Windows timers
 * alone jitter by ~16 ms, so this sits well above that.
 */
const LAG_P99_MS = 50;
/** Less than this much decoded audio buffered ahead means the next stall is heard. */
const LOW_BUFFER_MS = 1_000;
/** CPU above this while the buffer runs low blames the host rather than the network. */
const HIGH_CPU = 85;
/** Appended to the log line (and so to the tray notification): what the host can do about it. */
const HINT: Record<HealthIssue, string> = {
  busy: 'Closing heavy programs (games, builds) on this PC should help.',
  download: "Check this PC's internet connection; something may be using all the bandwidth.",
};

function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

/**
 * Watches for conditions that make playback stutter while something is playing, and emits 'change'
 * when the verdict changes. Logs "[health] warn: ..." / "[health] ok: ..." lines, which the Windows tray
 * launcher turns into notifications.
 */
export class HealthMonitor extends EventEmitter<{ change: [Health] }> {
  health: Health = { issue: null, detail: '' };

  private readonly manager: PlayerManager;
  private readonly loop = monitorEventLoopDelay({ resolution: 10 });
  private cpu = cpuTotals();
  private bad = 0;
  private good = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(manager: PlayerManager) {
    super();
    this.manager = manager;
  }

  start(): void {
    if (this.timer) return;
    this.loop.enable();
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (err) {
        console.error('[health]', err);
      }
    }, WINDOW_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loop.disable();
  }

  private check(): void {
    const lagMs = this.loop.percentile(99) / 1e6;
    this.loop.reset();
    const now = cpuTotals();
    const total = now.total - this.cpu.total;
    const cpuPct = total > 0 ? Math.round(100 * (1 - (now.idle - this.cpu.idle) / total)) : 0;
    this.cpu = now;

    const players = this.manager.all().filter((p) => p.playing);
    if (players.length === 0) {
      // Nothing to stutter. Drop any warning quietly; it no longer means anything to anyone.
      this.bad = this.good = 0;
      if (this.health.issue) this.set({ issue: null, detail: '' }, 'nothing playing');
      return;
    }

    const buffers = players.map((p) => p.bufferedMs()).filter((b): b is number => b !== null);
    const minBuffer = buffers.length > 0 ? Math.min(...buffers) : Infinity;
    let found: Health | null = null;
    if (lagMs > LAG_P99_MS) {
      found = { issue: 'busy', detail: `voice timer up to ${Math.round(lagMs)} ms late, CPU at ${cpuPct}%` };
    } else if (minBuffer < LOW_BUFFER_MS) {
      const buffered = `${(minBuffer / 1000).toFixed(1)} s of audio buffered`;
      found =
        cpuPct >= HIGH_CPU
          ? { issue: 'busy', detail: `CPU at ${cpuPct}%, only ${buffered}` }
          : { issue: 'download', detail: `audio download falling behind, only ${buffered}` };
    }

    if (found) {
      this.good = 0;
      this.bad++;
      if (!this.health.issue) {
        if (this.bad >= BAD_WINDOWS) this.set(found);
      } else if (found.issue !== this.health.issue) {
        // Already warning: follow a change of cause so the status names the right one.
        this.set(found);
      } else {
        this.health = found;
      }
    } else {
      this.bad = 0;
      this.good++;
      if (this.health.issue && this.good >= GOOD_WINDOWS) this.set({ issue: null, detail: '' }, 'audio is keeping up again');
    }
  }

  private set(health: Health, okReason = ''): void {
    this.health = health;
    if (health.issue) console.warn(`[health] warn: ${health.detail}. ${HINT[health.issue]}`);
    else console.log(`[health] ok: ${okReason}`);
    this.emit('change', health);
  }
}
