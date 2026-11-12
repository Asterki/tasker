# Tasker — User Manual

Tasker is a local-first todo and planning app. Everything you create lives on
your device in IndexedDB; there is no account and no login. The app works with
no network at all. If you turn on optional sync, Tasker talks only to the relay
you configure, and only with encrypted payloads.

---

## 1. Structure

Tasker organises work in four levels:

```
Category        Work, Personal, …            ← groups projects
  └ Project     Student management system     ← groups tasks, owns tags
      └ Task    Draft the proposal
          └ Subtask  Collect requirements     ← nests forever
```

- **Categories** are the top level, created from the rail or in Settings.
- **Projects** belong to a category and own their own tag set.
- **Tasks** belong to a project (or the Inbox) and can carry priorities, places,
  dates, times, tags and recurrence.
- **Subtasks** are ordinary tasks with a parent, so they support *exactly* the
  same metadata and nest to any depth.

---

## 2. Layout

### Desktop

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [ Search tasks ]                   ( 3 ) ↑4 ⚡2× ✓7   ☾ ?  + Add task │
├───────────────┬──────────────────────────────────────────────────────────┤
│ Scheduled     │                                                          │
│ Today         │                     Active view                          │
│ Inbox         │          Tasks · Calendar · Roadmap · Settings           │
│ All tasks     │                                                          │
│ Completed     │                                                          │
│ ───────────   │                                                          │
│ CATEGORIES +  │                                                          │
│  ▾ ● Work     │                                                          │
│     ● Tasker  │  ← thin progress bar under each project                  │
│     + Project │                                                          │
│  ▾ ● Personal │                                                          │
│ ───────────   │                                                          │
│ PLACES        │                                                          │
│  @desk @home  │                                                          │
├───────────────┴──────────────────────────────────────────────────────────┤
│ Settings   User manual              ● Local-first · Offline ready        │
└──────────────────────────────────────────────────────────────────────────┘
```

The global menu bar spans the top edge with search on the left and utility
actions on the right. The left rail holds navigation. Clicking a task opens the
detail panel on the right.

The badge in the top bar is your **progress HUD**: level ring, streak, current
combo and how many you have finished today. Click it for the full breakdown.

### Mobile

The bottom tab bar holds **Tasks**, **Calendar**, **Roadmap** and **More**. A
floating **+** sits in the thumb zone. Creating and editing happen in a **bottom
sheet**: drag the handle down — or swipe the sheet away — to close it.

---

## 3. Views

### Scheduled (the landing view)

Every task that has a date, grouped by the day it sits on and sorted
chronologically. Overdue days sort to the top, then today, tomorrow, and out into
the future. Undated work stays in the Inbox or inside its project.

The quick-add field is focused automatically on desktop, so you can open Tasker
and start typing immediately.

### Tasks

One list, scoped by whatever you picked in the rail (a category, a project, a
place, or a smart list). Use it to sort, filter and manipulate tasks.

- **Debounced live filter** — typing narrows the list after a short pause.
- **Group** — by date, project, priority, place or roadmap lane.
- **Sort** — by due date, priority, creation date, alphabetically, or manual.
- **Priority flag** — click the flag on a row to cycle P1 → P2 → P3 → P4.
- **Subtask expander** — rows with children show `2/3`; click it to nest them
  inline. The `＋` button on a row adds a subtask without opening anything.

### Calendar

An interactive month/week grid. A **multi-day task appears on every day it
spans**; continuation days are dashed and italic so the start is obvious. Select
a day to inspect it; the day panel below offers a quick-add pre-dated to that day.

### Roadmap

A timeline of execution sequences. Top-level tasks are grouped into **lanes**
(set the lane in the detail panel) and plotted week-by-week, or day-by-day with
the **Days** toggle. Bars are coloured by priority and turn red when overdue.
Subtasks stay with their parent instead of cluttering the timeline. Unscheduled
work sits in the backlog below.

---

## 4. Natural-language quick add

Type a normal sentence and Tasker extracts the metadata as you type — the chips
under the input always show exactly what will be saved.

```
Create a new feature in the app @work tomorrow !1 #UNAH
```

| Result | Value |
| --- | --- |
| Title | Create a new feature in the app |
| Place | `work` |
| Date | tomorrow's date |
| Priority | 1 |
| Project | UNAH |

**Press `Enter` to send.** `Esc` clears the field.

### Tokens

| Token | Meaning | Examples |
| --- | --- | --- |
| `@place` | Physical or contextual place | `@work` `@home` `@downtown` |
| `!1` … `!4` | Priority (1 = urgent, 4 = none) | `!1` `!p2` |
| `#Project` | Project (created automatically if new) | `#UNAH` `#Deep Work` |
| `^Category` | Category (created if new) | `^Work` `^Personal` |
| `+tag` | Tag from the target project | `+design` `+urgent` |

