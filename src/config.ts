import 'dotenv/config';

/** A named login that sees every server (owner password, PANEL_TOKEN, or a PANEL_USERS entry). */
export interface PanelUser {
  name: string;
  token: string;
}

export interface Config {
  discordToken: string;
  clientId: string;
  panelHost: string;
  panelPort: number;
  /** Named logins with access to every server. */
  panelUsers: PanelUser[];
  /** Server ID -> password that unlocks only that server (PANEL_PASSWORD_<serverId>). */
  serverPasswords: Map<string, string>;
  /** Public panel address for /link, e.g. https://villebot.example.com. Null when not set. */
  panelUrl: string | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const MIN_PASSWORD = 8;
const MIN_TOKEN = 16;

function checkLength(label: string, value: string, min: number): string {
  if (value.length < min) {
    throw new Error(`${label} must be at least ${min} characters. The panel can be public through the tunnel; pick something not guessable.`);
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
  const serverPasswords = loadServerPasswords();
  if (panelUsers.length === 0 && serverPasswords.size === 0) {
    throw new Error(
      'Set at least one panel login in .env: PANEL_PASSWORD (owner), PANEL_PASSWORD_<serverId> (one server), or PANEL_USERS (name:token,...).',
    );
  }
  let panelUrl: string | null = null;
  const rawUrl = process.env.PANEL_URL?.trim();
  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`PANEL_URL must be a full URL like https://villebot.example.com, got "${rawUrl}".`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`PANEL_URL must start with https://, got "${rawUrl}".`);
    }
    panelUrl = parsed.origin;
  }
  return {
    discordToken: required('DISCORD_TOKEN'),
    clientId: required('CLIENT_ID'),
    panelHost: process.env.PANEL_HOST?.trim() || '127.0.0.1',
    panelPort,
    panelUsers,
    serverPasswords,
    panelUrl,
  };
}

const NAME = /^[A-Za-z0-9_.-]{1,32}$/;

/**
 * Logins that see every server. PANEL_PASSWORD and PANEL_TOKEN are both a login called "owner";
 * PANEL_USERS="ville:<token>,alex:<token>" gives each person their own token, so one person can be
 * revoked without changing anyone else's.
 */
function loadPanelUsers(): PanelUser[] {
  const users: PanelUser[] = [];
  const password = process.env.PANEL_PASSWORD?.trim();
  if (password) users.push({ name: 'owner', token: checkLength('PANEL_PASSWORD', password, MIN_PASSWORD) });
  const single = process.env.PANEL_TOKEN?.trim();
  if (single) users.push({ name: 'owner', token: checkLength('PANEL_TOKEN', single, MIN_TOKEN) });

  for (const [i, entry] of (process.env.PANEL_USERS ?? '').split(',').entries()) {
    if (!entry.trim()) continue;
    const sep = entry.indexOf(':');
    const name = sep < 0 ? '' : entry.slice(0, sep).trim();
    const token = sep < 0 ? '' : entry.slice(sep + 1).trim();
    if (!NAME.test(name) || !token) {
      // Don't echo the entry: it may be a bare token.
      throw new Error(`PANEL_USERS entry #${i + 1} must look like name:token (name: letters, digits, _ . -).`);
    }
    if (name.toLowerCase() === 'owner') throw new Error('PANEL_USERS: the name "owner" is reserved for PANEL_PASSWORD / PANEL_TOKEN.');
    users.push({ name, token: checkLength(`Panel token for "${name}"`, token, MIN_TOKEN) });
  }

  const names = new Set<string>();
  const tokens = new Set<string>();
  for (const u of users) {
    const key = u.name.toLowerCase();
    if (names.has(key) && key !== 'owner') throw new Error(`Panel user "${u.name}" is listed twice.`);
    if (tokens.has(u.token)) throw new Error(`Panel user "${u.name}" shares a token with another login; each needs their own.`);
    names.add(key);
    tokens.add(u.token);
  }
  return users;
}

/** PANEL_PASSWORD_<serverId>=... unlocks only that server; /link in that server shows it. */
function loadServerPasswords(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, raw] of Object.entries(process.env)) {
    if (!name.startsWith('PANEL_PASSWORD_')) continue;
    const value = raw?.trim();
    if (!value) continue;
    const guildId = name.slice('PANEL_PASSWORD_'.length);
    if (!/^\d{17,20}$/.test(guildId)) {
      throw new Error(`${name}: the part after PANEL_PASSWORD_ must be a server ID (a long number), got "${guildId}".`);
    }
    out.set(guildId, checkLength(name, value, MIN_PASSWORD));
  }
  return out;
}
