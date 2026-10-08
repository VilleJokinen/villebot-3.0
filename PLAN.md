# VilleBot 3.0: build plan

Single Node.js process (TypeScript via `tsx`, no build step). Discord bot, player and web panel share one `PlayerManager` instance; the panel calls it directly.

```
src/
  index.ts            entry: checkBinaries → loadConfig → Client → PlayerManager → bot → panel → login   (C7)
  config.ts           .env loading/validation                                                            (done)
  ytdlp.ts            yt-dlp/ffmpeg: checkBinaries, search, resolve, AudioStream                          (C1)
  player/
    types.ts          shared types (contract)                                                            (done)
    GuildPlayer.ts    per-guild queue/playback/voice connection                                          (C2)
    PlayerManager.ts  guild → GuildPlayer map, event fan-in, voiceStateUpdate handling                   (C2)
    index.ts          re-exports                                                                         (C2)
  bot/
    commands.ts       slash command definitions (SlashCommandBuilder)                                    (C3)
    register.ts       `npm run register`: PUT guild commands                                             (C3)
    index.ts          createBot(client, manager): interaction handling + error reporting                 (C3)
  panel/
    auth.ts           PANEL_TOKEN check (query → cookie), WS upgrade auth                                (C4)
    server.ts         startPanel(...): Express REST API + static + ws broadcast                          (C4)
public/
  index.html, style.css, app.js    vanilla, phone-width first                                             (C5)
README.md                                                                                                 (C6)
scripts/villebot.ps1  Windows launcher: tray icon (NotifyIcon), console start, stop, Startup-folder autostart
start.cmd, stop.cmd   double-click wrappers
```

## Verified facts (2026-10-08)

