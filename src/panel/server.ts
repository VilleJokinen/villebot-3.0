import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { Client } from 'discord.js';
import { WebSocket, WebSocketServer } from 'ws';
import type { GuildPlayer, PlayerManager } from '../player/index.js';
import type { LoopMode, GuildPlayerState, QueueItem } from '../player/types.js';
import { isSpotifyInput, resolveSpotify } from '../spotify.js';
import { resolve as resolveInput, search } from '../ytdlp.js';
import { accessOf, canAccess, createAuth, panelUser, type Access } from './auth.js';
import type { PanelUser } from '../config.js';
import type { Health, HealthMonitor } from '../health.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const PING_INTERVAL_MS = 30_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** Mutating requests must be application/json (CSRF defense together with SameSite=Strict). */
const requireJson: RequestHandler = (req, _res, next) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') return next();
  const type = req.headers['content-type'];
  if (type !== undefined && JSON_TYPE.test(type)) return next();
  if (req.method === 'DELETE') {
    const len = req.headers['content-length'];
    const hasBody = req.headers['transfer-encoding'] !== undefined || (len !== undefined && len !== '0');
    if (!hasBody) return next();
  }
  next(new HttpError(415, 'Content-Type must be application/json'));
};

function body(req: Request): Record<string, unknown> {
  if (req.body === undefined || req.body === null) return {};
  if (!isRecord(req.body)) throw new HttpError(400, 'Body must be a JSON object');
  return req.body;
}

