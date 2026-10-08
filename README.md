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
5. **Bot** tab: with **Public Bot** off, only you can add the bot to servers (you need Manage Server there). Turn it on if friends should be able to add it to their own servers.
6. **Installation** (or **OAuth2 > URL Generator**): scopes `bot` and `applications.commands`. Bot permissions: View Channels, Connect, Speak, Send Messages, Set Voice Channel Status.

   Permission integer: `1<<10` (ViewChannel) + `1<<11` (SendMessages) + `1<<20` (Connect) + `1<<21` (Speak) + `1<<48` (SetVoiceChannelStatus) = 1024 + 2048 + 1048576 + 2097152 + 281474976710656 = **281474979859456**.

   Set Voice Channel Status lets the bot show the current song and the next one in the voice channel's status line, plus a warning when the host PC can't keep up (see [Performance warnings](#performance-warnings)). It is optional; without it the bot plays normally and logs one warning.

7. Invite URL (replace `<CLIENT_ID>`), open it and add the bot to each server you want it in:

   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=281474979859456
   ```

## Configuration

Copy `.env.example` to `.env` and fill it in:

```
DISCORD_TOKEN=
CLIENT_ID=

PANEL_HOST=127.0.0.1
PANEL_PORT=3000
PANEL_PASSWORD_123456789012345678=
PANEL_PASSWORD=
PANEL_USERS=
PANEL_URL=
```

| Variable | Meaning |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Bot tab. Required. |
| `CLIENT_ID` | Application ID. Required. |
| `PANEL_HOST` | Address the panel binds to. Default `127.0.0.1`. |
| `PANEL_PORT` | Panel port, 1-65535. Default `3000`. |
| `PANEL_PASSWORD_<serverId>` | Password that unlocks one server in the panel, at least 8 characters. Add one line per server. `/link` in that server shows it. |
| `PANEL_PASSWORD` | Owner password that unlocks every server, at least 8 characters. Optional; `/link` never shows it. |
| `PANEL_USERS` | Personal logins that unlock every server: `name:token,name:token`. Tokens at least 16 characters, each different. Optional. |
| `PANEL_TOKEN` | A token login named `owner`, at least 16 characters. Optional. |

At least one login of any kind is required. Generate a token with:

```
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```
| `PANEL_URL` | Public panel address that `/link` sends, e.g. `https://my-pc.tail1234.ts.net`. Optional; without it `/link` says the link isn't set up. |

To get a server ID: in Discord, User Settings > Advanced > enable **Developer Mode**, then right-click the server icon > **Copy Server ID**. Or run `/link` in that server: without a password it replies with the exact line to add.

`GUILD_ID` is no longer used. If it's still in `.env`, `npm run register` removes the old server-only commands there once (so they don't show up twice); after that you can delete it.

Never commit `.env`.

## Running

```
npm install
npm run register     # once, and again whenever the command definitions change
npm run dev          # tsx watch: restarts on file changes
npm start            # plain run, no watching
```

`npm run register` registers the commands globally, so they work in every server the bot is in, including servers added later. It only needs `DISCORD_TOKEN` and `CLIENT_ID`. If commands don't show up right away, restart Discord (Ctrl+R).

On startup the bot validates `.env` (missing variable, `PANEL_PASSWORD` shorter than 8 characters, bad `PANEL_USERS`, `PANEL_PORT` or `PANEL_URL` all exit with a message naming the problem), then checks that `yt-dlp` and `ffmpeg` run (if either is missing it prints install instructions and exits), starts the panel, and logs in to Discord. A healthy start looks like:

```
[startup] yt-dlp 2026.08.19, ffmpeg ffmpeg version 7.1 ...
Panel: http://127.0.0.1:3000/
[discord] logged in as VilleBot#1234; servers: My Server
```

Set `VOICE_DEPS_REPORT=1` to also print the `@discordjs/voice` dependency report (opus library, encryption, DAVE).

### Windows: tray icon launcher

Instead of keeping a terminal open, you can run the bot in the background with an icon in the taskbar. It also runs `tailscale funnel --bg <PANEL_PORT>` before starting the bot, so the panel link (see [Sharing it with friends](#sharing-it-with-friends-tailscale-funnel)) is up too.

1. **Start:** double-click `start.cmd` in the project folder. No window opens.
2. **Find the icon:** click the **^** arrow at the right end of the taskbar and look for the round blue **V**. Drag it onto the taskbar to keep it visible.
3. **Use it:**
   - Double-click the icon to open the panel (`PANEL_URL`, or `http://127.0.0.1:<PANEL_PORT>/` without it).
   - Right-click for **Open panel**, **Open log**, **Restart bot** (**Start bot** when it's stopped), **Stop bot** and **Exit**.
   - Blue means the bot is running, grey means stopped.
4. **Stop:** right-click the icon > **Exit** (stops the bot and removes the icon). `stop.cmd` also works, however the bot was started, including `npm run dev` in a terminal. The funnel stays configured either way.

Notifications:

- **"VilleBot stopped"**: the bot exited on its own. Right-click > **Open log** to see why, fix it, then **Start bot**.
- **"Panel link is down"**: Tailscale isn't running or isn't connected. Checked at startup and every minute. The bot keeps working in Discord; open the Tailscale app and connect to bring the link back.
- **"Audio may stutter"**: this PC can't keep up with playback. The message says why and what to try; see [Performance warnings](#performance-warnings). Shown at most every 10 minutes; while it lasts, the tray menu's status line says "audio lagging".

Output goes to `villebot.log` in the project folder. Only one copy runs at a time: if the panel port is already in use, `start.cmd` says so and does nothing.

**Start automatically at Windows login** (run once in the project folder):

```
powershell -ExecutionPolicy Bypass -File scripts\villebot.ps1 autostart-on
```

This adds a `VilleBot` shortcut to your Startup folder (Win+R, `shell:startup`), so the tray icon, funnel and bot start every time you log in. To turn it off:

```
powershell -ExecutionPolicy Bypass -File scripts\villebot.ps1 autostart-off
```

If you move the project folder, run `autostart-on` again so the shortcut points at the new location.

To watch the bot's output live in a console instead of the tray (the funnel still starts):

```
powershell -ExecutionPolicy Bypass -File scripts\villebot.ps1 start
```

## Control panel

Open `http://<PANEL_HOST>:<PANEL_PORT>/` (default `http://127.0.0.1:3000/`) and enter a password. A server's password shows and controls only that server: its queue, player and live updates. Other servers stay invisible, and the API answers "Unknown server" for them. The owner password (`PANEL_PASSWORD`) and personal tokens (`PANEL_USERS`, `PANEL_TOKEN`) show every server.

Personal tokens can be typed into the login screen, or sent as a link that logs in directly: `https://<panel>/?token=<token>`. The token is removed from the address bar right away. With a personal login, the top bar shows the name, tracks queued from the panel show it as "Requested by", and every change made in the panel is logged with it (`[panel] alex POST /api/guilds/.../skip`). Server-password logins show up as `panel`. To revoke one person, remove their `PANEL_USERS` entry and restart.

The login lasts 30 days (HttpOnly cookie). One browser can be logged in to several servers: opening a `/link` URL for a server you're not logged in to asks for that server's password and keeps the others. **Log out** in the top bar ends all of them on that device. Changing a password and restarting logs out everyone who used it. Give each server a different password; two servers with the same password are unlocked together.

### Sharing it with friends (Tailscale Funnel)

Funnel gives the panel a public HTTPS address, so friends only need the link and the password. No Tailscale account or app is needed on their side.

1. Install Tailscale on the machine that runs the bot (https://tailscale.com/download) and sign in.
2. In the Tailscale admin console, **DNS** page: enable **MagicDNS** and **HTTPS Certificates**.
3. Keep `PANEL_HOST=127.0.0.1` in `.env`. On the bot machine run:

   ```
   tailscale funnel --bg 3000
   ```

   (use your `PANEL_PORT` if it isn't 3000). The first run may ask you to allow Funnel in the admin console. `--bg` keeps it running across reboots. On Windows, the [tray launcher](#windows-tray-icon-launcher) runs this for you on every start.
4. `tailscale funnel status` shows the public URL (`https://<machine>.<tailnet>.ts.net`). Put it in `.env` as `PANEL_URL` and restart the bot.
5. In Discord, `/link` replies with the panel link and that server's password. Only the person who ran it sees the reply. The link opens the panel with that server selected.

To stop sharing: `tailscale funnel --bg 3000 off`.

Security:

- The panel is on the public internet. The passwords are the only thing protecting it, and anyone in a server can get that server's password with `/link`. Use passwords you don't use anywhere else. Keep the owner password to yourself.
- Wrong passwords are slowed down (1 second each). After 20 wrong tries in 15 minutes, all logins pause until older failures drop out of that window. People who are already logged in are not affected. The bot logs a warning when this happens.
- If a password leaks, change it in `.env` and restart. Everyone who used it is logged out.
- Don't bind `PANEL_HOST` to `0.0.0.0` and don't port-forward the panel. Funnel already provides HTTPS without opening ports on your router.
- Enabling HTTPS certificates publishes the machine name in public certificate-transparency logs, so don't use a sensitive machine name.
- GitHub Pages or any other static host won't work for the panel. It must be served by the bot itself: the API is same-origin with a SameSite=Strict cookie.

## Behaviour

- `/play` joins your voice channel. If the bot is playing in a different channel, `/play` refuses and tells you which channel to join; if it is idle, it moves to yours.
- Tracks advance automatically.
- The bot leaves after 5 minutes with nothing playing, or 30 seconds after the last human leaves its channel.
- A track that fails (unavailable, age-restricted, region-locked, yt-dlp error) is skipped. The error is posted in the text channel where `/play` was last used, and shown in the panel.
- Loop modes: `off`, `track` (repeat current), `queue` (finished tracks go to the back). A failed track is never repeated.
- Volume is per server, defaults to 50, and resets on restart. Queues are in memory too. There is no database, by design.
- Playlists are capped at 200 entries; private and deleted videos are skipped.

### Performance warnings

While something is playing, the bot checks every 5 seconds whether listeners are likely hearing stutter:

- **Host lagging**: the bot sends a voice packet every 20 ms. If those go out more than 50 ms late, the PC is too busy (a game, a build, a video export). Close heavy programs.
- **Slow download**: the bot keeps about 10 seconds of audio buffered ahead. If that drops under 1 second, audio is arriving slower than it plays. Check the PC's internet connection. If the CPU is above 85% at the same time, it counts as "Host lagging" instead.

After 10 seconds of either, the voice channel status gets a prefix like `⚠️ Host lagging · 🎶 Song`, so listeners know it's the host and not their connection, and the control panel shows a warning banner to every login. The log gets a `[health] warn: ...` line with the details and CPU usage, which the [tray launcher](#windows-tray-icon-launcher) shows as a notification. The warning clears after 30 seconds without problems, or when playback stops.

## Project layout

```
src/index.ts       entry: check binaries, load config, start client, bot and panel
src/config.ts      .env loading and validation
src/ytdlp.ts       yt-dlp/ffmpeg wrapper: binary check, search, resolve, AudioStream
src/health.ts      playback health monitor (event loop delay, audio buffer, CPU)
src/player/        PlayerManager (guild -> GuildPlayer, voice events) and GuildPlayer (queue, playback, timers)
src/bot/           slash command definitions, register script, interaction handlers
src/panel/         Express REST API, WebSocket broadcast, password login
public/            panel frontend (vanilla HTML/CSS/JS)
scripts/villebot.ps1  Windows launcher: tray icon, console start, stop, autostart on/off
start.cmd, stop.cmd   double-click wrappers for villebot.ps1
PLAN.md            build plan and interface contracts
```

## Troubleshooting

- **Slash commands don't appear:** run `npm run register`, then restart Discord (Ctrl+R); make sure the bot was invited with the `applications.commands` scope (re-invite with the URL above).
- **Every command shows up twice:** old server-only commands are still registered. Put that server's ID in `.env` as `GUILD_ID` and run `npm run register` once.
- **Bot joins but no sound:** check `ffmpeg -version` works in the same terminal; update yt-dlp; check the bot has Connect and Speak in that channel; check the bot isn't server-muted and volume isn't 0.
- **Tracks fail with "Sign in to confirm you're not a bot", 403 or similar:** update yt-dlp (see above).
- **`no such option: --js-runtimes`:** yt-dlp is too old; update it.
- **`@discordjs/opus` fails to install:** it is an optional native dependency. The bot falls back to `opusscript` (pure JS) automatically; slightly more CPU, otherwise fine.
- **Panel keeps showing the login screen:** the password changed or the 30-day login expired; log in again.
- **A server is missing from the panel:** you're logged in with another server's password. Open that server's `/link` URL, or use the owner password. "Too many wrong passwords" clears within 15 minutes, or immediately when the bot restarts.
- **`/link` says the link isn't set up:** set `PANEL_URL` in `.env` and restart. If it says the server has no password, add the `PANEL_PASSWORD_<serverId>` line it shows and restart.
- **Panel won't start (address error):** `PANEL_HOST` isn't an address on this machine. Set it back to `127.0.0.1`.
- **`start.cmd` says something is already listening on the port:** the bot is already running (maybe from autostart or a terminal). Use the tray icon or `stop.cmd` first.
- **Tray icon doesn't appear:** look under the ^ arrow in the taskbar. If it's not there, run `powershell -ExecutionPolicy Bypass -File scripts\villebot.ps1 start` to see the error in a console.
- **Tray icon stays after `stop.cmd`:** a leftover image; it disappears when you hover over it.
- **`Cannot find module ...`:** run `npm install`.
- **Node version error / syntax errors on startup:** `node --version` must be >= 22.12.
