import { EventEmitter } from 'node:events';
import type { Client, VoiceState } from 'discord.js';
import { GuildPlayer } from './GuildPlayer.js';
import type { GuildPlayerState, PlayerEvents } from './types.js';

/** guild -> GuildPlayer map; fans player events in and handles voiceStateUpdate. */
export class PlayerManager extends EventEmitter<PlayerEvents> {
  private readonly client: Client;
  private readonly players = new Map<string, GuildPlayer>();

  private readonly onVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): void => {
    try {
      const player = this.players.get(newState.guild.id);
      if (!player) return;
      if (newState.id === this.client.user?.id) {
        // The bot itself was moved or disconnected (by a user, or by us, which is a no-op there).
        player.handleBotVoiceState(newState.channelId);
        return;
      }
      // Someone else joined/left/moved: re-check whether the bot's channel is empty of humans.
      if (oldState.channelId !== newState.channelId) player.refreshOccupancy();
    } catch (err) {
      console.error('[player]', 'voiceStateUpdate failed', err);
    }
  };

  private readonly onGuildDelete = (guild: { id: string }): void => {
    try {
      const player = this.players.get(guild.id);
      if (!player) return;
      player.destroy();
      this.players.delete(guild.id);
    } catch (err) {
      console.error('[player]', 'guildDelete failed', err);
    }
  };

  constructor(client: Client) {
    super();
    this.client = client;
    client.on('voiceStateUpdate', this.onVoiceStateUpdate);
    client.on('guildDelete', this.onGuildDelete);
  }

  /** Returns the player for a guild, creating it lazily. Throws if the bot is not in that guild. */
  get(guildId: string): GuildPlayer {
    const existing = this.players.get(guildId);
    if (existing) return existing;
    if (!this.client.guilds.cache.has(guildId)) throw new Error('Bot is not in that server');
    const player = new GuildPlayer(this.client, guildId);
    player.on('state', (state) => this.emit('state', state));
    player.on('trackError', (gid, item, message) => this.emit('trackError', gid, item, message));
    this.players.set(guildId, player);
    return player;
  }

  /** Players created so far. */
  all(): GuildPlayer[] {
    return [...this.players.values()];
  }

  /** State of every guild the bot is in (players are created lazily for guilds that have none yet). */
  states(): GuildPlayerState[] {
    for (const id of this.client.guilds.cache.keys()) {
      try {
        this.get(id);
      } catch {
        // guild vanished from cache in between; ignore
      }
    }
    return this.all().map((p) => p.getState());
  }

  /** Leaves all voice channels and kills all child processes. For shutdown. */
  destroyAll(): void {
    this.client.off('voiceStateUpdate', this.onVoiceStateUpdate);
    this.client.off('guildDelete', this.onGuildDelete);
    for (const player of this.players.values()) {
      try {
        player.destroy();
      } catch (err) {
        console.error('[player]', 'destroy failed', err);
      }
    }
    this.players.clear();
  }
}
