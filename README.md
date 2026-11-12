# Tasker

A local-first, offline-capable todo and planning app. Tasker is a TypeScript
single-page application deployed to Vercel as static files, with a custom service
worker for offline use.

There is **no account and no login**. Every task, project, category, tag, place
and setting lives in the browser's IndexedDB, and the app works with no network
at all. If you want more than one device, an optional self-hosted relay syncs
encrypted changes in the background.

> 📖 The full user manual lives in [`USER_MANUAL.md`](./USER_MANUAL.md) and is
> also rendered inside the app under **Settings → Open user manual** (or `?`).

---

## Features

| Area | What you get |
| --- | --- |
| Structure | Categories → projects → tasks → subtasks (nested to any depth) |
| Capture | Inline natural-language parsing with live preview chips (`@place`, `!1`, `#Project`, `^Category`, `+tag`, dates, times, ranges, recurrence) and a trigger-driven autocomplete dropdown |
| Views | Scheduled (all dated tasks grouped by day), Tasks (debounced filter, sort, group), Calendar (multi-day spans, month/week), Roadmap (lane timeline, week/day zoom) |
| Metadata | Priority 1–4, places, start/end dates, start/end times, all-day vs. micro-scheduled timeframes |
| Recurrence | Daily / weekly / monthly / yearly plus custom intervals, weekday picks, day-of-month, end date, occurrence cap |
| Rewards | XP with a combo multiplier, levels, streaks, 12 achievements, daily milestones, and a 6-second Undo on every completion — synced across devices |
| Feedback | Particle bursts at the checkbox, optional chime, haptic patterns, and toasts — all respecting `prefers-reduced-motion` |
| Storage | IndexedDB, fully offline, JSON export / import / reset |
| Sync | Optional end-to-end encrypted relay sync across devices (your own server), including XP, streaks and achievements |
| Reminders | ntfy notifications with scheduled delivery, IANA timezone support, exact-time reminders, and 1–5 reminders/day for tasks that only have a date |
| PWA | Installable, custom `sw.js`, offline-first caching |

---

## Getting started

This project uses **pnpm**, pinned in `package.json` (`packageManager`) so local
builds and Vercel's build use the identical version.

```bash
pnpm install
pnpm dev           # http://localhost:5173
```

> Do not run `npm install` here. npm's dependency walker traverses pnpm's
> `node_modules/.pnpm` store, hits a package that depends on `workspace:*`, and
> aborts with `EUNSUPPORTEDPROTOCOL`. Vercel does the same thing if you force an
> install command, which is why `vercel.json` leaves install and build commands
> to Vercel's own package-manager detection.

### Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Vite dev server |
| `pnpm build` | Typecheck, then produce `dist/` |
| `pnpm preview` | Serve the production build |
| `pnpm typecheck` | TypeScript only |

---

## Deploying to Vercel

1. Import the repository. Vercel detects the Vite preset from `vercel.json`.
2. Optionally set `VITE_SYNC_URL` to your relay's public URL so the Sync card is
   pre-filled. Nothing else is required.

`vercel.json` handles the build output, the SPA rewrite and the cache headers.
The build is a static bundle: no serverless functions, no cron jobs and no
runtime secrets.

### Optional sync relay

Tasker works completely without a server. Sync is opt-in and runs against the
small relay in [`server/`](./server) — a single Express process with SQLite.

- The passphrase is stretched in the browser (PBKDF2-SHA-256, 600k rounds); the
  relay only receives a derived authentication key and AES-GCM ciphertext.
- Each entity is a UUID. Every change carries a hybrid logical clock, and merge
  is last-writer-wins with tag union for tasks and projects. Progress counters
  take the highest value and achievements are unioned.
- The relay stores an append-only log plus the latest entity per id, so devices
  catch up by polling. Tombstones are retained for 90 days.
- Tasker queues changes in IndexedDB while offline and pushes them when the
  connection returns.

Run it locally:

```bash
cd server
pnpm install
pnpm dev        # http://localhost:8787
```

