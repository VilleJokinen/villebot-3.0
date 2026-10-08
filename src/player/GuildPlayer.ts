import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Client, VoiceBasedChannel } from 'discord.js';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { AudioPlayer, AudioResource, VoiceConnection } from '@discordjs/voice';
import { AudioStream } from '../ytdlp.js';
import type { TrackInfo } from '../ytdlp.js';
import type { GuildPlayerState, LoopMode, PlayerEvents, QueueItem } from './types.js';

/** Leave the voice channel after this long with no current track. */
const IDLE_LEAVE_MS = 5 * 60_000;
/** Leave the voice channel after this long without a non-bot member in it. */
const EMPTY_LEAVE_MS = 30_000;
/** A track that goes Idle sooner than this with no recorded error is treated as failed. */
const EARLY_END_MS = 1_500;
/**
 * The AudioStream 'error' (stderr from yt-dlp/ffmpeg) can arrive slightly after the player went Idle.
 * For early ends we wait this long before deciding what the failure message is. Tracks that end
 * normally (after EARLY_END_MS) advance immediately; a mid-track error that arrives after Idle is lost,
 * which is fine because the track did play.
 */
const ERROR_GRACE_MS = 300;

const noop = (): void => {};

function errMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim().slice(0, 300) || 'Unknown playback error';
}

/**
 * Per-guild queue, playback and voice connection.
 * Emits 'state' on every mutation and 'trackError' when a track fails (PlayerManager re-emits both).
 */
export class GuildPlayer extends EventEmitter<PlayerEvents> {
  readonly guildId: string;
  /** Set by the bot on /play so errors can be reported there. */
  textChannelId: string | null = null;

  queue: QueueItem[] = [];
  current: QueueItem | null = null;
  volume = 50;
  loop: LoopMode = 'off';
  paused = false;

  private readonly client: Client;
  private readonly player: AudioPlayer;
  private connection: VoiceConnection | null = null;
  /** Voice channel we are connected to (set once Ready; cleared on leave/disconnect). */
  private channelId: string | null = null;
  private joining = false;
  private joinChain: Promise<void> = Promise.resolve();

  private audio: AudioStream | null = null;
  private resource: AudioResource | null = null;
  /** Incremented whenever a track starts or is torn down; events carrying an older token are stale. */
  private token = 0;
  private startedAt = 0;
  /** Failure message recorded for the current track (stream/player error), if any. */
  private failed: string | null = null;
  /** The current track is ending because of skip(), so it is neither a failure nor replayed by loop=track. */
  private skipped = false;
  private pending: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private emptyTimer: NodeJS.Timeout | null = null;

