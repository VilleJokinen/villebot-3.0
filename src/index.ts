import { Client, Events, GatewayIntentBits } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import type { Server } from 'node:http';
import { constants as osConstants, setPriority } from 'node:os';
import { loadConfig } from './config.js';
import { checkBinaries } from './ytdlp.js';
import { PlayerManager } from './player/index.js';
import { createBot } from './bot/index.js';
import { startPanel } from './panel/server.js';
import { HealthMonitor } from './health.js';

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

  // Voice packets go out on a 20 ms timer in this process; when the machine is busy (a game, a build),
  // a normal-priority bot gets starved and the audio stutters. Needs no admin rights on Windows; on Linux
  // it requires CAP_SYS_NICE, so a failure is expected there and harmless.
  try {
    setPriority(osConstants.priority.PRIORITY_ABOVE_NORMAL);
  } catch {
    /* not permitted; run at normal priority */
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    // Track titles come from YouTube; never let one ping anyone.
    allowedMentions: { parse: [] },
  });
  const manager = new PlayerManager(client);
  const health = new HealthMonitor(manager);
  health.start();
  createBot(client, manager, health, { panelUrl: config.panelUrl, serverPasswords: config.serverPasswords });

  client.once(Events.ClientReady, (c) => {
    const guilds = c.guilds.cache.map((g) => g.name).join(', ') || 'none';
    console.log(`[discord] logged in as ${c.user.tag}; servers: ${guilds}`);
    if (c.guilds.cache.size === 0) console.warn('[discord] the bot is in no servers. Invite it with the URL from the README.');
  });
  client.on(Events.Error, (err) => console.error('[discord]', err));
  client.on(Events.ShardDisconnect, (_e, id) => console.warn(`[discord] gateway disconnected (shard ${id}); reconnecting`));

  let panel: Server;
  try {
    panel = await startPanel({
      host: config.panelHost,
      port: config.panelPort,
      users: config.panelUsers,
      serverPasswords: config.serverPasswords,
      client,
      manager,
      health,
    });
  } catch (err) {
    fail(`Control panel failed to start: ${(err as Error).message}`);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal}: leaving voice channels and stopping`);
    health.stop();
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
