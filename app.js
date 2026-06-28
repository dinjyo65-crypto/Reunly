/**
 * app.js — UI controller for Reunly.
 *
 * Responsibilities: screen navigation, in-memory state, rendering, and wiring
 * user input back into the (pure) engine. All recommendation/cost math lives in
 * engine.js; this file only orchestrates and renders.
 *
 * Security note: every value that originates from user input is inserted via
 * textContent or createElement — never innerHTML with interpolation — so the app
 * is not vulnerable to stored/reflected XSS from participant fields.
 */

(function () {
  "use strict";

  const D = window.ReunlyData;
  const E = window.ReunlyEngine;
  const CURRENCY = D.CURRENCY;
  // Ordinal labels derived from the configured number of ranked slots, so adding
  // a 4th choice only requires bumping RANKED_SLOTS in data.js.
  const RANK_LABELS = ["1st", "2nd", "3rd", "4th", "5th", "6th"].slice(0, D.RANKED_SLOTS);

  // ---- App state (persisted to localStorage; see saveState/loadState) ----
  const state = {
    user: null, // {name, email, city}
    reunion: { name: "", type: "Family", code: "—" },
    participants: D.SEED_PARTICIPANTS.map((p) => ({ ...p })),
    editingId: null, // which participant card is open for editing
    currencyMode: "local", // "local" (per traveller) | "usd"
    fromInvite: false, // arrived via a shared invite link
  };

  // Fare provider injected into the engine: prefer a fetched (live/searched)
  // fare from the proxy cache, fall back to the synchronous engine estimate.
  const fareProvider = (from, to) =>
    window.ReunlyFares.getCached(from, to) || E.getFare(from, to);

  // ---- Persistence ----
  const LS_STATE = "reunly_state_v1";
  function saveState() {
    try {
      localStorage.setItem(
        LS_STATE,
        JSON.stringify({
          user: state.user,
          reunion: state.reunion,
          participants: state.participants,
          currencyMode: state.currencyMode,
        })
      );
    } catch (e) {
      /* storage unavailable — prototype still works in-memory */
    }
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_STATE) || "null");
      if (s && Array.isArray(s.participants)) {
        state.user = s.user || null;
        state.reunion = s.reunion || state.reunion;
        state.participants = s.participants;
        state.currencyMode = s.currencyMode || "local";
        return true;
      }
    } catch (e) {
      /* corrupt — ignore */
    }
    return false;
  }
  function clearState() {
    try {
      localStorage.removeItem(LS_STATE);
    } catch (e) {
      /* ignore */
    }
  }

  // Full reset: tear down the service worker + caches + saved state, then reload
  // fresh. Used by the Restart button and as the self-heal recovery path.
  async function nukeCaches() {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch (e) {
      /* ignore */
    }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {
      /* ignore */
    }
  }
  async function fullReset() {
    await nukeCaches();
    clearState();
    location.hash = "";
    location.reload();
  }

  // Self-heal: if stale cached code throws (e.g. a version mismatch between
  // app.js and fares.js after an update), clear caches + the SW and reload ONCE
  // per session so the user recovers without touching DevTools.
  let recovering = false;
  async function selfHeal() {
    if (recovering) return;
    let already = false;
    try {
      already = sessionStorage.getItem("reunly_selfheal") === "1";
    } catch (e) {
      /* ignore */
    }
    if (already) return; // already tried this session — avoid reload loops
    recovering = true;
    try {
      sessionStorage.setItem("reunly_selfheal", "1");
    } catch (e) {
      /* ignore */
    }
    await nukeCaches();
    location.reload();
  }
  window.addEventListener("error", selfHeal);
  window.addEventListener("unhandledrejection", selfHeal);

  // ---- Shareable invite links (state encoded in the URL hash, no backend) ----
  function buildShareUrl() {
    const payload = {
      v: 1,
      code: state.reunion.code,
      name: state.reunion.name,
      type: state.reunion.type,
      p: state.participants.map((p) => ({
        n: p.name, e: p.email, c: p.city, d: p.dates, x: p.destinations,
      })),
    };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return `${location.origin}${location.pathname}#r=${b64}`;
  }
  function importFromHash() {
    const m = (location.hash || "").match(/^#r=(.+)$/);
    if (!m) return false;
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      if (data && Array.isArray(data.p)) {
        state.reunion = {
          name: data.name || "Shared reunion",
          type: data.type || "Friends",
          code: data.code || generateInviteCode(data.type),
        };
        state.participants = data.p.map((x) =>
          D.makeParticipant({ name: x.n, email: x.e, city: x.c, dates: x.d, destinations: x.x })
        );
        return true;
      }
    } catch (e) {
      /* malformed link — ignore */
    }
    return false;
  }
  async function shareInvite() {
    const url = buildShareUrl();
    try {
      if (navigator.share) {
        await navigator.share({ title: `Join ${state.reunion.name || "our reunion"} on Reunly`, url });
        return;
      }
    } catch (e) {
      return; // user dismissed the share sheet
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied to clipboard");
    } catch (e) {
      window.prompt("Copy this invite link:", url);
    }
  }

  // ---- Tiny DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      // NOTE: intentionally no innerHTML path — all dynamic content goes through
      // textContent/createTextNode so user input can never inject markup (XSS).
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== null && v !== undefined) {
        node.setAttribute(k, v);
      }
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  };

  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = el("div", { id: "toast", class: "toast" });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(`#screen-${id}`).classList.add("active");
    $("#restartBtn").hidden = id === "register";
    window.scrollTo(0, 0);
  }

  function generateInviteCode(type) {
    const prefix = (type || "REU").slice(0, 3).toUpperCase();
    const n = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${n}`;
  }

  // -------------------------------------------------------------------------
  // City datalist
  // -------------------------------------------------------------------------
  function populateCityList() {
    const dl = $("#cityList");
    dl.textContent = "";
    D.CITY_LIST.forEach((city) => dl.appendChild(el("option", { value: city })));
  }

  // -------------------------------------------------------------------------
  // Screen: Register
  // -------------------------------------------------------------------------
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function wireRegister() {
    $("#regSubmit").addEventListener("click", () => {
      const name = $("#regName").value.trim();
      const email = $("#regEmail").value.trim();
      const city = $("#regCity").value.trim();
      const err = $("#regError");
      if (!name) return (err.textContent = "Please enter your name.");
      if (!isValidEmail(email)) return (err.textContent = "Please enter a valid email.");
      if (!city) return (err.textContent = "Please enter your home city.");
      err.textContent = "";
      state.user = { name, email, city };
      // Arrived via a shared invite link → skip the chooser, join straight in.
      if (state.fromInvite) {
        enterDashboard("join", state.reunion.code);
        return;
      }
      $("#choiceGreeting").textContent = `Hi ${name.split(" ")[0]} — what next?`;
      showScreen("choose");
    });
  }

  // -------------------------------------------------------------------------
  // Screen: Choose path
  // -------------------------------------------------------------------------
  function addCurrentUserAsParticipant() {
    // Add the registering user to the roster if not already present (by email).
    if (!state.user) return;
    const exists = state.participants.some(
      (p) => p.email.toLowerCase() === state.user.email.toLowerCase()
    );
    if (exists) return;
    state.participants.unshift(
      D.makeParticipant({
        name: state.user.name,
        email: state.user.email,
        city: state.user.city,
      })
    );
  }

  function enterDashboard(mode, code) {
    addCurrentUserAsParticipant();
    state.reunion.code = code || generateInviteCode(state.reunion.type);
    if (mode === "setup") {
      state.reunion.name = state.reunion.name || "Untitled Reunion";
    }
    $("#reunionName").value = state.reunion.name;
    $("#reunionType").value = state.reunion.type;
    // The current user's card starts open so they can fill their preferences.
    // Look them up by email rather than assuming a list position.
    const me =
      (state.user &&
        state.participants.find(
          (p) => p.email.toLowerCase() === state.user.email.toLowerCase()
        )) ||
      state.participants[0];
    state.editingId = me ? me.id : null;
    showScreen("dashboard");
    renderAll();
  }

  function wireChoose() {
    $("#chooseSetup").addEventListener("click", () => enterDashboard("setup"));
    $("#chooseJoin").addEventListener("click", () => {
      $("#joinPanel").hidden = !$("#joinPanel").hidden;
    });
    $("#joinSubmit").addEventListener("click", () => {
      const code = $("#joinCode").value.trim();
      if (!code) return ($("#joinError").textContent = "Enter the invitation code.");
      $("#joinError").textContent = "";
      enterDashboard("join", code.toUpperCase());
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard: reunion meta
  // -------------------------------------------------------------------------
  function wireReunionMeta() {
    $("#reunionName").addEventListener("input", (e) => {
      state.reunion.name = e.target.value;
      saveState();
    });
    $("#reunionType").addEventListener("change", (e) => {
      state.reunion.type = e.target.value;
      saveState();
    });
    $("#restartBtn").addEventListener("click", () => fullReset());
    $("#shareBtn").addEventListener("click", shareInvite);
    $("#currencyToggle").addEventListener("click", () => {
      state.currencyMode = state.currencyMode === "usd" ? "local" : "usd";
      updateCurrencyToggle();
      renderCosts();
      saveState();
    });
    $("#addParticipant").addEventListener("click", () => {
      const p = D.makeParticipant({ name: "New participant" });
      state.participants.push(p);
      state.editingId = p.id;
      renderAll();
      const node = document.getElementById(`pcard-${p.id}`);
      if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard: participant cards (inline editable)
  // -------------------------------------------------------------------------
  function chip(emoji, text) {
    const c = el("span", { class: "chip" });
    if (emoji) c.appendChild(el("span", { text: emoji }));
    c.appendChild(el("span", { text }));
    return c;
  }
  function summaryChips(p) {
    const chips = [];
    const firstDate = p.dates.find((d) => E.isValidRange(d));
    chips.push(chip("🏠", p.city || "no city"));
    chips.push(chip("🗓️", firstDate ? E.rangeLabel(firstDate) : "no dates"));
    chips.push(
      p.destinations[0]
        ? chip(D.cityEmoji(p.destinations[0]), p.destinations[0])
        : chip("📍", "no destination")
    );
    return chips;
  }

  function buildEditForm(p) {
    const wrap = el("div", { class: "pcard-edit" });

    // Identity fields
    const idGroup = el("div", { class: "field-group" });
    idGroup.appendChild(el("div", { class: "gl", text: "Details" }));
    const idRow = el("div", { class: "row" });
    idRow.appendChild(textInput(p, "name", "Full name"));
    idRow.appendChild(textInput(p, "email", "Email"));
    idGroup.appendChild(idRow);
    idGroup.appendChild(cityInput(p));
    wrap.appendChild(idGroup);

    // Date ranges (3 ranked)
    const dGroup = el("div", { class: "field-group" });
    dGroup.appendChild(el("div", { class: "gl", text: "Availability (ranked)" }));
    RANK_LABELS.forEach((label, i) => {
      const r = el("div", { class: "rank-row" });
      r.appendChild(el("span", { class: "badge rank", text: label }));
      r.appendChild(dateInput(p, i, "start"));
      r.appendChild(dateInput(p, i, "end"));
      dGroup.appendChild(r);
    });
    wrap.appendChild(dGroup);

    // Destinations (ranked) — type-ahead suggestions keep names consistent.
    const destGroup = el("div", { class: "field-group" });
    destGroup.appendChild(el("div", { class: "gl", text: "Destinations (ranked)" }));
    destGroup.appendChild(
      el("div", {
        class: "field-note",
        text: "Pick from the suggestions as you type so everyone's choices match.",
      })
    );
    RANK_LABELS.forEach((label, i) => {
      const r = el("div", { class: "rank-row dest" });
      r.appendChild(el("span", { class: "badge rank", text: label }));
      r.appendChild(destInput(p, i));
      destGroup.appendChild(r);
    });
    const helper = el("div", { class: "maps-helper" });
    const lookup = el("a", {
      href: E.mapsSearchLink("places to visit"),
      target: "_blank",
      rel: "noopener noreferrer",
      text: "🔎 Can't find it? Search on Google Maps",
    });
    helper.appendChild(lookup);
    destGroup.appendChild(helper);
    wrap.appendChild(destGroup);

    // Actions
    const actions = el("div", { class: "btn-row" });
    actions.appendChild(
      el("button", {
        class: "btn sm",
        text: "Done",
        onClick: () => {
          state.editingId = null;
          renderAll();
        },
      })
    );
    actions.appendChild(
      el("button", {
        class: "btn danger sm",
        text: "Remove",
        onClick: () => {
          state.participants = state.participants.filter((x) => x.id !== p.id);
          if (state.editingId === p.id) state.editingId = null;
          renderAll();
        },
      })
    );
    wrap.appendChild(actions);
    return wrap;
  }

  // --- Field builders: each writes straight into the participant object ---
  function textInput(p, key, placeholder) {
    return el("input", {
      type: key === "email" ? "email" : "text",
      value: p[key] || "",
      placeholder,
      onInput: (e) => {
        p[key] = e.target.value;
        if (key === "name" || key === "email") updateCardHeader(p);
      },
    });
  }
  function cityInput(p) {
    const wrap = el("div", { class: "field-group" });
    wrap.appendChild(el("label", { text: "Home city", for: `city-${p.id}` }));
    wrap.appendChild(
      el("input", {
        id: `city-${p.id}`,
        type: "text",
        list: "cityList",
        value: p.city || "",
        placeholder: "Type to see suggestions…",
        onInput: (e) => {
          p.city = e.target.value;
          scheduleRecompute();
        },
        onChange: () => updateCardHeader(p),
      })
    );
    return wrap;
  }
  function dateInput(p, idx, end) {
    return el("input", {
      type: "date",
      value: p.dates[idx][end] || "",
      onInput: (e) => {
        p.dates[idx][end] = e.target.value;
        scheduleRecompute();
      },
    });
  }
  function destInput(p, idx) {
    return el("input", {
      type: "text",
      list: "cityList",
      value: p.destinations[idx] || "",
      placeholder: `Choice ${idx + 1} — type to see suggestions`,
      autocomplete: "off",
      onInput: (e) => {
        p.destinations[idx] = e.target.value;
        scheduleRecompute();
      },
    });
  }

  // Single source of truth for how a participant's name + meta line read.
  const headerName = (p) => p.name || "Unnamed";
  const headerMeta = (p) => [p.email, p.city].filter(Boolean).join(" · ") || "—";

  function updateCardHeader(p) {
    const card = document.getElementById(`pcard-${p.id}`);
    if (!card) return;
    const nameEl = card.querySelector(".who .name");
    const metaEl = card.querySelector(".who .meta");
    if (nameEl) nameEl.textContent = headerName(p);
    if (metaEl) metaEl.textContent = headerMeta(p);
  }

  function renderParticipants() {
    const list = $("#participantList");
    list.textContent = "";
    if (!state.participants.length) {
      list.appendChild(el("div", { class: "empty", text: "No participants yet." }));
      return;
    }
    state.participants.forEach((p, idx) => {
      const editing = state.editingId === p.id;
      const card = el("div", {
        id: `pcard-${p.id}`,
        class: `card stagger${editing ? " highlight" : ""}`,
      });
      card.style.animationDelay = `${Math.min(idx, 8) * 0.04}s`;

      const head = el("div", { class: "pcard-head" });
      head.appendChild(
        el("div", { class: "pcard-avatar", text: D.cityEmoji(p.city) })
      );
      const who = el("div", { class: "who" });
      who.appendChild(el("div", { class: "name", text: headerName(p) }));
      who.appendChild(el("div", { class: "meta", text: headerMeta(p) }));
      head.appendChild(who);
      head.appendChild(
        el("button", {
          class: "btn secondary sm",
          style: "width:auto",
          text: editing ? "Close" : "Edit",
          onClick: () => {
            state.editingId = editing ? null : p.id;
            renderAll();
          },
        })
      );
      card.appendChild(head);

      if (editing) {
        card.appendChild(buildEditForm(p));
      } else {
        const summary = el("div", { class: "pcard-summary" });
        summaryChips(p).forEach((c) => summary.appendChild(c));
        card.appendChild(summary);
      }
      list.appendChild(card);
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard: recommendations
  // -------------------------------------------------------------------------
  function pct(x) {
    return `${Math.round(x * 100)}%`;
  }

  function scoreCell(lbl, value, fraction) {
    const cell = el("div", { class: "score-cell" });
    cell.appendChild(el("div", { class: "lbl", text: lbl }));
    cell.appendChild(el("div", { class: "val", text: value }));
    if (fraction != null) {
      const bar = el("div", { class: "bar" });
      const span = el("span");
      const target = pct(Math.max(0, Math.min(1, fraction)));
      // Animate width from 0 -> target (double rAF so the 0 state paints first).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          span.style.width = target;
        })
      );
      bar.appendChild(span);
      cell.appendChild(bar);
    }
    return cell;
  }

  // Attach a destination photo banner to a recommendation card. Uses the cached
  // photo immediately if present; otherwise fetches once and re-renders.
  let photoReqDest = null;
  function addRecPhoto(card, dest) {
    const cached = window.ReunlyFares.getCachedPhoto(dest);
    const banner = el("div", { class: "rec-photo" });
    if (cached) {
      banner.style.backgroundImage =
        `linear-gradient(180deg, rgba(8,11,22,0.15), rgba(8,11,22,0.85)), url("${cached}")`;
      banner.classList.add("has-photo");
    } else if (cached === undefined && photoReqDest !== dest) {
      // Not yet fetched — request once, then re-render recommendations.
      photoReqDest = dest;
      window.ReunlyFares.fetchPhoto(dest).then((url) => {
        if (url) renderRecommendations();
      });
    }
    const label = el("div", { class: "rec-photo-label" });
    label.appendChild(el("span", { class: "rec-photo-emoji", text: D.cityEmoji(dest) }));
    label.appendChild(el("span", { text: dest }));
    banner.appendChild(el("span", { class: "rec-photo-pin", text: "🏆 Top pick" }));
    banner.appendChild(label);
    card.appendChild(banner);
  }

  // Fire a one-off confetti burst when a clear winner is newly decided.
  let lastCelebrated = null;
  function maybeCelebrate(combos) {
    if (combos.length < 2) return;
    const winner = combos[0];
    const lead = winner.total - combos[1].total;
    const decisive = lead >= 0.06; // clear gap to #2
    const enoughData = state.participants.filter((p) => p.destinations[0]).length >= 3;
    const tag = `${winner.destination}|${winner.dateLabel}`;
    if (decisive && enoughData && tag !== lastCelebrated) {
      lastCelebrated = tag;
      confetti();
    }
  }

  function confetti() {
    const colors = ["#6366f1", "#a855f7", "#ec4899", "#34d399", "#fbbf24"];
    const layer = el("div", { class: "confetti" });
    for (let i = 0; i < 36; i++) {
      const piece = el("span", { class: "confetti-piece" });
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 0.25}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 2600);
  }

  function renderRecommendations() {
    const list = $("#recList");
    list.textContent = "";
    const combos = E.rankCombinations(state.participants, undefined, fareProvider).slice(0, 3);
    if (!combos.length) {
      list.appendChild(
        el("div", {
          class: "empty",
          text: "Add dates and destinations to participants to see recommendations.",
        })
      );
      return;
    }
    // Celebrate a newly-decided winner (see maybeCelebrate).
    maybeCelebrate(combos);

    const medals = ["🥇", "🥈", "🥉"];
    combos.forEach((c, i) => {
      const card = el("div", { class: `card rec-card stagger${i === 0 ? " gold" : ""}` });
      card.style.animationDelay = `${i * 0.07}s`;

      // Real destination photo banner on the #1 pick (Wikipedia via proxy).
      if (i === 0) addRecPhoto(card, c.destination);

      const top = el("div", { class: "rec-top" });
      top.appendChild(el("div", { class: "pos", text: medals[i] || `#${i + 1}` }));
      const titleWrap = el("div", { style: "flex:1;min-width:0" });
      const title = el("div", { class: "rec-title" });
      title.appendChild(el("span", { class: "rec-emoji", text: D.cityEmoji(c.destination) }));
      title.appendChild(el("span", { text: c.destination }));
      titleWrap.appendChild(title);
      titleWrap.appendChild(el("div", { class: "rec-sub", text: `📅 ${c.dateLabel}` }));
      top.appendChild(titleWrap);
      card.appendChild(top);

      const grid = el("div", { class: "score-grid" });
      grid.appendChild(scoreCell("Date", pct(c.dateScore), c.dateScore));
      grid.appendChild(scoreCell("Place", pct(c.destScore), c.destScore));
      grid.appendChild(scoreCell("Cost", pct(c.costScore), c.costScore));
      grid.appendChild(
        scoreCell(
          c.fareSearched ? "Avg fare ●" : "Avg fare ~",
          c.avgFare != null ? `$${Math.round(c.avgFare)}` : "—",
          null
        )
      );
      card.appendChild(grid);
      list.appendChild(card);
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard: travel costs
  // -------------------------------------------------------------------------
  function fareRangeFor(fromCity, toCity) {
    const fare = fareProvider(fromCity, toCity);
    if (!fare || fare.min == null) return null;
    // Prefer local distance; fall back to the distance the proxy computed
    // (e.g. for geocoded cities the client doesn't have coordinates for).
    let miles = E.distanceMiles(fromCity, toCity);
    if (miles == null && typeof fare.miles === "number") miles = fare.miles;
    return {
      miles,
      fare,
      flight: miles != null ? E.flightTimeHours(miles) : null,
      drive: miles != null ? E.driveTimeHours(miles) : null,
    };
  }

  function costCardSide(p, toCity, heading) {
    const side = el("div", { class: "card tight" });
    side.appendChild(el("div", { class: "cost-sub", text: heading }));
    if (!toCity) {
      side.appendChild(el("div", { class: "muted", text: "—" }));
      return side;
    }
    side.appendChild(el("div", { class: "badge gray", text: `${D.cityEmoji(toCity)} ${toCity}` }));
    const info = fareRangeFor(p.city, toCity);
    if (!info) {
      // Distinguish "still fetching from the proxy" from "proxy gave up".
      const resolved = window.ReunlyFares.isResolved(p.city, toCity);
      if (resolved) {
        side.appendChild(
          el("div", { class: "cost-meta", text: "No estimate for this city." })
        );
      } else {
        side.appendChild(el("div", { class: "skeleton sk-fare" }));
        side.appendChild(el("div", { class: "cost-meta muted", text: "Estimating fare…" }));
      }
      return side;
    }
    const fare = info.fare;
    // Region-aware display currency (the traveller pays from their home city),
    // unless the user has toggled the whole board to USD.
    const code = state.currencyMode === "usd" ? "USD" : D.currencyForCity(p.city);
    const fareRow = el("div", { class: "fare-row" });
    fareRow.appendChild(
      el("div", {
        class: "cost-fare",
        text: fare.min === 0 ? "Local" : E.formatRange(fare.min, fare.max, code),
      })
    );
    if (fare.min !== 0) {
      fareRow.appendChild(el("span", { class: "muted cur", text: code }));
    }
    // Provenance badge: live (proxy) / searched (curated) / estimated (distance).
    if (fare.source === "live") {
      fareRow.appendChild(el("span", { class: "badge good", text: "● live" }));
    } else if (fare.source === "searched") {
      fareRow.appendChild(
        el("span", { class: "badge good", text: `searched · ${fare.asOf}` })
      );
    } else if (fare.min !== 0) {
      fareRow.appendChild(el("span", { class: "badge warn", text: "estimated" }));
    }
    side.appendChild(fareRow);
    // Show the USD reference when displaying a non-USD local currency.
    if (fare.min !== 0 && code !== "USD") {
      side.appendChild(
        el("div", { class: "cost-meta", text: `≈ $${fare.min}–$${fare.max} USD` })
      );
    }
    // Distance + time. Drive time only shown when plausibly drivable (<= 800 mi),
    // so overseas routes don't display a nonsensical multi-day "drive".
    if (info.miles != null) {
      const metaParts = [`${Math.round(info.miles)} mi`];
      if (info.miles > 0) metaParts.push(`✈ ${E.formatHours(info.flight)}`);
      if (info.miles > 0 && info.miles <= 800) metaParts.push(`🚗 ${E.formatHours(info.drive)}`);
      side.appendChild(el("div", { class: "cost-meta", text: metaParts.join(" · ") }));
    }
    const links = el("div", { class: "cost-links" });
    links.appendChild(linkChip("Flights", E.googleFlightsLink(p.city, toCity)));
    links.appendChild(linkChip("Rome2Rio", E.rome2rioLink(p.city, toCity)));
    links.appendChild(linkChip("Maps", E.mapsRouteLink(p.city, toCity)));
    side.appendChild(links);
    return side;
  }

  function linkChip(label, href) {
    return el("a", { href, target: "_blank", rel: "noopener noreferrer", text: label });
  }

  function renderCosts() {
    const list = $("#costList");
    list.textContent = "";
    const combos = E.rankCombinations(state.participants, undefined, fareProvider);
    const groupBest = combos.length ? combos[0].destination : null;
    $("#costDestHint").textContent = groupBest
      ? `group best: ${groupBest}`
      : "no group pick yet";

    if (!groupBest) {
      list.appendChild(
        el("div", { class: "empty", text: "No destination data yet." })
      );
      return;
    }

    state.participants.forEach((p, idx) => {
      if (!p.city) return;
      const card = el("div", { class: "card stagger" });
      card.style.animationDelay = `${Math.min(idx, 8) * 0.04}s`;
      const head = el("div", { class: "pcard-head" });
      head.appendChild(el("div", { class: "pcard-avatar", text: D.cityEmoji(p.city) }));
      const who = el("div", { class: "who" });
      who.appendChild(el("div", { class: "name", text: p.name || "Unnamed" }));
      who.appendChild(el("div", { class: "meta", text: `from ${p.city}` }));
      head.appendChild(who);
      card.appendChild(head);

      const grid = el("div", { class: "cost-grid", style: "margin-top:10px" });
      grid.appendChild(costCardSide(p, groupBest, "Group best destination"));
      const pref = p.destinations[0] || "";
      const prefIsGroupBest =
        pref && pref.trim().toLowerCase() === groupBest.trim().toLowerCase();
      if (prefIsGroupBest) {
        const side = el("div", { class: "card tight side-note" });
        side.appendChild(el("div", { class: "cost-sub", text: "Their 1st preference" }));
        side.appendChild(el("span", { class: "badge good", text: "🎯 Same as group best" }));
      grid.appendChild(side);
      } else {
        grid.appendChild(costCardSide(p, pref, "Their 1st preference"));
      }
      card.appendChild(grid);
      list.appendChild(card);
    });
  }

  // -------------------------------------------------------------------------
  // Render orchestration + debounced recompute
  // -------------------------------------------------------------------------
  function renderMeta() {
    $("#inviteChip").textContent = `Invite code: ${state.reunion.code}`;
    $("#countChip").textContent = `${state.participants.length} participant${
      state.participants.length === 1 ? "" : "s"
    }`;
  }

  function updateCurrencyToggle() {
    const btn = $("#currencyToggle");
    if (btn) btn.textContent = state.currencyMode === "usd" ? "Show local" : "Show USD";
  }

  // Every (home city → candidate destination) route the views might price.
  // Fetched from the proxy so live/searched fares can upgrade the estimates.
  function neededRoutes() {
    const dests = E.tallyDestinations(state.participants).map((d) => d.destination);
    const routes = [];
    for (const p of state.participants) {
      if (!p.city) continue;
      for (const dest of dests) routes.push([p.city, dest]);
    }
    return routes;
  }
  let fareFetchPending = false;
  function refreshFares() {
    if (fareFetchPending) return;
    fareFetchPending = true;
    window.ReunlyFares.ensureFares(neededRoutes(), () => {
      // New fares arrived — re-render derived sections (not inputs).
      renderMeta();
      renderRecommendations();
      renderCosts();
    }).finally(() => {
      fareFetchPending = false;
    });
  }

  // Recompute only the derived sections (recs + costs) — leaves participant
  // inputs untouched so focus/caret isn't lost while typing.
  function recomputeDerived() {
    renderMeta();
    renderRecommendations();
    renderCosts();
    saveState();
    refreshFares();
  }

  let recomputeTimer = null;
  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recomputeDerived, 200);
  }

  // Full render (used on structural changes: add/remove/edit toggle).
  function renderAll() {
    clearTimeout(recomputeTimer); // a structural render supersedes any pending debounce
    renderMeta();
    renderParticipants();
    renderRecommendations();
    renderCosts();
    saveState();
    refreshFares();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function init() {
    populateCityList();
    wireRegister();
    wireChoose();
    wireReunionMeta();
    registerServiceWorker();
    updateCurrencyToggle();
    startRotator();
    initTheme();

    // Boot precedence: shared invite link > saved session > fresh registration.
    if (importFromHash()) {
      state.fromInvite = true;
      // Pre-fill the share-link reunion name so the user sees what they're joining.
      $("#choiceGreeting").textContent = `Joining "${state.reunion.name}"`;
      showScreen("register");
    } else if (loadState() && state.user) {
      enterDashboard("resume", state.reunion.code);
    } else {
      showScreen("register");
    }
    initOnboarding();
  }

  // ---- Theme (light/dark) ----
  const LS_THEME = "reunly_theme";
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const b = $("#themeToggle");
    if (b) b.textContent = theme === "light" ? "☀️" : "🌙";
  }
  function initTheme() {
    let t = "dark";
    try {
      t = localStorage.getItem(LS_THEME) || "dark";
    } catch (e) {
      /* ignore */
    }
    applyTheme(t);
    $("#themeToggle").addEventListener("click", () => {
      const next =
        document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
      try {
        localStorage.setItem(LS_THEME, next);
      } catch (e) {
        /* ignore */
      }
    });
  }

  // ---- First-run onboarding carousel ----
  function initOnboarding() {
    const ov = $("#onboarding");
    let seen = false;
    try {
      seen = localStorage.getItem("reunly_onboarded") === "1";
    } catch (e) {
      /* ignore */
    }
    // Skip for returning users, invited joiners, or resumed sessions.
    if (seen || state.fromInvite || !$("#screen-register").classList.contains("active")) return;

    const slides = ov.querySelectorAll(".onboard-slide");
    const dots = $("#onboardDots");
    slides.forEach((_, i) => dots.appendChild(el("span", { class: `dot${i === 0 ? " on" : ""}` })));
    const track = $("#onboardSlides");
    let idx = 0;
    function go(i) {
      idx = i;
      track.style.transform = `translateX(-${i * 100}%)`;
      [...dots.children].forEach((d, j) => d.classList.toggle("on", j === i));
      $("#onboardNext").textContent = i === slides.length - 1 ? "Get started →" : "Next";
    }
    function finish() {
      ov.classList.add("hide");
      setTimeout(() => (ov.hidden = true), 300);
      try {
        localStorage.setItem("reunly_onboarded", "1");
      } catch (e) {
        /* ignore */
      }
    }
    $("#onboardNext").addEventListener("click", () => (idx < slides.length - 1 ? go(idx + 1) : finish()));
    $("#onboardSkip").addEventListener("click", finish);
    ov.hidden = false;
    go(0);
  }

  // Rotating destination word in the registration hero tagline.
  function startRotator() {
    const node = document.getElementById("rotator");
    if (!node) return;
    const picks = [
      "Bali 🌺", "Goa 🏝️", "Bangkok 🛺", "Dubai 🏙️",
      "Singapore 🦁", "London 🎡", "Paris 🗼",
    ];
    let i = 0;
    setInterval(() => {
      // Only animate while the register screen is visible (saves cycles).
      if (!$("#screen-register").classList.contains("active")) return;
      i = (i + 1) % picks.length;
      node.textContent = picks[i];
      node.style.animation = "none";
      void node.offsetWidth; // reflow to restart the CSS animation
      node.style.animation = "";
    }, 2200);
  }

  // Register the PWA service worker. Guarded: it only works over http(s), so it
  // silently no-ops when the prototype is opened directly from the file system.
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    // When a newly-installed worker takes control AFTER an existing one (an
    // update), reload once so the page runs fresh assets instead of stale
    // in-memory modules. Guarded by an existing controller so first-ever visits
    // (no prior controller) don't reload.
    if (navigator.serviceWorker.controller) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    }
    navigator.serviceWorker.register("service-worker.js").catch(() => {
      /* offline support is optional for the prototype */
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
