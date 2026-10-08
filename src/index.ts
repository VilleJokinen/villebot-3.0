import { Client, Events, GatewayIntentBits } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { checkBinaries } from './ytdlp.js';
import { PlayerManager } from './player/index.js';
import { createBot } from './bot/index.js';
import { startPanel } from './panel/server.js';

process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection', err));
process.on('uncaughtException', (err) => console.error('[process] uncaught exception', err));

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail((err as Error).message);
  }

  try {
    const versions = await checkBinaries();
    console.log(`[startup] yt-dlp ${versions.ytdlp}, ffmpeg ${versions.ffmpeg}`);
  } catch (err) {
    fail((err as Error).message);
  }
  if (process.env.VOICE_DEPS_REPORT) console.log(generateDependencyReport());

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    // Track titles come from YouTube; never let one ping anyone.
    allowedMentions: { parse: [] },
  });
  const manager = new PlayerManager(client);
  createBot(client, manager);

  client.once(Events.ClientReady, (c) => {
    const guilds = c.guilds.cache.map((g) => g.name).join(', ') || 'none';
    console.log(`[discord] logged in as ${c.user.tag}; servers: ${guilds}`);
    if (!c.guilds.cache.has(config.guildId)) {
      console.warn(`[discord] the bot is not in GUILD_ID ${config.guildId}. Invite it with the URL from the README.`);
    }
  });
  client.on(Events.Error, (err) => console.error('[discord]', err));
  client.on(Events.ShardDisconnect, (_e, id) => console.warn(`[discord] gateway disconnected (shard ${id}); reconnecting`));

  let panel: Server;
  try {
    panel = await startPanel({
      host: config.panelHost,
      port: config.panelPort,
      users: config.panelUsers,
      client,
      manager,
    });
  } catch (err) {
    fail(`Control panel failed to start: ${(err as Error).message}`);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal}: leaving voice channels and stopping`);
    try {
      manager.destroyAll();
    } catch (err) {
      console.error('[shutdown]', err);
    }
    panel.close();
    void client.destroy().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await client.login(config.discordToken);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'TokenInvalid') fail('DISCORD_TOKEN is invalid. Reset it in the Developer Portal (Bot tab) and update .env.');
    if (/disallowed intents/i.test(e.message ?? '')) fail('Discord rejected the gateway intents. This bot only needs Guilds + GuildVoiceStates.');
    fail(`Discord login failed: ${e.message ?? String(err)}`);
  }
}

void main();
