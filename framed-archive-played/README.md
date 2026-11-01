# Framed Archive Played Tracker

Userscript for [framed.wtf](https://framed.wtf) that colors the day links on the
archive pages based on whether you've played them:

- 🟩 **Green** — won
- 🟥 **Red** — lost
- 🟧 **Amber** — started but not finished
- ⬜ Normal slate — not played

Works on all four archive tabs: Classic (`/archive`), One Frame, Titleshot and
Poster.

A small chart button in the bottom-right corner opens a panel with:

- **Statistics**, for all modes together or one at a time: played, won, lost,
  win rate, W/L ratio, the average clue you win on, current/best win streak
  (consecutive day numbers), and a "solved on clue" distribution like framed's
  own.
- **Import / export**, for moving your history to another browser: download
  (or copy) a JSON file, then load it on the other side and **Merge** (keep
  what's there, add what's missing, finish days that were only "started") or
  **Replace**. The export also carries framed's own `title-log`, so amber days
  and older wins' clue numbers come along too.

## Fullscreen layout

On game pages (daily and archive), a button next to **SUBMIT** toggles a
fullscreen layout; it's on by default and remembered per browser. Framed caps
its column at 728px (970px on very wide screens) and gives the frame a fixed
height, so on a big screen the frame stays small. In fullscreen the script:

- hides the header (logo, games/archive/help links, menu); the "FRAMED #n"
  title bar stays;
- measures what's left above the frame and below it (frame buttons, guess
  input) and sizes the frame box at the frame's own aspect ratio to fill the
  remaining window height, capped by the window width;
- hides the 320px ad columns beside the game only when the wider game leaves
  them no room.

Framed's suggestion list already opens upward over the frame. The list of
previous guesses and "N GUESSES REMAINING" sit below the input, just past the
bottom of the window, so the frame doesn't shrink with every guess. Other
pages (archive grid, etc.) keep framed's normal layout.

## Install

1. Install a userscript manager in Firefox, e.g.
   [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/) or
   [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/).
2. Open the extension dashboard, create a new script, and paste in the contents
   of [`framed-archive-played.user.js`](framed-archive-played.user.js) — or drag
   the file into Firefox.

## How it works

Framed itself keeps no per-day history of results. Its localStorage only holds
the *current daily* game (`day` + `gameData`, prefixed per mode, e.g.
`one-frame-day`), overwritten each day — and archive plays are never persisted
at all (framed skips every write when `isArchive` is set). The only per-day
trace framed keeps is `title-log`, which records which guess slots you used,
but not whether you won.

So the script builds its own history, polling every 750 ms:

- **Daily games**: it snapshots `gameData.gameState` from framed's localStorage
  and records each day's result under its own key,
  `framed-archive-played-v1`.
- **Archive games**: since nothing is persisted, it watches the game page's DOM
  while you play — the end panel shows "You got it!" on a win and "THE ANSWER
  WAS:" on a loss.
- **Amber (started)** comes from framed's own `title-log`: any used guess slot
  marks the day as attempted, even for plays from before the script was
  installed.
- **Winning clue**: daily wins take it from `gameData.currentGuess`; other wins
  get it backfilled from `title-log` (position of the last used slot) and
  stored under `steps` in the same record.
- On the archive pages it colors the day links from that record. Polling also
  handles Next.js client-side navigation, so colors survive tab switches
  without a page reload.
- Clicking an archive link in the slide-out menu also closes the menu (framed
  normally leaves it open over the archive page).
- Opening an already-played archive day restores framed's real end screen
  (answer, title statistics, guess distribution, share) even though framed
  itself restarts the day from scratch. The script computes the finished state
  the game would have reached (one skip per clue used, then the correct answer
  — or six skips for a loss) and jumps there in a single React state update,
  found by walking the fiber tree from the guess input; if that ever breaks it
  falls back to replaying guess by guess through the game's own UI. The answer
  comes from the day-ordered list
  bundled in framed's own JS (extracted via the webpack module registry;
  classic mode only). The end screen is only restored for results this script
  recorded itself (`framed-archive-played-v1`) — that's the only certain
  signal. Days that `title-log` shows as attempted but have no recorded
  result (played before install, or paused mid-game) stay playable — no
  spoilers, and you can continue them later.

## Limitations

- **Win/loss history starts at install time**, and archive results are only
  recorded while the game page is open — if you close the tab mid-game and the
  result panel is never shown, that day stays amber. Days attempted before
  install show as amber (from `title-log`), never green/red, since framed never
  stored the outcome.
- The record lives in localStorage for framed.wtf, which never expires but is
  deleted if you clear cookies/site data for the site (this would also wipe
  your framed stats). Back it up with **Download JSON** in the panel. (Older
  console backups of `framed-archive-played-v1` can be imported too.)
- **Clue numbers** (for the average and distribution) are recorded from the
  daily game's state, or else from framed's `title-log` (the last guess slot
  used). Wins that have neither are counted as wins but left out of the
  average.

## Tweaks

- Strictly red/green: remove the `playing` entry from `COLORS` in the script.
- Colors are Tailwind values matching the site's palette (emerald-600, red-600,
  amber-700) — edit `COLORS` to taste.