  constructor(client: Client, guildId: string) {
    super();
    this.client = client;
    this.guildId = guildId;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        this.safe(() => this.handleIdle());
      }
    });
    this.player.on('error', (err) => {
      this.safe(() => {
        // err.resource is the resource that failed; ignore errors from an already replaced one.
        if (this.resource && err.resource !== this.resource) return;
        this.failCurrent(errMessage(err));
      });
    });
  }

  // ---------------------------------------------------------------- voice

  /** Joins (or moves to) a voice/stage channel of this guild. No-op if already connected there. */
  join(channelId: string): Promise<void> {
    // Serialize joins so two concurrent calls cannot fight over the connection.
    const run = this.joinChain.then(() => this.doJoin(channelId));
    this.joinChain = run.catch(noop);
    return run;
  }

  private async doJoin(channelId: string): Promise<void> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error('Bot is not in that server');
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) throw new Error('That is not a voice channel in this server');
    const voiceChannel: VoiceBasedChannel = channel;

    if (
      this.connection &&
      this.connection.state.status === VoiceConnectionStatus.Ready &&
      this.channelId === channelId
    ) {
      return;
    }
    if (!voiceChannel.joinable) throw new Error("I don't have permission to join that voice channel");

    this.joining = true;
    let conn: VoiceConnection;
    try {
      conn = joinVoiceChannel({
        channelId,
        guildId: this.guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      const isNew = conn !== this.connection;
      this.connection = conn;
      if (isNew) this.attachConnection(conn);

      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        if (this.connection === conn) this.connection = null;
        this.channelId = null;
        this.safeDestroy(conn);
        this.resetPlayback();
        this.emitState();
        throw new Error('Could not connect to the voice channel');
      }
      conn.subscribe(this.player);
      this.channelId = channelId;
    } finally {
      this.joining = false;
    }

    this.cancelIdle();
    this.refreshOccupancy();
    if (!this.current && this.queue.length > 0) {
      this.playNext();
    } else {
      this.updateIdle();
      this.emitState();
    }
  }

  private attachConnection(conn: VoiceConnection): void {
    conn.on('stateChange', (_old, newState) => {
      this.safe(() => {
        if (conn !== this.connection) return; // stale connection (already replaced or left)
        if (newState.status === VoiceConnectionStatus.Destroyed) {
          this.leave();
        }
      });
    });
    // The documented reconnect pattern: on Disconnected, see whether the library is reconnecting
    // (Signalling/Connecting within 5 s, e.g. a channel move); if not, tear down.
    conn.on(VoiceConnectionStatus.Disconnected, () => {
      void (async () => {
        try {
          try {
            await Promise.race([
              entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
              entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            // Reconnecting; the Ready state will follow.
          } catch {
            if (conn === this.connection) this.leave();
            else this.safeDestroy(conn);
          }
        } catch (err) {
          console.error('[player]', 'disconnect handler failed', err);
        }
      })();
    });
    conn.on('error', (err) => console.error('[player]', `voice connection error (${this.guildId})`, err));
  }

  /** Called by the manager when the bot's own voice state changed (moved or disconnected by someone). */
  handleBotVoiceState(channelId: string | null): void {
    this.safe(() => {
      if (this.joining || !this.connection) return;
      if (channelId === null) {
        if (this.channelId !== null) this.leave();
      } else if (channelId !== this.channelId) {
        this.channelId = channelId;
        this.refreshOccupancy();
        this.emitState();
      }
    });
  }

  /**
   * Re-evaluates whether the bot's channel holds any non-bot member and starts/cancels the 30 s
   * leave timer accordingly. Called by the manager on relevant voiceStateUpdate events.
   */
  refreshOccupancy(): void {
    this.safe(() => {
      if (!this.channelId) {
        this.clearEmpty();
        return;
      }
      const channel = this.client.guilds.cache.get(this.guildId)?.channels.cache.get(this.channelId);
      if (!channel || !channel.isVoiceBased()) return;
      const humans = channel.members.filter((m) => !m.user.bot).size;
      if (humans > 0) {
        this.clearEmpty();
      } else if (!this.emptyTimer) {
        this.emptyTimer = setTimeout(() => {
          this.emptyTimer = null;
          this.safe(() => {
            console.error('[player]', `leaving ${this.guildId}: voice channel empty`);
            this.leave();
          });
        }, EMPTY_LEAVE_MS);
      }
    });
  }

  /** Stops playback, clears the queue and leaves the voice channel. */
  leave(): void {
    this.safe(() => {
      const conn = this.connection;
      this.connection = null;
      this.channelId = null;
      this.resetPlayback();
      if (conn) this.safeDestroy(conn);
      this.emitState();
    });
  }

  /** Leave and drop all listeners; the instance is unusable afterwards. */
  destroy(): void {
    this.leave();
    this.clearTimers();
    this.removeAllListeners();
    this.player.removeAllListeners();
  }

  private safeDestroy(conn: VoiceConnection): void {
    try {
      if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    } catch (err) {
      console.error('[player]', 'destroy failed', err);
    }
  }

  // ---------------------------------------------------------------- queue

  /**
   * Adds tracks to the queue. playNow inserts them at the front and skips whatever is playing.
   * Starts playback when connected and idle.
   */
  enqueue(tracks: TrackInfo[], requestedBy: string, playNow = false): QueueItem[] {
    const items: QueueItem[] = tracks.map((t) => ({ ...t, uid: randomUUID(), requestedBy }));
    if (items.length === 0) return items;
    this.safe(() => {
      if (playNow) this.queue.unshift(...items);
      else this.queue.push(...items);

      if (this.channelId) {
        if (this.current) {
          if (playNow) this.skip();
        } else {
          this.playNext();
        }
      }
      this.emitState();
    });
    return items;
  }

  remove(uid: string): boolean {
    const i = this.queue.findIndex((q) => q.uid === uid);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    this.emitState();
    return true;
  }

  /** Moves a queued item to toIndex (clamped to the queue bounds). */
  move(uid: string, toIndex: number): boolean {
    const from = this.queue.findIndex((q) => q.uid === uid);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(this.queue.length - 1, Math.trunc(Number(toIndex)) || 0));
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item!);
    this.emitState();
    return true;
  }

  setLoop(mode: LoopMode): void {
    if (mode !== 'off' && mode !== 'track' && mode !== 'queue') return;
    this.loop = mode;
    this.emitState();
  }

  setVolume(volume: number): void {
    const n = Math.round(Number(volume));
    if (!Number.isFinite(n)) return;
    this.volume = Math.max(0, Math.min(100, n));
    this.resource?.volume?.setVolume(this.volume / 100);
    this.emitState();
  }

  // ---------------------------------------------------------------- playback controls

  /** Skips the current track (not a failure; loop=track does not replay it). Returns false if nothing is playing. */
  skip(): boolean {
    if (!this.current) return false;
    this.skipped = true;
    // stop(true) goes Idle synchronously, and the Idle handler advances. If the player is already Idle
    // (e.g. waiting out the error grace period) stop() returns false and we finish the track ourselves.
    if (!this.player.stop(true)) this.safe(() => this.handleIdle());
    return true;
  }

  /** Clears queue and current track; stays connected. */
  stop(): void {
    this.safe(() => {
      this.resetPlayback();
      this.updateIdle();
      this.emitState();
    });
  }

  pause(): boolean {
    if (!this.current || this.paused) return false;
    const ok = this.player.pause(true);
    if (ok) {
      this.paused = true;
      this.emitState();
    }
    return ok;
  }

  resume(): boolean {
    if (!this.current || !this.paused) return false;
    const ok = this.player.unpause();
    if (ok) {
      this.paused = false;
      this.emitState();
    }
    return ok;
  }

  // ---------------------------------------------------------------- internals

  /** Starts the next queued track (looping past ones that fail to start). */
  private playNext(): void {
    if (!this.channelId) return;
    for (;;) {
      const next = this.queue.shift();
      if (!next) {
        this.current = null;
        this.updateIdle();
        this.emitState();
        return;
      }
      if (this.tryStart(next)) return;
    }
  }

  private tryStart(item: QueueItem): boolean {
    try {
      this.startTrack(item);
      return true;
    } catch (err) {
      console.error('[player]', `failed to start ${item.id}`, err);
      this.killAudio();
      this.token++;
      this.current = null;
      this.resource = null;
      this.emitTrackError(item, errMessage(err));
      return false;
    }
  }

  private startTrack(item: QueueItem): void {
    this.killAudio();
    this.clearPending();
    const token = ++this.token;

    const audio = new AudioStream(item.url);
    audio.on('error', (err) => this.safe(() => this.onStreamError(token, err)));
    audio.stream.on('error', noop); // the AudioPlayer already reports resource errors; avoid unhandled 'error'
    this.audio = audio;

    let resource: AudioResource;
    try {
      resource = createAudioResource(audio.stream, { inputType: StreamType.Raw, inlineVolume: true });
    } catch (err) {
      audio.kill();
      this.audio = null;
      throw err;
    }
    resource.volume?.setVolume(this.volume / 100);

    this.current = item;
    this.resource = resource;
    this.failed = null;
    this.skipped = false;
    this.paused = false;
    this.startedAt = Date.now();
    this.cancelIdle();
    this.player.play(resource);
    this.emitState();
  }

  private onStreamError(token: number, err: Error): void {
    if (token !== this.token || !this.current) return; // stale (old track or already torn down)
    this.failCurrent(errMessage(err));
  }

  /** Records a failure for the current track and forces the player to Idle so the Idle handler finishes it. */
  private failCurrent(message: string): void {
    if (!this.current) return;
    if (!this.failed) this.failed = message;
    if (!this.player.stop(true)) this.handleIdle(); // already Idle (grace period): finish now
  }

  /** The AudioPlayer went Idle: the current track ended, was skipped, failed or was stopped. */
  private handleIdle(): void {
    this.clearPending();
    const item = this.current;
    if (!item) return; // stop()/leave() cleared it first
    // Measured in audio actually played, not wall time: yt-dlp alone can take seconds before the first
    // byte, so a broken track often "ends" well after EARLY_END_MS of wall time with nothing played.
    const played = this.resource?.playbackDuration ?? 0;
    if (!this.skipped && !this.failed && played < EARLY_END_MS) {
      // Ended suspiciously fast. Keep the AudioStream alive briefly so its stderr 'error' can still
      // arrive and explain why; otherwise report a generic message.
      const token = this.token;
      this.pending = setTimeout(() => {
        this.pending = null;
        this.safe(() => {
          if (token !== this.token || this.current !== item) return;
          if (!this.failed) this.failed = 'Track ended immediately (unavailable or blocked)';
          this.finishTrack(item);
        });
      }, ERROR_GRACE_MS);
      return;
    }
    this.finishTrack(item);
  }

  /** Applies loop/failure rules to the finished item and advances. */
  private finishTrack(item: QueueItem): void {
    const failed = this.failed;
    const skipped = this.skipped;
    this.killAudio();
    this.token++;
    this.current = null;
    this.resource = null;
    this.failed = null;
    this.skipped = false;
    this.paused = false;

    if (failed) {
      // A failed track is never replayed or re-queued, whatever the loop mode.
      this.emitTrackError(item, failed);
    } else if (this.loop === 'track' && !skipped && this.channelId) {
      if (this.tryStart(item)) return;
    } else if (this.loop === 'queue') {
      this.queue.push(item);
    }
    this.playNext();
  }

  /** Common teardown for stop/leave/disconnect: clears queue and current track, kills the stream. */
  private resetPlayback(): void {
    this.clearPending();
    this.queue = [];
    this.token++;
    this.current = null; // before player.stop so the Idle handler ignores it
    this.resource = null;
    this.failed = null;
    this.skipped = false;
    this.paused = false;
    this.killAudio();
    try {
      this.player.stop(true);
    } catch (err) {
      console.error('[player]', 'player.stop failed', err);
    }
    if (!this.channelId) this.clearTimers();
  }

  private killAudio(): void {
    const audio = this.audio;
    this.audio = null;
    if (!audio) return;
    try {
      audio.kill();
    } catch (err) {
      console.error('[player]', 'kill failed', err);
    }
  }

  // ---------------------------------------------------------------- timers

  /** Starts the 5 min idle-leave timer when connected with nothing playing; cancels it otherwise. */
  private updateIdle(): void {
    if (this.channelId && !this.current) {
      if (this.idleTimer) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.safe(() => {
          if (this.current || !this.channelId) return;
          console.error('[player]', `leaving ${this.guildId}: idle`);
          this.leave();
        });
      }, IDLE_LEAVE_MS);
    } else {
      this.cancelIdle();
    }
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearEmpty(): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  private clearTimers(): void {
    this.cancelIdle();
    this.clearEmpty();
    this.clearPending();
  }

  // ---------------------------------------------------------------- state

  getState(): GuildPlayerState {
    const guild = this.client.guilds.cache.get(this.guildId);
    const channel = this.channelId ? guild?.channels.cache.get(this.channelId) : undefined;
    return {
      guildId: this.guildId,
      guildName: guild?.name ?? this.guildId,
      channelId: this.channelId,
      channelName: channel?.name ?? null,
      current: this.current,
      positionMs: this.current && this.resource ? this.resource.playbackDuration : 0,
      sampledAt: Date.now(),
      paused: this.paused,
      volume: this.volume,
      loop: this.loop,
      queue: [...this.queue],
    };
  }

  private emitState(): void {
    try {
      this.emit('state', this.getState());
    } catch (err) {
      console.error('[player]', 'state listener failed', err);
    }
  }

  private emitTrackError(item: QueueItem, message: string): void {
    try {
      this.emit('trackError', this.guildId, item, message);
    } catch (err) {
      console.error('[player]', 'trackError listener failed', err);
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('[player]', err);
    }
  }
}
