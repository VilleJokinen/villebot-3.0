import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';

const COOKIE_NAME = 'vb_panel';
const COOKIE_MAX_AGE = 2592000; // 30 days

export interface Auth {
  middleware: RequestHandler;
  checkUpgrade(req: IncomingMessage): boolean;
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

export function createAuth(token: string): Auth {
  const expected = digest(token);
  const valid = (candidate: string | null | undefined): boolean =>
    typeof candidate === 'string' && timingSafeEqual(digest(candidate), expected);

  const cookieValid = (req: IncomingMessage): boolean =>
    valid(parseCookies(req.headers.cookie)[COOKIE_NAME]);

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
        res.type('text/plain').send('Unauthorized. Open the panel once with ?token=<PANEL_TOKEN>.');
      }
    };

    if (url.searchParams.has('token')) {
      if (!valid(url.searchParams.get('token'))) {
        deny();
        return;
      }
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
      );
      url.searchParams.delete('token');
      // Collapse leading slashes so the Location can never be protocol-relative.
      const path = url.pathname.replace(/^\/{2,}/, '/');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, path + url.search);
      return;
    }

    if (!cookieValid(req)) {
      deny();
      return;
    }
    next();
  };

  const checkUpgrade = (req: IncomingMessage): boolean => {
    try {
      const url = parseUrl(req);
      if (url.pathname !== '/ws') return false;
      if (!cookieValid(req) && !valid(url.searchParams.get('token'))) return false;
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const host = req.headers.host;
        if (!host || new URL(origin).host !== host) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  return { middleware, checkUpgrade };
}
