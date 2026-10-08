import {
  EmbedBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Interaction,
} from 'discord.js';
import type { GuildPlayer } from '../player/GuildPlayer.js';
import type { PlayerManager } from '../player/PlayerManager.js';
import { isSpotifyInput, resolveSpotify } from '../spotify.js';
import { resolve } from '../ytdlp.js';
import { syncVoiceStatus } from './voiceStatus.js';
import type { HealthMonitor } from '../health.js';

/** Error with a message that is safe and useful to show to the user. */
class UserError extends Error {}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'live';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const esc = (s: string): string => escapeMarkdown(s);

function progressBar(positionMs: number, durationSec: number | null, width = 15): string {
  if (durationSec === null || durationSec <= 0) return '▬'.repeat(width);
  const ratio = Math.min(1, Math.max(0, positionMs / 1000 / durationSec));
  const at = Math.min(width - 1, Math.floor(ratio * width));
  return '▬'.repeat(at) + '🔘' + '▬'.repeat(width - 1 - at);
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `⚠️ ${msg.trim().slice(0, 500) || 'Unknown error'}`;
}

function isUnknownInteraction(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 10062;
}

async function memberOf(i: ChatInputCommandInteraction<'cached' | 'raw'>): Promise<GuildMember> {
  if (i.member && 'voice' in i.member) return i.member;
  if (!i.guild) throw new UserError('This command only works in a server');
  return i.guild.members.fetch(i.user.id);
}

async function callerChannelId(i: ChatInputCommandInteraction<'cached' | 'raw'>): Promise<string> {
  const member = await memberOf(i);
  const channel = member.voice.channel;
  if (!channel) throw new UserError('Join a voice channel first');
  return channel.id;
}

type Reply = (content: string, ephemeral?: boolean) => Promise<void>;

export interface PanelInfo {
  panelUrl: string | null;
  serverPasswords: ReadonlyMap<string, string>;
}

function linkText(panel: PanelInfo, guildId: string): string {
  if (!panel.panelUrl) return 'The control panel link is not set up yet. The bot owner needs to set `PANEL_URL` in `.env`.';
  const password = panel.serverPasswords.get(guildId);
  if (!password) {
    return `This server has no panel password yet. The bot owner needs to add \`PANEL_PASSWORD_${guildId}=...\` to \`.env\` and restart the bot.`;
  }
  const url = `${panel.panelUrl}/?guild=${guildId}`;
  // Inline code makes the password easy to copy; it can't hold a backtick, so fall back to escaping.
  const pw = password.includes('`') ? esc(password) : `\`${password}\``;
  return `🎛️ Control panel: ${url}\nPassword: ${pw}\n\nDon't share the password outside this server.`;
}

async function handle(
  interaction: ChatInputCommandInteraction<'cached' | 'raw'>,
  manager: PlayerManager,
  panel: PanelInfo,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  let deferred = false;
  const reply: Reply = async (content, ephemeral = false) => {
    if (deferred || interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, embeds: [] });
    } else {
      await interaction.reply({ content, ...(ephemeral ? { flags: 'Ephemeral' as const } : {}) });
    }
  };

  try {
    const player = manager.get(guildId);
    switch (interaction.commandName) {
      case 'play': {
        await interaction.deferReply();
        deferred = true;
        await play(interaction, player, reply);
        break;
      }
      case 'skip': {
        if (!player.getState().current) return void (await reply('Nothing is playing', true));
        player.skip();
        await reply('⏭️ Skipped');
        break;
      }
      case 'pause': {
        if (!player.getState().current) return void (await reply('Nothing is playing', true));
        await reply(player.pause() ? '⏸️ Paused' : 'Already paused', false);
        break;
      }
      case 'resume': {
        if (!player.getState().current) return void (await reply('Nothing is playing', true));
        await reply(player.resume() ? '▶️ Resumed' : 'Not paused', false);
        break;
      }
      case 'stop': {
        const s = player.getState();
        if (!s.current && s.queue.length === 0) return void (await reply('Nothing is playing', true));
        player.stop();
        await reply('⏹️ Stopped and cleared the queue');
        break;
      }
      case 'queue': {
        await interaction.reply({ embeds: [queueEmbed(player)] });
        break;
      }
      case 'np': {
        const embed = npEmbed(player);
        if (!embed) return void (await reply('Nothing is playing', true));
        await interaction.reply({ embeds: [embed] });
        break;
      }
      case 'volume': {
        const level = interaction.options.getInteger('level', true);
        player.setVolume(level);
        await reply(`🔊 Volume ${player.getState().volume}%`);
        break;
      }
      case 'join': {
        const channelId = await callerChannelId(interaction);
        await interaction.deferReply();
        deferred = true;
        await player.join(channelId);
        await reply(`Joined <#${channelId}>`);
        break;
      }
      case 'leave': {
        player.leave();
        await reply('👋 Left the voice channel');
        break;
      }
      case 'link': {
        await reply(linkText(panel, guildId), true);
        break;
      }
      default:
        await reply('Unknown command', true);
    }
  } catch (err) {
    if (isUnknownInteraction(err)) return;
    if (!(err instanceof UserError)) console.error('[bot]', `/${interaction.commandName} failed`, err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorText(err), embeds: [] });
      } else {
        await interaction.reply({ content: errorText(err), flags: 'Ephemeral' });
      }
    } catch (err2) {
      if (!isUnknownInteraction(err2)) console.error('[bot]', 'failed to send error reply', err2);
    }
  }
}