- `@discordjs/voice` 0.19.2 README: Node ≥ 22.12. DAVE (E2EE) lib `@snazzah/davey` ships as a dependency. Encryption lib only needed if `aes-256-gcm` is missing from node:crypto (it isn't on Node 22). Opus: `@discordjs/opus` (installed as optional, native) with `opusscript` (pure JS) as fallback. FFmpeg on PATH.
- yt-dlp 2026.x needs a JS runtime for YouTube; only deno is enabled by default. Always pass `--js-runtimes node:<process.execPath>`.
- Verified pipeline: `yt-dlp --js-runtimes node:$NODE -f bestaudio/best --no-playlist -q --no-warnings -o - URL | ffmpeg -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1` → raw PCM. Killing it produces a "Broken pipe" error from yt-dlp; it must be ignored after kill().

## Conventions (all chunks)

- ESM, `import ... from './x.js'` (NodeNext). `npm run typecheck` must pass.
- Never throw out of event handlers / timers. Log with `console.error('[module]', ...)`.
- No new dependencies without a reason. Installed: discord.js, @discordjs/voice, opusscript, @discordjs/opus (optional), express 5, ws, dotenv, tsx, typescript.

## Contracts

### C1 `src/ytdlp.ts`
Signatures are fixed in the stub (`TrackInfo`, `checkBinaries`, `search`, `resolve`, `AudioStream`).
- Spawn with argument arrays, never a shell (no injection via query). Use `shell: false`, `windowsHide: true`.
- `search`: `yt-dlp ytsearch<N>:<query> --flat-playlist --dump-json` (one JSON per line). Thumbnail: last entry of `thumbnails` or `https://i.ytimg.com/vi/<id>/hqdefault.jpg`. Timeout 30 s.
- `resolve`: URL detection for youtube.com / youtu.be / music.youtube.com. Playlist: `--flat-playlist --dump-json` (cap 200 entries, skip `[Private video]`/`[Deleted video]`). Single video: `--dump-json --no-playlist --skip-download`. Error messages: take the `ERROR:` line from stderr, strip the `[youtube] id:` prefix.
- `AudioStream`: yt-dlp stdout → ffmpeg stdin; `stream` = ffmpeg stdout. Collect stderr (bounded) for error messages. kill(): SIGKILL both, unpipe, destroy streams, swallow EPIPE. No 'error' after kill().

### C2 `src/player/`
`class PlayerManager extends EventEmitter<PlayerEvents>`:
- `constructor(client: Client)`; listens to `voiceStateUpdate` (empty channel detection, bot moved/kicked).
- `get(guildId): GuildPlayer` (creates lazily; throws if the bot isn't in that guild), `all(): GuildPlayer[]`, `states(): GuildPlayerState[]`, `destroyAll()`.

`class GuildPlayer`:
- `readonly guildId`, `textChannelId: string | null` (bot sets it on /play so errors get reported there).
- `join(channelId): Promise<void>` (joinVoiceChannel with `selfDeaf: true`, wait Ready 20 s, subscribe AudioPlayer). Moving channels = join again.
- `leave(): void` (stop + destroy connection; queue cleared).
- `enqueue(tracks: TrackInfo[], requestedBy: string, playNow = false): QueueItem[]`. playNow: insert at queue front and skip current. Starts playback if idle and connected.
- `skip()`, `stop()` (clear queue + current, stay connected), `pause(): boolean`, `resume(): boolean`, `setVolume(0-100)`, `setLoop(mode)`, `remove(uid): boolean`, `move(uid, toIndex): boolean`, `getState(): GuildPlayerState`.
- Playback: `new AudioStream(url)` → `createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true })`, volume = v/100 (default 50). Keep the AudioStream; kill it on skip/stop/leave/track end.
- Advance on AudioPlayerStatus.Idle respecting loop (track: replay same item, new uid not needed; queue: push finished item to the back).
- Failure (AudioStream 'error', AudioPlayer 'error', or a track that goes Idle in < 1 s with an error recorded): emit `trackError`, advance. Guard against loop=track infinite retry on a broken track: a failed track is never replayed.
- Voice disconnect handling: the documented pattern (on Disconnected: race entersState Signalling/Connecting 5 s; else destroy and reset state).
- Timers: leave after 5 min with nothing playing (no current track); leave 30 s after the channel has no non-bot members (cancel if someone rejoins).
- Emit `state` on every change (manager re-emits). Don't emit position ticks; the panel interpolates.

### C3 `src/bot/`
- Commands: /play query:<string, required> · /skip · /pause · /resume · /stop · /queue · /np · /volume level:<int 0-100> · /join · /leave. `setDMPermission(false)` / contexts guild-only.
- `register.ts`: uses loadConfig() but only needs DISCORD_TOKEN, CLIENT_ID, GUILD_ID; `REST.put(Routes.applicationGuildCommands(...))`. Must not import the player or start the client.
- `createBot(client: Client, manager: PlayerManager): void`: interaction handler. /play: caller must be in a voice channel; join it if not connected (or if in a different channel and nothing is playing); `deferReply()` before resolve; reply with what was queued (playlist: count). Sets `player.textChannelId`. /join joins caller's channel. Replies are short; errors are ephemeral. Listens for `trackError` and posts `⚠️ Skipped **title**: message` to `textChannelId` (catch send failures). Every handler wrapped in try/catch that replies/edits with the error.

### C4 `src/panel/`
`startPanel(opts: { host, port, token, client: Client, manager: PlayerManager }): Promise<http.Server>`.

Auth (`auth.ts`):
- Every HTTP request incl. static files: if `?token=` equals PANEL_TOKEN (crypto.timingSafeEqual on equal-length buffers) → set cookie `vb_panel=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` and 302 to the same URL minus `token`. Else require that cookie. Otherwise 401 text: "Unauthorized. Open the panel with ?token=<PANEL_TOKEN> once."
- WS upgrade on `/ws`: same cookie check, and `Origin` must match `http://<Host>`; else write `HTTP/1.1 401` and destroy.
- Mutating API routes require `Content-Type: application/json`.

REST (JSON, errors → `{ error: string }` with 4xx/5xx; never crash):
| Method | Path | Body | Result |
|---|---|---|---|
| GET | /api/guilds | | `[{ id, name, voiceChannels: [{ id, name }] }]` (voice + stage channels the bot can Connect to) |
| GET | /api/state | | `GuildPlayerState[]` |
| GET | /api/search?q= | | `TrackInfo[]` (10) |
| POST | /api/guilds/:gid/join | `{ channelId }` | state |
| POST | /api/guilds/:gid/leave | | state |
| POST | /api/guilds/:gid/play | `{ input, mode: 'now' \| 'queue' }` | `{ added: number, state }`, resolve() handles URL/playlist/search text. 409 if not connected. |
| POST | /api/guilds/:gid/pause, /resume, /skip, /stop | | state |
| POST | /api/guilds/:gid/volume | `{ volume }` | state |
| POST | /api/guilds/:gid/loop | `{ mode }` | state |
| DELETE | /api/guilds/:gid/queue/:uid | | state |
| POST | /api/guilds/:gid/queue/move | `{ uid, to }` | state |

WebSocket `/ws`, server → client JSON only:
- on connect: `{ type: 'snapshot', states: GuildPlayerState[] }`
- `{ type: 'state', state: GuildPlayerState }` on manager `state`
- `{ type: 'trackError', guildId, title, message }` on manager `trackError`
- ping every 30 s, terminate dead sockets.

Static: `public/` via express.static after auth.

### C5 `public/`
Vanilla HTML/CSS/JS, no framework, no CDN. Usable at 360 px. Sections: guild + voice channel picker with Join/Leave; now playing (thumbnail, title, channel, progress bar interpolated from positionMs/sampledAt, play/pause, skip, stop, volume slider debounced, loop cycle off/track/queue); search box + paste-URL (same input: URL → play directly, text → search) with results (thumbnail, title, channel, duration, "Play now" / "Add to queue"); queue (remove, drag-to-reorder with Pointer Events so it works on touch, plus up/down buttons as fallback); toast for errors. Reconnects WS with backoff. Remembers selected guild in localStorage. On 401 show "open with ?token=".

### C6 `README.md`
Discord dev portal setup, scopes `bot` + `applications.commands`, permissions Connect + Speak + Send Messages (+ View Channel) → permission integer, invite URL format, .env example, yt-dlp + ffmpeg install on Windows (winget) and macOS (brew), `npm install`, `npm run register`, `npm run dev`, panel access (token URL, Cloudflare Tunnel), `yt-dlp -U` note, troubleshooting.

### C7 integration (Opus)
`src/index.ts`, global `unhandledRejection`/`uncaughtException` logging, graceful SIGINT/SIGTERM (destroy connections, kill children), end-to-end run, fixes.

## Waves (max 2 workers at once)
1. C1 ytdlp + C2 player
2. C3 bot + C4 panel server
3. C5 panel frontend + C6 README
4. C7 integration + verification (Opus)
