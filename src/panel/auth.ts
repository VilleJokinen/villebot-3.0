import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler, Response } from 'express';
import type { PanelUser } from '../config.js';

const COOKIE_NAME = 'vb_panel';
const COOKIE_MAX_AGE = 2592000; // 30 days

export interface Auth {
  /** Authenticates every request; sets res.locals.user to the panel user's name. */
  middleware: RequestHandler;
  /** Returns the panel user's name for an allowed WebSocket upgrade, or null to reject it. */
  checkUpgrade(req: IncomingMessage): string | null;
}

/** The authenticated panel user's name (set by the auth middleware). */
export function panelUser(res: Response): string {
  return typeof res.locals.user === 'string' ? res.locals.user : 'panel';
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
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

export function createAuth(users: PanelUser[]): Auth {
  const known = users.map((u) => ({ name: u.name, digest: digest(u.token) }));
  /** Name of the user owning this token, or null. Compares against every user so timing doesn't leak which. */
  const lookup = (candidate: string | null | undefined): string | null => {
    if (typeof candidate !== 'string' || candidate === '') return null;
    const d = digest(candidate);
    let match: string | null = null;
    for (const u of known) if (timingSafeEqual(d, u.digest)) match = u.name;
    return match;
  };

  const cookieUser = (req: IncomingMessage): string | null => lookup(parseCookies(req.headers.cookie)[COOKIE_NAME]);

  const parseUrl = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://panel.invalid');

  const middleware: RequestHandler = (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    const url = parseUrl(req);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (isApi) res.setHeader('Cache-Control', 'no-store');

    const deny = (): void => {
      res.status(401);
      if (isApi) {
        res.json({ error: 'Unauthorized' });
      } else {
        res.type('text/plain').send('Unauthorized. Open the panel once with your personal link (…/?token=<your token>).');
      }
    };

    if (url.searchParams.has('token')) {
      const token = url.searchParams.get('token');
      if (!lookup(token)) {
        deny();
        return;
      }
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token!)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
      );
      url.searchParams.delete('token');
      // Collapse leading slashes so the Location can never be protocol-relative.
      const path = url.pathname.replace(/^\/{2,}/, '/');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, path + url.search);
      return;
    }

    const user = cookieUser(req);
    if (!user) {
      deny();
      return;
    }
    res.locals.user = user;
    next();
  };

  const checkUpgrade = (req: IncomingMessage): string | null => {
    try {
      const url = parseUrl(req);
      if (url.pathname !== '/ws') return null;
      const user = cookieUser(req) ?? lookup(url.searchParams.get('token'));
      if (!user) return null;
      const origin = req.headers.origin;
      if (origin !== undefined) {
        // Behind a reverse proxy (e.g. `tailscale serve`) Host may be the upstream address; the public
        // host is then in X-Forwarded-Host. Browsers can't set headers on a WebSocket handshake, so
        // accepting either does not weaken the cross-site check.
        const originHost = new URL(origin).host;
        const forwarded = req.headers['x-forwarded-host'];
        const hosts = [req.headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])]
          .flatMap((h) => (h ? h.split(',') : []))
          .map((h) => h.trim());
        if (!hosts.includes(originHost)) return null;
      }
      return user;
    } catch {
      return null;
    }
  };

  return { middleware, checkUpgrade };
}