A token must be preceded by a space (or start the line), so email addresses and
words like `C#` are never mistaken for tokens. The dropdown inserts the space for
you.

### Dates

`today`, `tomorrow`, `tonight`, `mon` … `sun`, `monday` … `sunday`,
`next friday`, `this monday`, `next week`, `next month`, `in 3 days`,
`in 2 weeks`, `25/10`, `10/25/2027`, `2027-01-09`, `Oct 25`, `25 Oct`,
`Oct 25 2027`.

### Times, durations and multi-day spans

`3pm`, `3:30pm`, `15:00`, `at 7`, `noon`, `morning`, `evening`.

- **Start and end time:** `9-11am`, `from 9 to 11am`, `at 3pm to 5pm`.
- **Start and end date:** `tomorrow until monday`, `Oct 24 through Oct 30`.

A date with no time is an **all-day** event. Adding a time turns it into a
micro-scheduled timeframe with an optional finish time.

### Recurrence

`every day`, `every 2 weeks`, `every monday`, `every month`, `every 1st`,
`every year`, `daily`, `weekly`, `monthly`, `yearly`.

### Autocomplete dropdowns

Start a token and a list of what already exists appears — arrow keys to move,
`Tab` or `Enter` to accept (or click it):

| Trigger | Suggests |
| --- | --- |
| `#` | projects, **grouped by category** |
| `^` | categories |
| `@` | places |
| `!` | priorities 1–4 |
| `+` | tags, scoped to the project you already typed |

While the list is open, `Enter` still sends the task unless you have moved into
the list with the arrow keys.

---

## 5. Progress and rewards

Finishing something should feel like finishing something.

- **XP** — every tick scores XP by priority: P1 12, P2 8, P3 5, P4 3.
- **Combo** — complete tasks within 8 seconds of each other and the multiplier
  climbs ×2, ×3 … up to ×5. The HUD shows the live combo while it is running.
- **Checklist bonus** — ticking the last open subtask of a parent adds 6 XP and
  fires its own green burst.
- **Levels** — 100 XP for level 2, 200 more for level 3, and so on. The ring in
  the top bar fills as you go and a toast announces each level.
- **Streak** — consecutive days with at least one completion, with your best
  streak kept forever. The current streak resets only after a full day is skipped.
- **Achievements** — twelve of them, from *First step* to *Veteran*, listed in the
  HUD and in Settings. Unlocking one raises a toast.
- **Daily milestones** — 1, 3, 5, 10 and 20 completions in a day get a shout.
- **Haptics** — supported devices buzz on completion, with a distinct pattern for
  a level-up or a cleared checklist. Toggle it in the HUD or Settings.
- **Sound** — an optional short chime, a richer arpeggio for level-ups. Off by
  default; toggle it with the speaker icon in the HUD.
- **Undo** — every completion raises an *Undo* pill at the bottom of the screen
  for six seconds. Undoing restores the task (and its subtasks) and takes the XP
  back, so a mis-tap costs nothing.

