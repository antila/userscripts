// ==UserScript==
// @name         Framed Archive Played Tracker
// @namespace    anders.userscripts
// @version      1.0.1
// @description  Colors days on the framed.wtf archive pages: green = won, red = lost, amber = started but unfinished.
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
    const slots = readJSON(`${mode.prefix}title-log`)?.[day];
    const clues = Array.isArray(slots) ? slots.filter(Boolean).length : 0;
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
    if (changed) saveStore(store);
    colorArchiveLinks(store);
    replayFinishedGame(store);
  }

  tick();
  // Polling covers both live play (the DOM / gameData update after each
  // guess) and Next.js client-side navigation re-rendering the archive list.
  setInterval(tick, 750);
})();
