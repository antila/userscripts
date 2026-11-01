# Flickle Tools

Userscript for [flickle.co](https://www.flickle.co). For now it adds an
**import / export** panel for moving your Flickle data between browsers or
devices.

A small upload-arrow button in the bottom-right corner opens the panel. It
shows what this browser has (games finished per mode, watchlist size) and lets
you:

- **Export**: download the data as a JSON file, or copy it to the clipboard.
- **Import**: pick an exported file (or paste it), then
  - **Merge** keeps everything already in this browser and adds what's
    missing: new days, days that were only started here but finished in the
    import, and watchlist titles. If both sides finished the same day with
    different results, the local one is kept.
  - **Replace** deletes this browser's Flickle data first, then writes the
    import.

The page reloads after an import so Flickle picks up the new data.

## Install

1. Install a userscript manager in Firefox, e.g.
   [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/) or
   [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/).
2. Open the extension dashboard, create a new script, and paste in the contents
   of [`flickle-tools.user.js`](flickle-tools.user.js) — or drag the file into
   Firefox.

## How it works

Flickle has no accounts; everything lives in its localStorage under keys
starting with `flickle_`:

| Key | Contents |
| --- | --- |
| `flickle_history_movie` / `_tv` | Classic: `{ "YYYY-MM-DD": { status, guesses, currentFrame, gameId } }` |
| `flickle_cast_history_movie` / `_tv` | Cast Game, same shape |
| `flickle_hilo_history_movie` / `_tv` | Hi-Lo: `{ status: "finished", score, answers, … }` per day |
| `flickle_timeline_history` | Timeline: `{ status, attempts, items, feedback }` per day |
| `flickle_career_history` | Career Game, same shape as classic |
| `flickle_watchlist` | Array of `{ id, title, poster, type, dateAdded, … }` |
| `flickle_*_tutorial_seen`, `flickle_campaign_*_seen`, `flickle_started_*` | Flags |

Flickle's own statistics (win %, streaks, guess distribution) are calculated
from the history keys, so they move along with them.

The export copies every `flickle_` key as-is, so modes added later are
included without script changes. A merge works key by key:

- **History** (date → `{status}`): adds missing days, and replaces a local
  `playing` day with a finished one.
- **Lists of `{id}`** (the watchlist): appends titles whose `id` isn't there
  yet, keeping the local order.
- **Other objects**: adds missing properties.
- **Flags / plain values**: the local value wins; missing keys are added.

The reload matters: the classic, cast and career games read their history once
on page load and write the whole object back after each game, so without a
reload the next finished game would overwrite the imported history.
