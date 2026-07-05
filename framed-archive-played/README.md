# Framed Archive Played Tracker

Userscript for [framed.wtf](https://framed.wtf) that colors the day links on the
archive pages based on whether you've played them:

- 🟩 **Green** — won
- 🟥 **Red** — lost
- 🟧 **Amber** — started but not finished
- ⬜ Normal slate — not played

Works on all four archive tabs: Classic (`/archive`), One Frame, Titleshot and
Poster.

## Install

1. Install a userscript manager in Firefox, e.g.
   [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/) or
   [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/).
2. Open the extension dashboard, create a new script, and paste in the contents
   of [`framed-archive-played.user.js`](framed-archive-played.user.js) — or drag
   the file into Firefox.

## How it works

Framed itself keeps no per-day history: its localStorage only holds the
*current* game (`day` + `gameState`, prefixed per mode, e.g. `one-frame-day`),
and each new game overwrites the previous one.

So the script builds its own history:

- While you play (the daily or any archive day, in any mode), it polls framed's
  localStorage every 750 ms and records each day's result under its own key,
  `framed-archive-played-v1`.
- On the archive pages it colors the day links from that record. Polling also
  handles Next.js client-side navigation, so colors survive tab switches
  without a page reload.

## Limitations

- **History starts at install time.** Games played before installing the script
  can't be recovered (framed never stored them); only the most recent game per
  mode is backfilled on first run.
- The record lives in localStorage for framed.wtf, which never expires but is
  deleted if you clear cookies/site data for the site (this would also wipe
  your framed stats). Back it up from the devtools console with
  `copy(localStorage.getItem('framed-archive-played-v1'))`.

## Tweaks

- Strictly red/green: remove the `playing` entry from `COLORS` in the script.
- Colors are Tailwind values matching the site's palette (emerald-600, red-600,
  amber-700) — edit `COLORS` to taste.
