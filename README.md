# VilleBot 3.0

Private, self-hosted Discord music bot with a local web control panel. One Node process (TypeScript run directly with `tsx`, no build step) hosts the Discord bot, the audio player and the panel. Audio comes from YouTube via `yt-dlp` piped into `ffmpeg`.

## Features

Slash commands (guild-only):

| Command | Description |
|---|---|
| `/play query` | Search text, YouTube URL or playlist URL. Joins your voice channel, plays now or queues. |
| `/skip` | Skip the current track. |
| `/pause`, `/resume` | Pause / resume playback. |
| `/stop` | Stop playback and clear the queue (stays in the channel). |
| `/queue` | Show the current track and the next 10 queued. |
| `/np` | Current track with progress, volume, requester. |
| `/volume level` | Set volume, 0-100. |
| `/join` | Join your voice channel. |
| `/leave` | Leave the voice channel (clears the queue). |

Control panel (web UI, phone-friendly):

- Guild and voice channel picker with Join / Leave
- Search box and paste-URL/playlist input (URL plays directly, text shows search results)
- Queue with remove and drag-to-reorder (touch works)
- Now playing with thumbnail and progress bar
- Play/pause, skip, stop, volume, loop off / track / queue
- Live sync over WebSocket; Discord commands and the panel always show the same state

## Requirements

- Node.js >= 22.12 (required by `@discordjs/voice` 0.19)
- `yt-dlp` and `ffmpeg` on `PATH`

yt-dlp needs a JavaScript runtime to extract from YouTube. The bot passes `--js-runtimes node:<path to the running node>` automatically, so you do not need to install deno. That flag needs a recent yt-dlp (2025.11 or later). If you see `no such option: --js-runtimes`, update yt-dlp.

## Installing yt-dlp and ffmpeg

Windows:

```
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Alternative: `scoop install yt-dlp ffmpeg`. Reopen the terminal afterwards so `PATH` updates, then verify:

```
yt-dlp --version
ffmpeg -version
```

macOS:

```
brew install yt-dlp ffmpeg
```

**Keep yt-dlp updated.** YouTube changes break old versions regularly. Most "track failed", "Sign in to confirm you're not a bot" and HTTP 403 errors are fixed by updating:

- Standalone install: `yt-dlp -U`
- winget: `winget upgrade yt-dlp.yt-dlp`
- brew: `brew upgrade yt-dlp`

## Discord setup

1. Open https://discord.com/developers/applications and create a **New Application**.
2. On the General Information page, copy the **Application ID**. This is `CLIENT_ID`.
3. **Bot** tab: **Reset Token** and copy it. This is `DISCORD_TOKEN`. Keep it secret; anyone with it controls the bot. If it leaks, reset it again.
4. **Bot** tab, Privileged Gateway Intents: leave all off. The bot only uses the `Guilds` and `GuildVoiceStates` intents; it reads no message content.
5. **Bot** tab: turn **Public Bot** off, since this is a private bot.
6. **Installation** (or **OAuth2 > URL Generator**): scopes `bot` and `applications.commands`. Bot permissions: View Channels, Connect, Speak, Send Messages.

   Permission integer: `1<<10` (ViewChannel) + `1<<11` (SendMessages) + `1<<20` (Connect) + `1<<21` (Speak) = 1024 + 2048 + 1048576 + 2097152 = **3148800**.

7. Invite URL (replace `<CLIENT_ID>`), open it and add the bot to your server:

   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=3148800
   ```

8. `GUILD_ID`: in Discord, User Settings > Advanced > enable **Developer Mode**. Right-click your server icon > **Copy Server ID**.

## Configuration

Copy `.env.example` to `.env` and fill it in:

```
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=

PANEL_HOST=127.0.0.1
PANEL_PORT=3000
PANEL_USERS=ville:<token>,alex:<token>
```

| Variable | Meaning |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Bot tab. Required. |
| `CLIENT_ID` | Application ID. Required. |
| `GUILD_ID` | Server ID that slash commands are registered in. Required. |
| `PANEL_HOST` | Address the panel binds to. Default `127.0.0.1`. |
| `PANEL_PORT` | Panel port, 1-65535. Default `3000`. |
| `PANEL_USERS` | Panel logins, `name:token` pairs separated by commas. Each person gets their own token (at least 16 characters, all different). Names: letters, digits, `_ . -`. |
| `PANEL_TOKEN` | Optional shorthand for one login named `owner`. At least one of `PANEL_USERS` / `PANEL_TOKEN` is required. |

Generate a token:

```
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Never commit `.env`.

## Running

```
npm install
npm run register     # once, and again whenever the command definitions change
npm run dev          # tsx watch: restarts on file changes
npm start            # plain run, no watching
```

`npm run register` registers the commands to the single guild in `GUILD_ID`, so they show up immediately (global commands can take up to an hour). It only needs `DISCORD_TOKEN`, `CLIENT_ID` and `GUILD_ID`.

On startup the bot validates `.env` (missing variable, a panel token shorter than 16 characters or reused between users, bad `PANEL_PORT` all exit with a message naming the problem), then checks that `yt-dlp` and `ffmpeg` run (if either is missing it prints install instructions and exits), starts the panel, and logs in to Discord. A healthy start looks like:

```
[startup] yt-dlp 2026.08.19, ffmpeg ffmpeg version 7.1 ...
Panel: http://127.0.0.1:3000/?token=abcd…
[discord] logged in as VilleBot#1234; servers: My Server
```

Set `VOICE_DEPS_REPORT=1` to also print the `@discordjs/voice` dependency report (opus library, encryption, DAVE).

## Control panel

Open once:

```
http://<PANEL_HOST>:<PANEL_PORT>/?token=<your token>
```

For the defaults: `http://127.0.0.1:3000/?token=<your token>`. The server stores the token in an HttpOnly cookie (30 days) and redirects to the URL without `?token=`. Every HTTP request and the WebSocket connection require that cookie (or the token).

