# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Fork notice:** v2.4.3 and earlier belong to the original project
([scarecr0w12/wowmin](https://github.com/scarecr0w12/wowmin)). This repository
is a fork maintained by Jellypowered; **v3.0.0 starts the new release line for
the fork** and adds live worldserver telemetry, instance/battleground watch,
and session recording built on the separate `mod-wowmin-telemetry` module.

## [Unreleased]

### Added

- Added a full-workspace **Dungeon Clear** tab that directly embeds DC Test Deck through its origin-allowlisted iframe support, with reload and direct-open fallbacks.
- Added cross-platform setup and troubleshooting instructions plus an environment sample for the independent Test Deck service.
- Paused Session Replay now shows a compact, human-readable recorded-information card when hovering a bot marker; clicking the bot pins the card until another replay element is clicked.
- Session History now persists and prominently displays battleground outcomes. Warsong Gulch records the final flag score, Eye of the Storm records final resource points, and other battlegrounds and arenas identify the winner; replay logs include a match-result event.
- Added protocol v6 player gender and compact taxi, mounted, sap, stun, and Spirit of Redemption state telemetry, plus protocol v7 authoritative Warsong/Silverwing/Netherstorm flag-carrier state. Shared race/gender portraits, class icons, and prioritized state indicators appear across Players, Live Map, Instance Watch, and replay.
- Added `npm run extract:icons` to extract client-owned portrait, class, and state BLP artwork into gitignored local PNG assets; generic emoji remain the zero-setup fallback.
- **3D Instance Watch**: an isometric 3D view of instances, raids, battlegrounds, and arenas built from the WoW 3.3.5a client (buildings, instanced props, textured terrain, and liquids), with quarter-turn and free rotation, a compass that turns and tilts with the view, zoom about the pointer, Follow, and a party fade by height and distance; the flat map remains as a toggle and fallback.
- **Live position stream**: Instance Watch reads `mod-wowmin-telemetry`'s 10 Hz UDP stream (`wowmin stream`, `WOWMIN_STREAM_HOST`/`WOWMIN_STREAM_PORT`) for smooth movement, mobs (near party, all, or off), bot paths and decisions, appearances, combat events, auras, debuffs, raid markers, passengers, and game objects. Without it, Instance Watch works as before on the 1 s telemetry.
- **Unit models**: players and mobs are drawn with their game models (race, gear, druid forms, pets, mounts, vehicles and passengers), animated by stance (including sitting to eat or drink), built on demand from `WOWMIN_CLIENT_DATA` in a worker and cached under `assets/models/`.
- **Spell art**: the client's own cast, missile, impact, channel, ground, and aura effects, chains between targets (Chain Heal, Chain Lightning), wand bolts in the wand's school, a steady area on the floor round the bearer of an aura that keeps casting an area spell (Starfall), and the client's own model colours and see-through looks (Frostbolt's slow, Ice Block, Shadowform, a Shadowfiend), plus floating combat numbers; `/spell-preview` plays any spell's art on test models.
- **Nameplates**: Neon, Grey, and Quatre plates with health, power, cast bars with spell names and icons, debuffs, threat, raid markers, and battleground crests.
- **Scene export**: `npm run extract:scenes -- --source /path/to/WoW --all-instances` writes a 3D scene and its manifest per map to `assets/instances/`, cropped to the area players use, with repeated props GPU-instanced. It is independent of the flat-map extraction (`extract:maps`): both read the client's map tables themselves, and `npm run check:exports` compares two export folders with 2D and 3D differences reported separately.
- **World lighting** in the 3D view, from the client: each map's own light (its colours through the day, the client's sun, local time or the map's fixed time), drawn as the client lights terrain, buildings (both its render paths, batch by batch), props, and units, including indoor light from the floor under a unit or a building's prop, doorway faces that blend indoor light into outdoor, and dungeons' brighter character ambient; the lights of torches and braziers near the party (a Lights toggle); and a Lighting setting (Client or Neutral).
- **Rendering performance** for battleground scale: a shared fade uniform buffer, instanced props, skeletons kept out of the scene graph with an animation budget (48 nearest units at full rate, the rest at 10 Hz, off-screen units skipped), merged unit draw calls, a 1.5 pixel-ratio cap, and a Render scale control; `?debug` shows frame rate, draws, and stream rates.
- Added synchronized, persisted icon-size controls to Live Map and Instance Watch. Canvas markers now scale progressively with zoom, participant-list icons are larger, and pre-v6 telemetry uses extracted male race portraits instead of emoji when gender is unavailable.
- Instance Watch participant rows now use a stable two-line status layout with live state icons and Tank/Heal/DPS labels. Extracted client icons remain optional; the same layout uses emoji fallbacks when they are absent.
- Added live-stream protocol v2 participant role masks. `mod-wowmin-telemetry` uses assigned core LFG roles first and, when available, `mod-playerbots` talent/gear role classification for manually assembled groups; WoWMin remains compatible with stream v1.

### Changed

- Managed-mode SOAP and database connections are now owned by the Node service instead of individual browsers. Independent services start non-fatally, retry with bounded backoff, expose non-secret status, support per-database host/credential overrides, and cannot be disconnected by another browser session.
- WoWMin is now a web-only Node.js service; Electron entrypoints, packaging, desktop update checks, and platform installers were removed.
- The content security policy allows WebAssembly (meshopt decoding of 3D scenes) and `blob:` images and connections (glTF textures).
- The web service reads its settings files itself, without `--env-file`: `/etc/wowmin.env` (`%ProgramData%\wowmin\wowmin.env` on Windows) takes precedence over the project's `.env`, and variables already set in the environment over both.
- Instance Watch now orders sidebar cards by session type. Battlegrounds place Battleground before Participants; dungeons and raids hide only Battleground while retaining Participants, Encounters, and Bot Decisions with empty-state guidance. Flat-map mode hides controls that only affect 3D rendering.

### Fixed

- Expected database fallback probes no longer flood server logs while SOAP or telemetry keeps the UI functional; genuine API failures now identify their channel and suppress identical repeats.
- Instance Watch now merges live-stream participants into database-fallback sessions so active playerbots remain visible, and protects focused dropdowns from periodic refreshes and card reordering.
- The persisted **Record sessions** control defaults off when no preference exists, can discard an in-progress recording without deleting completed history, and retains its setting across WoWMin restarts.
- Battleground Session History and replay now interpret the core `PvPTeamId` winner correctly, retain authoritative final state after participants leave, and classify Eye of the Storm resource gains as score objectives rather than flag captures.
- Session History now loads persisted local records at application startup and remains available while disconnected from SOAP, the worldserver, and realm databases.
- New Session History files now use familiar dungeon, raid, and battleground abbreviations in names such as `WSG-3-Oct08-26.json` and `Ramps(H)-22-Oct08-26.json`; collision suffixes preserve every run, and existing numeric filenames remain readable.
- Corrected AzerothCore `TeamId` handling so Alliance is consistently blue and Horde consistently red in Instance Watch, replay, and battleground outcome styling.
- Flag carriers now keep a prominent flag indicator until the authoritative carrier aura is removed by a drop, capture, return, or death.
- Player-state indicators now treat Spirit of Redemption, death/release, and living states as mutually coherent groups. Alive players immediately suppress stale Dead and Waiting to Resurrect icons.
- Outland/map 530 extraction now filters exact audited white/grey source-padding textures before JPEG output, preserving real water pixels and projection bounds; individual continent maps can be regenerated without touching unrelated continents.
- Map extraction now applies custom lettered locale patches after numbered patches and resolves artwork directories from `WorldMapArea.dbc`, enabling proper classic/TBC floor artwork and patched WMO/Z floor tables from WDM M/N patches instead of misleading dungeon minimap terrain.
- Map extraction keeps the artwork directory of a `WorldMapArea.dbc` record without bounds, so dungeon floor art filed that way (such as `TheTempleOfAtalHakkar` for Sunken Temple) is found.

## [3.0.0] - 2026-10-05

### Added

- **Live worldserver telemetry**: Live Map positions, health/power, target, and combat state now stream from the companion `mod-wowmin-telemetry` AzerothCore module every second (versioned WMAP protocol v1–v5, with backward-compatible parsing of earlier versions), replacing stale database-saved positions; the characters database remains a fallback
- **Instance / Battleground Watch tab**: automatic discovery of every active runtime instance, raid, battleground, and arena, with participant markers (faction colors, health, trails, headings, combat indicators), group/raid, subgroup, faction/team, and core LFG role details, runtime session age, boss state tracking, and per-session death history
- **Battleground state**: match phase, team scores and alive counts, decoded objectives (scores, captures, timers, flag state), resurrection state, and the server-selected bot strategy shown read-only
- **Floor-aware dungeons**: per-floor dungeon artwork extracted from `DungeonMap.dbc`/`DungeonMapChunk.dbc`, with per-participant floor classification and per-floor marker/trail filtering
- **Client artwork pipeline**: the map extractor now produces instance, raid, battleground, and arena backgrounds (including `worldMapArea`, `dungeonFloors`, and `minimapTiles` projections) from a WoW 3.3.5a client, with calibrated or auto-fit bounds as fallback
- **Stable map interaction**: pointer dragging, anchored wheel/button zoom, Fit view, participant focus, and per-session viewport persistence without refresh-interval jitter; zooming back to 100% recenters
- **Session recording**: completed runs are recorded automatically to JSON under `WOWMIN_DATA_DIR/sessions/` (participants, server-deduplicated kill/loot/level events plus snapshot-derived objective and flag transitions, running totals, sampled routes), with an index, atomic writes, and startup purge of abandoned checkpoints
- **Session history & replay tab**: browsable record index and embedded replay panel with per-participant colored routes (broken across death/release/teleport jumps), chronological event log, running totals at the seek position, and play/pause/stop/seek/0.5×–16× controls
- **Native web service hardening**: HTTP Basic Authentication, server-managed SOAP/database credentials, local log discovery without SSH, TLS-reverse-proxy guidance, and a hardened systemd unit template at `deploy/wowmin.service.example`
- **Self-contained test suite**: `npm test` runs telemetry parsing, command building, session grouping, projection math, session-recorder persistence, and replay math without any server, client, or database

### Changed

- The native web service is now the primary, fully tested route; the Electron desktop build shares the same code but has not been validated end-to-end on every platform
- Completed session records are retained indefinitely; removal is only via the explicit **Purge all** button (previous plans for automatic retention limits were dropped)
- Route trails and replay routes no longer draw lines across death, release, or teleport discontinuities
- Battleground bot strategies are captured by `mod-wowmin-telemetry` itself and are read-only; strategy control remains with the server/playerbot logic
- Live Map auto-refresh is 1 s and feeds the Live Map, Instance Watch, and session recorder from a single shared poll (`WOWMIN_TELEMETRY_POLL_MS`, default 1000, minimum 500)

### Fixed

- Live Map selection no longer shifts the canvas when the selected-player bar updates: the bar now overlays the map and canvas dimensions are only reassigned on real layout changes
- Map images are letterboxed to their natural aspect ratio instead of being stretched; continent and instance views keep stable bounds across refreshes

## [2.4.3] - 2026-04-30

### Fixed

- Ticket list parsing now understands AzerothCore's colorized `Ticket: <id>.` output instead of assuming a `Ticket #<id>` format
- Ticket rows now populate the **Player**, **Created**, and **Last Updated** columns more accurately from labeled GM-ticket fields
- Ticket detail view now renders a structured summary for the selected ticket message, comment, and response instead of showing the raw SOAP output line

## [2.4.2] - 2026-04-30

### Fixed

- Restored the missing **Tickets** tab handlers in the TypeScript renderer so ticket lists, detail views, actions, and auto-refresh work again in the live app bundle

## [2.4.1] - 2026-04-22

### Improved

- Live map rendering now supports cover-style viewport filling so continent backgrounds scale to fill the available canvas area more naturally
- Expanded the live map zoom range to support much wider inspection, from 10% all the way up to 5000%

## [2.4.0] - 2026-04-20

### Added

- New **Economy** tab for monitoring the in-game economy from the desktop client
- Auction house lookup with live listing search by item name, item entry, or owner name
- Character wealth lookup for checking individual player gold directly from the connected characters database
- Market summary view with per-item average unit buyout, listing counts, total quantity, and min/max unit pricing
- Economy database settings now persist inside connection profiles alongside SOAP, database, live-map, and log-monitor settings

### Fixed

- Economy market summary and auction lookups no longer fail with MySQL prepared-statement argument mismatches when search filters are applied

## [2.3.0] - 2026-04-13

### Changed

- Replaced the horizontal top tab bar with a persistent left-hand **sidebar navigation** panel, giving more vertical space to content areas and matching a modern dashboard layout
- Sidebar shows the WoW Admin brand, connection status indicator, and all navigation tabs as a vertical list with icons and labels
- Connection panel moved into a top header within the main content area with a glassmorphism backdrop for a cleaner, floating appearance
- Updated font stack to **Inter** (UI) and **JetBrains Mono** (code/console), loaded via Google Fonts for a premium modern feel
- Sidebar navigation tabs now feature a sliding hover animation, gold left-border active indicator, and smooth gradient highlight on the active item
- Cards and panels now use deeper box shadows to create stronger visual depth against the darker background

### Fixed

- `npm run start` and `npm run dev` now launch on Linux without requiring `chrome-sandbox` to be setuid root, by passing `--no-sandbox` to the Electron process

## [2.2.4] - 2026-04-09

### Fixed

- Restored the missing **Accounts** tab action handlers in the TypeScript renderer so account management forms no longer trigger native page submits that reset the UI back to the dashboard
- Account creation, password changes, GM level updates, ban tools, online-account lookups, and addon-setting actions now stay in-app and execute through the SOAP command pipeline again

## [2.2.3] - 2026-04-09

### Added

- Player inventory browsing from the **Players** tab, including in-app WoW-style item tooltips backed by `character_inventory`, `item_instance`, and `item_template`
- Main-menu navigation shortcuts for quickly jumping between app tabs from the desktop shell

### Improved

- Main tab bar and database subtabs now expose better keyboard navigation and ARIA metadata for a more accessible desktop workflow
- The app shell and database workspace received a broader visual refresh with cleaner semantic theme tokens and more consistent control states

### Fixed

- SOAP commands are now XML-escaped correctly and serialized one at a time to avoid malformed requests and timeout-prone concurrent worldserver calls

## [2.2.2] - 2026-04-03

### Added

- Live map support for selected playerbots to resolve and display their waypoint destination from the playerbots travel-node database
- New live-map options to toggle the selected bot waypoint overlay and override the playerbots database name when it differs from the default derived naming

### Improved

- Selected live-map bot details now include resolved waypoint name, node id, and distance in the selection panel
- Selected bot markers can now render a waypoint guide line and destination marker on the map for quicker travel inspection while debugging playerbot movement

## [2.2.1] - 2026-03-25

### Improved

- Remote log monitoring now uses a cleaner logger-first workflow: pick a logger, then choose from its currently available live files instead of scrolling through a giant readable-file list
- The Logs sidebar now uses explicit **Logger** and **Live File** selectors with a compact details panel for the selected file path, size, timestamp, and source hints

### Fixed

- Remote logger mappings now include dynamic `%s` appender matches when resolving live files, so logger-specific file selection stays accurate for rotating or pattern-based logs
- Selecting a live log file is now more reliable thanks to the explicit selector-based UI, avoiding the previous finicky card-click behavior

## [2.2.0] - 2026-03-25

### Added

- Keira3-inspired **Entity Editor workspace** with a dedicated editing column, generated SQL panel, and right-side live preview / related-data rail
- Live entity preview cards for items, creatures, quests, and other supported entities, including quality colouring, summary stats, quick external reference links, and fetched visual reference media inside the app
- Smart selector overlays for common reference fields so item, creature, and quest IDs can be searched and inserted without manual lookup
- Related-data sections with quick **Load** actions for vendor, loot, and quest-linked rows so adjacent records can be opened directly from the current entity
- Remote **Logs** tab with SSH/SFTP-backed `worldserver.conf` discovery, appender/logger parsing, packet-log path resolution, readable file detection, and in-app log tail preview
- Live follow mode for remote log previews, including a persisted refresh interval and automatic polling pause when the Logs tab is inactive

### Improved

- Item previews now surface a much richer dossier, including stats, resistances, sockets, embedded spells, stack/container details, and other high-signal template data
- Database entity editing flows now keep the live preview and related-data rail in sync while fields are being edited, giving the database tab a much more Keira-style feel

### Fixed

- Database and live-map database connection settings now save inside the selected connection profile instead of being shared outside profile state
- Database table selection is more robust thanks to button-based table entries and delegated click handling in the table browser
- Schema loading no longer fails on MySQL `DESCRIBE ??` syntax errors; table identifiers are now escaped explicitly before schema queries run

## [2.1.3] - 2026-03-23

### Fixed

- Live map player filters now resolve account usernames from the auth database before classifying bots, so **Players Only** and **Bots Only** correctly separate real players from `RNDBOT` accounts even though the characters table stores numeric account IDs

### Improved

- Windows packaging scripts and CI now run through `scripts/package.js`, preserving the local Windows-safe Electron Builder flags during release builds
- Windows NSIS and portable builds now use distinct artifact names so the portable executable no longer overwrites the installer output

## [2.1.2] - 2026-03-23

### Improved

- Live map backgrounds now preserve their original aspect ratio instead of stretching to the canvas bounds, keeping stitched continent images visually correct on resize
- Added live-map zoom controls with mouse wheel zoom, zoom in/out buttons, reset-to-100% control, and cursor-anchored zooming
- Added live-map panning while zoomed, with clamped drag bounds so the current continent remains in view
- Updated map hit-testing, player marker projection, and tooltip/selection logic to stay aligned while zoomed or letterboxed
- Added double-click zoom shortcut and an inline interaction hint for the map canvas

## [2.1.1] - 2026-03-22

### Added

- **GitHub update checker** — the app now checks the latest GitHub release on startup, shows current/update status in the header, supports manual refresh, and can open the release page in the default browser
- `scripts/extract-map-assets.mjs` CLI and `npm run extract:maps` helper for generating continent JPGs directly from a WoW 3.3.5a client or extracted `World/Minimaps` tiles
- Generated live-map background assets for Eastern Kingdoms, Kalimdor, Outland, and Northrend in `assets/maps/`

### Improved

- Live map coordinate projection now supports cropped minimap tile bounds so generated JPG backgrounds line up more accurately with in-game player coordinates
- Map extractor tolerates unreadable patch archives and corrupt minimap tiles when possible, improving compatibility with patched Linux client archives and mixed client sources

## [2.1.0] - 2026-03-22

### Added

- **Live Map tab** — real-time canvas map showing all online player positions, polling the `acore_characters` database on a configurable interval
- Map image backgrounds: place `0.jpg`, `1.jpg`, `530.jpg`, `571.jpg` in `assets/maps/` to use actual continent maps; colour-fill + grid fallback is used when images are absent
- Continent switcher for Eastern Kingdoms (0), Kalimdor (1), Outland (530), and Northrend (571)
- Player dots colour-coded by class using WoW class colours; bot accounts rendered with reduced opacity
- Player name labels displayed automatically when ≤ 30 players are visible on the current continent
- Sidebar player list showing name, class colour dot, and level for all players on the selected continent
- **Player selection** — click a dot on the canvas or a row in the sidebar to select a player; re-click to deselect
  - Selected player highlighted with a white outer ring on the canvas and a highlighted row in the sidebar
  - Selection panel below the canvas shows name (in class colour), level/race/class, and live coordinates
  - Quick SOAP action buttons: **Info**, **Freeze**, **Unfreeze**, **Summon**, **Kick**, **Ban**
  - Inline action result feedback; selection cleared automatically on continent switch or disconnect
- Hover tooltip on the canvas showing player name, level, race, class, and map coordinates
- Auto-refresh toggle (5 s default) with manual refresh button
- Filter selector: Real Players only, Bots only, or All
- Separate database connection for the map tab (connects to `acore_characters`)
- `assets/maps/README.txt` with instructions for sourcing and naming map image files
- `renderer/scripts/utils/map-coords.ts` — `CONTINENT_BOUNDS` constants and `worldToCanvas()` coordinate conversion using WorldMapArea.dbc bounds

## [2.0.1] - 2026-03-12

### Fixed

- Player list now correctly displays level, race, and class for all online players — previously these always showed as empty/0 because `account onlinelist` does not include that data. The list now batch-fetches `pinfo` for each player on load so all columns are populated immediately. Fixed level regex to use a negative lookbehind (`(?<!\\w)Level:`) instead of a line anchor, correctly matching `Level: 80` while ignoring `GMLevel: 0` regardless of leading pipe/box-drawing prefix characters in the raw pinfo output.

## [2.0.0] - 2026-02-22

### Added

- Database Editor feature with MySQL connection support for AzerothCore databases
- Connect to auth, characters, and world databases with saved connection profiles
- Browse database tables with pagination and column sorting
- Edit records directly in the table with inline editing
- Insert new rows and delete existing rows
- Raw SQL query editor with result display
- Transaction support for safe database operations

### Changed

- Migrated codebase from JavaScript to TypeScript for better type safety
- Added Tailwind CSS for modern styling with utility classes
- Updated build system with esbuild for faster TypeScript compilation
- Improved code organization with proper type definitions

### Improved

- Tickets tab completely redesigned with a proper table-based ticket list
- Tickets auto-load when switching to the Tickets tab while connected
- Filter tabs (Open, Online, Closed, Escalated) replace the old manual "Load" buttons
- Clicking a ticket row opens a detail panel and auto-fills the action/response forms
- Inline action buttons on each ticket row for quick view, close, and delete
- Added auto-refresh toggle (30s) for the ticket list
- Ticket list refreshes automatically after performing actions (close, delete, escalate, etc.)
- Ticket auto-refresh interval properly cleaned up on disconnect

## [1.0.0] - 2026-02-10

### Added

- SOAP connection management with saved profiles
- Dashboard with server info, uptime, player count, peak, and MOTD
- Players tab with live player list, search, filtering, and pagination
- Player detail view using `pinfo` command
- Inline player actions: kick, mute, ban, unban, revive, teleport, and more
- Accounts tab for account creation and management
- Tickets tab for viewing and responding to in-game tickets
- Interactive console with command history and auto-scroll
- Quick-action buttons for common server commands (shutdown, announce, reload, etc.)
- Auto-refresh for dashboard and player list
- Multi-profile connection support with save/update/delete
- Cross-platform builds for Windows (NSIS + portable), macOS (DMG), and Linux (AppImage, deb, tar.gz)
- Custom application icons for all platforms

### Fixed

- Player detail and action buttons now work correctly under Content Security Policy (replaced inline handlers with event delegation)