async function play(
  interaction: ChatInputCommandInteraction<'cached' | 'raw'>,
  player: GuildPlayer,
  reply: Reply,
): Promise<void> {
  const channelId = await callerChannelId(interaction);
  const state = player.getState();
  if (state.channelId && state.channelId !== channelId && state.current) {
    throw new UserError(`I'm playing in <#${state.channelId}>; join that channel`);
  }
  if (state.channelId !== channelId) await player.join(channelId);

  const query = interaction.options.getString('query', true).trim();
  const tracks = isSpotifyInput(query) ? await resolveSpotify(query) : await resolve(query);
  if (tracks.length === 0) throw new UserError('No results found');

  const member = await memberOf(interaction);
  const wasPlaying = player.getState().current !== null;
  player.textChannelId = interaction.channelId;
  player.enqueue(tracks, member.displayName);

  if (tracks.length > 1) {
    await reply(`Queued ${tracks.length} tracks`);
  } else {
    const t = tracks[0]!;
    await reply(
      wasPlaying ? `Queued **${esc(t.title)}** (${formatDuration(t.duration)})` : `Playing **${esc(t.title)}**`,
    );
  }
}

function queueEmbed(player: GuildPlayer): EmbedBuilder {
  const s = player.getState();
  const embed = new EmbedBuilder().setTitle('Queue');
  const line = (t: { title: string; duration: number | null; requestedBy: string }): string =>
    `**${esc(t.title)}** (${formatDuration(t.duration)}) · ${esc(t.requestedBy)}`;
  embed.addFields({ name: 'Now playing', value: s.current ? line(s.current) : 'Nothing' });
  if (s.queue.length > 0) {
    const next = s.queue.slice(0, 10).map((t, i) => `${i + 1}. ${line(t)}`);
    if (s.queue.length > 10) next.push(`…and ${s.queue.length - 10} more`);
    embed.addFields({ name: 'Up next', value: next.join('\n').slice(0, 1024) });
  }
  embed.setFooter({ text: `${s.queue.length} queued · Loop: ${s.loop}` });
  return embed;
}

function npEmbed(player: GuildPlayer): EmbedBuilder | null {
  const s = player.getState();
  const t = s.current;
  if (!t) return null;
  const embed = new EmbedBuilder()
    .setTitle(t.title.slice(0, 256))
    .setURL(t.url)
    .setDescription(
      `${progressBar(s.positionMs, t.duration)}\n${formatDuration(s.positionMs / 1000)} / ${formatDuration(t.duration)}`,
    )
    .addFields(
      { name: 'Channel', value: esc(t.channel) || '—', inline: true },
      { name: 'Volume', value: `${s.volume}%`, inline: true },
      { name: 'Requested by', value: esc(t.requestedBy) || '—', inline: true },
    );
  if (t.thumbnail) embed.setThumbnail(t.thumbnail);
  if (s.paused) embed.setFooter({ text: 'Paused' });
  return embed;
}

export function createBot(client: Client, manager: PlayerManager, health: HealthMonitor, panel: PanelInfo): void {
  client.on('interactionCreate', (interaction: Interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
    handle(interaction as ChatInputCommandInteraction<'cached' | 'raw'>, manager, panel).catch((err) =>
      console.error('[bot]', 'unhandled handler error', err),
    );
  });

  syncVoiceStatus(client, manager, health);

  manager.on('trackError', (guildId, item, message) => {
    void (async () => {
      try {
        const channelId = manager.get(guildId).textChannelId;
        if (!channelId) return;
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !('send' in channel)) return;
        await channel.send(`⚠️ Skipped **${esc(item.title)}**: ${message}`);
      } catch (err) {
        console.error('[bot]', 'failed to report track error', err);
      }
    })();
  });
}
