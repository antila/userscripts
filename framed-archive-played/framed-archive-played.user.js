// ==UserScript==
// @name         Framed Archive Played Tracker
// @namespace    anders.userscripts
// @version      1.0.0
// @description  Colors days on the framed.wtf archive pages: green = won, red = lost, amber = started but unfinished.
// @match        https://framed.wtf/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'framed-archive-played-v1';

  // Framed stores the *current* game only, under `day` + `gameState`
  // (JSON-encoded), with a prefix per game mode. We snapshot those into our
  // own persistent per-day record while the user plays.
  const MODES = [
    { name: 'classic', prefix: '', archivePath: '/archive' },
    { name: 'one-frame', prefix: 'one-frame-', archivePath: '/archive/one-frame' },
    { name: 'titleshot', prefix: 'titleshot-', archivePath: '/archive/titleshot' },
    { name: 'poster', prefix: 'poster-', archivePath: '/archive/poster' },
  ];

  const COLORS = {
    won: '#059669', // emerald-600
    lost: '#dc2626', // red-600
    playing: '#b45309', // amber-700
  };

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveStore(store) {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  // Snapshot framed's current-game state for every mode into our record.
  // Returns true if anything changed.
  function recordCurrentGames(store) {
    let changed = false;
    for (const mode of MODES) {
      const day = readJSON(mode.prefix + 'day');
      const state = readJSON(mode.prefix + 'gameState');
      if (!Number.isInteger(day) || !['playing', 'won', 'lost'].includes(state)) continue;

      const days = (store[mode.name] = store[mode.name] || {});
      const prev = days[day];
      // A finished result is final; never downgrade won/lost back to playing.
      if (prev === state || ((prev === 'won' || prev === 'lost') && state === 'playing')) continue;
      days[day] = state;
      changed = true;
    }
    return changed;
  }

  function colorArchiveLinks(store) {
    for (const mode of MODES) {
      const days = store[mode.name];
      if (!days) continue;
      const links = document.querySelectorAll(`a[href^="${mode.archivePath}?day="]`);
      for (const link of links) {
        const day = new URL(link.href, location.origin).searchParams.get('day');
        // The "Random Movie" button uses the same href shape; day links are
        // labeled with their own number.
        if (link.textContent.trim() !== day) continue;
        const state = days[day];
        if (link.dataset.playedState === (state || '')) continue;
        link.dataset.playedState = state || '';
        if (state) {
          link.style.setProperty('background-color', COLORS[state], 'important');
        } else {
          link.style.removeProperty('background-color');
        }
      }
    }
  }

  function tick() {
    const store = loadStore();
    if (recordCurrentGames(store)) saveStore(store);
    colorArchiveLinks(store);
  }

  tick();
  // Polling covers both live play (gameState updates after each guess) and
  // Next.js client-side navigation re-rendering the archive list.
  setInterval(tick, 750);
})();
