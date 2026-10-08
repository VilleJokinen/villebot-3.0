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
// Optional: older setups registered commands per server. Clearing them there avoids every command
// showing up twice next to the global ones.
const oldGuildId = env('GUILD_ID');
const missing = [
  ['DISCORD_TOKEN', token],
  ['CLIENT_ID', clientId],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (!token || !clientId) {
  fail(`Missing environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
}

try {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = commandsJSON();
  const result = (await rest.put(Routes.applicationCommands(clientId), { body })) as unknown[];
  console.log(`[register] Registered ${result.length} commands globally (every server the bot is in).`);
  if (oldGuildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, oldGuildId), { body: [] });
      console.log(`[register] Removed old server-only commands from ${oldGuildId}. You can delete GUILD_ID from .env.`);
    } catch (err) {
      console.warn(`[register] Could not clear old commands in GUILD_ID ${oldGuildId}: ${(err as Error).message}`);
    }
  }
} catch (err) {
  const e = err as { status?: number; code?: number | string; message?: string };
  if (e.status === 401) fail('DISCORD_TOKEN is invalid.');
  if (e.status === 404 || e.code === 10002) fail('CLIENT_ID is not a valid application id.');
  fail(`Registering commands failed: ${e.message ?? String(err)}`);
}
