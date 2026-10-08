import 'dotenv/config';

export interface PanelUser {
  name: string;
  token: string;
}

export interface Config {
  discordToken: string;
  clientId: string;
  guildId: string;
  panelHost: string;
  panelPort: number;
  /** Everyone who may use the panel, each with their own token. */
  panelUsers: PanelUser[];
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
  const panelUsers = loadPanelUsers();
  return {
    discordToken: required('DISCORD_TOKEN'),
    clientId: required('CLIENT_ID'),
    guildId: required('GUILD_ID'),
    panelHost: process.env.PANEL_HOST?.trim() || '127.0.0.1',
    panelPort,
    panelUsers,
  };
}

const NAME = /^[A-Za-z0-9_.-]{1,32}$/;

/**
 * PANEL_USERS="ville:<token>,alex:<token>" gives each person their own token; PANEL_TOKEN is a shorthand
 * for a single user called "owner". Both may be set. Tokens must be unique and at least 16 characters.
 */
function loadPanelUsers(): PanelUser[] {
  const users: PanelUser[] = [];
  const single = process.env.PANEL_TOKEN?.trim();
  if (single) users.push({ name: 'owner', token: single });

  for (const [i, entry] of (process.env.PANEL_USERS ?? '').split(',').entries()) {
    if (!entry.trim()) continue;
    const sep = entry.indexOf(':');
    const name = sep < 0 ? '' : entry.slice(0, sep).trim();
    const token = sep < 0 ? '' : entry.slice(sep + 1).trim();
    if (!NAME.test(name) || !token) {
      // Don't echo the entry: it may be a bare token.
      throw new Error(`PANEL_USERS entry #${i + 1} must look like name:token (name: letters, digits, _ . -).`);
    }
    users.push({ name, token });
  }

  if (users.length === 0) {
    throw new Error('Set PANEL_USERS (name:token,name:token) or PANEL_TOKEN in .env so the control panel has at least one login.');
  }
  const names = new Set<string>();
  const tokens = new Set<string>();
  for (const u of users) {
    if (u.token.length < 16) throw new Error(`Panel token for "${u.name}" must be at least 16 characters. Use a long random string.`);
    if (names.has(u.name.toLowerCase())) throw new Error(`Panel user "${u.name}" is listed twice.`);
    if (tokens.has(u.token)) throw new Error(`Panel users "${u.name}" and another user share a token; each needs their own.`);
    names.add(u.name.toLowerCase());
    tokens.add(u.token);
  }
  return users;
}
