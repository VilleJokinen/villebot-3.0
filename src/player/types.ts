import type { TrackInfo } from '../ytdlp.js';

export type LoopMode = 'off' | 'track' | 'queue';

export interface QueueItem extends TrackInfo {
  /** Unique per queue entry (the same video can be queued twice). crypto.randomUUID(). */
  uid: string;
  /** Display name of who added it, e.g. "ville" or "panel". */
  requestedBy: string;
}

/** Serializable snapshot of one guild's player. Sent verbatim to the panel over WebSocket. */
export interface GuildPlayerState {
  guildId: string;
  guildName: string;
  /** Voice channel the bot is in, or null. */
  channelId: string | null;
  channelName: string | null;
  current: QueueItem | null;
  /** Elapsed ms of the current track (AudioResource.playbackDuration). */
  positionMs: number;
  /** Date.now() when positionMs was sampled; the panel interpolates from it while playing. */
  sampledAt: number;
  paused: boolean;
  /** 0-100 */
  volume: number;
  loop: LoopMode;
  /** Upcoming tracks, excluding current. */
  queue: QueueItem[];
}

export interface PlayerEvents {
  /** Any state change for a guild. */
  state: [state: GuildPlayerState];
  /** A track failed (yt-dlp error, unavailable, age-restricted). The player has already moved on. */
  trackError: [guildId: string, item: QueueItem, message: string];
}