All of this respects `prefers-reduced-motion` — with it enabled the particles are
skipped and only the XP label and toasts remain.

---

## 6. Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `n` | Focus the quick-add field |
| `/` or `⌘/Ctrl + K` | Focus the filter / search field |
| `1` | Scheduled view |
| `2` | Calendar view |
| `3` | Roadmap view |
| `4` | Settings |
| `t` | Jump to Today |
| `?` | Open this manual |
| `Esc` | Close the open panel, sheet, or dropdown |

Shortcuts are disabled while you are typing in a field.

---

## 7. Projects, tags and places

- **Projects** are isolated containers with their own colour, tags and tasks.
  Create one from the rail (**＋ New project**) or by typing `#Name`.
- **Tags** belong to a project. Add them from the detail panel or the `+ tag`
  button in a project view; attach or detach them with a click. Clicking a tag
  chip in a project view filters the list to it.
- **Places** are global contexts such as `@work`. They appear in the rail and can
  be used as a grouping dimension.

Manage a category or project with the `⋯` button next to it: rename, recolour,
move a project between categories, or delete. Deleting a category keeps its
projects; deleting a project moves its tasks to the Inbox.

---

## 8. Subtasks

Open a task and use **Subtasks → Add a subtask**, or press `＋` on any row. A
subtask:

- inherits its parent's project,
- uses the same natural-language syntax as any other task,
- can itself have subtasks, forever,
- shows the parent's progress as `2/3` once you tick some off.

Completing a parent completes its whole subtree. Deleting a parent deletes its
subtree (you are asked first). Completing a **recurring** task moves its
checklist onto the new occurrence and resets it, so a weekly routine keeps its
steps.

---

## 9. Recurrence

Open a task and choose a repeat cycle. Simple cycles work out of the box; the
custom controls add a multi-unit interval (`every 2 weeks`), explicit weekdays,
a day of month, an end date, and a maximum number of occurrences.

Completing a recurring task archives the current occurrence and creates the next
one, so your history stays intact.

---

## 10. Backup, restore and reset

Everything lives in **Settings → Data**.

- **Export JSON** downloads a complete snapshot: categories, projects, tags,
  places, tasks (with subtasks and progress) and settings — including the ntfy
  topic and access token, so keep the file private.
- **Import JSON** restores that snapshot. Import *replaces* the current state, so
  export first if you are unsure.
- **Reset app** erases all local data. This cannot be undone.

Keep the exported file somewhere safe — it is the only copy of your data.

---

## 11. Sync between devices

Sync is optional and off by default. Everything works without it. To turn it on,
open **Settings → Sync**.

1. Enter the **relay URL** (for example `https://tasker-api.asterki.xyz`).
2. Enter a long **passphrase**. It is stretched in your browser and never sent to
   the relay.
3. Choose **Connect**. If that passphrase has no data yet, Tasker asks you to
   confirm **Create new space**.
4. On the second device, use the same relay URL and passphrase and choose
   **Connect**. Both devices must show the same 8-character **Space**
   fingerprint.

There is no recovery: if you lose the passphrase, the sync space is gone.

Once connected:

- Every change is queued locally first. Tasker pushes the queue whenever it can
  reach the relay and pulls new changes every 20 seconds while open, and right
  away when the tab regains focus or the network returns.
- Changes made offline are sent when the connection comes back.
- Conflicts are settled per record by the most recent change. Tags on tasks and
  projects are combined rather than discarded.
- **Sync now** forces an immediate cycle; the card shows queued changes and the
  last successful sync.
- **Disconnect** stops syncing and clears the sync metadata. Your tasks stay.
  Reconnecting merges this device with the remote space; where the same record
  changed on both sides, the newest change wins.
- XP, streaks and achievements sync with the rest of the space. Each device merges
  the record it receives, so counters take the highest value and achievements are
  unioned.

Importing a JSON backup is blocked while sync is connected. Disconnect first.

---

## 12. Notifications (ntfy)

