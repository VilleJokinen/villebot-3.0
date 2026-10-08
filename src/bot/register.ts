import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandsJSON } from './commands.js';

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function fail(message: string): never {
  console.error(`[register] ${message}`);
  process.exit(1);
}

const token = env('DISCORD_TOKEN');
const clientId = env('CLIENT_ID');
const guildId = env('GUILD_ID');
const missing = [
  ['DISCORD_TOKEN', token],
  ['CLIENT_ID', clientId],
  ['GUILD_ID', guildId],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (!token || !clientId || !guildId) {
  fail(`Missing environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
}

try {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = commandsJSON();
  const result = (await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body })) as unknown[];
  console.log(`[register] Registered ${result.length} commands in guild ${guildId}.`);
} catch (err) {
  const e = err as { status?: number; code?: number | string; message?: string };
  if (e.status === 401) fail('DISCORD_TOKEN is invalid.');
  if (e.status === 403 || e.code === 50001) {
    fail('Missing Access: the bot is not in that guild, or the applications.commands scope is missing from the invite.');
  }
  if (e.status === 404 || e.code === 10002) fail('CLIENT_ID is not a valid application id.');
  fail(`Registering commands failed: ${e.message ?? String(err)}`);
}