export async function startPanel(opts: {
  host: string;
  port: number;
  users: readonly PanelUser[];
  serverPasswords: ReadonlyMap<string, string>;
  client: Client;
  manager: PlayerManager;
  health: HealthMonitor;
}): Promise<http.Server> {
  const { host, port, client, manager, health } = opts;
  const auth = createAuth(opts);
  const app = express();
  app.disable('x-powered-by');

  app.use(auth.middleware);
  // Audit trail: who did what from the panel.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.path.startsWith('/api/') && req.path !== '/api/login' && req.path !== '/api/logout') {
      console.log(`[panel] ${panelUser(res)} ${req.method} ${req.path}`);
    }
    next();
  });
  app.use(requireJson);
  app.use(express.json({ limit: '100kb' }));

  // A server the login doesn't cover looks exactly like one the bot isn't in.
  const guildPlayer = (req: Request, res: Response): GuildPlayer => {
    const gid = String(req.params.gid);
    if (!client.guilds.cache.has(gid) || !canAccess(accessOf(res), gid)) throw new HttpError(404, 'Unknown server');
    return manager.get(gid);
  };

  const api = express.Router();

  api.post('/login', auth.login);
  api.post('/logout', auth.logout);

  api.get('/guilds', (_req, res) => {
    const access = accessOf(res);
    res.json(
      [...client.guilds.cache.values()].filter((guild) => canAccess(access, guild.id)).map((guild) => ({
        id: guild.id,
        name: guild.name,
        voiceChannels: [...guild.channels.cache.values()]
          .filter((c) => c.isVoiceBased() && c.joinable)
          .sort((a, b) => ('position' in a && 'position' in b ? a.position - b.position : 0))
          .map((c) => ({ id: c.id, name: c.name })),
      })),
    );
  });

  api.get('/me', (_req, res) => {
    res.json({ name: accessOf(res).name });
  });

  api.get('/state', (_req, res) => {
    const access = accessOf(res);
    res.json(manager.states().filter((s) => canAccess(access, s.guildId)));
  });

  api.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) throw new HttpError(400, 'Missing query parameter q');
    if (q.length > 200) throw new HttpError(400, 'q must be at most 200 characters');
    res.json(await search(q, 10));
  });

  api.post('/guilds/:gid/join', async (req, res) => {
    const player = guildPlayer(req, res);
    const { channelId } = body(req);
    if (typeof channelId !== 'string' || !channelId) throw new HttpError(400, 'channelId is required');
    const channel = client.guilds.cache.get(player.guildId)?.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) throw new HttpError(400, 'Not a voice channel of that server');
    if (!channel.joinable) throw new HttpError(400, "I don't have permission to join that voice channel");
    await player.join(channelId);
    res.json(player.getState());
  });

  api.post('/guilds/:gid/leave', (req, res) => {
    const player = guildPlayer(req, res);
    player.leave();
    res.json(player.getState());
  });

  api.post('/guilds/:gid/play', async (req, res) => {
    const player = guildPlayer(req, res);
    const { input, mode } = body(req);
    if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'input is required');
    if (input.length > 500) throw new HttpError(400, 'input must be at most 500 characters');
    if (mode !== 'now' && mode !== 'queue') throw new HttpError(400, "mode must be 'now' or 'queue'");
    if (player.getState().channelId === null) throw new HttpError(409, 'Join a voice channel first');
    let tracks;
    try {
      const text = input.trim();
      tracks = isSpotifyInput(text) ? await resolveSpotify(text) : await resolveInput(text);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (tracks.length === 0) throw new HttpError(404, 'Nothing found');
    // The player may have left while resolving.
    if (player.getState().channelId === null) throw new HttpError(409, 'Join a voice channel first');
    const added = player.enqueue(tracks, panelUser(res), mode === 'now');
    res.json({ added: added.length, state: player.getState() });
  });

  for (const action of ['pause', 'resume', 'skip', 'stop'] as const) {
    api.post(`/guilds/:gid/${action}`, (req, res) => {
      const player = guildPlayer(req, res);
      player[action]();
      res.json(player.getState());
    });
  }

  api.post('/guilds/:gid/volume', (req, res) => {
    const player = guildPlayer(req, res);
    const { volume } = body(req);
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new HttpError(400, 'volume must be a number between 0 and 100');
    }
    player.setVolume(volume);
    res.json(player.getState());
  });

  api.post('/guilds/:gid/loop', (req, res) => {
    const player = guildPlayer(req, res);
    const { mode } = body(req);
    if (mode !== 'off' && mode !== 'track' && mode !== 'queue') {
      throw new HttpError(400, "mode must be 'off', 'track' or 'queue'");
    }
    player.setLoop(mode as LoopMode);
    res.json(player.getState());
  });

  api.delete('/guilds/:gid/queue/:uid', (req, res) => {
    const player = guildPlayer(req, res);
    if (!player.remove(String(req.params.uid))) throw new HttpError(404, 'No such queue item');
    res.json(player.getState());
  });

  api.post('/guilds/:gid/queue/move', (req, res) => {
    const player = guildPlayer(req, res);
    const { uid, to } = body(req);
    if (typeof uid !== 'string' || !uid) throw new HttpError(400, 'uid is required');
    if (typeof to !== 'number' || !Number.isInteger(to) || to < 0) {
      throw new HttpError(400, 'to must be a non-negative integer');
    }
    if (!player.move(uid, to)) throw new HttpError(404, 'No such queue item');
    res.json(player.getState());
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  app.use(express.static(PUBLIC_DIR));

  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) return next(err);
    const e = err as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
    const raw = e?.status ?? e?.statusCode;
    const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
    const message = err instanceof Error ? err.message : typeof e?.message === 'string' ? e.message : String(err);
    if (status >= 500) console.error('[panel]', err);
    res.status(status).json({ error: message || 'Internal error' });
  };
  app.use(onError);

  const server = http.createServer(app);

  // ---------------------------------------------------------------- websocket
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakSet<WebSocket>();
  // Fixed at connect time; the panel reconnects after logging in to another server.
  const accessByWs = new WeakMap<WebSocket, Access>();

  const send = (ws: WebSocket, payload: unknown): void => {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[panel]', 'ws send failed', err);
    }
  };
  /** Send to every client whose login covers that server. */
  const broadcast = (guildId: string, payload: unknown): void => {
    for (const ws of wss.clients) {
      const access = accessByWs.get(ws);
      if (access && canAccess(access, guildId)) send(ws, payload);
    }
  };

  server.on('upgrade', (req, socket, head) => {
    try {
      const access = auth.checkUpgrade(req);
      if (!access) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        accessByWs.set(ws, access);
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      console.error('[panel]', 'upgrade failed', err);
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('message', () => {}); // server -> client only
    ws.on('error', () => {});
    try {
      const access = accessByWs.get(ws);
      const states = access ? manager.states().filter((s) => canAccess(access, s.guildId)) : [];
      send(ws, { type: 'snapshot', states });
      send(ws, { type: 'health', health: health.health });
    } catch (err) {
      console.error('[panel]', 'snapshot failed', err);
    }
  });

  const onState = (state: GuildPlayerState): void => broadcast(state.guildId, { type: 'state', state });
  const onTrackError = (guildId: string, item: QueueItem, message: string): void =>
    broadcast(guildId, { type: 'trackError', guildId, title: item.title, message });
  // Host-wide, so every login sees it: it affects whichever server they're listening in.
  const onHealth = (h: Health): void => {
    for (const ws of wss.clients) send(ws, { type: 'health', health: h });
  };
  manager.on('state', onState);
  manager.on('trackError', onTrackError);
  health.on('change', onHealth);

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, PING_INTERVAL_MS);
  pinger.unref();

  server.on('close', () => {
    clearInterval(pinger);
    manager.off('state', onState);
    manager.off('trackError', onTrackError);
    health.off('change', onHealth);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });

  // ---------------------------------------------------------------- listen
  await new Promise<void>((resolveListen, reject) => {
    const onListenError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Panel port ${port} on ${host} is already in use. Change PANEL_PORT or stop the other process.`));
      } else if (err.code === 'EADDRNOTAVAIL') {
        reject(new Error(`PANEL_HOST ${host} is not an address of this machine (wrong Tailscale IP, or Tailscale is down?).`));
      } else {
        reject(new Error(`Panel failed to listen on ${host}:${port}: ${err.message}`));
      }
    };
    server.once('error', onListenError);
    server.listen(port, host, () => {
      server.off('error', onListenError);
      resolveListen();
    });
  });
  server.on('error', (err) => console.error('[panel]', 'server error', err));

  const names = [...new Set(opts.users.map((u) => u.name))];
  console.log(
    `Panel: http://${host}:${port}/  (logins: ${[...names, ...(opts.serverPasswords.size ? [`${opts.serverPasswords.size} server password(s)`] : [])].join(', ')})`,
  );
  return server;
}
