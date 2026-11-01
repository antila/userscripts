// ==UserScript==
// @name         Flickle Tools
// @namespace    anders.userscripts
// @version      1.2.0
// @description  Fullscreen game layout for flickle.co, plus import/export of your history, stats and watchlist.
// @match        https://flickle.co/*
// @match        https://www.flickle.co/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  console.log("[Flickle Tools] initialized");

  // Flickle keeps all player data in localStorage under `flickle_` keys:
  // per-mode histories (date -> result, which flickle's own stats screen is
  // computed from), the watchlist, and "seen"/"started" flags. Exporting
  // every `flickle_` key picks up new modes without changes here.
  const KEY_PREFIX = "flickle_";
  const EXPORT_FORMAT = "flickle-backup";

  const LABELS = {
    flickle_history_movie: "Classic · Movies",
    flickle_history_tv: "Classic · TV",
    flickle_cast_history_movie: "Cast · Movies",
    flickle_cast_history_tv: "Cast · TV",
    flickle_hilo_history_movie: "Hi-Lo · Movies",
    flickle_hilo_history_tv: "Hi-Lo · TV",
    flickle_timeline_history: "Timeline",
    flickle_career_history: "Career",
  };

  function flickleKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) keys.push(key);
    }
    return keys.sort();
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (_e) {
      return undefined;
    }
  }

  const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

  // History values look like { "2026-10-31": { status, ... }, ... }.
  function isHistory(v) {
    if (!isPlainObject(v)) return false;
    const entries = Object.values(v);
    return entries.length > 0 && entries.every((e) => isPlainObject(e) && "status" in e);
  }

  const isFinished = (entry) => isPlainObject(entry) && entry.status && entry.status !== "playing";

  // Summary rows for the history keys: games finished per mode.
  function summarize(data) {
    const rows = [];
    for (const [key, raw] of Object.entries(data)) {
      const value = parse(raw);
      if (key === "flickle_watchlist" && Array.isArray(value)) {
        rows.push({ label: "Watchlist", count: value.length, unit: "title" });
      } else if (isHistory(value) || (key.includes("history") && isPlainObject(value))) {
        const entries = Object.values(value);
        const finished = entries.filter(isFinished).length;
        // Only win/lose modes get a "won" count (Hi-Lo ends as "finished").
        const winLose = entries.some((e) => e?.status === "won" || e?.status === "lost");
        const won = winLose ? entries.filter((e) => e?.status === "won").length : undefined;
        rows.push({ label: LABELS[key] || key, count: finished, unit: "game", won });
      }
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }

  // ---------------------------------------------------------------------
  // Export / import
  // ---------------------------------------------------------------------

  function buildExport() {
    const data = {};
    for (const key of flickleKeys()) data[key] = localStorage.getItem(key);
    return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), data };
  }

  function parseImport(text) {
    const raw = parse(text);
    if (!isPlainObject(raw)) throw new Error("That isn't a JSON object.");
    if (raw.format !== EXPORT_FORMAT || !isPlainObject(raw.data)) {
      throw new Error("That isn't a Flickle Tools export.");
    }
    const data = {};
    for (const [key, value] of Object.entries(raw.data)) {
      if (key.startsWith(KEY_PREFIX) && typeof value === "string") data[key] = value;
    }
    if (!Object.keys(data).length) throw new Error("The export contains no Flickle data.");
    return data;
  }

  // Merges one key. Returns the new raw value, or null to keep the local one.
  function mergeValue(localRaw, incomingRaw, report) {
    if (localRaw === null) {
      const incoming = parse(incomingRaw);
      if (isHistory(incoming)) report.daysAdded += Object.keys(incoming).length;
      else if (Array.isArray(incoming)) report.listItemsAdded += incoming.length;
      return incomingRaw;
    }
    if (localRaw === incomingRaw) return null;
    const local = parse(localRaw);
    const incoming = parse(incomingRaw);

    // Histories: per day, keep the local result unless it's missing or
    // still in progress and the import has a finished one.
    if (isPlainObject(local) && isPlainObject(incoming) && (isHistory(local) || isHistory(incoming))) {
      const out = { ...local };
      let changed = false;
      for (const [day, entry] of Object.entries(incoming)) {
        const mine = out[day];
        if (!mine) {
          out[day] = entry;
          report.daysAdded++;
          changed = true;
        } else if (!isFinished(mine) && isFinished(entry)) {
          out[day] = entry;
          report.daysCompleted++;
          changed = true;
        } else if (isFinished(mine) && isFinished(entry) && mine.status !== entry.status) {
          report.conflicts++;
        }
      }
      return changed ? JSON.stringify(out) : null;
    }

    // Lists of {id} (the watchlist): keep local order, append missing ids.
    if (Array.isArray(local) && Array.isArray(incoming)) {
      const ids = new Set(local.map((e) => e?.id));
      const extra = incoming.filter((e) => e?.id !== undefined && !ids.has(e.id));
      report.listItemsAdded += extra.length;
      return extra.length ? JSON.stringify([...local, ...extra]) : null;
    }

    // Any other object: add keys that are missing locally.
    if (isPlainObject(local) && isPlainObject(incoming)) {
      const extra = Object.keys(incoming).filter((k) => !(k in local));
      return extra.length ? JSON.stringify({ ...incoming, ...local }) : null;
    }

    return null; // scalars/flags: local wins
  }

  function applyImport(data, replace) {
    const report = { daysAdded: 0, daysCompleted: 0, conflicts: 0, listItemsAdded: 0 };
    if (replace) {
      for (const key of flickleKeys()) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(data)) localStorage.setItem(key, value);
      return report;
    }
    for (const [key, value] of Object.entries(data)) {
      const merged = mergeValue(localStorage.getItem(key), value, report);
      if (merged !== null) localStorage.setItem(key, merged);
    }
    return report;
  }

  // ---------------------------------------------------------------------
  // Fullscreen layout
  // ---------------------------------------------------------------------

  // Not a `flickle_` key, so it stays out of exports.
  const SETTINGS_KEY = "flickle-tools-settings";

  function loadSettings() {
    try {
      return { fullscreen: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
    } catch (_e) {
      return { fullscreen: true };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_e) {}
  }

  const settings = loadSettings();

  // Everything is scoped under html.ft-full so the toggle turns it all off.
  // The game's width cap normally comes from .responsive-game-container
  // (42–56rem); fitGame() replaces it with --ft-game-w, the width at which
  // the 16:9 frame plus the controls under it exactly fill the viewport.
  const LAYOUT_CSS = `
    html.ft-full .responsive-game-container { max-width: var(--ft-game-w, 42rem) !important; }
    /* Drop the header (logo, menu buttons, Movies/TV tabs) and the
       "Guess the movie" hint under the input. Only the hint text: the same
       row later holds a button on the right. */
    html.ft-full main header { display: none !important; }
    html.ft-full .max-w-md > div > p.uppercase.text-zinc-700 { display: none !important; }
    /* The desktop ad rail is laid out around the game column; hide it when
       the wider game leaves no room for it beside the game. */
    html.ft-full.ft-no-rail main > .fixed.inset-0.pointer-events-none { display: none !important; }
    /* Open the autocomplete upwards, over the frame, instead of below the
       input where it falls off the screen. */
    html.ft-full div:has(> #autocomplete-results) {
      top: auto !important; bottom: 100% !important;
      margin-top: 0 !important; margin-bottom: 8px !important;
    }
    html.ft-full #autocomplete-results { max-height: var(--ft-ac-h, 20rem) !important; }
  `;

  // The classic-style game: a 16:9 frame above a guess input with an
  // autocomplete list. Other modes (or pages) without both are left alone.
  function gameParts() {
    const input = document.querySelector('input[aria-autocomplete="list"]');
    const container = input?.closest(".responsive-game-container");
    const frame = container?.querySelector(".aspect-video");
    return input && frame ? { input, container, frame } : null;
  }

  function setVar(name, value) {
    const style = document.documentElement.style;
    if (value === null) style.removeProperty(name);
    else if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
  }

  // Height covered by the site's sticky footer ad (fixed to the bottom of
  // the viewport, loaded after the game), so the input isn't hidden under
  // it. 0 when it's absent or blocked.
  function bottomInset() {
    let inset = 0;
    for (const el of document.querySelectorAll(".adthrive-footer")) {
      if (getComputedStyle(el).position !== "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom >= window.innerHeight - 1) {
        inset = Math.max(inset, window.innerHeight - r.top);
      }
    }
    return inset;
  }

  function fitGame() {
    const root = document.documentElement;
    root.classList.toggle("ft-full", settings.fullscreen);
    if (!settings.fullscreen) return;

    const parts = gameParts();
    if (!parts) {
      // Keep the size while the game is on screen without its input (e.g.
      // after finishing); reset on pages without a game frame.
      if (!document.querySelector(".responsive-game-container .aspect-video")) {
        setVar("--ft-game-w", null);
        root.classList.remove("ft-no-rail");
      }
      return;
    }
    const { input, container, frame } = parts;
    const f = frame.getBoundingClientRect();
    const controls = (input.closest(".max-w-md") || input).getBoundingClientRect();
    // Height of everything above the frame (header, tabs) and of the
    // controls below it (frame buttons, progress bar, input). Neither depends
    // on the frame's width, so this converges in one step.
    const above = f.top + window.scrollY;
    const below = controls.bottom - f.bottom;
    const cs = getComputedStyle(container);
    const padX = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight);
    const availH = window.innerHeight - bottomInset() - above - below - 12;
    const frameW = Math.max(320, Math.min(window.innerWidth - padX, (availH * 16) / 9));
    const width = Math.floor(frameW + padX);

    setVar("--ft-game-w", `${width}px`);
    root.classList.toggle("ft-no-rail", (window.innerWidth - width) / 2 < 320);
    // Let the upward autocomplete use the space between the frame's top
    // and the input.
    const room = input.getBoundingClientRect().top - Math.max(f.top, 0) - 16;
    setVar("--ft-ac-h", `${Math.max(160, Math.min(480, Math.floor(room)))}px`);
  }

  function initLayout() {
    const style = document.createElement("style");
    style.id = "flickle-tools-layout";
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);
    fitGame();
    window.addEventListener("resize", fitGame);
    // Polling covers the game loading in after hydration, client-side
    // navigation between modes, and the controls changing as you play.
    setInterval(fitGame, 500);
  }

  // ---------------------------------------------------------------------
  // Panel UI (in a shadow root so the site's Tailwind styles don't leak in)
  // ---------------------------------------------------------------------

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
    .fab {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 50%; border: 1px solid #3f3f46;
      background: #18181b; color: #d4d4d8; cursor: pointer; opacity: .6;
      display: grid; place-items: center; box-shadow: 0 2px 8px rgba(0,0,0,.4);
      transition: opacity .15s;
    }
    .fab:hover, .fab:focus-visible { opacity: 1; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.75);
      display: none; align-items: center; justify-content: center; padding: 16px;
    }
    .backdrop.open { display: flex; }
    .panel {
      width: min(520px, 100%); max-height: calc(100vh - 32px); overflow: auto;
      background: #09090b; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 12px;
      padding: 16px 18px 20px; font-size: 14px; line-height: 1.4;
      scrollbar-color: #3f3f46 transparent;
    }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .head h2 { margin: 0; font-size: 16px; flex: 1; }
    button { font: inherit; cursor: pointer; }
    .x { background: none; border: 0; color: #a1a1aa; font-size: 20px; line-height: 1; padding: 4px; }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #a1a1aa; margin: 0 0 8px; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { padding: 4px 6px; text-align: right; border-bottom: 1px solid #27272a; }
    th:first-child, td:first-child { text-align: left; }
    th { color: #a1a1aa; font-weight: 500; font-size: 12px; }
    .note { color: #a1a1aa; font-size: 12px; margin: 4px 0 0; }
    .section { margin-bottom: 20px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .btn { background: #18181b; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px 12px; }
    .btn:hover { border-color: #71717a; }
    .btn.primary { background: #16a34a; border-color: #16a34a; color: #fff; }
    .btn.danger { border-color: #7f1d1d; color: #fca5a5; }
    input[type=file] { color: #d4d4d8; }
    .check { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
    .check input { margin-top: 3px; accent-color: #eab308; }
    textarea {
      width: 100%; min-height: 90px; resize: vertical; background: #000; color: #e4e4e7;
      border: 1px solid #3f3f46; border-radius: 6px; padding: 8px;
      font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .msg { margin-top: 8px; font-size: 13px; min-height: 1em; }
    .msg.ok { color: #86efac; }
    .msg.err { color: #fca5a5; }
  `;

  const ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/>
    <circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>`;

  function summaryTable(rows) {
    if (!rows.length) return `<p class="note">No Flickle games recorded in this browser yet.</p>`;
    return `<table>
      <tr><th>Data</th><th>Count</th></tr>
      ${rows
        .map(
          (r) =>
            `<tr><td>${r.label}</td><td>${plural(r.count, r.unit)}${
              r.won !== undefined && r.count ? ` (${r.won} won)` : ""
            }</td></tr>`,
        )
        .join("")}
    </table>`;
  }

  function renderBody() {
    const data = buildExport().data;
    return `
      <div class="section">
        <h3>Layout</h3>
        <label class="check"><input type="checkbox" data-setting="fullscreen" ${
          settings.fullscreen ? "checked" : ""
        }> Fullscreen game: frame, guesses and input sized to fill the window, suggestions open over the frame</label>
      </div>
      <div class="section">
        <h3>In this browser</h3>
        ${summaryTable(summarize(data))}
      </div>
      <div class="section">
        <h3>Export</h3>
        <p class="note">Saves all Flickle data (history and stats for every mode, watchlist, settings). Import the file in the other browser.</p>
        <div class="row">
          <button class="btn primary" data-act="download">Download JSON</button>
          <button class="btn" data-act="copy">Copy to clipboard</button>
        </div>
      </div>
      <div class="section">
        <h3>Import</h3>
        <p class="note">Pick an exported file or paste its contents. <b>Merge</b> keeps everything here and adds what's missing; <b>Replace</b> discards this browser's Flickle data first. The page reloads afterwards so Flickle picks up the data.</p>
        <div class="row"><input type="file" accept=".json,application/json"></div>
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
    if (document.getElementById("flickle-tools-host")) return;
    const host = document.createElement("div");
    host.id = "flickle-tools-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <button class="fab" title="Flickle Tools" aria-label="Flickle Tools">${ICON}</button>
      <div class="backdrop">
        <div class="panel" role="dialog" aria-modal="true" aria-label="Flickle Tools">
          <div class="head">
            <h2>Flickle Tools</h2>
            <button class="x" aria-label="Close">×</button>
          </div>
          <div class="body"></div>
        </div>
      </div>`;
    document.body.appendChild(host);

    const backdrop = root.querySelector(".backdrop");
    const body = root.querySelector(".body");
    const isOpen = () => backdrop.classList.contains("open");

    function message(text, ok) {
      const el = root.querySelector(".msg");
      el.textContent = text;
      el.className = `msg ${ok ? "ok" : "err"}`;
    }

    function open() {
      body.innerHTML = renderBody();
      backdrop.classList.add("open");
    }
    function close() {
      backdrop.classList.remove("open");
    }

    function doImport(replace) {
      const text = root.querySelector("textarea").value.trim();
      if (!text) return message("Choose a file or paste exported JSON first.", false);
      let data;
      try {
        data = parseImport(text);
      } catch (e) {
        return message(`Couldn't read that: ${e.message}`, false);
      }
      if (replace && !confirm("Replace all Flickle data in this browser with the imported data?")) {
        return;
      }
      const r = applyImport(data, replace);
      const summary = replace
        ? `Replaced with ${plural(Object.keys(data).length, "imported key")}.`
        : `Merged: ${plural(r.daysAdded, "game")} added, ${plural(r.daysCompleted, "unfinished game")} completed, ${plural(r.listItemsAdded, "watchlist title")} added${
            r.conflicts ? `, ${plural(r.conflicts, "conflicting game")} kept as they were` : ""
          }.`;
      // Flickle reads its history once on load and writes the whole object
      // back after each game, so reload before anything can overwrite it.
      message(`${summary} Reloading…`, true);
      setTimeout(() => location.reload(), 1500);
    }

    root.querySelector(".fab").addEventListener("click", open);
    root.querySelector(".x").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    // Keep keystrokes inside the panel away from the game's key handlers.
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
      if (t.dataset.act === "download") {
        const json = JSON.stringify(buildExport(), null, 2);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = `flickle-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
      if (input instanceof HTMLInputElement && input.dataset.setting) {
        settings[input.dataset.setting] = input.checked;
        saveSettings(settings);
        fitGame();
        return;
      }
      if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.files[0]) return;
      root.querySelector("textarea").value = await input.files[0].text();
      message(`Loaded ${input.files[0].name}. Choose Merge or Replace.`, true);
    });
  }

  initLayout();
  mountPanel();
})();
