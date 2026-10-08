import 'dotenv/config';

export interface Config {
  discordToken: string;
  clientId: string;
  guildId: string;
  panelHost: string;
  panelPort: number;
  panelToken: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/** Loads and validates .env. Throws a readable error on anything missing or invalid. */
export function loadConfig(): Config {
  const panelPort = Number(process.env.PANEL_PORT?.trim() || 3000);
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535) {
    throw new Error(`PANEL_PORT must be a port number, got "${process.env.PANEL_PORT}".`);
  }
  const panelToken = required('PANEL_TOKEN');
  if (panelToken.length < 16) {
    throw new Error('PANEL_TOKEN must be at least 16 characters. Use a long random string.');
  }
  return {
    discordToken: required('DISCORD_TOKEN'),
    clientId: required('CLIENT_ID'),
    guildId: required('GUILD_ID'),
    panelHost: process.env.PANEL_HOST?.trim() || '127.0.0.1',
    panelPort,
    panelToken,
  };
}
