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
    reunion: { name: "", type: "Friends meetup", code: "—" },
    participants: [], // starts empty — the organizer is added on entry
    me: null, // participant id of the current user
    role: null, // "organizer" | "participant"
    editingId: null, // which participant card is open for editing
    phase: "decide", // active dashboard tab
    currencyMode: "local", // "local" (per traveller) | "usd"
    fromInvite: false, // arrived via a shared invite link
    demoMode: false, // sample group loaded?
    lockedPlan: null, // { destination, dateStart, dateEnd, dateLabel } once confirmed
    ballot: null, // { open, openedBy, options:[...], votesByParticipant:{ id:{optionId} } }
    memories: [], // [{ id, authorId, authorName, type:"note"|"photo", text, dataUrl?, ts }]
  };
  let memoryPreview = false; // organiser previewing the wall before the event

  const isMe = (p) => p.id === state.me;
  const canEdit = (p) => state.role === "organizer" || isMe(p);

  // Fare provider injected into the engine: prefer a fetched (live/searched)
  // fare from the proxy cache, fall back to the synchronous engine estimate.
  const fareProvider = (from, to) =>
    window.ReunlyFares.getCached(from, to) || E.getFare(from, to);

  // ---- Persistence ----
  const LS_STATE = "reunly_state_v1";
  // Returns true on success, false if storage failed (e.g. quota exceeded by a
  // large photo) — callers that add heavy data check the result.
  function saveState() {
    try {
      localStorage.setItem(
        LS_STATE,
        JSON.stringify({
          user: state.user,
          reunion: state.reunion,
          participants: state.participants,
          me: state.me,
          role: state.role,
          phase: state.phase,
          currencyMode: state.currencyMode,
          demoMode: state.demoMode,
          lockedPlan: state.lockedPlan,
          ballot: state.ballot,
          memories: state.memories,
        })
      );
      return true;
    } catch (e) {
      return false; // storage unavailable / full — prototype still works in-memory
    }
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_STATE) || "null");
      if (s && Array.isArray(s.participants)) {
        state.user = s.user || null;
        state.reunion = s.reunion || state.reunion;
        state.participants = s.participants.map(D.normalizeParticipant);
        state.me = s.me || null;
        state.role = s.role || "organizer";
        state.phase = s.phase || "decide";
        state.currencyMode = s.currencyMode || "local";
        state.demoMode = !!s.demoMode;
        state.lockedPlan = s.lockedPlan || null;
        state.ballot = s.ballot || null;
        state.memories = Array.isArray(s.memories) ? s.memories : [];
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
      // Privacy: the invite link does NOT carry anyone's email address.
      p: state.participants.map((p) => ({
        n: p.name, c: p.city, d: p.dates, x: p.destinations, pr: p.prefs, rsvp: p.rsvp,
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
          D.normalizeParticipant({
            name: x.n, email: x.e || "", city: x.c, dates: x.d, destinations: x.x,
            prefs: x.pr, rsvp: x.rsvp,
          })
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

  // ---- Smart invitations modal (WhatsApp / SMS / Email / Copy) ----
  function inviteMessage() {
    const name = state.reunion.name || "our get-together";
    return `You're invited to ${name} on Reunly 🎉 Add your dates & preferences here: ${buildShareUrl()}`;
  }
  let inviteOpener = null;
  function openInviteModal() {
    inviteOpener = document.activeElement;
    const url = buildShareUrl();
    const msg = inviteMessage();
    $("#inviteLink").value = url;
    $("#inviteWhatsApp").href = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    $("#inviteSms").href = `sms:?&body=${encodeURIComponent(msg)}`;
    $("#inviteEmail").href =
      `mailto:?subject=${encodeURIComponent("You're invited: " + (state.reunion.name || "Reunly get-together"))}` +
      `&body=${encodeURIComponent(msg)}`;
    $("#inviteModal").hidden = false;
    $("#inviteClose").focus();
  }
  function closeInviteModal() {
    $("#inviteModal").hidden = true;
    if (inviteOpener && inviteOpener.focus) inviteOpener.focus();
  }
  function wireInviteModal() {
    $("#inviteClose").addEventListener("click", closeInviteModal);
    $("#inviteModal").addEventListener("click", (e) => {
      if (e.target.id === "inviteModal") closeInviteModal(); // click backdrop
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#inviteModal").hidden) closeInviteModal();
    });
    $("#inviteSms").addEventListener("click", () => setTimeout(closeInviteModal, 50));
    $("#inviteEmail").addEventListener("click", () => setTimeout(closeInviteModal, 50));
    $("#inviteWhatsApp").addEventListener("click", () => setTimeout(closeInviteModal, 50));
    $("#inviteCopy").addEventListener("click", async () => {
      const url = $("#inviteLink").value;
      try {
        await navigator.clipboard.writeText(url);
        toast("Invite link copied");
      } catch (e) {
        $("#inviteLink").select();
        window.prompt("Copy this invite link:", url);
      }
    });
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
      t = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
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

  function populateEventTypes() {
    const sel = $("#reunionType");
    sel.textContent = "";
    D.EVENT_TYPES.forEach((t) => sel.appendChild(el("option", { value: t, text: t })));
    sel.value = state.reunion.type;
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
  // Ensure the current user exists in the roster and return them. Sets state.me.
  function addCurrentUserAsParticipant() {
    if (!state.user) return null;
    let mine = state.participants.find(
      (p) => p.email.toLowerCase() === state.user.email.toLowerCase()
    );
    if (!mine) {
      mine = D.makeParticipant({
        name: state.user.name,
        email: state.user.email,
        city: state.user.city,
      });
      state.participants.unshift(mine);
    }
    state.me = mine.id;
    return mine;
  }

  function enterDashboard(mode, code) {
    if (mode !== "resume") {
      const mine = addCurrentUserAsParticipant();
      state.role = mode === "join" ? "participant" : "organizer";
      state.reunion.code = code || generateInviteCode(state.reunion.type);
      if (mode === "setup") {
        state.reunion.name = state.reunion.name || "Untitled get-together";
      }
      // Open the current user's card so they can fill in their own answers.
      state.editingId = mine ? mine.id : null;
      // Invitees land on People (answer for yourself); organizers on Decide.
      state.phase = state.role === "participant" ? "people" : "decide";
    }
    populateEventTypes();
    $("#reunionName").value = state.reunion.name;
    $("#reunionType").value = state.reunion.type;
    showScreen("dashboard");
    showPhase(state.phase || "decide");
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
    $("#shareBtn").addEventListener("click", openInviteModal);
    wireInviteModal();
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
  // RSVP control: tappable pills when editable, a status badge otherwise.
  function rsvpControl(p) {
    const wrap = el("div", { class: "rsvp-row" });
    if (canEdit(p)) {
      const mk = (val, label) =>
        el("button", {
          class: `rsvp-pill ${val}${p.rsvp === val ? " on" : ""}`,
          text: label,
          onClick: () => {
            p.rsvp = p.rsvp === val ? "no_response" : val;
            saveState();
            renderAll();
          },
        });
      wrap.appendChild(mk("in", isMe(p) ? "✓ I'm in" : "✓ In"));
      wrap.appendChild(mk("out", isMe(p) ? "Can't make it" : "Out"));
    } else {
      const label =
        p.rsvp === "in" ? "✓ Going" : p.rsvp === "out" ? "✗ Can't make it" : "… No reply yet";
      wrap.appendChild(el("span", { class: `rsvp-status ${p.rsvp}`, text: label }));
    }
    return wrap;
  }

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

    // Preferences (the broader "how should we meet" answers)
    wrap.appendChild(buildPrefsGroup(p));

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
    // Only an organiser can remove others — and never themselves.
    if (state.role === "organizer" && !isMe(p)) {
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
    }
    wrap.appendChild(actions);
    return wrap;
  }

  // Preferences sub-form: budget, food, accommodation, kids, accessibility,
  // activities. All optional; each writes straight into p.prefs.
  function buildPrefsGroup(p) {
    const pr = p.prefs;
    const group = el("div", { class: "field-group" });
    group.appendChild(el("div", { class: "gl", text: "Preferences (optional)" }));

    const row = el("div", { class: "row" });
    // Budget
    const bWrap = el("div");
    bWrap.appendChild(el("label", { text: "Max budget / person (USD)" }));
    bWrap.appendChild(
      el("input", {
        type: "number", min: "0", inputmode: "numeric", value: pr.budget || "",
        placeholder: "e.g. 800",
        onInput: (e) => { pr.budget = e.target.value; scheduleRecompute(); },
      })
    );
    row.appendChild(bWrap);
    // Food
    const fWrap = el("div");
    fWrap.appendChild(el("label", { text: "Food preference" }));
    const fSel = el("select", {
      onChange: (e) => { pr.food = e.target.value; scheduleRecompute(); },
    });
    D.FOOD_OPTIONS.forEach((o) => fSel.appendChild(el("option", { value: o, text: o })));
    fSel.value = pr.food || "No preference";
    fWrap.appendChild(fSel);
    row.appendChild(fWrap);
    group.appendChild(row);

    const row2 = el("div", { class: "row" });
    // Kids
    const kWrap = el("div");
    kWrap.appendChild(el("label", { text: "Kids attending" }));
    kWrap.appendChild(
      el("input", {
        type: "number", min: "0", inputmode: "numeric", value: pr.kids || 0,
        onInput: (e) => { pr.kids = Math.max(0, parseInt(e.target.value || "0", 10)); scheduleRecompute(); },
      })
    );
    row2.appendChild(kWrap);
    // Accommodation (toggle styled as checkbox row)
    const aWrap = el("div");
    aWrap.appendChild(el("label", { text: "Needs accommodation" }));
    const toggle = el("label", { class: "check-row" });
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!pr.accommodation;
    cb.addEventListener("change", (e) => { pr.accommodation = e.target.checked; scheduleRecompute(); });
    toggle.appendChild(cb);
    toggle.appendChild(el("span", { text: "Yes, needs a place to stay" }));
    aWrap.appendChild(toggle);
    row2.appendChild(aWrap);
    group.appendChild(row2);

    // Accessibility
    const accWrap = el("div", { class: "field-group" });
    accWrap.appendChild(el("label", { text: "Accessibility needs" }));
    accWrap.appendChild(
      el("input", {
        type: "text", value: pr.accessibility || "",
        placeholder: "e.g. step-free access",
        onInput: (e) => { pr.accessibility = e.target.value; scheduleRecompute(); },
      })
    );
    group.appendChild(accWrap);

    // Activities (multi-select chips)
    group.appendChild(el("div", { class: "gl", text: "Activity interests", style: "margin-top:10px" }));
    const chips = el("div", { class: "chip-select" });
    D.ACTIVITY_OPTIONS.forEach((a) => {
      const on = pr.activities.includes(a);
      const c = el("button", {
        type: "button",
        class: `chip-toggle${on ? " on" : ""}`,
        text: a,
        onClick: (e) => {
          const i = pr.activities.indexOf(a);
          if (i >= 0) pr.activities.splice(i, 1);
          else pr.activities.push(a);
          e.currentTarget.classList.toggle("on");
          scheduleRecompute();
        },
      });
      chips.appendChild(c);
    });
    group.appendChild(chips);
    return group;
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

    // Empty state: only the organiser themselves, no sample data.
    const others = state.participants.filter((p) => !isMe(p));
    if (state.role === "organizer" && others.length === 0 && !state.demoMode) {
      const cta = el("div", { class: "card empty-cta" });
      cta.appendChild(el("div", { class: "empty-emoji", text: "🪄" }));
      cta.appendChild(el("div", { class: "empty-title", text: "It's just you so far" }));
      cta.appendChild(
        el("div", {
          class: "empty-sub",
          text: "Invite your group, or explore with a sample group to see how Reunly decides.",
        })
      );
      const row = el("div", { class: "btn-row" });
      row.appendChild(el("button", { class: "btn", text: "📨 Invite people", onClick: openInviteModal }));
      row.appendChild(el("button", { class: "btn secondary", text: "Explore sample group", onClick: loadDemo }));
      cta.appendChild(row);
      list.appendChild(cta);
    }

    // Own card first, then the rest.
    const ordered = [...state.participants].sort(
      (a, b) => (isMe(b) ? 1 : 0) - (isMe(a) ? 1 : 0)
    );
    ordered.forEach((p, idx) => {
      const editing = state.editingId === p.id;
      const mine = isMe(p);
      const card = el("div", {
        id: `pcard-${p.id}`,
        class: `card stagger${editing ? " highlight" : ""}${mine ? " is-me" : ""}`,
      });
      card.style.animationDelay = `${Math.min(idx, 8) * 0.04}s`;

      const head = el("div", { class: "pcard-head" });
      head.appendChild(el("div", { class: "pcard-avatar", text: D.cityEmoji(p.city) }));
      const who = el("div", { class: "who" });
      const nameLine = el("div", { class: "name" });
      nameLine.appendChild(el("span", { text: headerName(p) }));
      if (mine) nameLine.appendChild(el("span", { class: "you-badge", text: "You" }));
      who.appendChild(nameLine);
      who.appendChild(el("div", { class: "meta", text: headerMeta(p) }));
      head.appendChild(who);
      if (canEdit(p)) {
        head.appendChild(
          el("button", {
            class: "btn secondary sm",
            style: "width:auto",
            text: editing ? "Close" : mine ? "Edit yours" : "Edit",
            onClick: () => {
              state.editingId = editing ? null : p.id;
              renderAll();
            },
          })
        );
      }
      card.appendChild(head);

      if (editing) {
        card.appendChild(buildEditForm(p));
      } else {
        const summary = el("div", { class: "pcard-summary" });
        summaryChips(p).forEach((c) => summary.appendChild(c));
        card.appendChild(summary);
      }
      card.appendChild(rsvpControl(p));
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
      const bar = el("div", {
        class: "bar",
        role: "progressbar",
        "aria-valuenow": String(Math.round(Math.max(0, Math.min(1, fraction)) * 100)),
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-label": `${lbl} score`,
      });
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
        if (url) renderWinner();
      });
    }
    const label = el("div", { class: "rec-photo-label" });
    label.appendChild(el("span", { class: "rec-photo-emoji", text: D.cityEmoji(dest) }));
    label.appendChild(el("span", { text: dest }));
    banner.appendChild(el("span", { class: "rec-photo-pin", text: "Top pick" }));
    banner.appendChild(label);
    card.appendChild(banner);
  }

  // One-line plain-English reason the top option wins (transparency).
  function winnerReason(c) {
    const parts = [];
    if (c.destScore >= 0.6) parts.push("most-wanted place");
    if (c.dateScore >= 0.6) parts.push("works for most people");
    if (c.costScore >= 0.6) parts.push("easiest on budgets");
    return parts.length ? `Wins on ${parts.join(" · ")}` : "Best overall balance";
  }

  function lockState(c) {
    return (
      state.lockedPlan &&
      state.lockedPlan.destination === c.destination &&
      state.lockedPlan.dateLabel === c.dateLabel
    );
  }
  function toggleLock(c) {
    const locked = lockState(c);
    if (!locked && state.role !== "organizer") {
      toast("Only the organiser can lock the plan");
      return;
    }
    if (!locked && state.lockedPlan) {
      if (!window.confirm(`Lock ${c.destination} on ${c.dateLabel} for everyone?`)) return;
    }
    state.lockedPlan = locked
      ? null
      : {
          destination: c.destination,
          dateStart: c.dateRange.start,
          dateEnd: c.dateRange.end,
          dateLabel: c.dateLabel,
        };
    state.phase = "decide";
    renderAll();
    if (!locked) confetti();
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

  // Cache the ranked combos for a single render pass (winner + others share them).
  function rankedCombos() {
    return E.rankCombinations(state.participants, undefined, fareProvider);
  }

  // The #1 option as a hero: photo, name+date, why-it-won, scores, primary Lock.
  function renderWinner() {
    const hero = $("#winnerHero");
    hero.textContent = "";
    const combos = rankedCombos();
    if (!combos.length) {
      hero.appendChild(
        el("div", {
          class: "empty",
          text: "Add dates and destinations on the People tab to see the best option.",
        })
      );
      return;
    }
    maybeCelebrate(combos);
    const c = combos[0];
    const locked = lockState(c);
    const card = el("div", { class: "card winner-card stagger" });

    addRecPhoto(card, c.destination);

    const body = el("div", { class: "winner-body" });
    body.appendChild(el("div", { class: "winner-when", text: `📅 ${c.dateLabel}` }));
    body.appendChild(el("div", { class: "winner-reason", text: winnerReason(c) }));

    const grid = el("div", { class: "score-grid" });
    grid.appendChild(scoreCell("Date", pct(c.dateScore), c.dateScore));
    grid.appendChild(scoreCell("Place", pct(c.destScore), c.destScore));
    grid.appendChild(scoreCell("Cost", pct(c.costScore), c.costScore));
    grid.appendChild(
      scoreCell("Avg fare", c.avgFare != null ? `$${Math.round(c.avgFare)}` : "—", null)
    );
    body.appendChild(grid);

    const lockBtn = el("button", {
      class: locked ? "btn secondary" : "btn",
      style: "width:100%;margin-top:14px",
      text: locked ? "✓ Locked — tap to unlock" : "🔒 Lock this plan",
      onClick: () => toggleLock(c),
    });
    body.appendChild(lockBtn);
    card.appendChild(body);
    hero.appendChild(card);
  }

  // The runners-up (combos 2 & 3): compact rows, no photo/medal noise.
  function renderRecommendations() {
    const list = $("#recList");
    list.textContent = "";
    const others = rankedCombos().slice(1, 3);
    const section = list.closest(".section");
    if (section) section.hidden = !others.length;
    others.forEach((c, i) => {
      const row = el("div", { class: "card tight alt-option stagger" });
      row.style.animationDelay = `${i * 0.06}s`;
      const head = el("div", { class: "alt-head" });
      head.appendChild(el("span", { class: "alt-emoji", text: D.cityEmoji(c.destination) }));
      const w = el("div", { style: "flex:1;min-width:0" });
      w.appendChild(el("div", { class: "alt-title", text: c.destination }));
      w.appendChild(el("div", { class: "alt-sub", text: `${c.dateLabel} · ~$${Math.round(c.avgFare || 0)} avg` }));
      head.appendChild(w);
      head.appendChild(
        el("button", {
          class: "btn ghost sm",
          style: "width:auto",
          text: lockState(c) ? "Locked" : "Lock",
          onClick: () => toggleLock(c),
        })
      );
      row.appendChild(head);
      list.appendChild(row);
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard: countdown (shown once a plan is locked)
  // -------------------------------------------------------------------------
  function renderCountdown() {
    const box = $("#countdown");
    const plan = state.lockedPlan;
    if (!plan) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.textContent = "";
    const days = E.daysUntil(plan.dateStart);
    const big =
      days == null ? "Locked" : days > 0 ? `${days}` : days === 0 ? "Today" : "Past";
    box.appendChild(el("div", { class: "cd-emoji", text: D.cityEmoji(plan.destination) }));
    const mid = el("div", { class: "cd-mid" });
    mid.appendChild(
      el("div", {
        class: "cd-line",
        text:
          days > 0
            ? `${plan.destination} in`
            : days === 0
            ? `It's today — ${plan.destination}!`
            : plan.destination,
      })
    );
    if (days > 0) {
      const big2 = el("div", { class: "cd-big" });
      big2.appendChild(el("span", { class: "cd-num", text: big }));
      big2.appendChild(el("span", { class: "cd-days", text: days === 1 ? "day" : "days" }));
      mid.appendChild(big2);
    }
    mid.appendChild(el("div", { class: "cd-sub", text: `📅 ${plan.dateLabel}` }));
    box.appendChild(mid);
  }

  // -------------------------------------------------------------------------
  // Dashboard: group insights (preference roll-up)
  // -------------------------------------------------------------------------
  function statTile(big, label) {
    const t = el("div", { class: "stat-tile" });
    t.appendChild(el("div", { class: "stat-big", text: big }));
    t.appendChild(el("div", { class: "stat-label", text: label }));
    return t;
  }
  function renderInsights() {
    const list = $("#insightsList");
    list.textContent = "";
    const s = E.summarizePrefs(state.participants);
    if (!s.total) {
      list.appendChild(el("div", { class: "empty", text: "No responses yet." }));
      return;
    }
    const card = el("div", { class: "card" });
    const grid = el("div", { class: "stat-grid" });
    grid.appendChild(statTile(`${s.total}`, "people"));
    grid.appendChild(
      statTile(
        s.medianBudget != null ? `$${s.medianBudget}` : "—",
        s.medianBudget != null ? "median budget" : "budget"
      )
    );
    grid.appendChild(statTile(`${s.accommodation}`, "need a stay"));
    grid.appendChild(statTile(`${s.kids}`, s.kids === 1 ? "child" : "kids"));
    card.appendChild(grid);

    // Food mix
    if (s.foodRanked.length) {
      const fr = el("div", { class: "insight-row" });
      fr.appendChild(el("span", { class: "insight-key", text: "🍽️ Dietary" }));
      const tags = el("div", { class: "insight-tags" });
      s.foodRanked.forEach(([label, n]) =>
        tags.appendChild(el("span", { class: "badge gray", text: `${label} ×${n}` }))
      );
      fr.appendChild(tags);
      card.appendChild(fr);
    }
    // Top activities
    if (s.activitiesRanked.length) {
      const ar = el("div", { class: "insight-row" });
      ar.appendChild(el("span", { class: "insight-key", text: "🎯 Top activities" }));
      const tags = el("div", { class: "insight-tags" });
      s.activitiesRanked.slice(0, 5).forEach(([label, n]) =>
        tags.appendChild(el("span", { class: "badge", text: `${label} ×${n}` }))
      );
      ar.appendChild(tags);
      card.appendChild(ar);
    }
    // Budget range
    if (s.medianBudget != null) {
      card.appendChild(
        el("div", {
          class: "insight-note",
          text: `Budgets range $${s.minBudget}–$${s.maxBudget} per person (USD).`,
        })
      );
    }
    // Accessibility callouts
    if (s.accessibility.length) {
      s.accessibility.forEach((a) =>
        card.appendChild(
          el("div", { class: "insight-note", text: `♿ ${a.name}: ${a.note}` })
        )
      );
    }
    list.appendChild(card);
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

  function costCardSide(p, toCity, heading, opts = {}) {
    const side = el("div", { class: "cost-side" });
    if (heading) side.appendChild(el("div", { class: "cost-sub", text: heading }));
    if (!toCity) {
      side.appendChild(el("div", { class: "muted", text: "—" }));
      return side;
    }
    if (opts.showDest !== false) {
      side.appendChild(el("div", { class: "badge gray", text: `${D.cityEmoji(toCity)} ${toCity}` }));
    }
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
    const combos = rankedCombos();
    const groupBest = combos.length ? combos[0].destination : null;
    // Name the destination ONCE in the heading instead of on every card.
    $("#costsHeading").textContent = groupBest
      ? `Getting to ${D.cityEmoji(groupBest)} ${groupBest}`
      : "Travel costs";

    if (!groupBest) {
      list.appendChild(
        el("div", { class: "empty", text: "Add destinations on People to see travel costs." })
      );
      return;
    }
    const withCity = state.participants.filter((p) => p.city);
    if (!withCity.length) {
      list.appendChild(el("div", { class: "empty", text: "No home cities entered yet." }));
      return;
    }

    withCity.forEach((p, idx) => {
      const card = el("div", { class: "card stagger cost-row" });
      card.style.animationDelay = `${Math.min(idx, 8) * 0.04}s`;
      const head = el("div", { class: "pcard-head" });
      head.appendChild(el("div", { class: "pcard-avatar", text: D.cityEmoji(p.city) }));
      const who = el("div", { class: "who" });
      who.appendChild(
        el("div", { class: "name", text: (p.name || "Unnamed") + (isMe(p) ? " (you)" : "") })
      );
      who.appendChild(el("div", { class: "meta", text: `from ${p.city}` }));
      head.appendChild(who);
      card.appendChild(head);
      // Single fare side to the agreed/best destination — no redundant labels.
      card.appendChild(costCardSide(p, groupBest, null, { showDest: false }));
      list.appendChild(card);
    });
  }

  // -------------------------------------------------------------------------
  // Voting ("Decide" — the group converges; engine score is the seed/tiebreak)
  // -------------------------------------------------------------------------
  function optionId(c) {
    return `${c.destination}|${c.dateLabel}`;
  }
  function openBallot() {
    const combos = rankedCombos().slice(0, 4);
    if (combos.length < 2) {
      toast("Need at least two options to vote on");
      return;
    }
    state.ballot = {
      open: true,
      openedBy: state.me,
      options: combos.map((c) => ({
        id: optionId(c),
        destination: c.destination,
        dateStart: c.dateRange.start,
        dateEnd: c.dateRange.end,
        dateLabel: c.dateLabel,
        seedTotal: c.total,
      })),
      votesByParticipant: {},
    };
    renderAll();
    toast("Voting opened — cast your vote!");
  }
  function closeBallot() {
    if (state.ballot) state.ballot.open = false;
    renderAll();
  }
  function reopenBallot() {
    if (state.ballot) state.ballot.open = true;
    renderAll();
  }
  function clearBallot() {
    state.ballot = null;
    renderAll();
  }
  function castVote(id) {
    if (!state.ballot || !state.ballot.open) return;
    if (!state.me) {
      toast("Register to vote");
      return;
    }
    state.ballot.votesByParticipant[state.me] = { optionId: id };
    saveState();
    renderVote();
  }
  function weightedPick(weights) {
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let r = Math.random() * sum;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
  function seedDemoVotes() {
    if (!state.ballot) return;
    const opts = state.ballot.options;
    state.participants.forEach((p) => {
      if (isMe(p)) return; // leave the user's own vote intact
      const idx = weightedPick(opts.map((o) => Math.max(0.05, o.seedTotal)));
      state.ballot.votesByParticipant[p.id] = { optionId: opts[idx].id };
    });
    saveState();
    renderVote();
  }
  function lockBallotOption(o) {
    if (!window.confirm(`Lock ${o.destination} on ${o.dateLabel} for everyone?`)) return;
    state.lockedPlan = {
      destination: o.destination,
      dateStart: o.dateStart,
      dateEnd: o.dateEnd,
      dateLabel: o.dateLabel,
    };
    state.phase = "decide";
    renderAll();
    confetti();
  }

  function renderVote() {
    const panel = $("#votePanel");
    if (!panel) return;
    panel.textContent = "";
    const b = state.ballot;
    const combos = rankedCombos();

    // No ballot yet — organiser can open one.
    if (!b) {
      if (state.role === "organizer" && combos.length >= 2) {
        const card = el("div", { class: "card vote-cta" });
        card.appendChild(el("div", { class: "vote-cta-title", text: "🗳️ Can't agree? Put it to a vote" }));
        card.appendChild(
          el("div", { class: "vote-cta-sub", text: "Let everyone pick from the top options — the group decides, the score just breaks ties." })
        );
        card.appendChild(
          el("button", { class: "btn", style: "width:100%;margin-top:12px", text: "Open a vote", onClick: openBallot })
        );
        panel.appendChild(card);
      }
      return;
    }

    // Tally.
    const counts = {};
    let totalVotes = 0;
    Object.values(b.votesByParticipant).forEach((v) => {
      counts[v.optionId] = (counts[v.optionId] || 0) + 1;
      totalVotes += 1;
    });
    const myVote = state.me ? (b.votesByParticipant[state.me] || {}).optionId : null;
    const ordered = [...b.options].sort(
      (a, c) => (counts[c.id] || 0) - (counts[a.id] || 0) || c.seedTotal - a.seedTotal
    );
    const maxCount = Math.max(1, ...b.options.map((o) => counts[o.id] || 0));

    const card = el("div", { class: "card vote-card" });
    const head = el("div", { class: "vote-head" });
    head.appendChild(el("h3", { class: "vote-title", text: b.open ? "🗳️ Vote for the plan" : "🏁 Vote results" }));
    head.appendChild(el("span", { class: "hint", text: `${totalVotes} of ${state.participants.length} voted` }));
    card.appendChild(head);

    ordered.forEach((o, i) => {
      const n = counts[o.id] || 0;
      const leading = !b.open && i === 0 && n > 0;
      const row = el("button", {
        class: `vote-opt${myVote === o.id ? " mine" : ""}${leading ? " winner" : ""}`,
        onClick: b.open ? () => castVote(o.id) : null,
      });
      if (!b.open) row.disabled = true;
      const top = el("div", { class: "vote-opt-top" });
      top.appendChild(el("span", { class: "vote-emoji", text: D.cityEmoji(o.destination) }));
      const w = el("div", { style: "flex:1;min-width:0" });
      const t = el("div", { class: "vote-opt-title" });
      t.appendChild(el("span", { text: o.destination }));
      if (myVote === o.id) t.appendChild(el("span", { class: "vote-you", text: "✓ you" }));
      if (leading) t.appendChild(el("span", { class: "vote-you win", text: "winner" }));
      w.appendChild(t);
      w.appendChild(el("div", { class: "vote-opt-sub", text: o.dateLabel }));
      top.appendChild(w);
      top.appendChild(el("span", { class: "vote-count", text: String(n) }));
      row.appendChild(top);
      const bar = el("div", { class: "vote-bar" });
      const span = el("span");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          span.style.width = `${Math.round((n / maxCount) * 100)}%`;
        })
      );
      bar.appendChild(span);
      row.appendChild(bar);
      card.appendChild(row);
    });

    // Organiser controls.
    if (state.role === "organizer") {
      const ctrl = el("div", { class: "vote-controls" });
      if (b.open) {
        ctrl.appendChild(el("button", { class: "btn secondary sm", text: "Close voting", onClick: closeBallot }));
        if (state.demoMode) {
          ctrl.appendChild(el("button", { class: "btn ghost sm", text: "Seed demo votes", onClick: seedDemoVotes }));
        }
      } else {
        ctrl.appendChild(
          el("button", { class: "btn sm", text: `🔒 Lock ${ordered[0].destination}`, onClick: () => lockBallotOption(ordered[0]) })
        );
        ctrl.appendChild(el("button", { class: "btn ghost sm", text: "Reopen", onClick: reopenBallot }));
        ctrl.appendChild(el("button", { class: "btn ghost sm", text: "Clear", onClick: clearBallot }));
      }
      card.appendChild(ctrl);
    } else if (b.open && !myVote) {
      card.appendChild(el("div", { class: "vote-hintline", text: "Tap an option above to cast your vote." }));
    }
    panel.appendChild(card);
  }

  // -------------------------------------------------------------------------
  // Render orchestration + debounced recompute
  // -------------------------------------------------------------------------
  function hasResponded(p) {
    return p.destinations.some(Boolean) || p.dates.some(E.isValidRange);
  }
  function renderMeta() {
    $("#inviteChip").textContent = `Invite code: ${state.reunion.code}`;
    const going = state.participants.filter((p) => p.rsvp === "in").length;
    $("#countChip").textContent = `${going} in · ${state.participants.length} invited`;
    const responded = state.participants.filter(hasResponded).length;
    const hint = $("#respondedHint");
    if (hint) hint.textContent = `${responded} of ${state.participants.length} responded`;
    renderDemoBanner();
  }

  // ---- Demo mode (sample group) ----
  function renderDemoBanner() {
    const b = $("#demoBanner");
    if (!b) return;
    b.textContent = "";
    if (!state.demoMode) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    const line = el("div");
    line.appendChild(el("span", { text: "🧪 Demo mode — sample people loaded. " }));
    line.appendChild(el("button", { class: "link-btn", text: "Clear sample data", onClick: clearDemo }));
    b.appendChild(line);
    // "Respond as" simulator: experience the app — and vote — as any member.
    const sim = el("div", { class: "respond-as" });
    sim.appendChild(el("label", { class: "respond-as-label", text: "Acting as", for: "respondAs" }));
    const sel = el("select", {
      id: "respondAs",
      onChange: (e) => {
        state.me = e.target.value;
        renderAll();
      },
    });
    state.participants.forEach((p) => {
      const opt = el("option", { value: p.id, text: p.name || "Unnamed" });
      if (p.id === state.me) opt.selected = true;
      sel.appendChild(opt);
    });
    sim.appendChild(sel);
    b.appendChild(sim);
  }
  function loadDemo() {
    const have = new Set(state.participants.map((p) => p.id));
    D.SEED_PARTICIPANTS.map(D.normalizeParticipant).forEach((p) => {
      if (!have.has(p.id)) state.participants.push(p);
    });
    state.demoMode = true;
    renderAll();
  }
  function clearDemo() {
    state.participants = state.participants.filter(
      (p) => isMe(p) || !String(p.id).startsWith("p_seed_")
    );
    state.demoMode = false;
    state.lockedPlan = null;
    renderAll();
  }

  // ---- Tabs / phases ----
  function showPhase(phase) {
    state.phase = phase;
    document.querySelectorAll(".phase").forEach((node) => {
      node.hidden = node.getAttribute("data-phase") !== phase;
    });
    document.querySelectorAll(".phase-tab").forEach((t) => {
      const on = t.getAttribute("data-phase") === phase;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    saveState();
  }
  function wirePhases() {
    document.querySelectorAll(".phase-tab").forEach((t) => {
      t.addEventListener("click", () => {
        showPhase(t.getAttribute("data-phase"));
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  // ---- Memory wall (real: photos + notes, author-tagged, on-device storage) ----
  const MEMORY_PHOTO_CAP = 12;
  function meName() {
    const m = state.participants.find(isMe);
    return (m && m.name) || state.user?.name || "You";
  }
  function authorEmoji(authorId) {
    const a = state.participants.find((p) => p.id === authorId);
    return a ? D.cityEmoji(a.city) : "📍";
  }
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  // Downscale an image file to a JPEG dataURL so it fits in localStorage.
  function downscaleImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width >= height && width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function addNote(text) {
    const t = (text || "").trim();
    if (!t) return;
    state.memories.unshift({
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      authorId: state.me,
      authorName: meName(),
      type: "note",
      text: t,
      ts: Date.now(),
    });
    saveState();
    renderMemories();
  }
  async function addPhoto(file) {
    if (!file) return;
    if (state.memories.filter((m) => m.type === "photo").length >= MEMORY_PHOTO_CAP) {
      toast(`Photo limit reached (${MEMORY_PHOTO_CAP}) on this device`);
      return;
    }
    let dataUrl;
    try {
      dataUrl = await downscaleImage(file, 1024, 0.7);
    } catch (e) {
      toast("Couldn't read that image");
      return;
    }
    const mem = {
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      authorId: state.me,
      authorName: meName(),
      type: "photo",
      dataUrl,
      ts: Date.now(),
    };
    state.memories.unshift(mem);
    if (!saveState()) {
      state.memories.shift(); // roll back — too big for this device's storage
      toast("Photo too large to save on this device");
    }
    renderMemories();
  }
  function deleteMemory(id) {
    state.memories = state.memories.filter((m) => m.id !== id);
    saveState();
    renderMemories();
  }

  function renderMemories() {
    const panel = $("#memoriesPanel");
    if (!panel) return;
    panel.textContent = "";

    if (!state.lockedPlan) {
      panel.appendChild(
        el("div", {
          class: "empty",
          text: "Lock a plan first — the memory wall opens once your get-together is set.",
        })
      );
      return;
    }

    const days = E.daysUntil(state.lockedPlan.dateStart);
    const beforeEvent = days != null && days > 0;

    // Gated teaser before the event (organiser can preview early).
    if (beforeEvent && !memoryPreview) {
      const card = el("div", { class: "card memory-teaser" });
      card.appendChild(el("div", { class: "memory-emoji", text: "📸" }));
      card.appendChild(el("div", { class: "memory-title", text: "The Memory Wall unlocks on the day" }));
      card.appendChild(
        el("div", {
          class: "memory-sub",
          text: `Opens for everyone after ${state.lockedPlan.dateLabel} — share photos & notes from ${state.lockedPlan.destination}.`,
        })
      );
      if (state.role === "organizer") {
        card.appendChild(
          el("button", {
            class: "btn ghost sm",
            style: "margin-top:14px",
            text: "Preview the wall",
            onClick: () => {
              memoryPreview = true;
              renderMemories();
            },
          })
        );
      }
      panel.appendChild(card);
      return;
    }

    // Preview banner.
    if (beforeEvent && memoryPreview) {
      panel.appendChild(
        el("div", {
          class: "demo-banner",
          text: `👀 Preview — the wall opens for everyone after ${state.lockedPlan.dateLabel}.`,
        })
      );
    }

    // Composer.
    const composer = el("div", { class: "card memory-composer" });
    const ta = el("textarea", {
      class: "memory-input",
      rows: "2",
      placeholder: `Share a memory from ${state.lockedPlan.destination}…`,
    });
    composer.appendChild(ta);
    const row = el("div", { class: "memory-actions" });
    // Hidden file input + button to trigger it.
    const fileInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
    fileInput.addEventListener("change", (e) => {
      addPhoto(e.target.files && e.target.files[0]);
      e.target.value = "";
    });
    row.appendChild(fileInput);
    row.appendChild(
      el("button", { class: "btn secondary sm", text: "📷 Photo", onClick: () => fileInput.click() })
    );
    row.appendChild(
      el("button", {
        class: "btn sm",
        style: "flex:1",
        text: "Add note",
        onClick: () => {
          addNote(ta.value);
          ta.value = "";
        },
      })
    );
    composer.appendChild(row);
    composer.appendChild(
      el("div", { class: "memory-note", text: "🔒 Stored only in this browser — these stay on your device." })
    );
    panel.appendChild(composer);

    // Feed (newest first).
    if (!state.memories.length) {
      panel.appendChild(el("div", { class: "empty", text: "No memories yet — be the first to share." }));
      return;
    }
    const feed = el("div", { class: "memory-feed" });
    state.memories.forEach((m) => {
      const item = el("div", { class: "card tight memory-item stagger" });
      const head = el("div", { class: "memory-item-head" });
      head.appendChild(el("div", { class: "pcard-avatar sm", text: authorEmoji(m.authorId) }));
      const who = el("div", { style: "flex:1;min-width:0" });
      who.appendChild(el("div", { class: "memory-author", text: m.authorName || "Someone" }));
      who.appendChild(el("div", { class: "memory-time", text: timeAgo(m.ts) }));
      head.appendChild(who);
      if (m.authorId === state.me) {
        head.appendChild(
          el("button", { class: "icon-btn sm", "aria-label": "Delete", text: "✕", onClick: () => deleteMemory(m.id) })
        );
      }
      item.appendChild(head);
      if (m.type === "photo" && m.dataUrl) {
        const img = el("img", { class: "memory-photo", alt: `Photo from ${m.authorName || "someone"}`, src: m.dataUrl });
        item.appendChild(img);
      }
      if (m.text) item.appendChild(el("div", { class: "memory-text", text: m.text }));
      feed.appendChild(item);
    });
    panel.appendChild(feed);
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
      renderWinner();
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
    renderCountdown();
    renderWinner();
    renderVote();
    renderRecommendations();
    renderInsights();
    renderCosts();
    renderMemories();
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
    renderCountdown();
    renderWinner();
    renderVote();
    renderParticipants();
    renderRecommendations();
    renderInsights();
    renderCosts();
    renderMemories();
    saveState();
    refreshFares();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function init() {
    populateCityList();
    populateEventTypes();
    wireRegister();
    wireChoose();
    wireReunionMeta();
    wirePhases();
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
