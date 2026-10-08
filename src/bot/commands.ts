import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

const base = (name: string, description: string): SlashCommandBuilder =>
  new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);

export const commands: SlashCommandBuilder[] = [
  base('play', 'Play a song or add it to the queue').addStringOption((o) =>
    o.setName('query').setDescription('Search text, YouTube URL or playlist URL').setRequired(true),
  ) as SlashCommandBuilder,
  base('skip', 'Skip the current track'),
  base('pause', 'Pause playback'),
  base('resume', 'Resume playback'),
  base('stop', 'Stop playback and clear the queue'),
  base('queue', 'Show the queue'),
  base('np', 'Show the current track'),
  base('volume', 'Set the volume').addIntegerOption((o) =>
    o.setName('level').setDescription('Volume 0-100').setMinValue(0).setMaxValue(100).setRequired(true),
  ) as SlashCommandBuilder,
  base('join', 'Join your voice channel'),
  base('leave', 'Leave the voice channel'),
  base('link', 'Get the control panel link and password (only you see the reply)'),
];

export function commandsJSON(): ReturnType<SlashCommandBuilder['toJSON']>[] {
  return commands.map((c) => c.toJSON());
}