> Local relay development is tested on Node 20/22. The native
> `better-sqlite3` binding in this package does not support Node 24; use the
> Docker image or Node 22 if your default `node` is newer.

Build and run in production:

```bash
cd server
pnpm build
DB_PATH=/data/tasker.db CORS_ORIGINS=https://tasker.asterki.xyz node dist/index.js
```

With Docker (the volume holds the SQLite file):

```bash
docker build -t tasker-relay ./server
docker run -d --name tasker-relay -p 8787:8787 \
  -v tasker-data:/data \
  -e CORS_ORIGINS=https://tasker.asterki.xyz \
  tasker-relay
```

Put it behind TLS, for example an nginx server block for
`tasker-api.asterki.xyz` that proxies to `127.0.0.1:8787`. Then connect from
**Settings → Sync** with that URL and a long passphrase. The same passphrase on
another device joins the same space; the fingerprint shown on both devices must
match.

Losing the passphrase means the sync space cannot be recovered — there is no
account and no reset. Export a JSON backup as well if the data matters.

### MCP server (models)

The relay can expose a **Streamable HTTP MCP endpoint** so an MCP-capable model
can read and write the same sync space. It authenticates with the **same sync
passphrase** you enter on your devices: the relay derives the same keys, verifies
that the sync space exists, decrypts the change log, and writes encrypted
changes back with a fresh hybrid logical clock.

- **Endpoint:** `https://<relay-host>/mcp`
- **Transport:** Streamable HTTP (stateless)
- **Auth:** `Authorization: Bearer <sync-passphrase>`, or
  `X-Tasker-Passphrase: <sync-passphrase>` when the passphrase contains
  characters that confuse a bearer parser.

Example client entry:

```json
{
  "mcp": {
    "tasker": {
      "type": "remote",
      "url": "https://tasker-api.asterki.xyz/mcp",
      "headers": {
        "Authorization": "Bearer YOUR-SYNC-PASSPHRASE"
      },
      "enabled": true
    }
  }
}
```

Available tools:

| Tool | Purpose |
| --- | --- |
| `list_tasks` | Filter by status, project, category, place, priority, date range or text |
| `get_task` | One task plus its subtasks |
| `search_tasks` | Search titles, notes and tags |
| `task_overview` | Counts for today, overdue, upcoming, priorities and projects |
| `list_projects`, `list_categories`, `list_places` | Workspace structure |
| `create_project`, `create_category` | Add structure |
| `create_task`, `update_task` | Create and edit tasks, including recurrence |
| `complete_task` | Complete/reopen; recurring tasks advance to their next occurrence |
| `delete_task` | Delete a task and its subtasks on every device |

The endpoint is enabled by default. Set `MCP_ENABLED=false` to turn it off, or
`MCP_ORIGINS=https://some-browser-client.example` to allow browser-originated
clients in addition to `CORS_ORIGINS`. Auth is rate-limited, but the passphrase
is still a bearer secret: anyone who has it can read and modify the whole sync
space.

> **Security trade-off:** unlike the sync relay, the MCP endpoint must decrypt
> task data to answer tool calls, so plaintext exists in the relay process while
> requests are served. Run it only on a host you trust, keep it behind TLS, and
> use a long passphrase.

### Notifications with ntfy

