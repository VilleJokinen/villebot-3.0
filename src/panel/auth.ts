import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler, Response } from 'express';
import type { PanelUser } from '../config.js';

const COOKIE_NAME = 'vb_session';
const COOKIE_MAX_AGE = 2592000; // 30 days
// One browser can hold logins for several servers (someone in two servers with two passwords).
const MAX_SESSIONS_PER_COOKIE = 10;
// Failed logins are counted globally: behind the Cloudflare Tunnel every request comes from the same
// local proxy address, so per-IP limits would not tell visitors apart.
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 20;

/** What a logged-in browser may see and control. */
export interface Access {
  /** Named login (owner / PANEL_USERS): every server, including ones the bot joins later. */
  all: boolean;
  guilds: ReadonlySet<string>;
  /** Name of the named login, or null when only server passwords were used. */
  name: string | null;
}

export const canAccess = (access: Access, guildId: string): boolean => access.all || access.guilds.has(guildId);

/** The Access that the auth middleware attached to an /api request. */
export const accessOf = (res: Response): Access => res.locals.access as Access;

/** Who did it, for "Requested by" and the log. */
export const panelUser = (res: Response): string => (res.locals.access as Access | undefined)?.name ?? 'panel';

export interface Auth {
  /** Security headers, plus 401 for /api/* without a valid session (login/logout excepted). */
  middleware: RequestHandler;
  login: RequestHandler;
  logout: RequestHandler;
  /** Access for a WebSocket upgrade, or null to reject it. */
  checkUpgrade(req: IncomingMessage): Access | null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

const hmac = (key: string, value: string): Buffer => createHmac('sha256', key).update(value).digest();

interface Credential {
  passwordDigest: Buffer;
  /** Cookie value for this password. Derived from it, so it survives restarts and changes with it. */
  session: string;
  sessionDigest: Buffer;
  all: boolean;
  guilds: Set<string>;
  name: string | null;
}

export function createAuth(opts: { users: readonly PanelUser[]; serverPasswords: ReadonlyMap<string, string> }): Auth {
  // Group by password: two servers may share one, and a server password may equal a user's token.
  const byPassword = new Map<string, Credential>();
  const credential = (password: string): Credential => {
    let c = byPassword.get(password);
    if (!c) {
      const session = hmac(password, 'villebot-panel-session').toString('base64url');
      c = {
        passwordDigest: hmac('cmp', password),
        session,
        sessionDigest: hmac('cmp', session),
        all: false,
        guilds: new Set(),
        name: null,
      };
      byPassword.set(password, c);
    }
    return c;
  };
  for (const user of opts.users) {
    const c = credential(user.token);
    c.all = true;
    c.name ??= user.name;
  }
  for (const [guildId, password] of opts.serverPasswords) credential(password).guilds.add(guildId);
  const credentials = [...byPassword.values()];

  // Compare against every credential so timing doesn't reveal which one matched.
  const match = (digest: Buffer, field: 'passwordDigest' | 'sessionDigest'): Credential | null => {
    let found: Credential | null = null;
    for (const c of credentials) if (timingSafeEqual(digest, c[field]) && !found) found = c;
    return found;
  };

  const validSessions = (req: IncomingMessage): Credential[] => {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!raw) return [];
    const out: Credential[] = [];
    for (const value of raw.split('.').slice(0, MAX_SESSIONS_PER_COOKIE)) {
      const c = match(hmac('cmp', value), 'sessionDigest');
      if (c && !out.includes(c)) out.push(c);
    }
    return out;
  };

  const accessFor = (req: IncomingMessage): Access | null => {
    const sessions = validSessions(req);
    if (sessions.length === 0) return null;
    return {
      all: sessions.some((c) => c.all),
      guilds: new Set(sessions.flatMap((c) => [...c.guilds])),
      name: sessions.find((c) => c.name !== null)?.name ?? null,
    };
  };

  const setCookie = (res: Response, sessions: Credential[]): void => {
    const value = sessions.map((c) => c.session).join('.');
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessions.length ? COOKIE_MAX_AGE : 0}`,
    );
  };

  const failures: number[] = [];
  const pruneFailures = (): void => {
    const cutoff = Date.now() - FAIL_WINDOW_MS;
    while (failures.length > 0 && failures[0]! < cutoff) failures.shift();
  };

  const parseUrl = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://panel.invalid');

  const middleware: RequestHandler = (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    // Static files are public (they hold no secrets); only the API needs a session.
    const { pathname } = parseUrl(req);
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/api/login' || pathname === '/api/logout') return next();
    const access = accessFor(req);
    if (!access) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.access = access;
    next();
  };

  const login: RequestHandler = (req, res) => {
    pruneFailures();
    if (failures.length >= FAIL_LIMIT) {
      res.status(429).json({ error: 'Too many wrong passwords. Try again in a few minutes.' });
      return;
    }
    const given = (req.body as { password?: unknown } | undefined)?.password;
    const c = typeof given === 'string' ? match(hmac('cmp', given), 'passwordDigest') : null;
    if (!c) {
      failures.push(Date.now());
      if (failures.length === FAIL_LIMIT) {
        console.warn(`[panel] ${FAIL_LIMIT} wrong panel passwords in 15 minutes; login paused`);
      }
      // Small delay to slow down guessing.
      setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 1000);
      return;
    }
    // Keep logins for other servers; stale ones (changed passwords) drop out here.
    const sessions = [c, ...validSessions(req).filter((s) => s !== c)].slice(0, MAX_SESSIONS_PER_COOKIE);
    setCookie(res, sessions);
    res.json({ ok: true });
  };

  const logout: RequestHandler = (_req, res) => {
    setCookie(res, []);
    res.json({ ok: true });
  };

  const checkUpgrade = (req: IncomingMessage): Access | null => {
    try {
      const url = parseUrl(req);
      if (url.pathname !== '/ws') return null;
      const access = accessFor(req);
      if (!access) return null;
      const origin = req.headers.origin;
      if (origin !== undefined) {
        // Behind a reverse proxy (e.g. a Cloudflare Tunnel) Host may be the upstream address; the public
        // host is then in X-Forwarded-Host. Browsers can't set headers on a WebSocket handshake, so
        // accepting either does not weaken the cross-site check.
        const originHost = new URL(origin).host;
        const forwarded = req.headers['x-forwarded-host'];
        const hosts = [req.headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])]
          .flatMap((h) => (h ? h.split(',') : []))
          .map((h) => h.trim());
        if (!hosts.includes(originHost)) return null;
      }
      return access;
    } catch {
      return null;
    }
  };

  return { middleware, login, logout, checkUpgrade };
}