Phone access via Tailscale (recommended: `tailscale serve`, free on the Personal plan):

1. Install Tailscale on the host machine and the phone and log both in to the same tailnet.
2. Keep `PANEL_HOST=127.0.0.1` in `.env`. The panel stays bound to localhost; Tailscale proxies to it.
3. On the host run:

   ```
   tailscale serve --bg 3000
   ```

   (use your `PANEL_PORT` if it isn't 3000). The first run asks you to enable MagicDNS and HTTPS certificates for the tailnet in the admin console. `--bg` keeps it running across reboots; `tailscale serve status` shows the URL, `tailscale serve reset` removes it.
4. On the phone (Tailscale connected), open `https://<machine>.<tailnet>.ts.net/?token=<your token>` once. After that the cookie is set and the plain URL works. Add it to your home screen.

This gives you a real HTTPS certificate, reachable only from devices in your tailnet. Enabling HTTPS certificates publishes the machine name and tailnet DNS name in public certificate-transparency logs, so don't use a sensitive machine name.

Alternative without `serve`: set `PANEL_HOST` to the host's Tailscale IP (`tailscale ip -4`) and open `http://<tailscale-ip>:<PANEL_PORT>/?token=<your token>`. That's plain HTTP, but still encrypted by Tailscale's WireGuard tunnel.

### Sharing with friends

Everyone in your Discord server can already use the slash commands. To give a friend the panel too:

1. Generate a token for them and add it to `.env`, e.g. `PANEL_USERS=ville:<token>,alex:<token>`, then restart the bot.
2. In the Tailscale admin console, Machines, open the bot machine's menu, choose **Share**, and send them the invite link. They install Tailscale, sign in with their own account and accept. They can reach only that machine, not the rest of your tailnet. Machine sharing works on the free plan.
3. Send them `https://<machine>.<tailnet>.ts.net/?token=<their token>`.

The panel header shows who is signed in, tracks they add show their name as the requester, and every panel action is logged to the console as `[panel] alex POST /api/guilds/.../skip`. To cut someone off, remove their `PANEL_USERS` entry and restart, and/or revoke the share in Tailscale.

### Security

- Do not bind to `0.0.0.0`, don't port-forward the panel, and don't use `tailscale funnel` (that exposes it to the public internet).
- Anyone with a valid token fully controls the bot. Revoke or rotate one person by removing or changing their `PANEL_USERS` entry and restarting; only their cookie stops working.
- If `PANEL_HOST` is not an address of the machine (for example Tailscale is down, so its IP does not exist), the panel fails to start with an error.
- GitHub Pages or any other static host won't work for the panel. It must be served by the bot itself: the API is same-origin with a SameSite=Strict cookie, and an HTTPS page can't call a plain-HTTP bot anyway.

## Behaviour

- `/play` joins your voice channel. If the bot is playing in a different channel, `/play` refuses and tells you which channel to join; if it is idle, it moves to yours.
- Tracks advance automatically.
- The bot leaves after 5 minutes with nothing playing, or 30 seconds after the last human leaves its channel.
- A track that fails (unavailable, age-restricted, region-locked, yt-dlp error) is skipped. The error is posted in the text channel where `/play` was last used, and shown in the panel.
- Loop modes: `off`, `track` (repeat current), `queue` (finished tracks go to the back). A failed track is never repeated.
- Volume is per server, defaults to 50, and resets on restart. Queues are in memory too. There is no database, by design.
- Playlists are capped at 200 entries; private and deleted videos are skipped.

## Project layout

```
src/index.ts       entry: check binaries, load config, start client, bot and panel
src/config.ts      .env loading and validation
src/ytdlp.ts       yt-dlp/ffmpeg wrapper: binary check, search, resolve, AudioStream
src/player/        PlayerManager (guild -> GuildPlayer, voice events) and GuildPlayer (queue, playback, timers)
src/bot/           slash command definitions, register script, interaction handlers
src/panel/         Express REST API, WebSocket broadcast, token auth
public/            panel frontend (vanilla HTML/CSS/JS)
PLAN.md            build plan and interface contracts
```

## Troubleshooting

- **Slash commands don't appear:** run `npm run register`; check `GUILD_ID` is the right server; make sure the bot was invited with the `applications.commands` scope (re-invite with the URL above). `Missing Access` from the register script means the bot is not in that guild or lacks that scope.
- **Bot joins but no sound:** check `ffmpeg -version` works in the same terminal; update yt-dlp; check the bot has Connect and Speak in that channel; check the bot isn't server-muted and volume isn't 0.
- **Tracks fail with "Sign in to confirm you're not a bot", 403 or similar:** update yt-dlp (see above).
- **`no such option: --js-runtimes`:** yt-dlp is too old; update it.
- **`@discordjs/opus` fails to install:** it is an optional native dependency. The bot falls back to `opusscript` (pure JS) automatically; slightly more CPU, otherwise fine.
- **Panel shows 401 / "Unauthorized":** open the panel with your `?token=` link again (cookie expired, or your token was changed or removed).
- **Panel won't start (address error):** `PANEL_HOST` isn't an address on this machine; with Tailscale, make sure it is running and `tailscale ip -4` matches.
- **`Cannot find module ...`:** run `npm install`.
- **Node version error / syntax errors on startup:** `node --version` must be >= 22.12.