Reminders are delivered by [ntfy](https://ntfy.sh), not by a Vercel function or
`web-push`/VAPID. This keeps the static deployment intact and works while the
app is closed: ntfy's own Android, iOS or desktop app receives the notification.

1. Install the ntfy app and subscribe to a topic. On ntfy.sh, use a long random
   topic — the topic is effectively the password.
2. Open **Settings → Notifications**, enable reminders, and enter the ntfy server
   and topic. Add an access token if your server requires one.
3. Choose the **time zone** Tasker should use. It defaults to the device zone and
   is stored in IndexedDB with the rest of your settings.
4. Choose how many reminders per day an all-day task should produce (1–5). Timed
   tasks always remind at their exact time.
5. Use **Send test notification** to verify the topic.

Tasker publishes scheduled messages with ntfy sequence IDs, so editing,
completing or deleting a task replaces or cancels the pending notification.
Because ntfy limits scheduled delivery (three days by default on ntfy.sh), the
app arms a rolling two-day window whenever it launches, regains focus, comes
back online, or every six hours while open. Raise `message-delay-limit` on a
self-hosted ntfy server if you want a longer window.

The ntfy server sees task titles and times in plaintext. Self-host ntfy if that
matters, and protect the topic with auth. The optional token is stored in
IndexedDB, included in encrypted sync, and present in JSON backups.

---

## Architecture

```
tasker/
├── public/
│   ├── sw.js                  custom service worker (offline caching)
│   ├── manifest.webmanifest   PWA manifest
│   └── icons/                 generated app icons
├── scripts/
│   └── generate-icons.py      dependency-free icon generator
├── server/                    optional sync relay (Express + SQLite)
│   ├── src/db.ts              schema, change log, snapshot queries
│   ├── src/index.ts           HTTP API, auth, CORS, rate limiting
│   ├── src/mcp/               Streamable HTTP MCP server (passphrase auth)
│   └── Dockerfile
├── src/
│   ├── components/            UI building blocks (rail, sheets, rows, tree, editor…)
│   ├── db/database.ts         IndexedDB persistence layer (v4 schema, outbox)
│   ├── docs/UserManual.tsx    in-app Markdown manual renderer
│   ├── domain/                types, date maths, recurrence, NL parser,
│   │                          suggestions, progress/XP maths
│   ├── notifications/         ntfy publisher, timezone-aware schedule, engine
│   ├── pwa/serviceWorker.ts   production service-worker registration
│   ├── state/                 React context store, hooks, navigation model
│   ├── sync/                  crypto, HLC clock, recorder, engine
│   ├── views/                 Tasks, Calendar, Roadmap, Settings
│   ├── App.tsx                shell: layout, shortcuts, manual overlay
│   ├── main.tsx               bootstrap + service-worker registration
│   └── styles.css             Nordic Minimal design tokens and components
├── vercel.json                static build, rewrites, headers
└── USER_MANUAL.md             the user manual (also rendered in-app)
```

### Design decisions

- **Local-first.** IndexedDB is the source of truth; every mutation is written
  through immediately, so closing the tab never loses work.
- **Subtasks are tasks.** A subtask is an ordinary `Task` with a `parentId`, so
  nesting is unlimited and every subtask supports the full metadata set without
  a parallel code path.
- **Rewards are accumulated, not derived.** XP, streaks and achievements live in
  `settings.progress` rather than being recomputed from the task list, so
  deleting an old task never rewinds your level.
- **No shared utility grab-bag.** Helpers live inside the domain that owns them
  (`domain/date.ts`, `domain/recurrence.ts`, `domain/parser.ts`,
  `domain/progress.ts`) rather than in a generic `utils/` module.
- **Plain CSS with tokens.** The palette from `DESIGN.md` is expressed as CSS
  custom properties, so the light and dark themes stay in lockstep without a
  build-time CSS framework.
- **Reminders are device-computed, server-delivered.** The browser derives the
  next two days of reminders in your chosen IANA time zone and publishes them to
  ntfy with deterministic sequence IDs. No task data is mirrored to Vercel, and
  editing or completing a task replaces or cancels the waiting message.
- **Animation never blocks state.** Completing a task fires the burst
  immediately and commits ~220ms later, so the reward feels instant while the row
  still gets to animate. The celebration layer is `position: fixed` and
  `pointer-events: none`, so it survives the row unmounting.

### Environment replacement

Vite loads `.env`, `.env.<mode>` and `.env.<mode>.local` natively for every
build mode, so deployment-specific values never need code changes.
`vite.config.ts` additionally inlines `__APP_VERSION__`, `__APP_MODE__` and
`__BUILD_TIME__` into the bundle so a running build can report exactly what it
is.

---

## Regenerating icons

```bash
python3 scripts/generate-icons.py
```

No image libraries required — the script writes PNGs directly.