Reminders are delivered through [ntfy](https://ntfy.sh), a small notification
server with Android, iOS and desktop apps. Tasker does **not** ask for browser
notification permission and does not use a serverless cron: the app publishes
scheduled messages to ntfy, and the ntfy app shows them even when Tasker is
closed.

### Setup

1. Install the ntfy app on the device that should ring. Subscribe to a topic
   (for example `tasker-8f3k2m`). On the public `ntfy.sh`, use a long random
   topic — anyone who knows it can read and publish to it.
2. Open **Settings → Notifications**. Turn on **Enable ntfy reminders**.
3. Set the **ntfy server**. Use `https://ntfy.sh` or your own server, such as
   `https://ntfy.example.com`. If the server requires authentication, paste an
   access token (`tk_…`).
4. Enter the same **Topic** you subscribed to.
5. Pick the **Time zone**. It defaults to the device zone and is stored with your
   settings. Changing it re-computes every reminder.
6. Choose **All-day reminders**: 1–5 times per day. The times used for each
   choice are shown under the selector (for example 2× = 09:00 and 18:00).
7. Press **Send test notification** and confirm it arrives in the ntfy app.

### How reminders behave

- A task **with a time** reminds you at that exact time on its date.
- A task **with only a date** (or marked **All-day**) reminds you at the
  configured times. A multi-day all-day task reminds you on each day it spans.
- Tasks without a date never remind you.
- Use the **Reminder** switch in a task's detail panel to mute or unmute one task.
- Completing, deleting, rescheduling or renaming a task updates or cancels its
  pending notification. The same record is replaced rather than duplicated.

### The two-day window

ntfy accepts scheduled delivery up to three days ahead by default. Tasker
therefore keeps a rolling **two-day** schedule and refreshes it when the app
opens, regains focus, comes back online, and every six hours while a tab stays
open. If you do not open Tasker for more than two days, reminders further out
will not have been armed yet. A self-hosted ntfy server can raise
`message-delay-limit`; Tasker still re-arms on launch either way.

### Privacy and backups

The ntfy server sees the notification title and text (project, place, priority,
date). Use a self-hosted ntfy server or a private topic if that matters. The
access token lives in IndexedDB, syncs through the encrypted relay, and is
present in JSON exports — store backups accordingly.

---

## 13. Offline behaviour

- The app shell is cached by `sw.js`, so Tasker opens with no network.
- All reads and writes go to IndexedDB and work offline.
- If sync is connected, changes queue on the device and upload when the relay is
  reachable again. Nothing is sent anywhere until you connect a sync space.

### Installing the app (PWA)

Use the browser's **Install** / **Add to Home Screen** action. Tasker then runs in
its own window and works fully offline.

---

## 14. Troubleshooting

| Symptom | Fix |
| --- | --- |
| A `#project` or `^category` stayed in the task title | Put a space before the token — `release #Tasker`, not `release#Tasker`. |
| The combo never builds | Completions must be within 8 seconds of each other. |
| No vibration | Most desktops have no vibration motor; check the toggle in the HUD. |
| App shows stale content | Hard-reload once; the service worker updates on the next visit. |
| Sync says “Could not reach the sync server” | Check the relay URL and TLS certificate; the device must be online. |
| Sync shows a different Space fingerprint | The passphrases differ. Use the same passphrase on both devices. |
| Sync card asks to create a space | That passphrase has no data on the relay yet; confirm only if this is the first device. |
| ntfy test fails with HTTP 401/403 | Add the access token, or allow anonymous write access to the topic on your server. |
| ntfy test fails with a network error | Check the server URL, TLS certificate and CORS (`allow-origin`) on a self-hosted server. |
| No reminder arrives | Confirm the ntfy app is subscribed to the same topic, and open Tasker once to arm the two-day schedule. |
| Reminder arrives at the wrong time | Check **Settings → Notifications → Time zone**; it is independent of the device clock setting. |
| Lost data | Import your most recent JSON export. |
