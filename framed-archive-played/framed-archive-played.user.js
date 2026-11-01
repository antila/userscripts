// ==UserScript==
// @name         Framed Archive Played Tracker
// @namespace    anders.userscripts
// @version      1.1.0
// @description  Colors days on the framed.wtf archive pages (green = won, red = lost, amber = started), plus win/loss statistics and data import/export.
// @match        https://framed.wtf/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  console.log("[Framed Archive Played Tracker] initialized");

  const STORE_KEY = "framed-archive-played-v1";

  // Key prefixes follow framed's own scheme: bare keys for the classic game,
  // `<gameType>-` for the other modes.
  const MODES = [
    { name: "classic", prefix: "", archivePath: "/archive" },
    { name: "one-frame", prefix: "one-frame-", archivePath: "/archive/one-frame" },
    { name: "titleshot", prefix: "titleshot-", archivePath: "/archive/titleshot" },
    { name: "poster", prefix: "poster-", archivePath: "/archive/poster" },
  ];

  const COLORS = {
    won: "#059669", // emerald-600
    lost: "#dc2626", // red-600
    playing: "#b45309", // amber-700
  };

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (_e) {
      return {};
    }
  }

  function saveStore(store) {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (_e) {
      return null;
    }
  }

  // Deduplicates debug output across the 750ms polling loop: only logs when
  // the message for a given key changes.
  const lastLogged = new Map();
  function logChange(key, ...args) {
    const msg = JSON.stringify(args);
    if (lastLogged.get(key) === msg) return;
    lastLogged.set(key, msg);
    console.log("[Framed Archive Played Tracker]", ...args);
  }

  function record(store, mode, day, state) {
    if (!Number.isInteger(day) || !["playing", "won", "lost"].includes(state)) return false;

    store[mode.name] = store[mode.name] || {};
    const days = store[mode.name];
    const prev = days[day];
    // A finished result is final; never downgrade won/lost back to playing.
    if (prev === state || ((prev === "won" || prev === "lost") && state === "playing")) {
      return false;
    }
    logChange(`record:${mode.name}:${day}`, mode.name, `recording day ${day}:`, prev, "->", state);
    days[day] = state;
    return true;
  }

  // store.steps[mode][day] = the clue (1–6) a won day was solved on. Kept
  // apart from the per-mode day maps so those stay plain day -> state.
  function getStep(store, mode, day) {
    return store.steps?.[mode.name]?.[day] || null;
  }

  function setStep(store, mode, day, step) {
    if (!Number.isInteger(step) || step < 1 || step > 6 || getStep(store, mode, day)) return false;
    store.steps = store.steps || {};
    store.steps[mode.name] = store.steps[mode.name] || {};
    store.steps[mode.name][day] = step;
    logChange(`step:${mode.name}:${day}`, mode.name, `day ${day} won on clue ${step}`);
    return true;
  }

  // Framed's title-log holds one entry per guess slot used for a day; on a
  // win the last used slot is the winning guess, so its position is the clue
  // the day was solved on.
  function lastUsedSlot(slots) {
    if (!Array.isArray(slots)) return null;
    for (let i = slots.length - 1; i >= 0; i--) if (slots[i]) return i + 1;
    return null;
  }

  // Daily games persist their state in localStorage as `day` + `gameData`
  // (a JSON object whose `gameState` is waiting/playing/won/lost). Snapshot
  // those into our own per-day record while the user plays.
  function recordDailyGames(store) {
    let changed = false;
    for (const mode of MODES) {
      const day = readJSON(`${mode.prefix}day`);
      const gameData = readJSON(`${mode.prefix}gameData`);
      const state = gameData ? gameData.gameState : null;
      logChange(`read:${mode.name}`, mode.name, "daily read", { day, state });
      changed = record(store, mode, day, state) || changed;
      // gameData mirrors the game's React state, where currentGuess is the
      // 0-based index of the winning guess once gameState is "won".
      if (state === "won" && Number.isInteger(gameData.currentGuess)) {
        changed = setStep(store, mode, day, gameData.currentGuess + 1) || changed;
      }
    }
    return changed;
  }

  // Fill in the winning clue for won days that don't have one yet (archive
  // wins, and wins recorded before steps were tracked) from title-log. The
  // archive day currently open is skipped: title-log may still be catching
  // up with the guess that just won it.
  function recordWinSteps(store) {
    const ctx = archiveGameContext();
    let changed = false;
    for (const mode of MODES) {
      const days = store[mode.name];
      if (!days) continue;
      const log = readJSON(`${mode.prefix}title-log`) || {};
      for (const [day, state] of Object.entries(days)) {
        if (state !== "won" || getStep(store, mode, day)) continue;
        if (ctx && ctx.mode === mode && String(ctx.day) === day) continue;
        changed = setStep(store, mode, day, lastUsedSlot(log[day])) || changed;
      }
    }
    return changed;
  }

  // Mode + day of the archive game currently open, or null when not on an
  // archive game page. (Unlike the archive grid's labels, the ?day= param is
  // reliable here: the game page derives its "FRAMED #n" from it.)
  function archiveGameContext() {
    const mode = MODES.find((m) => m.archivePath === location.pathname);
    const dayParam = new URLSearchParams(location.search).get("day");
    if (!mode || !/^\d+$/.test(dayParam || "")) return null;
    return { mode, day: Number(dayParam) };
  }

  // Archive plays never touch localStorage (framed skips all writes when
  // isArchive), so the only way to catch their outcome is to watch the game
  // page itself: the end-of-game panel says "You got it!" on a win and
  // "THE ANSWER WAS:" on a loss.
  function recordArchiveGame(store) {
    const ctx = archiveGameContext();
    if (!ctx) return false;
    const { mode, day } = ctx;

    let state = null;
    for (const p of document.querySelectorAll("p")) {
      const text = p.textContent.trim();
      if (text === "You got it!") state = "won";
      else if (text === "THE ANSWER WAS:") state = "lost";
      if (state) break;
    }
    logChange(`archive:${mode.name}`, mode.name, "archive game", { day, state });
    return record(store, mode, day, state);
  }

  // Framed's own `title-log` records which of the 6 guess slots were used per
  // day (for every mode, archive included). It says nothing about win/loss,
  // but any used slot means the day was at least attempted.
  function attemptedDays(mode) {
    const log = readJSON(`${mode.prefix}title-log`) || {};
    const days = new Set();
    for (const [day, slots] of Object.entries(log)) {
      if (Array.isArray(slots) && slots.some(Boolean)) days.add(day);
    }
    return days;
  }

  // Framed's per-day answers ship inside its JS bundle (guesses are validated
  // client-side). Pull the classic list out of the webpack module registry:
  // the module whose source mentions `occurrence:` exports a day-ordered
  // array of {title, id} — the answer to "FRAMED #n" is list[n - 1].
  let cachedAnswers;
  function classicAnswers() {
    if (cachedAnswers !== undefined) return cachedAnswers;
    if (!window.webpackChunk_N_E) return null; // not loaded yet, retry later
    cachedAnswers = null;
    try {
      let req;
      window.webpackChunk_N_E.push([["fap-probe"], {}, (r) => (req = r)]);
      for (const id of Object.keys(req.m)) {
        if (!String(req.m[id]).includes("occurrence:")) continue;
        for (const v of Object.values(req(id))) {
          if (Array.isArray(v) && v.length > 500 && v[0] && typeof v[0].title === "string") {
            cachedAnswers = v;
            return v;
          }
        }
      }
    } catch (_e) {}
    return cachedAnswers;
  }

  function answerForDay(mode, day) {
    if (mode.name !== "classic") return null; // other modes' lists not mapped
    return classicAnswers()?.[day - 1]?.title || null;
  }

  // Framed restarts already-played archive days as if they were never
  // touched. To get the real end screen back (answer, community guesses,
  // share), put the game into the finished state it would have reached: one
  // skip per clue that was used, then the correct answer — framed then
  // renders everything itself. Preferably in a single jump via the game's
  // React state; driving the UI guess by guess is the fallback.
  //
  // The replay decision is made once per opened day, from the data as it was
  // on arrival: title-log fills up while playing, so deciding later would
  // mistake an ongoing first play for a previous attempt.
  let replayedKey = null;
  let replayBusy = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function guessInput() {
    for (const input of document.querySelectorAll("input[placeholder]")) {
      if (/submit to skip/i.test(input.placeholder)) return input;
    }
    return null;
  }

  function submitGuess(text) {
    const input = guessInput();
    if (!input?.form) return false;
    // React listens to the native input event; set the value through the
    // native setter so the controlled component picks it up.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form.requestSubmit();
    return true;
  }

  // The game keeps {gameState, currentGuess, currentImage, guesses} in a
  // single useState hook. Walk the React fiber tree up from the guess input
  // to find it; its dispatch jumps straight to the finished state without
  // the UI flickering through the guesses.
  function gameStateDispatch() {
    try {
      const input = guessInput();
      const key = input && Object.keys(input).find((k) => k.startsWith("__reactFiber$"));
      let fiber = key ? input[key] : null;
      while (fiber) {
        let hook = fiber.memoizedState;
        while (hook && typeof hook === "object" && "memoizedState" in hook) {
          const s = hook.memoizedState;
          if (s && typeof s === "object" && !Array.isArray(s) && "gameState" in s) {
            const dispatch = hook.queue?.dispatch;
            if (dispatch) return dispatch;
          }
          hook = hook.next;
        }
        fiber = fiber.return;
      }
    } catch (_e) {}
    return null;
  }

  // Returns the guesses to replay, or null when there is nothing to restore.
  function replaySequence(store, mode, day) {
    const state = store[mode.name]?.[day];
    const clues =
      getStep(store, mode, day) || lastUsedSlot(readJSON(`${mode.prefix}title-log`)?.[day]) || 0;
    const answer = answerForDay(mode, day);

    const skips = ["", "", "", "", "", ""];
    if (state === "lost") return skips;
    if (state === "won") {
      // Skip up to the clue it was solved on, then the winning guess.
      return answer ? [...skips.slice(0, Math.max(clues, 1) - 1), answer] : null;
    }
    // No result recorded by this script = not certain the day was finished
    // (title-log only proves guesses were made, and a paused day must stay
    // playable without spoiling the answer).
    return null;
  }

  async function replayFinishedGame(store) {
    const ctx = archiveGameContext();
    if (!ctx || replayBusy) return;
    const key = `${ctx.mode.name}:${ctx.day}`;
    if (key === replayedKey) return;
    // Wait until the game UI (and, for wins, the answers list) is ready.
    if (!guessInput()) return;
    if (ctx.mode.name === "classic" && !classicAnswers()) return;

    replayedKey = key;
    const seq = replaySequence(store, ctx.mode, ctx.day);
    if (!seq) return;

    // The finished state these guesses would produce (verified against what
    // the game engine itself leaves behind after playing them out).
    const last = seq.length - 1;
    const won = seq[last] !== "";
    const guesses = seq.concat(Array(6 - seq.length).fill(""));

    const dispatch = gameStateDispatch();
    logChange(`replay:${key}`, ctx.mode.name, `day ${ctx.day}: restoring`, {
      instant: !!dispatch,
      seq,
    });
    if (dispatch) {
      dispatch((prev) => ({
        ...prev,
        gameState: won ? "won" : "lost",
        currentGuess: last,
        currentImage: last,
        guesses,
      }));
      return;
    }

    // Fallback when the fiber walk fails: drive the game's UI guess by guess.
    replayBusy = true;
    try {
      for (const guess of seq) {
        if (!submitGuess(guess)) break; // input gone = game finished
        await sleep(300); // let React process before the next guess
      }
    } finally {
      replayBusy = false;
    }
  }

  function colorArchiveLinks(store) {
    for (const mode of MODES) {
      const days = store[mode.name] || {};
      const attempted = attemptedDays(mode);
      const links = document.querySelectorAll(`a[href^="${mode.archivePath}?day="]`);
      for (const link of links) {
        // Identify days by the visible label, not the ?day= href param. On
        // the initially hydrated page the param can be stale by one: framed's
        // server and client can disagree about today's day number, and React
        // patches the label text on hydration but not the href attribute.
        // Clicking follows the label (client-side navigation), so the label
        // is the truth. This also skips the "Random Movie" button, which
        // shares the same href shape but has a text label.
        const day = link.textContent.trim();
        if (!/^\d+$/.test(day)) continue;
        const state = days[day] || (attempted.has(day) ? "playing" : undefined);
        if (link.dataset.playedState === (state || "")) continue;
        link.dataset.playedState = state || "";
        if (state) {
          link.style.setProperty("background-color", COLORS[state], "important");
        } else {
          link.style.removeProperty("background-color");
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------

  const MODE_LABELS = {
    classic: "Classic",
    "one-frame": "One Frame",
    titleshot: "Titleshot",
    poster: "Poster",
  };

  function modeStats(store, mode) {
    const days = store[mode.name] || {};
    const steps = store.steps?.[mode.name] || {};
    const s = { won: 0, lost: 0, dist: [0, 0, 0, 0, 0, 0], stepSum: 0, stepN: 0, unfinished: 0 };
    const finished = new Map(); // day number -> "won" | "lost"
    for (const [day, state] of Object.entries(days)) {
      if (state === "won") {
        s.won++;
        const step = steps[day];
        if (step >= 1 && step <= 6) {
          s.dist[step - 1]++;
          s.stepSum += step;
          s.stepN++;
        }
      } else if (state === "lost") {
        s.lost++;
      }
      if (state === "won" || state === "lost") finished.set(Number(day), state);
    }
    for (const day of new Set([...attemptedDays(mode), ...Object.keys(days)])) {
      if (!finished.has(Number(day))) s.unfinished++;
    }

    // Streaks run over consecutive day numbers: an unplayed day or a loss
    // breaks them. "Current" is the run ending at the highest finished day.
    let run = 0;
    let best = 0;
    let prev = null;
    for (const day of [...finished.keys()].sort((a, b) => a - b)) {
      if (finished.get(day) === "won") {
        run = prev !== null && day === prev + 1 && finished.get(prev) === "won" ? run + 1 : 1;
        best = Math.max(best, run);
      } else {
        run = 0;
      }
      prev = day;
    }
    s.bestStreak = best;
    s.currentStreak = run;
    return s;
  }

  function combineStats(list) {
    const s = { won: 0, lost: 0, dist: [0, 0, 0, 0, 0, 0], stepSum: 0, stepN: 0, unfinished: 0 };
    s.bestStreak = 0;
    for (const m of list) {
      for (const k of ["won", "lost", "stepSum", "stepN", "unfinished"]) s[k] += m[k];
      m.dist.forEach((n, i) => {
        s.dist[i] += n;
      });
      s.bestStreak = Math.max(s.bestStreak, m.bestStreak);
    }
    s.currentStreak = null; // not meaningful across modes
    return s;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const fmt = {
    pct: (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—"),
    ratio: (w, l) => (l ? (w / l).toFixed(2) : w ? "∞" : "—"),
    avg: (sum, n) => (n ? (sum / n).toFixed(2) : "—"),
  };

  // ---------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------

  const EXPORT_FORMAT = "framed-archive-played";
  const VALID_STATES = ["playing", "won", "lost"];

  function buildExport() {
    const titleLog = {};
    for (const mode of MODES) {
      const log = readJSON(`${mode.prefix}title-log`);
      if (log && typeof log === "object") titleLog[mode.name] = log;
    }
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      data: loadStore(),
      // framed's own guess-slot log: carries the amber "started" days and
      // the clue numbers of older wins over to the new browser.
      titleLog,
    };
  }

  // Accepts this script's export file or a bare store (the old
  // `localStorage.getItem('framed-archive-played-v1')` console backup).
  // Returns a sanitized store plus any title-log data.
  function parseImport(text) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object") throw new Error("That isn't a JSON object.");
    const wrapped = raw.format === EXPORT_FORMAT;
    const data = wrapped ? raw.data : raw;
    const store = {};
    let count = 0;
    for (const mode of MODES) {
      const days = data?.[mode.name];
      if (days && typeof days === "object") {
        for (const [day, state] of Object.entries(days)) {
          if (!/^\d+$/.test(day) || !VALID_STATES.includes(state)) continue;
          store[mode.name] = store[mode.name] || {};
          store[mode.name][day] = state;
          count++;
        }
      }
      const steps = data?.steps?.[mode.name];
      if (steps && typeof steps === "object") {
        for (const [day, step] of Object.entries(steps)) {
          if (/^\d+$/.test(day)) setStep(store, mode, day, step);
        }
      }
    }
    if (!count) throw new Error("No Framed results found in that data.");
    const titleLog = wrapped && raw.titleLog && typeof raw.titleLog === "object" ? raw.titleLog : {};
    return { store, titleLog, count };
  }

  function mergeStores(base, incoming) {
    const out = JSON.parse(JSON.stringify(base));
    const report = { added: 0, upgraded: 0, conflicts: 0 };
    for (const mode of MODES) {
      for (const [day, state] of Object.entries(incoming[mode.name] || {})) {
        out[mode.name] = out[mode.name] || {};
        const prev = out[mode.name][day];
        if (!prev) {
          out[mode.name][day] = state;
          report.added++;
        } else if (prev === "playing" && state !== "playing") {
          out[mode.name][day] = state;
          report.upgraded++;
        } else if (prev !== state && state !== "playing") {
          report.conflicts++; // both finished but disagree: keep this browser's
        }
      }
      for (const [day, step] of Object.entries(incoming.steps?.[mode.name] || {})) {
        setStep(out, mode, day, step);
      }
    }
    return { store: out, report };
  }

  // Only adds days framed's title-log doesn't have yet; never overwrites.
  function mergeTitleLogs(titleLog) {
    let added = 0;
    for (const mode of MODES) {
      const incoming = titleLog[mode.name];
      if (!incoming || typeof incoming !== "object") continue;
      const key = `${mode.prefix}title-log`;
      const log = readJSON(key) || {};
      for (const [day, slots] of Object.entries(incoming)) {
        if (/^\d+$/.test(day) && Array.isArray(slots) && !(day in log)) {
          log[day] = slots;
          added++;
        }
      }
      if (added) localStorage.setItem(key, JSON.stringify(log));
    }
    return added;
  }

  // ---------------------------------------------------------------------
  // Panel UI (in a shadow root so framed's Tailwind styles don't leak in)
  // ---------------------------------------------------------------------

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
    .fab {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 50%; border: 1px solid #334155;
      background: #1e293b; color: #cbd5e1; cursor: pointer; opacity: .6;
      display: grid; place-items: center; box-shadow: 0 2px 8px rgba(0,0,0,.4);
      transition: opacity .15s;
    }
    .fab:hover, .fab:focus-visible { opacity: 1; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483001; background: rgba(2,6,23,.7);
      display: none; align-items: center; justify-content: center; padding: 16px;
    }
    .backdrop.open { display: flex; }
    .panel {
      width: min(520px, 100%); max-height: calc(100vh - 32px); overflow: auto;
      background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 12px;
      padding: 16px 18px 20px; font-size: 14px; line-height: 1.4;
      scrollbar-color: #334155 transparent;
    }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .head h2 { margin: 0; font-size: 16px; flex: 1; }
    button { font: inherit; cursor: pointer; }
    .x { background: none; border: 0; color: #94a3b8; font-size: 20px; line-height: 1; padding: 4px; }
    .tabs, .modes { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; }
    .tabs button, .modes button {
      background: #1e293b; color: #cbd5e1; border: 1px solid #334155;
      border-radius: 999px; padding: 4px 12px;
    }
    .tabs button.on, .modes button.on { background: #e2e8f0; color: #0f172a; border-color: #e2e8f0; }
    .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
    .tile { background: #1e293b; border-radius: 8px; padding: 8px; text-align: center; }
    .tile b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
    .tile span { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: .03em; }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; margin: 0 0 8px; }
    .dist { display: grid; grid-template-columns: 16px 1fr; gap: 4px 8px; align-items: center; margin-bottom: 16px; }
    .dist .lbl { color: #94a3b8; text-align: right; font-variant-numeric: tabular-nums; }
    .bar {
      min-width: 24px; height: 20px; border-radius: 4px; background: #059669; color: #fff;
      font-size: 12px; padding: 0 6px; display: flex; align-items: center; justify-content: flex-end;
      font-variant-numeric: tabular-nums;
    }
    .bar.lost { background: #dc2626; }
    .bar.zero { background: #334155; color: #94a3b8; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin-bottom: 8px; }
    th, td { padding: 4px 6px; text-align: right; border-bottom: 1px solid #1e293b; }
    th:first-child, td:first-child { text-align: left; }
    th { color: #94a3b8; font-weight: 500; font-size: 12px; }
    .note { color: #94a3b8; font-size: 12px; margin: 4px 0 0; }
    .section { margin-bottom: 20px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .btn { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 6px 12px; }
    .btn:hover { border-color: #64748b; }
    .btn.primary { background: #059669; border-color: #059669; color: #fff; }
    .btn.danger { border-color: #7f1d1d; color: #fca5a5; }
    textarea {
      width: 100%; min-height: 90px; resize: vertical; background: #020617; color: #e2e8f0;
      border: 1px solid #334155; border-radius: 6px; padding: 8px;
      font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .msg { margin-top: 8px; font-size: 13px; min-height: 1em; }
    .msg.ok { color: #6ee7b7; }
    .msg.err { color: #fca5a5; }
    @media (max-width: 420px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
  `;

  const ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`;

  const ui = { tab: "stats", mode: "all" };

  function tile(value, label) {
    return `<div class="tile"><b>${value}</b><span>${label}</span></div>`;
  }

  function renderStats() {
    const store = loadStore();
    const perMode = MODES.map((m) => ({ mode: m, s: modeStats(store, m) }));
    const s =
      ui.mode === "all"
        ? combineStats(perMode.map((p) => p.s))
        : perMode.find((p) => p.mode.name === ui.mode).s;
    const played = s.won + s.lost;

    const modeButtons = [["all", "All modes"], ...MODES.map((m) => [m.name, MODE_LABELS[m.name]])]
      .map(([k, l]) => `<button data-mode="${k}" class="${ui.mode === k ? "on" : ""}">${l}</button>`)
      .join("");

    const max = Math.max(1, ...s.dist, s.lost);
    const bar = (label, n, cls) =>
      `<div class="lbl">${label}</div><div class="bar ${cls} ${n ? "" : "zero"}" style="width:${
        n ? Math.max(8, (n / max) * 100) : 0
      }%">${n}</div>`;
    const dist = s.dist.map((n, i) => bar(i + 1, n, "")).join("") + bar("✕", s.lost, "lost");

    const unknownSteps = s.won - s.stepN;
    const breakdown =
      ui.mode !== "all"
        ? ""
        : `<h3>By mode</h3><table>
            <tr><th>Mode</th><th>Played</th><th>Won</th><th>Win %</th><th>Avg clue</th></tr>
            ${perMode
              .map(
                ({ mode, s: m }) =>
                  `<tr><td>${MODE_LABELS[mode.name]}</td><td>${m.won + m.lost}</td><td>${m.won}</td>
                  <td>${fmt.pct(m.won, m.won + m.lost)}</td><td>${fmt.avg(m.stepSum, m.stepN)}</td></tr>`,
              )
              .join("")}
          </table>`;

    return `
      <div class="modes">${modeButtons}</div>
      <div class="tiles">
        ${tile(played, "Played")}
        ${tile(s.won, "Won")}
        ${tile(s.lost, "Lost")}
        ${tile(fmt.pct(s.won, played), "Win rate")}
        ${tile(fmt.ratio(s.won, s.lost), "W/L ratio")}
        ${tile(fmt.avg(s.stepSum, s.stepN), "Avg win clue")}
        ${tile(s.currentStreak ?? "—", "Streak")}
        ${tile(s.bestStreak, "Best streak")}
      </div>
      <div class="section">
        <h3>Solved on clue</h3>
        <div class="dist">${dist}</div>
        ${unknownSteps ? `<p class="note">${plural(unknownSteps, "win")} with unknown clue number (not counted in the average).</p>` : ""}
        ${s.unfinished ? `<p class="note">${plural(s.unfinished, "day")} started but not finished.</p>` : ""}
        <p class="note">Streaks count consecutive day numbers won; an unplayed day or a loss ends one.</p>
      </div>
      ${breakdown}
    `;
  }

  function renderData() {
    const store = loadStore();
    const total = MODES.reduce((n, m) => n + Object.keys(store[m.name] || {}).length, 0);
    return `
      <div class="section">
        <h3>Export</h3>
        <p class="note">${plural(total, "recorded day")}, plus framed's guess log. Save the file, then import it in the other browser.</p>
        <div class="row">
          <button class="btn primary" data-act="download">Download JSON</button>
          <button class="btn" data-act="copy">Copy to clipboard</button>
        </div>
      </div>
      <div class="section">
        <h3>Import</h3>
        <p class="note">Pick an exported file or paste its contents. <b>Merge</b> keeps everything here and adds what's missing; <b>Replace</b> discards this browser's results first.</p>
        <div class="row"><input type="file" accept=".json,application/json" data-act="file"></div>
        <div class="row"><textarea placeholder="Paste exported JSON here"></textarea></div>
        <div class="row">
          <button class="btn primary" data-act="merge">Merge</button>
          <button class="btn danger" data-act="replace">Replace</button>
        </div>
      </div>
      <div class="msg"></div>
    `;
  }

  function mountPanel() {
    if (document.getElementById("fap-panel-host")) return;
    const host = document.createElement("div");
    host.id = "fap-panel-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <button class="fab" title="Framed tracker: stats & data" aria-label="Framed tracker stats and data">${ICON}</button>
      <div class="backdrop">
        <div class="panel" role="dialog" aria-modal="true" aria-label="Framed tracker">
          <div class="head">
            <h2>Framed tracker</h2>
            <button class="x" aria-label="Close">×</button>
          </div>
          <div class="tabs">
            <button data-tab="stats">Statistics</button>
            <button data-tab="data">Import / export</button>
          </div>
          <div class="body"></div>
        </div>
      </div>`;
    document.body.appendChild(host);

    const backdrop = root.querySelector(".backdrop");
    const body = root.querySelector(".body");
    const isOpen = () => backdrop.classList.contains("open");

    function render() {
      for (const b of root.querySelectorAll("[data-tab]")) {
        b.classList.toggle("on", b.dataset.tab === ui.tab);
      }
      body.innerHTML = ui.tab === "stats" ? renderStats() : renderData();
    }

    function message(text, ok) {
      const el = root.querySelector(".msg");
      if (!el) return;
      el.textContent = text;
      el.className = `msg ${ok ? "ok" : "err"}`;
    }

    function open() {
      render();
      backdrop.classList.add("open");
    }
    function close() {
      backdrop.classList.remove("open");
    }

    function doImport(replace) {
      const text = root.querySelector("textarea").value.trim();
      if (!text) return message("Choose a file or paste exported JSON first.", false);
      let parsed;
      try {
        parsed = parseImport(text);
      } catch (e) {
        return message(`Couldn't read that: ${e.message}`, false);
      }
      if (replace && !confirm("Replace all results in this browser with the imported data?")) return;
      const logs = mergeTitleLogs(parsed.titleLog);
      if (replace) {
        saveStore(parsed.store);
        tick();
        render();
        message(
          `Replaced with ${plural(parsed.count, "imported day")} (${plural(logs, "guess-log day")} added).`,
          true,
        );
      } else {
        const { store, report } = mergeStores(loadStore(), parsed.store);
        saveStore(store);
        tick();
        render();
        const parts = [
          `${plural(report.added, "day")} added`,
          `${plural(report.upgraded, "unfinished day")} completed`,
        ];
        if (report.conflicts) {
          parts.push(`${plural(report.conflicts, "conflicting day")} kept as they were`);
        }
        parts.push(`${plural(logs, "guess-log day")} added`);
        message(`Merged: ${parts.join(", ")}.`, true);
      }
    }

    root.querySelector(".fab").addEventListener("click", open);
    root.querySelector(".x").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    // Keep keystrokes inside the panel away from framed's own key handlers.
    host.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) close();
    });

    root.addEventListener("click", async (e) => {
      const t = e.target instanceof Element ? e.target.closest("button") : null;
      if (!t) return;
      if (t.dataset.tab) {
        ui.tab = t.dataset.tab;
        render();
      } else if (t.dataset.mode) {
        ui.mode = t.dataset.mode;
        render();
      } else if (t.dataset.act === "download") {
        const json = JSON.stringify(buildExport(), null, 2);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = `framed-tracker-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        message("Export downloaded.", true);
      } else if (t.dataset.act === "copy") {
        try {
          await navigator.clipboard.writeText(JSON.stringify(buildExport()));
          message("Export copied to clipboard.", true);
        } catch (_e) {
          message("Clipboard access was blocked; use Download instead.", false);
        }
      } else if (t.dataset.act === "merge" || t.dataset.act === "replace") {
        doImport(t.dataset.act === "replace");
      }
    });

    root.addEventListener("change", async (e) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.files[0]) return;
      root.querySelector("textarea").value = await input.files[0].text();
      message(`Loaded ${input.files[0].name}. Choose Merge or Replace.`, true);
    });
  }

  // Framed's slide-out menu stays open after navigating; when an archive
  // link inside it is clicked, click its X button (top-right of the drawer)
  // to close it. The drawer check also keeps the archive grid's day links
  // (same paths, outside the drawer) from triggering this.
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link) return;
      const path = new URL(link.href, location.origin).pathname;
      if (!MODES.some((m) => m.archivePath === path)) return;
      const closeButton = document.querySelector("button.absolute.top-4.right-4");
      if (!closeButton?.closest("div.fixed")?.contains(link)) return;
      // After the link's own handler has started the navigation.
      setTimeout(() => closeButton.click(), 0);
    },
    true,
  );

  function tick() {
    const store = loadStore();
    let changed = recordDailyGames(store);
    changed = recordArchiveGame(store) || changed;
    changed = recordWinSteps(store) || changed;
    if (changed) saveStore(store);
    colorArchiveLinks(store);
    replayFinishedGame(store);
  }

  mountPanel();
  tick();
  // Polling covers both live play (the DOM / gameData update after each
  // guess) and Next.js client-side navigation re-rendering the archive list.
  setInterval(tick, 750);
})();
