import type { Client } from 'discord.js';
import type { PlayerManager } from '../player/PlayerManager.js';
import type { GuildPlayerState } from '../player/types.js';
import type { HealthIssue, HealthMonitor } from '../health.js';

/** Discord caps voice channel status at 500 characters. */
const MAX_STATUS = 500;
/** State events fire in bursts (skip = idle + start + emit); wait for them to settle before calling the API. */
const DEBOUNCE_MS = 1_000;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Shown in front of the song so listeners know the stutter is the host, not Discord or their connection. */
const WARNING: Record<HealthIssue, string> = {
  busy: '⚠️ Host lagging',
  download: '⚠️ Slow download',
};

/** Status text for a guild's player: current track and what plays next, or '' to clear. */
function statusText(s: GuildPlayerState, issue: HealthIssue | null): string {
  if (!s.current) return '';
  // loop=track replays the current track; loop=queue wraps back to it once the queue runs out.
  const next = s.loop === 'track' ? s.current : (s.queue[0] ?? (s.loop === 'queue' ? s.current : null));
  const now = `🎶 ${clip(s.current.title, 200)}`;
  const song = next ? `${now} · Next: ${clip(next.title, 200)}` : now;
  const text = issue ? `${WARNING[issue]} · ${song}` : song;
  return clip(text, MAX_STATUS);
}

interface Applied {
  channelId: string;
  status: string;
}

/**
 * Mirrors each guild's now-playing / up-next into the status line of the voice channel the bot is in.
 * While the host can't keep up, the status is prefixed with a warning.
 * Needs the Set Voice Channel Status permission; failures are logged and otherwise ignored.
 */
export function syncVoiceStatus(client: Client, manager: PlayerManager, health: HealthMonitor): void {
  const applied = new Map<string, Applied>();
  const timers = new Map<string, NodeJS.Timeout>();
  const latest = new Map<string, GuildPlayerState>();
  /** Per-guild promise chain so a slow request can't race the next one. */
  const chains = new Map<string, Promise<void>>();
  let warnedPermission = false;

  const put = async (channelId: string, status: string): Promise<void> => {
    await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status } });
  };

  const apply = async (guildId: string): Promise<void> => {
    const s = latest.get(guildId);
    if (!s) return;
    const prev = applied.get(guildId);
    const status = s.channelId ? statusText(s, health.health.issue) : '';

    // Bot moved or left: clear the old channel's status. Usually fails once we're no longer connected
    // there (unless we also have Manage Channels), which is fine.
    if (prev && prev.channelId !== s.channelId) {
      applied.delete(guildId);
      if (prev.status) await put(prev.channelId, '').catch(() => {});
    }
    if (!s.channelId) return;

    const cur = applied.get(guildId);
    if (cur && cur.status === status) return;
    // Nothing to clear on a channel we have never set.
    if (!cur && !status) {
      applied.set(guildId, { channelId: s.channelId, status });
      return;
    }
    try {
      await put(s.channelId, status);
      applied.set(guildId, { channelId: s.channelId, status });
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === 50013 || code === 50001) {
        if (!warnedPermission) {
          warnedPermission = true;
          console.warn('[bot]', 'cannot set voice channel status: missing Set Voice Channel Status permission');
        }
      } else {
        console.error('[bot]', 'failed to set voice channel status', err);
      }
    }
  };

  const schedule = (guildId: string): void => {
    const existing = timers.get(guildId);
    if (existing) clearTimeout(existing);
    timers.set(
      guildId,
      setTimeout(() => {
        timers.delete(guildId);
        const run = (chains.get(guildId) ?? Promise.resolve())
          .then(() => apply(guildId))
          .catch((err) => console.error('[bot]', 'voice status sync failed', err));
        chains.set(guildId, run);
      }, DEBOUNCE_MS),
    );
  };

  manager.on('state', (s) => {
    latest.set(s.guildId, s);
    schedule(s.guildId);
  });
  health.on('change', () => {
    for (const guildId of latest.keys()) schedule(guildId);
  });
}
