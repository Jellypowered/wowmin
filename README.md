# WoW Admin – AzerothCore Admin Tool

A web-based server administration tool (Node.js + TypeScript) for an
[AzerothCore](https://www.azerothcore.org/) World of Warcraft server, using
SOAP and direct database access. It runs as a native Node.js service and is
accessed from a browser.

> This repository is a fork of
> [scarecr0w12/wowmin](https://github.com/scarecr0w12/wowmin) ("WoW Admin",
> v2.4.3 and earlier), by **Jellypowered**. Version 3.0.0 starts a
> new release line for this fork, focused on live worldserver telemetry,
> instance/battleground observation, and session recording. See
> [CHANGELOG.md](CHANGELOG.md).

## Features

### SOAP Console
- Connect to any AzerothCore worldserver with SOAP enabled
- Execute any server console command remotely
- Quick-command sidebar for common operations
- Command history (↑ / ↓ arrow keys)
- Color-coded success/error responses

### Database Editor 
- **SQL Query Editor** - Execute raw SQL queries with syntax highlighting
- **Table Browser** - View and edit any table in the database
- **Keira-style Entity Workspace** - A dedicated editor column, generated SQL panel, and side rail for live preview + related data
- **Entity Editors** - Specialized editors for:
  - Creatures (`creature_template`)
  - Items (`item_template`)
  - Quests (`quest_template`)
  - Spells (`spell_dbc`)
  - Game Objects (`gameobject_template`)
  - NPC Vendors (`npc_vendor`)
  - Loot Tables (`creature_loot_template`)
  - SmartAI Scripts (`smart_scripts`)
- **Live Preview Rail** - Quality-coloured preview cards, summary stats, quick lookup links, and in-app visual reference media for supported entities
- **Related Data Rail** - View vendor, loot, and quest-adjacent rows from the current entity and jump directly into those records
- **Smart Selectors** - Search-and-apply pickers for common creature/item/quest reference fields
- **Connection Profiles** - Save and switch between multiple database connections
- **Query History** - Track and re-run previous queries
- **Export to CSV** - Export query results to clipboard

### Live Map (Enhanced in 3.0.0)
- Real-time canvas map showing all online player positions
- **Live worldserver telemetry**: with the companion
  [`mod-wowmin-telemetry`](https://github.com/Jellypowered/mod-wowmin-telemetry) module
  installed, player positions, health/power, target, and combat state come
  straight from the worldserver every second instead of stale database saves;
  the characters database is used only as a fallback
- Continent switcher: Eastern Kingdoms, Kalimdor, Outland, Northrend
- Map backgrounds preserve their aspect ratio automatically to avoid stretching/deformation on resize
- Player dots colour-coded by WoW class; bot accounts dimmed; movement is interpolated so dots glide between telemetry polls
- **Click a dot or sidebar row to select a player** — shows name, level, race, class, and live coordinates without disturbing the camera, pan, or zoom
- Quick SOAP actions from the selection panel: Info, Freeze, Unfreeze, Summon, Kick, Ban
- Hover tooltip with player details
- Zoom controls with mouse wheel zoom, double-click zoom, drag-to-pan while zoomed, and quick reset back to `100%`
- Auto-refresh (1 s) with manual refresh; filter by real players, bots, or all, with bot detection resolved from account usernames when available
- Optional map image backgrounds: place `0.jpg`, `1.jpg`, `530.jpg`, `571.jpg` in `assets/maps/` (see `assets/maps/README.txt`)
- Shared race/gender portraits, class icons, and compact flag-carrier, taxi,
  mounted, combat, sap, stun, death, spirit-form, and resurrection indicators across Players,
  Live Map, and Instance Watch. Extracted client artwork is optional; generic
  emoji are used automatically when it is absent
- Requires a separate database connection to `acore_characters` unless live telemetry is active

### Instance / Battleground Watch (New in 3.0.0)
- Dedicated **Instance Watch** tab that discovers every active runtime instance,
  raid, battleground, and arena on the server, grouped by runtime instance ID
- Client artwork backgrounds for instances, raids, battlegrounds, and arenas
  extracted from the WoW client (including per-floor dungeon artwork for
  multi-floor instances), with stable projection bounds and letterboxing
- Live participant markers with faction colors, health bars, movement trails,
  headings, and combat indicators
- Participant rows with race/class artwork, compact live state icons, wrapped
  two-line status text, and Tank/Heal/DPS beside each dungeon/raid participant;
  roles use the core LFG assignment or `mod-playerbots` talent/gear inference
  for manually assembled groups. Emoji fallbacks preserve the same layout when
  client icons have not been extracted
- Battleground match state: phase, team scores, alive counts, decoded
  objectives (scores, captures, timers, flag state), and resurrection state;
  the active server-selected bot strategy is shown read-only when available
- Encounter state: boss state tracking and per-session death history
- Pan, anchored zoom, participant focus, and Fit view with per-session
  viewport persistence, so the view stays stable across polling
- Floor-aware dungeons: participants are classified onto the correct dungeon
  floor from WMO/height context and only that floor's markers and trails are
  shown
- Contextual sidebar order: battlegrounds show Active Sessions, Battleground,
  Participants, Bot Decisions, and Encounters; dungeons/raids hide only the
  Battleground card and keep the other cards visible with empty-state guidance

### 3D Instance Watch (New)
- An isometric 3D view of every instance, raid, battleground, and arena,
  built from the WoW 3.3.5a client: buildings, props, terrain with its
  texture layers, and water, lava, and slime; the flat map stays one click
  away (**3D** button) and is used wherever a scene isn't available
- Players and mobs drawn with their own game models (race, gear, druid forms,
  pets, mounts, vehicles and their passengers), animated walking, running,
  fighting, casting, sitting (to eat or drink), and dying, with floor rings
  showing side, combat, selection, and health
- Live from the companion module's UDP position stream (10 updates a second):
  smooth movement, mobs, bot paths and decisions (with `mod-playerbots`),
  battleground banners, flags, and doors, raid markers, and debuffs
- The client's own spell art for casts, missiles, impacts, channels, ground
  effects, auras, and chains (Chain Heal), with wand bolts in the wand's
  school and models coloured and made see-through as the client does it
  (Frostbolt's slow, Ice Block, Shadowform), plus floating combat numbers
- TidyPlates-style nameplates (Neon, Grey, or Quatre) with health, power, cast
  bars with spell names and icons, debuffs, threat, and battleground crests
- A party fade that keeps the floors and rooms around the party solid and
  fades the rest, by height and by distance, so multi-level dungeons stay
  readable; turned off, the whole map is shown, as suits battlegrounds. When
  flat-map mode is selected, 3D-only controls (fade ranges, render scale,
  plates, lighting, models, fade, and lights) are hidden
- Rotate (Q/E, or middle-drag to rotate and tilt freely), zoom about the
  pointer, and Follow a participant
- Built for battleground scale: in testing on a GeForce RTX 2060 SUPER, about
  25 fps with 80 players and 200 mobs and 20 to 25 fps for a busy Arathi Basin
  at 1600x1400; `?debug` on the page URL shows frame rate, draw calls, and
  stream rates

### Dungeon Clear
- Dedicated **Dungeon Clear** tab embeds the existing DC Test Deck from
  `mod-dungeon-clear`
- The deck runs independently and retains its own GM-account login, permissions,
  audit logging, and live test workflow
- The iframe URL is configurable with `WOWMIN_DUNGEON_CLEAR_URL` and otherwise
  defaults to the current browser hostname on port `8790`
- A reload control and direct-open fallback remain available when the deck is
  unavailable or its iframe allowlist is not configured

### Session History & Replay (New in 3.0.0)
- Completed instance, raid, battleground, and arena runs are recorded
  automatically to JSON files: participants, timestamped discrete events
  (kills, deaths, loot, level-ups, objective and flag transitions), running
  totals, and sampled movement routes
- Server-owned event IDs make kills, loot, and level-ups exact despite the
  1 s telemetry poll; routes sample every 5 s by default
- **Session history** tab with a browsable index, embedded replay panel, and
  playback controls (play, pause, stop, seek, and 0.5×–16× speed)
- Completed battlegrounds show the winning faction directly in the history
  list and replay header. Warsong Gulch shows its flag score, Eye of the Storm
  shows resource points, and other battlegrounds show the winner without a
  misleading generic scoreline
- Replay renders the map artwork with per-participant colored routes (broken
  across death/release/teleport jumps), a chronological event log, and running
  totals at the seek position
- Instance Watch includes a persisted **Record sessions** checkbox that is off
  by default on a new install. Turning it off discards recordings currently in progress without touching completed
  history; interrupted checkpoints are also purged at startup, and completed
  history is only removed by the explicit **Purge all** button

### Live telemetry – `mod-wowmin-telemetry`
- Live position/state telemetry is produced by the standalone companion module
  **`mod-wowmin-telemetry`** (a separate AzerothCore module that is not
  included in this repository). Install it into
  `azerothcore-wotlk/modules/mod-wowmin-telemetry`, build, and start the
  worldserver as usual (see below)
- It publishes a versioned `WMAP` protocol (v1–v7) via an administrator-only
  `wowmin telemetry [mapId] [instanceId]` SOAP command; older module versions
  are still parsed by this client for backward compatibility
- The module is independent of `mod-playerbots` (playerbot details are an
  optional, compile-time extension) and shares a single 1 s poll across the
  Live Map, Instance Watch, and session recorder, configurable via
  `WOWMIN_TELEMETRY_POLL_MS` (default 1000, minimum 500)
- For the 3D Instance Watch it also streams the watched instance over UDP at
  10 Hz (positions, roles, mobs, paths, appearances, combat events, auras,
  game objects, markers). Live-stream protocol v2 adds each participant's role
  mask while WoWMin retains v1 parsing. The stream runs only while a page is
  watching: WoWMin renews it every few seconds with the
  `wowmin stream <mapId> <instanceId>` SOAP command, and the module stops
  sending when renewals stop

### Economy Monitor
- Dedicated **Economy** tab for monitoring the live in-game auction house and character wealth
- Search active auction-house listings by item name, item entry, or owner name
- View per-item market averages including listing count, total quantity, average unit buyout, and min/max unit pricing
- Look up any character's current gold directly from the connected characters database
- Overview cards surface active auction counts, unique items listed, average buyout pricing, total realm gold, and the richest tracked character
- Uses the connected `acore_characters` database for auction and gold data, plus the matching world database name for item names and quality metadata

### Remote Log Monitor
- Connect to a remote AzerothCore host over SSH/SFTP
- Scan `worldserver.conf` to discover configured `Logger.*` and `Appender.*` definitions
- Resolve `LogsDir`, packet log paths, file-based appender targets, and dynamic `%s` log patterns
- Pick a logger first, then choose from the live readable files currently associated with that logger for a much cleaner in-app tail workflow
- Flag unreadable configured targets and preview the latest log output directly in-app
- Optional live follow mode refreshes the selected log preview every few seconds for a lightweight `tail -f` workflow
- Save remote log connection details and follow-mode settings as part of an existing connection profile
- Works with password-based SSH/SFTP access today

### Dashboard
- Server info at a glance (uptime, online players, peak)
- Quick actions for common server operations
- Activity log for tracking commands

### Player Management
- View online players with filtering and search
- Player level, race, and class populated automatically on list load
- Player details and moderation actions
- Kick, ban, mute, freeze, and more

### GM Tickets
- Dedicated **Tickets** tab for open, online, closed, and escalated GM tickets
- Ticket list parsing understands AzerothCore's colorized GM-ticket output and fills the player, created, and last-updated columns directly from the server response
- Selecting a ticket opens a structured detail panel with the ticket message, comment, and response when available
- Quick ticket actions for assign, unassign, comment, close, delete, escalate, and response management
- Optional auto-refresh keeps the queue current while connected

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** ≥ 20 | Required by Tailwind CSS v4's native build tooling; https://nodejs.org |
| **Modern browser** | Chrome/Edge 111+, Firefox 128+, or Safari 16.4+ (the Tailwind CSS v4 compatibility baseline) |
| **AzerothCore worldserver** | SOAP must be enabled (see below) |
| **MySQL/MariaDB** | For database editing features |
| **`mod-wowmin-telemetry`** | Optional but strongly recommended for live map/instance telemetry (see below) |
| **DC Test Deck** | Optional; commit `cd74fa3` or newer is required for the embedded Dungeon Clear tab (setup below) |
| **WoW 3.3.5a client files** | Only if you want map background artwork extracted locally |

### Live telemetry – `mod-wowmin-telemetry`

Live player positions, combat state, instance/battleground state, and session
recording all come from the standalone **`mod-wowmin-telemetry`** AzerothCore
module, which is a separate project and is not bundled in this repository.
Install it into
your AzerothCore source tree:

```bash
# clone the module into your AzerothCore source tree, e.g.
cd azerothcore-wotlk/modules
git clone https://github.com/Jellypowered/mod-wowmin-telemetry.git
# then rebuild and restart the worldserver
```

Once it is running, the module registers the administrator-only SOAP command:

```
wowmin telemetry [mapId] [instanceId]
```
There is no need to actually issue that command, WoWmin handles using it on it's own. 

No worldserver configuration changes are required for the 1 s telemetry.
Without the module, the Live Map falls back to saved database positions
(stale between character saves) and the Instance Watch / Session History tabs
have no live data.

The 3D Instance Watch's live stream is off by default. Enable it in the
module's `mod-wowmin-telemetry.conf`, pointing it at the machine WoWMin runs
on:

```ini
WowMinTelemetry.Stream.Enable = 1
# Where WoWMin listens (WOWMIN_STREAM_HOST / WOWMIN_STREAM_PORT); an IP address
WowMinTelemetry.Stream.Host = "127.0.0.1"
WowMinTelemetry.Stream.Port = 7979
```

With a module that has no stream (or with it disabled), Instance Watch keeps
working on the 1 s telemetry: the flat map, or the 3D scene with markers in
place of models, and no mobs, paths, spell art, or combat numbers.

### Enable SOAP on your worldserver

In your `worldserver.conf`, set:

```ini
SOAP.Enabled  = 1
SOAP.IP       = "127.0.0.1"
SOAP.Port     = 7878
```

You also need an account with security level **3** (or higher) to
authenticate. You can set this in the `account` table or with:

```
.account set sec <account> 3
```

### Database Access

For database editing features, you need MySQL/MariaDB credentials with read/write
access to your AzerothCore databases:

- `acore_world` - World database (creatures, items, quests, etc.)
- `acore_auth` - Auth database (accounts, permissions)
- `acore_characters` - Characters database (player data)

The **Economy** tab uses the `acore_characters` database for auction-house and character-money data, and derives the matching world database name (for example `acore_world`) to resolve item names and quality.

## Getting Started

```bash
# Install dependencies
npm install

# Build TypeScript and Tailwind CSS
npm run build

# Run validation (no worldserver or client required)
npm run typecheck
npm test

# Configure the environment, then start the web service
npm start
```

## Web Service

Build the UI, set HTTP Basic Authentication credentials, and start the Node.js
service:

```bash
npm ci
npm run build

export WOWMIN_HOST=0.0.0.0
export WOWMIN_PORT=3000
export WOWMIN_USERNAME=admin
export WOWMIN_PASSWORD='replace-with-a-strong-password'
export WOWMIN_DATA_DIR="$PWD/.wowmin-data"
npm start
```

Instead of exporting them, you can put these settings in a file (one
`NAME=value` per line). The web service reads them at startup, in this order of
precedence:

1. variables already set in the environment (an export, or a systemd unit's
   `EnvironmentFile`);
2. the system file: `/etc/wowmin.env`, or `%ProgramData%\wowmin\wowmin.env` on
   Windows;
3. `.env` in the project root (kept out of git), as the fallback.

Keep these files private (`chmod 600`), as they hold passwords.

Open `http://server-address:3000/` and sign in with the configured HTTP
credentials. The browser UI provides SOAP, database, map, economy, inventory,
profile, and remote-log APIs. Because those APIs include raw
SQL and server administration commands, do not expose the service without
authentication; use a TLS reverse proxy when access crosses an untrusted
network.

A hardened systemd unit template is provided at `deploy/wowmin.service.example` (copy it to
`/etc/systemd/system/wowmin.service`, adjust the install path, and
`systemctl daemon-reload`). It
expects `/etc/wowmin.env` to define the variables above and stores profiles in
`/var/lib/wowmin` when `WOWMIN_DATA_DIR=/var/lib/wowmin` is set. Set
`WOWMIN_MODEL_CACHE_DIR=/var/lib/wowmin/models` so generated client assets use
the service's writable state directory. Start from
[`deploy/wowmin.env.example`](deploy/wowmin.env.example).

For server-managed connections, set all three of `WOWMIN_SOAP_USERNAME`,
`WOWMIN_SOAP_PASSWORD`, and `WOWMIN_DB_PASSWORD` in the environment. The Node
service then owns the shared SOAP, world DB, characters map DB, and economy DB
connections; browsers only consume their status and cannot disconnect them for
other users. Unavailable services do not prevent startup, retry with bounded
backoff, and are health-checked so runtime outages can recover. Credential forms remain hidden, saved profiles are disabled in managed
mode, and logs are read locally rather than through browser-supplied SSH
credentials. The remaining settings are:

```ini
WOWMIN_SOAP_HOST=127.0.0.1
WOWMIN_SOAP_PORT=7878
WOWMIN_DB_HOST=127.0.0.1
WOWMIN_DB_PORT=3306
WOWMIN_DB_USERNAME=acore
WOWMIN_WORLD_DB=acore_world
WOWMIN_CHARACTERS_DB=acore_characters
WOWMIN_ECONOMY_DB=acore_characters
# Optional per-service host/port/username/password overrides:
# WOWMIN_WORLD_DB_HOST / _PORT / _USERNAME / _PASSWORD
# WOWMIN_CHARACTERS_DB_HOST / _PORT / _USERNAME / _PASSWORD
# WOWMIN_ECONOMY_DB_HOST / _PORT / _USERNAME / _PASSWORD
WOWMIN_CONNECTION_RETRY_INITIAL_MS=5000
WOWMIN_CONNECTION_RETRY_MAX_MS=60000
WOWMIN_CONNECTION_HEALTH_MS=30000
WOWMIN_WORLD_CONFIG=/path/to/azerothcore/env/dist/etc/worldserver.conf
WOWMIN_LOG_DIR=/path/to/azerothcore/env/dist/bin
# Optional override; default is http(s)://<current-browser-host>:8790/
WOWMIN_DUNGEON_CLEAR_URL=http://server-address:8790/
```

Live telemetry and session recording settings (all optional):

```ini
# Shared poll interval for Live Map, Instance Watch, and session recording (ms, min 500)
WOWMIN_TELEMETRY_POLL_MS=1000
# How often movement routes are sampled into session records (ms)
WOWMIN_SESSION_ROUTE_INTERVAL_MS=5000
# How long a vanished session must stay absent before it is finalized (ms)
WOWMIN_SESSION_COMPLETION_GRACE_MS=15000
```

The 3D Instance Watch reads the module's live stream on a UDP port, and draws
players, mobs, spell art, and icons from a WoW 3.3.5a client's `Data` folder.
Each model, spell's art, and icon is built from the client files the first
time it is seen (in a worker process) and cached under
`WOWMIN_MODEL_CACHE_DIR`. When that variable is unset, the cache remains under
`assets/models/` (not in git). A cache version bump rebuilds the files. Without
the client folder the 3D scene still draws, with markers in place of models.
The scenes themselves are generated once with the extractor (see
[Generating 3D scenes](#generating-3d-instance-scenes)).

```ini
# Where the module's stream arrives (match WowMinTelemetry.Stream.Host/Port)
WOWMIN_STREAM_HOST=127.0.0.1
WOWMIN_STREAM_PORT=7979
# A WoW 3.3.5a client's Data folder, for unit models, spell art, and icons
WOWMIN_CLIENT_DATA=/path/to/WoW/Data
# Optional cache location; recommended for the hardened systemd service
WOWMIN_MODEL_CACHE_DIR=/var/lib/wowmin/models
```

Completed session records use readable names such as `WSG-3-Oct08-26.json` and are kept indefinitely
under `$WOWMIN_DATA_DIR/sessions/`; only the explicit **Purge all** button in the
Session history tab deletes them. Abandoned checkpoints from crashes are
removed automatically at startup.

Each per-service database setting falls back to the shared `WOWMIN_DB_*`
value, preserving existing single-host installations while supporting split
hosts and credentials. During an outage, SOAP and database-backed features
degrade independently; Live Map retains the latest telemetry snapshot and the
Dashboard/Players views use SOAP rather than repeatedly probing a known-offline
characters database.

Keep `/etc/wowmin.env` mode `0600` and restart the service after edits.

## Dungeon Clear / DC Test Deck setup

WoWMin embeds the existing Test Deck; it does not install or start it. Test
Deck remains a separate service from
`azerothcore-wotlk/modules/mod-dungeon-clear/testdeck` and requires:

- Python 3.9 or newer
- a `mysql`/`mysql.exe` client
- a built and running worldserver with `mod-dungeon-clear`
- SOAP enabled in `worldserver.conf`
- a dedicated SOAP bridge account with GM level 3
- game accounts with GM level 1 or higher for Test Deck login

Follow Test Deck's own README for the authoritative setup. Test Deck Setup is NOT covered here. 

Test Deck commit `cd74fa3` or newer supports secure, opt-in direct iframe
embedding. Keep its normal port `8790` and add the exact
browser-visible WoWMin origin to the generated `testdeck.toml`:

```toml
[server]
host = "0.0.0.0"
port = 8790
allowed_frame_ancestors = ["http://server-address:3000"]
```

An allowed origin has no trailing slash or path. Its scheme, hostname, and
port must exactly match the address used to open WoWMin.

If WoWMin is opened as
`http://192.168.1.20:3000/`, for example, configure
`"http://192.168.1.20:3000"`. 

If WoWMin is opened as
`http://127.0.0.1:3000/`, for example, configure
`"http://127.0.0.1:3000"`.

Multiple exact origins may be listed when needed.
If Test Deck reports `forbidden: unexpected Host header` when reached through
a hostname, add that hostname to `[server] allowed_hosts` as described in Test
Deck's README.

If users connect from another computer, allow TCP port `8790` through the host
firewall. On Ubuntu with UFW use `sudo ufw allow 8790/tcp`; on a
Fedora/RHEL-family host use `sudo firewall-cmd --permanent --add-port=8790/tcp`
followed by `sudo firewall-cmd --reload`. On Windows, run this in an
Administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "DC Test Deck" `
  -Direction Inbound -Protocol TCP -LocalPort 8790 `
  -Action Allow -Profile Private
```

Verify the configured framing headers after restarting Test Deck:

```bash
# Linux / macOS
curl -I http://127.0.0.1:8790/

# Windows PowerShell or Command Prompt
curl.exe -I http://127.0.0.1:8790/
```

The response must omit `X-Frame-Options` and its `Content-Security-Policy`
`frame-ancestors` directive must contain the exact WoWMin origin. Open
`http://server-address:8790/` directly to verify login, then open WoWMin's
**Dungeon Clear** tab.

If WoWMin uses HTTPS, Test Deck must also be served over HTTPS or the browser
will block it as mixed content. Test Deck's `SameSite=Strict` login cookie also
requires WoWMin and Test Deck to share a site; using the same hostname on ports
`3000` and `8790` is the simplest setup. Set `WOWMIN_DUNGEON_CLEAR_URL` only
when Test Deck is not available from the browser at the default
`http(s)://<WoWMin-host>:8790/` URL.

### Dungeon Clear troubleshooting

| Symptom | What to check |
|---|---|
| Test Deck opens directly but the iframe is blank | Confirm `allowed_frame_ancestors` exactly matches the WoWMin address bar origin, has no trailing slash, and Test Deck was restarted after editing its configuration. |
| The response still has `X-Frame-Options: DENY` | The allowlist is empty or the wrong Test Deck configuration file is being loaded. Run `python3 -m testdeck check` and restart it. |
| Browser reports mixed content | WoWMin is HTTPS but Test Deck is HTTP. Serve Test Deck over HTTPS and set `WOWMIN_DUNGEON_CLEAR_URL` to that URL. |
| Login succeeds and immediately returns to login | Open WoWMin and Test Deck with the same hostname/site, not `localhost` for one and a LAN address for the other. |
| Test Deck reports an unexpected Host header | Add the browser-visible Test Deck hostname to `[server] allowed_hosts`, or use an address printed in its startup banner. |
| Remote users cannot connect to `8790` | Check the firewall rule and confirm Test Deck is listening with `ss -ltnp` on Linux or `netstat -ano | findstr :8790` on Windows. |

## Usage

### SOAP Connection
1. Enter the **Host**, **Port**, **Username**, and **Password** in the
   connection bar.
2. Click **Connect** — the app will run `server info` to verify the connection.
3. Type commands in the console input or use the **Quick Commands** sidebar.
4. Press **Enter** or click **Send** to execute.

### Database Connection
1. Navigate to the **Database** tab.
2. Select the database type (World, Auth, or Characters).
3. Enter your MySQL connection details.
4. Click **Connect** to establish the database connection.
5. Use the table browser to explore tables, or use the SQL editor for queries.
6. Open the **Entity Editor** when you want a richer Keira-style workflow for template records instead of raw rows.

### Entity Editor
1. In the Database tab, switch to the **Entity Editor** subtab.
2. Select an entity type (Creature, Item, Quest, etc.).
3. Enter the entry/ID and click **Load**.
4. Use the form editor for field groups, the generated SQL panel for diff/full query review, and the right-side preview rail for quick validation.
5. Use selector buttons on supported reference fields to search for linked items, creatures, or quests without leaving the editor.
6. Review the **Related Data** panel to inspect nearby vendor/loot/reward rows and jump directly into linked records.
7. Edit fields and click **Save** to commit changes.

#### Entity Editor highlights

- **Live Preview** updates while you edit, including item quality colouring and richer item/creature/quest summary cards
- **Visual Reference Media** is fetched into the preview rail for supported entities so you can sanity-check what you loaded without leaving the app
- **Related Data** helps you move through connected rows faster when working on loot, vendors, or quest rewards
- **Quick links** let you open external references such as Wowhead in your default browser when deeper research is needed

### Live Map
1. Navigate to the **Live Map** tab.
2. If `mod-wowmin-telemetry` is running on the connected worldserver, positions come live automatically. Otherwise enter the `acore_characters` MySQL connection details in the map connection bar and click **Connect** (saved, between-saves positions).
3. Players on the selected continent appear as coloured dots (class colours) on the canvas.
4. Use the continent buttons to switch between Eastern Kingdoms, Kalimdor, Outland, and Northrend.
5. **Click a dot** or a row in the sidebar to select a player — a panel appears with their details and quick action buttons (Info, Freeze, Unfreeze, Summon, Kick, Ban). Actions are sent via the active SOAP connection. Selecting a player does not move the camera, pan, or zoom.
6. Use the mouse wheel or **double-click** to zoom into the map; drag to pan while zoomed, or click the zoom percentage control to reset to `100%`.
7. Optionally place map image files (`0.jpg`, `1.jpg`, `530.jpg`, `571.jpg`) in `assets/maps/` for visual map backgrounds (see `assets/maps/README.txt`). The app preserves the image aspect ratio automatically.
8. To generate those from a WoW 3.3.5a client, run `npm run extract:maps -- --source /path/to/WoW` or point it at an extracted `World/Minimaps` folder. The standalone `--` tells npm to forward the remaining arguments unchanged.
9. Optionally extract race/gender portraits, class icons, and player-state icons with `npm run extract:icons -- --source /path/to/WoW`. If skipped, WoWMin uses emoji fallbacks.

### Instance / Battleground Watch
1. Navigate to the **Instance Watch** tab (keyboard shortcut **Alt+7**). Active runtime instances, raids, battlegrounds, and arenas are discovered automatically and appear as cards in the sidebar; nothing to configure beyond a SOAP connection.
2. Switch the **Session** dropdown to inspect another session; **Auto (1 s)** keeps the selected session fresh, with a full re-discovery every 10 s. Refreshes never replace or move an actively used dropdown.
3. The map pane uses extracted client artwork when available (with per-floor dungeon artwork for multi-floor dungeons), otherwise calibrated or auto-fit bounds.
4. **Click a participant marker or sidebar row** to focus the view on them; **Fit** restores a view that fits everyone, **−**/**+** zoom around the cursor, and **Clear focus** releases the focused participant.
5. Battleground cards are ordered Active Sessions, Battleground, Participants, Bot Decisions, Encounters. Dungeon/raid cards are ordered Active Sessions, Participants, Encounters, Bot Decisions; only Battleground is hidden, and cards without current data remain visible with an explanation.
6. The participant list shows live players and bots even during database fallback, with race/class artwork, state icons, a stable two-line wrapped status, and Tank/Heal/DPS beside dungeon/raid names. Roles prefer the core LFG assignment and fall back to `mod-playerbots` classification for manually assembled groups. Without extracted icons the same layout uses emoji fallbacks.
7. Where a 3D scene has been generated, the map opens in 3D (the **3D** button switches back to the flat map). **Q**/**E** rotate by a quarter turn; middle-drag or Shift+drag rotates and tilts freely; the compass under the buttons shows where north is; the scroll wheel zooms about the pointer.
8. **Fade** keeps the area around the party solid and fades the rest; **Height fade** and **Horizontal fade** set how far. Turn **Fade** off to see a whole battleground. **Render scale** lowers the 3D resolution on slow GPUs. These and the other 3D-only controls are hidden while flat-map mode is selected.
9. **Mobs** (Near party, All, Off), **Plates** (Neon, Grey, Quatre, or plain Labels), and the **Follow**, **Trails**, **Paths**, **Decisions**, **Models**, and **Numbers** toggles choose what is drawn; each remembers its setting per browser.
10. **Record sessions**, below the heading, is off by default when no saved preference exists and persists across service restarts. Unchecking it deletes active checkpoints but leaves every completed session file in place.
11. Add `?debug` to the page URL for a frame-rate, draw-call, and stream-rate overlay, and open `/spell-preview` to play any spell's client art on test models.

### Dungeon Clear
1. Add WoWMin's exact origin to Test Deck's
   `[server] allowed_frame_ancestors`, then start Test Deck on its normal port
   `8790`.
2. Navigate to the **Dungeon Clear** tab. WoWMin hides its connection header and
   gives the embedded deck the full workspace.
3. Log in inside Test Deck with a game account whose GM level meets Test Deck's
   `[auth] min_gmlevel` setting (default 1).
4. Use Test Deck normally to launch, watch, stop, and review runs. WoWMin does
   not replace Test Deck's authentication or command bridge.
5. Use **Reload** after restarting Test Deck. Use **Open directly** when the
   frame stays blank so the Test Deck or configuration error is visible in its
   own tab.

### Session history & replay
1. Navigate to the **Session history** tab (keyboard shortcut **Alt+9**). Completed runs from `$WOWMIN_DATA_DIR/sessions/` are loaded at startup and remain available without a SOAP, worldserver, or database connection.
2. **Click a record** to load it into the embedded replay panel.
3. Use **Play**, **Pause**, **Stop**, the seek slider, and the speed selector (0.5×–16×) to scrub through the run. Routes are drawn incrementally per participant, the event log follows the playhead, and the running totals reflect the seek position.
4. **Purge all** permanently deletes every completed session record after a confirmation prompt; it does not affect in-progress recordings. Abandoned checkpoints are already removed automatically at startup.

> **Replay fidelity:** server-reported events (kills, loot, level-ups) are exact. Objective and flag transitions derived from telemetry snapshots reflect poll timing, and routes are sampled (default every 5 s), so movement between samples is interpolated rather than recorded.

### Remote Log Monitor
1. Navigate to the **Logs** tab.
2. Enter the remote SSH host, port, username, password, and the remote `worldserver.conf` path.
3. Click **Scan Remote Logs** to inspect `LogsDir`, appenders, loggers, packet log settings, and readable files.
4. Review the summary cards and warnings to spot unreadable configured paths, missing dynamic log matches, or directory access issues.
5. Use the **Logger** picker to choose the subsystem you want to inspect, then choose one of its currently available **Live File** entries.
6. Review the file details panel to confirm the resolved path, timestamp, size, and matched appender hints before loading the preview.
7. Enable **Live follow** if you want the preview to auto-refresh like a lightweight in-app `tail -f`, then choose the refresh interval that fits your server.
8. Save the connection profile if you want those remote log settings remembered alongside your SOAP/database details.

### Economy Monitor
1. Navigate to the **Economy** tab.
2. Enter the `acore_characters` MySQL connection details and click **Connect**.
3. Review the overview cards to see active auctions, unique listed items, average buyout values, and total character gold.
4. Use the search field to find auction-house rows by item name, numeric item entry, or owner name.
5. Review **Average Market Values** for quick per-item pricing averages and **Auction House Listings** for the live individual rows behind that market.
6. Use **Character Gold Lookup** to inspect the money held by a specific character.

### GM Tickets
1. Navigate to the **Tickets** tab while connected to SOAP.
2. Use the filter buttons to switch between **Open**, **Online**, **Closed**, and **Escalated** ticket queues.
3. Click a ticket row to open the detail panel and review the player, created age, last change, and ticket message.
4. Use the inline row buttons or the forms below the table to assign, comment, escalate, close, delete, or manage ticket responses.
5. Enable **Auto (30s)** if you want the ticket queue to refresh periodically while connected.

#### Economy monitor notes

- Auction data comes from the AzerothCore `auctionhouse` and `item_instance` tables in the connected characters database.
- Item names and quality colours are resolved from the matching world database's `item_template` table.
- Search supports both fuzzy text matching and direct numeric item-entry lookup.

#### Remote log monitor notes

- The current remote log workflow uses **username/password SSH/SFTP authentication**.
- The app reads `worldserver.conf` remotely and infers log file locations from `LogsDir`, `Appender.*`, and `PacketLogFile`.
- Dynamic file appenders such as `gm_%s.log` are matched against the current contents of the resolved logs directory.
- Logger-to-file matching is resolved in-app, so the live file picker only shows files currently associated with the selected logger instead of every readable file in the logs directory.
- Live follow pauses automatically when you leave the **Logs** tab, so it does not keep polling in the background unnecessarily.

### Extracting player and state icons

WoWMin can use the race/gender portraits, class atlas, and state/spell icons
from your own WoW 3.3.5a client:

```bash
npm run extract:icons -- --source "/path/to/WoW 3.3.5a"
```

The command reads MPQ patches in client precedence order and writes local PNGs
plus `assets/player-icons/index.json`. These derived files are gitignored and
are not distributed with WoWMin. Without the index—or when older telemetry does
not provide state fields—the interface uses generic emoji. Older telemetry
without gender uses the extracted male race portrait until v6 is deployed.
Lists stack up to three states by priority; map markers show only the
highest-priority state so simultaneous effects remain readable. Live Map and
Instance Watch provide synchronized, persisted 75–250% icon-size controls;
canvas icons also grow progressively as the map is zoomed.

### Extracting map backgrounds from the WoW client

You can now generate the live-map backgrounds directly from WoW minimap tiles:

```bash
# From a WoW 3.3.5a client root (the extractor now reads WoW MPQs directly; external tools are only a fallback)
npm run extract:maps -- --source "/path/to/WoW 3.3.5a"

# Without the separator, npm value options require equals syntax
npm run extract:maps --source="/path/to/WoW 3.3.5a"

# Or from an already extracted World/Minimaps directory
npm run extract:maps -- --source "/path/to/World/Minimaps"
```

The extractor stitches the continent tiles and writes these files into `assets/maps/`:

- `0.jpg` — Eastern Kingdoms
- `1.jpg` — Kalimdor
- `530.jpg` — Outland
- `571.jpg` — Northrend

To regenerate only Outland/map 530 without touching the other continents:

```bash
npm run extract:maps -- --source "/path/to/WoW" --map 530 --output ./assets/maps
```

Map 530 includes detached starting-zone islands. Some client `common.MPQ`
textures contain opaque white/grey padding around their edges; the extractor
removes those pixels only for exact audited source texture hashes on map 530.
It preserves real water pixels, image dimensions, and tile-coordinate bounds.
Different replacement textures and artwork on other maps are not filtered.

Useful flags:

- `--output /custom/dir` to write somewhere else
- `--quality 95` to tweak JPEG quality
- `--keep-workspace` to keep the raw extracted minimap tiles
- `--workspace ./tmp/minimaps` to control where temporary extraction files go

On Linux, note that some patch MPQs may be malformed or some minimap tiles may be corrupt in patched clients. The extractor now skips unreadable archives/tiles when possible and continues building the continent JPGs. If built-in extraction still cannot resolve your client, `7zz` remains a useful fallback, or you can extract `World/Minimaps` manually and point `--source` there.

### Extracting instance, raid, battleground, and arena artwork

The same extractor produces the artwork used by the Instance Watch tab:

```bash
# One map
npm run extract:maps -- --source "/path/to/WoW" --map 489

# Every instance, raid, battleground, and arena (recommended once)
npm run extract:maps -- --source "/path/to/WoW" --all-instances
```

### Generating 3D instance scenes

The 3D Instance Watch draws each map from a scene (`assets/instances/<mapId>.glb`
plus its manifest `<mapId>.scene.json`, not in git) exported from the client by
a separate command. It does not need the flat artwork above, and the flat
artwork does not need it: either can be re-run on its own.

```bash
# One map
npm run extract:scenes -- --source "/path/to/WoW" --map 529

# Every instance, raid, battleground, and arena (about 1.5 GB, 15 to 20 minutes)
npm run extract:scenes -- --source "/path/to/WoW" --all-instances
```

A scene holds the map's buildings and their props, the props placed on the
map, and the terrain and liquids of the area players use (each dungeon floor,
or the world map's bounds), with props sharing a model drawn instanced. Every
map with client map files gets a scene, with or without flat artwork. Re-run
the export after upgrading WoWMin if the release notes say the scene format
changed; maps without a scene use the flat map.

To check that a change to one export leaves the other alone, export into a
fresh folder and compare it with the previous one; 2D and 3D differences are
reported separately:

```bash
npm run check:exports -- ./assets/instances ./instances-new
```

#### Classic/TBC dungeon artwork with WDM patches

For proper classic/TBC dungeon floor plans rather than stitched exterior
minimaps, install the optional [WDM client patches](https://github.com/Trimitor/WDM-patch)
into your own client's `Data/<locale>/` before extracting:

- `patch-<locale>-M.MPQ`: dungeon artwork, floor-coordinate bounds, and
  WMO-group/Z floor membership tables.
- `patch-<locale>-N.MPQ`: optional outdoor caves/entrances and area overrides;
  the patch author requires M plus the WDM/Astrolabe addons for these in-game maps.

Then run the same `--all-instances` command above. The extractor loads lettered
patches after numbered patches (N after M), uses `WorldMapArea.dbc` directory
aliases to find the artwork, and reads the patched `DungeonMap.dbc` and
`DungeonMapChunk.dbc` tables. WoWMin uses those bounds and its existing telemetry
WMO-group/Z floor selector; it does **not** run or require addon Lua at runtime.

WDM supplies in-game navigation/UI for the optional microdungeons, while
Astrolabe supplies marker-position translation. Those outdoor microdungeon
menus and the client's native fallback/transform rules are not fully reproduced
by WoWMin's instance viewer. Individual floor transitions still need in-game
comparison; having the artwork does not by itself prove exact client parity.

Patch artwork remains locally extracted, not bundled in this repository.

Outputs go to `assets/instances/` (`<mapId>.jpg`, per-floor
`<mapId>-floor-<n>.jpg`, plus JSON metadata and an `index.json`). These
artifacts are **not committed** to this repository (they are large and derived
from the client), so run the extractor once on your own machine. Maps without
directly extractable artwork fall back to calibrated or auto-fit bounds and a
plain background.

## Project Structure

```
wow-admin/
├── package.json
├── tsconfig.json           # TypeScript configuration
├── tailwind.config.js      # Tailwind CSS configuration
├── esbuild.config.js       # Build configuration
├── src/
│   ├── web-server.ts       # Authenticated HTTP service and static-file server
│   ├── api-backend.ts      # SOAP, database, telemetry, and session API handlers
│   ├── api-router.ts       # Internal API channel dispatcher
│   ├── dungeon-clear-config.ts # Test Deck URL and CSP configuration
│   ├── soap-client.ts      # SOAP/HTTP client for AzerothCore
│   ├── live-map-telemetry.ts # WMAP protocol (v1–v7) parser + command builder
│   ├── session-recorder.ts # Session recording, persistence, index, purge
│   ├── local-logs.ts       # Local (non-SSH) log discovery for web mode
│   ├── config-store.ts     # Profile persistence
│   ├── database/
│   │   └── db-service.ts   # MySQL database service
│   └── types/
│       └── api.ts          # Shared API and domain types
├── renderer/
│   ├── index.html          # App UI
│   ├── styles.css          # Base styling
│   ├── styles/
│   │   ├── tailwind.css    # Tailwind input
│   │   └── output.css      # Generated CSS
│   └── scripts/
│       ├── app.ts          # Main frontend logic (SOAP, DB, map, instances, replay)
│       ├── web-api.ts      # Browser fetch implementation of the API surface
│       ├── types/
│       │   ├── state.ts    # Application state types
│       │   └── wowmin-api.ts # Browser API contract
│       └── utils/
│           ├── helpers.ts  # Utility functions
│           ├── map-coords.ts # WoW coordinate conversion utilities
│           ├── instance-watch.ts # Instance grouping, floors, bounds, projection
│           ├── session-replay.ts # Replay route/event/total math
│           ├── player-icons.ts # Shared extracted-icon and emoji fallback logic
│           └── online-players.ts # Online-player parsing helpers
├── assets/
│   ├── maps/               # Optional continent map backgrounds (0.jpg, 1.jpg, 530.jpg, 571.jpg)
│   ├── instances/          # Optional instance/raid/BG/arena artwork (extracted locally)
│   └── player-icons/       # Optional client portraits/class/state icons (extracted locally)
├── scripts/
│   ├── extract-map-assets.mjs # WoW minimap/worldmap/dungeon-floor extractor
│   ├── extract-player-icons.mjs # WoW portrait/class/state icon extractor
│   └── test-*.cjs          # Self-contained test suites (npm test)
├── deploy/
│   ├── wowmin.service.example # Hardened systemd unit template
│   └── wowmin.env.example     # Environment configuration sample
└── dist/                   # Compiled output
```

## Testing

The repository ships a self-contained test suite that needs no worldserver,
client, or database:

```bash
npm test          # runs all scripts/test-*.cjs with node:test
npm run typecheck # tsc --noEmit over the whole project
```

Coverage includes the managed connection lifecycle (serialized startup,
degraded services, retry/recovery, and shutdown), telemetry protocol parser
(versions 1–7, rejection of truncated/unknown snapshots), command building, session grouping and
battleground decoding, map projection math (continents, calibrated
battlegrounds, minimap tiles, dungeon floors, pan/zoom/fit), the session
recorder (persistence, deduplication, checkpoint purge, explicit history
purge), and replay route/event math.

## Development

```bash
# Type checking
npm run typecheck

# Build TypeScript (watch mode)
npm run build:ts:watch

# Build Tailwind CSS (watch mode)
npm run build:css:watch

# Build once and start the local web service
npm run dev
```

## Building for deployment

```bash
npm ci
npm run build
npm run typecheck
npm test
```

Deploy the repository with production dependencies and the generated `dist/`
files, then run `npm start`. Tagged GitHub releases use GitHub's automatic
source archives; this project does not produce platform-specific installers.

## Technology Stack

- **Node.js HTTP server** - Authenticated web service
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS** - Utility-first CSS framework
- **mysql2** - MySQL client with Promise support
- **esbuild** - Fast TypeScript bundler

## Inspiration

This project was inspired by [Keira3](https://github.com/azerothcore/Keira3),
an excellent database editor for AzerothCore. WoW Admin combines similar database
editing capabilities with SOAP console functionality for a complete server
administration toolkit.

## License

MIT
