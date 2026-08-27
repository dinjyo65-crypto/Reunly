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
  const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
  const ordinal = (i) => ORDINALS[i] || `${i + 1}th`;

  // ---- App state (persisted to localStorage; see saveState/peekSavedState) ----
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
    expenses: [], // [{ id, payerId, desc, amount(USD), ts }]
    itinerarySeed: 1, // deterministic seed for the suggested itinerary
    pro: false, // Reunly Pro unlocked?
    // id -> name for people removed from the roster, so expenses they paid
    // still read sensibly in the settle-up instead of showing "Someone".
    pastNames: {},
    notifSeen: 0, // ts of the last notification the organiser has viewed
  };
  let memoryPreview = false; // organiser previewing the wall before the event
  let notifItems = []; // in-memory only — latest fetch from /api/notify
  let notifPollTimer = null;

  const isMe = (p) => p.id === state.me;
  const canEdit = (p) => state.role === "organizer" || isMe(p);

  // Fare provider injected into the engine: prefer a fetched (live/searched)
  // fare from the proxy cache, fall back to the synchronous engine estimate.
  const fareProvider = (from, to) =>
    window.ReunlyFares.getCached(from, to) || E.getFare(from, to);

  // ---- Persistence ----
  const LS_STATE = "reunly_state_v1";
  /**
   * Stamp the current user's record so a link they send back can be merged
   * last-write-wins against other copies (see mergeParticipantsFromHash).
   * Only their OWN row is touched — we have no authority to claim an edit
   * time for anyone else's answers.
   */
  // Stamp the record that actually changed. Merging an invite link keeps the
  // newer copy of each participant, so a mutation that forgets to stamp is
  // silently thrown away on the next round-trip — hence one helper, used
  // everywhere a participant is edited.
  function touchParticipant(p) {
    if (p) p.updatedAt = Date.now();
  }
  function touchMine() {
    touchParticipant(state.participants.find((p) => p.id === state.me));
  }
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
          expenses: state.expenses,
          itinerarySeed: state.itinerarySeed,
          pastNames: state.pastNames,
          pro: state.pro,
          notifSeen: state.notifSeen,
        })
      );
      return true;
    } catch (e) {
      return false; // storage unavailable / full — prototype still works in-memory
    }
  }
  // Parse saved localStorage state WITHOUT applying it to `state` yet — boot
  // needs to compare this against an incoming invite link (see init()) before
  // deciding which one should actually win, so an invite link can never
  // silently wipe out progress someone already made on this device.
  function peekSavedState() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_STATE) || "null");
      if (s && Array.isArray(s.participants)) return s;
    } catch (e) {
      /* corrupt — ignore */
    }
    return null;
  }
  // Apply a previously-peeked saved-state object onto `state`.
  function applySavedState(s) {
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
    state.expenses = Array.isArray(s.expenses) ? s.expenses : [];
    state.itinerarySeed = s.itinerarySeed || 1;
    state.pastNames = s.pastNames || {};
    state.pro = !!s.pro;
    state.notifSeen = s.notifSeen || 0;
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
      v: 2,
      code: state.reunion.code,
      name: state.reunion.name,
      type: state.reunion.type,
      // The agreed plan travels with the link, so a joiner sees what was
      // decided rather than an apparently-undecided event.
      locked: state.lockedPlan || null,
      // Privacy: the invite link does NOT carry anyone's email address. The
      // participant id IS included — it's a random local token, not PII, and
      // without it the same person re-appears as a duplicate on every merge.
      p: state.participants.map((p) => ({
        id: p.id, n: p.name, c: p.city, d: p.dates, x: p.destinations,
        pr: p.prefs, rsvp: p.rsvp, dc: p.dateConfirmed, xc: p.destConfirmed,
        // Last-write-wins clock so a returning link can update someone's
        // answers without a newer local edit being overwritten by a stale one.
        ts: p.updatedAt || 0,
      })),
    };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return `${location.origin}${location.pathname}#r=${b64}`;
  }
  // Parse an invite-link hash WITHOUT applying it — see peekSavedState() above
  // for why boot needs to look at both before it leaps.
  function peekHashPayload() {
    const m = (location.hash || "").match(/^#r=(.+)$/);
    if (!m) return null;
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      if (data && Array.isArray(data.p)) return data;
    } catch (e) {
      /* malformed link — ignore */
    }
    return null;
  }
  // Apply a previously-peeked invite payload onto `state` (replaces the whole
  // roster — only call once the caller has decided that's safe/wanted).
  /** Turn one payload entry back into a full participant object. */
  function participantFromPayload(x) {
    return D.normalizeParticipant({
      id: x.id, name: x.n, email: x.e || "", city: x.c, dates: x.d,
      destinations: x.x, prefs: x.pr, rsvp: x.rsvp,
      dateConfirmed: x.dc, destConfirmed: x.xc, updatedAt: x.ts || 0,
    });
  }
  function applyHashPayload(data) {
    state.reunion = {
      name: data.name || "Shared reunion",
      type: data.type || "Friends",
      code: data.code || generateInviteCode(data.type),
    };
    state.participants = data.p.map(participantFromPayload);
    if (data.locked) state.lockedPlan = data.locked;
  }
  /**
   * Merge an invite payload into the roster we already have for this event.
   *
   * This is what makes the invite link a genuine round-trip: a participant
   * fills in their dates, sends their link back, and the organiser's copy
   * actually picks up those answers. Append-only merging silently discarded
   * them, which is worse than useless — people would think they'd replied.
   *
   * Conflicts resolve last-write-wins on each participant's `updatedAt`, so
   * re-opening an older link can never roll back newer local edits. Matching
   * prefers the stable id and falls back to name for links made before ids
   * were included.
   */
  function mergeParticipantsFromHash(data) {
    let added = 0;
    let updated = 0;
    const byId = new Map(state.participants.map((p) => [p.id, p]));
    const byName = new Map(
      state.participants.map((p) => [(p.name || "").trim().toLowerCase(), p])
    );
    data.p.forEach((x) => {
      const nameKey = (x.n || "").trim().toLowerCase();
      const existing = (x.id && byId.get(x.id)) || (nameKey && byName.get(nameKey));
      const incoming = participantFromPayload(x);
      if (!existing) {
        if (!nameKey) return; // nothing to identify them by
        state.participants.push(incoming);
        byId.set(incoming.id, incoming);
        byName.set(nameKey, incoming);
        added += 1;
        return;
      }
      // Never let a stale copy overwrite fresher answers.
      if ((incoming.updatedAt || 0) <= (existing.updatedAt || 0)) return;
      Object.assign(existing, incoming, { id: existing.id });
      updated += 1;
    });
    if (data.locked && !state.lockedPlan) state.lockedPlan = data.locked;
    return { added, updated };
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
      if (e.key !== "Escape") return;
      if (!$("#inviteModal").hidden) closeInviteModal();
      if (!$("#phoneModal").hidden) $("#phoneModal").hidden = true;
      if (!$("#proModal").hidden) closeProModal();
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

  // ---- "Open on your phone" modal (LAN URL + QR) ----
  let lanInfo = null; // cached /api/host result
  async function openPhoneModal() {
    const modal = $("#phoneModal");
    modal.hidden = false;
    let url = location.origin + location.pathname;
    try {
      if (!lanInfo) lanInfo = await (await fetch("/api/host")).json();
      if (lanInfo && lanInfo.publicUrl) {
        // Deployed (e.g. Render) — this IS the address other people should use.
        url = lanInfo.publicUrl.replace(/\/$/, "") + "/";
      } else if (lanInfo && lanInfo.lan) {
        // Running locally — LAN address works for phones on the same Wi-Fi.
        url = `http://${lanInfo.lan}:${lanInfo.port}/`;
      }
    } catch (e) {
      /* static hosting / offline — fall back to the current origin */
    }
    $("#phoneUrl").value = url;
    $("#phoneQr").src =
      "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" +
      encodeURIComponent(url);
    $("#phoneClose").focus();
  }
  function wirePhoneModal() {
    $("#phoneBtn").addEventListener("click", openPhoneModal);
    $("#phoneClose").addEventListener("click", () => ($("#phoneModal").hidden = true));
    $("#phoneModal").addEventListener("click", (e) => {
      if (e.target.id === "phoneModal") $("#phoneModal").hidden = true;
    });
    $("#phoneUrl").addEventListener("click", (e) => e.target.select());
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

  // The current user's home display currency (set from their location/city).
  function myCurrency() {
    return (state.user && state.user.currency) || D.currencyForCity(state.user && state.user.city);
  }

  // ---- Live place autocomplete (proxy /api/geosuggest) ----
  // Attaches a type-ahead dropdown to any text input. onPick(label, suggestion)
  // fires on selection; the input's own "input" event is also re-dispatched so
  // existing handlers (which write into state) run.
  function attachAutocomplete(input, onPick) {
    let menu = null;
    let items = [];
    let active = -1;
    let timer = null;
    const close = () => {
      if (menu) menu.remove();
      menu = null;
      items = [];
      active = -1;
    };
    const place = () => {
      if (!menu) return;
      const r = input.getBoundingClientRect();
      menu.style.left = `${r.left}px`;
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.width = `${r.width}px`;
    };
    const render = () => {
      if (!menu) {
        menu = el("div", { class: "ac-menu" });
        document.body.appendChild(menu);
        place();
      }
      menu.textContent = "";
      items.forEach((s, i) => {
        const opt = el("div", { class: `ac-item${i === active ? " active" : ""}`, text: s.label });
        opt.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(s);
        });
        menu.appendChild(opt);
      });
    };
    const pick = (s) => {
      input.value = s.label;
      close();
      if (onPick) onPick(s.label, s);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const query = async (q) => {
      try {
        const res = await fetch(`/api/geosuggest?q=${encodeURIComponent(q)}`, {
          headers: { Accept: "application/json" },
        });
        const data = await res.json();
        if (input.value.trim() !== q) return; // stale response
        items = (data.results || []).slice(0, 6);
        active = -1;
        if (items.length) render();
        else close();
      } catch (e) {
        close();
      }
    };
    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) return close();
      timer = setTimeout(() => query(q), 220);
    });
    input.addEventListener("keydown", (e) => {
      if (!menu) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        active = Math.min(active + 1, items.length - 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        active = Math.max(active - 1, 0);
        render();
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        pick(items[active]);
      } else if (e.key === "Escape") {
        close();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
  }

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

  let regCurrency = null; // currency captured from location detect / suggestion pick

  function wireRegister() {
    // Live suggestions on the home-city field; capture currency from the country.
    attachAutocomplete($("#regCity"), (label, s) => {
      if (s && s.cc && D.CC_CURRENCY[s.cc]) regCurrency = D.CC_CURRENCY[s.cc];
    });

    // "Use my location" — browser geolocation → reverse geocode → fill city.
    const detect = $("#regDetect");
    if (detect) {
      detect.addEventListener("click", () => {
        if (!navigator.geolocation) {
          toast("Location isn't available on this device");
          return;
        }
        detect.disabled = true;
        detect.textContent = "Locating…";
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            try {
              const { latitude, longitude } = pos.coords;
              const r = await fetch(`/api/reverse?lat=${latitude}&lng=${longitude}`);
              const data = await r.json();
              if (data.label) {
                $("#regCity").value = data.label;
                if (data.cc && D.CC_CURRENCY[data.cc]) regCurrency = D.CC_CURRENCY[data.cc];
                const cur = regCurrency || D.currencyForCity(data.label);
                $("#regLocNote").textContent = `📍 ${data.label} · prices will show in ${cur}`;
              } else {
                toast("Couldn't find your city — type it in");
              }
            } catch (e) {
              toast("Location lookup failed — type your city");
            } finally {
              detect.disabled = false;
              detect.textContent = "📍 Use my location";
            }
          },
          () => {
            toast("Location permission denied — type your city");
            detect.disabled = false;
            detect.textContent = "📍 Use my location";
          },
          { timeout: 8000 }
        );
      });
    }

    $("#regSubmit").addEventListener("click", () => {
      const name = $("#regName").value.trim();
      const email = $("#regEmail").value.trim();
      const city = $("#regCity").value.trim();
      const err = $("#regError");
      if (!name) return (err.textContent = "Please enter your name.");
      if (!isValidEmail(email)) return (err.textContent = "Please enter a valid email.");
      if (!city) return (err.textContent = "Please enter your home city.");
      err.textContent = "";
      state.user = { name, email, city, currency: regCurrency || D.currencyForCity(city) };
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
      // Everyone lands on Decide: it shows the "add your dates & places" CTA
      // (which jumps to editing). People is for reviewing everyone's answers.
      state.phase = "decide";
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
            touchParticipant(p);
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

    // Availability — one row to start, add as many as you like (best first).
    wrap.appendChild(buildDatesGroup(p));
    // Destinations — same flexible pattern, with live suggestions.
    wrap.appendChild(buildDestGroup(p));

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
            const who = p.name || "this person";
            const owesMoney = state.expenses.some((x) => x.payerId === p.id);
            const warn = owesMoney
              ? `\n\n${who} has paid for expenses — those amounts stay in the settle-up so nobody's money disappears.`
              : "";
            // Destructive, and it's someone else's data — always confirm.
            if (!window.confirm(`Remove ${who} from this event?${warn}`)) return;
            // Keep their name so any expense they paid still reads sensibly.
            rememberName(p.id, p.name);
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

  // Flexible availability rows (add/remove; top = best).
  function buildDatesGroup(p) {
    const g = el("div", { class: "field-group" });
    g.appendChild(el("div", { class: "gl", text: "When can you make it?" }));
    g.appendChild(el("div", { class: "field-note", text: "Add your best dates first — as many as you like." }));
    p.dates.forEach((d, i) => {
      const r = el("div", { class: "rank-row" });
      r.appendChild(el("span", { class: "badge rank", text: ordinal(i) }));
      r.appendChild(dateInput(p, i, "start"));
      r.appendChild(dateInput(p, i, "end"));
      if (p.dates.length > 1) {
        r.appendChild(
          el("button", {
            class: "row-del", "aria-label": "Remove this date", text: "✕",
            onClick: () => {
              p.dates.splice(i, 1);
              renderAll();
            },
          })
        );
      }
      g.appendChild(r);
    });
    g.appendChild(
      el("button", {
        class: "btn ghost sm add-row", text: "+ Add another date",
        onClick: () => {
          p.dates.push({ start: "", end: "" });
          renderAll();
        },
      })
    );
    return g;
  }

  // Flexible destination rows (add/remove; top = best).
  function buildDestGroup(p) {
    const g = el("div", { class: "field-group" });
    g.appendChild(el("div", { class: "gl", text: "Where would you like to go?" }));
    g.appendChild(el("div", { class: "field-note", text: "Pick from the suggestions so everyone's choices match up." }));
    p.destinations.forEach((_, i) => {
      const r = el("div", { class: "rank-row dest" });
      r.appendChild(el("span", { class: "badge rank", text: ordinal(i) }));
      r.appendChild(destInput(p, i));
      if (p.destinations.length > 1) {
        r.appendChild(
          el("button", {
            class: "row-del", "aria-label": "Remove this place", text: "✕",
            onClick: () => {
              p.destinations.splice(i, 1);
              renderAll();
            },
          })
        );
      }
      g.appendChild(r);
    });
    g.appendChild(
      el("button", {
        class: "btn ghost sm add-row", text: "+ Add another place",
        onClick: () => {
          p.destinations.push("");
          renderAll();
        },
      })
    );
    return g;
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
        onInput: (e) => { pr.budget = e.target.value; scheduleRecompute(p); },
      })
    );
    row.appendChild(bWrap);
    // Food
    const fWrap = el("div");
    fWrap.appendChild(el("label", { text: "Food preference" }));
    const fSel = el("select", {
      onChange: (e) => { pr.food = e.target.value; scheduleRecompute(p); },
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
        onInput: (e) => { pr.kids = Math.max(0, parseInt(e.target.value || "0", 10)); scheduleRecompute(p); },
      })
    );
    row2.appendChild(kWrap);
    // Accommodation. Phrased as an opt-OUT so the safe assumption (they need a
    // bed, and lodging is budgeted for them) is what happens when nobody
    // touches this — under-stating someone's cost is the harmful direction.
    const aWrap = el("div");
    aWrap.appendChild(el("label", { text: "Accommodation" }));
    const toggle = el("label", { class: "check-row" });
    const cb = el("input", { type: "checkbox" });
    cb.checked = pr.accommodation === false;
    cb.addEventListener("change", (e) => {
      pr.accommodation = e.target.checked ? false : true;
      scheduleRecompute(p);
    });
    toggle.appendChild(cb);
    toggle.appendChild(el("span", { text: "I'm sorted — don't budget a stay for me" }));
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
        onInput: (e) => { pr.accessibility = e.target.value; scheduleRecompute(p); },
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
          scheduleRecompute(p);
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
        // Without this a name/email correction was never persisted until some
        // unrelated action happened to trigger a save.
        scheduleRecompute(p);
      },
    });
  }
  function cityInput(p) {
    const wrap = el("div", { class: "field-group" });
    wrap.appendChild(el("label", { text: "Home city", for: `city-${p.id}` }));
    const input = el("input", {
      id: `city-${p.id}`,
      type: "text",
      autocomplete: "off",
      value: p.city || "",
      placeholder: "Start typing a city…",
      onInput: (e) => {
        p.city = e.target.value;
        updateCardHeader(p);
        scheduleRecompute(p);
      },
    });
    attachAutocomplete(input, (label, s) => {
      p.city = label;
      // A member's own currency follows their home city's country.
      if (s && s.cc && D.CC_CURRENCY[s.cc] && isMe(p) && state.user) {
        state.user.currency = D.CC_CURRENCY[s.cc];
      }
    });
    wrap.appendChild(input);
    return wrap;
  }
  function dateInput(p, idx, end) {
    return el("input", {
      type: "date",
      value: p.dates[idx][end] || "",
      onInput: (e) => {
        p.dates[idx][end] = e.target.value;
        scheduleRecompute(p);
      },
    });
  }
  function destInput(p, idx) {
    const input = el("input", {
      type: "text",
      value: p.destinations[idx] || "",
      placeholder: "Type a city or place…",
      autocomplete: "off",
      onInput: (e) => {
        p.destinations[idx] = e.target.value;
        scheduleRecompute(p);
      },
    });
    attachAutocomplete(input, (label) => {
      p.destinations[idx] = label;
    });
    return input;
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
    // Only claim budget-friendliness when we actually checked stated budgets;
    // otherwise say what's true — it's the cheapest of the options, which is
    // not the same as affordable.
    if (c.budgetFit != null && c.budgetFit >= 0.6) parts.push("fits stated budgets");
    else if (c.budgetFit == null && c.relCostScore >= 0.6) parts.push("cheapest travel");
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
    // Someone who has said they can't make it shouldn't still be steering the
    // group's date, destination or budget warnings. Keep everyone else,
    // including people who haven't replied yet.
    const relevant = state.participants.filter((p) => p.rsvp !== "out");
    return E.rankCombinations(
      relevant.length ? relevant : state.participants,
      undefined,
      fareProvider
    );
  }

  // -------------------------------------------------------------------------
  // "Does the group's current pick work for you?" — a one-time confirm step
  // shown to anyone (organiser or invitee) who lands on Decide with a group
  // pick already forming but no data of their own yet. Both the date and the
  // destination question must be answered independently — you can accept one
  // and reject the other — and any "No" needs a real alternative before you
  // can continue.
  // -------------------------------------------------------------------------

  // True once EITHER field has been answered, since both are always written
  // together (atomically) in confirmSubmit — so checking one is enough, but we
  // check both for robustness against older/partial imported data.
  function hasAnsweredConfirm(p) {
    return p.dateConfirmed !== null || p.destConfirmed !== null;
  }
  function needsConfirmStep(p) {
    if (!p) return false;
    if (hasAnsweredConfirm(p)) return false; // already submitted the confirm step
    // Once they've started answering (clicked Yes/No on either question), stay
    // in the flow even if typing an alternative date/place makes hasResponded()
    // true — that's expected mid-flow, not evidence they entered data some
    // other way. Only treat pre-existing data as a reason to skip the step
    // BEFORE they've touched it at all.
    const draft = getConfirmDraft(p.id);
    const inProgress = draft.dateOk !== null || draft.destOk !== null;
    if (!inProgress && hasResponded(p)) return false; // had their own data already
    return inProgress || rankedCombos().length > 0;
  }

  // Transient (not persisted) yes/no answers while the confirm card is open.
  // Keyed to the current participant id so switching people (or a fresh join)
  // always starts blank, but re-renders triggered while filling in an
  // alternative (typing a date/place) don't lose the in-progress answers.
  let confirmDraft = { forId: null, dateOk: null, destOk: null };
  function getConfirmDraft(meId) {
    if (confirmDraft.forId !== meId) confirmDraft = { forId: meId, dateOk: null, destOk: null };
    return confirmDraft;
  }

  function yesNoRow(draft, key) {
    const row = el("div", { class: "confirm-yn" });
    row.appendChild(
      el("button", {
        type: "button",
        class: `yn-btn${draft[key] === true ? " on yes" : ""}`,
        text: "✓ Yes",
        onClick: () => {
          draft[key] = true;
          renderWinner();
        },
      })
    );
    row.appendChild(
      el("button", {
        type: "button",
        class: `yn-btn${draft[key] === false ? " on no" : ""}`,
        text: "✕ No",
        onClick: () => {
          draft[key] = false;
          renderWinner();
        },
      })
    );
    return row;
  }

  // Fire-and-forget: tell the server this person answered, so the organiser's
  // app can show a notification. Best-effort only — if the request fails
  // (offline, server asleep, etc.) the local confirmation still goes through.
  function notifyOrganiser(p, top, draft) {
    try {
      fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: state.reunion.code,
          name: p.name || "Someone",
          destination: top.destination,
          dateLabel: top.dateLabel,
          dateOk: draft.dateOk,
          destOk: draft.destOk,
        }),
      }).catch(() => {});
    } catch (e) {
      /* ignore — notification is a nice-to-have, not required for the app to work */
    }
  }

  function confirmSubmit(p, top, draft) {
    if (draft.dateOk) {
      p.dates = [{ start: top.dateRange.start, end: top.dateRange.end }];
    }
    // If dateOk === false, p.dates already holds whatever alternative they
    // typed into the inline form below (validated before Continue enables).
    if (draft.destOk) {
      p.destinations = [top.destination];
    }
    p.dateConfirmed = draft.dateOk;
    p.destConfirmed = draft.destOk;
    // These answers ARE this person's response — losing the stamp meant the
    // organiser's copy silently ignored the whole confirm step on merge.
    touchParticipant(p);
    saveState();
    notifyOrganiser(p, top, draft);
    toast("Thanks! Just a few more details…");
    goEditMine();
  }

  // The Yes/No confirm card itself: reuses the photo banner + the existing
  // flexible date/destination editors for the "No, here's my alternative" path.
  function renderConfirmStep(hero, p, top) {
    const draft = getConfirmDraft(p.id);
    const card = el("div", { class: "card confirm-card stagger" });
    addRecPhoto(card, top.destination);

    const body = el("div", { class: "confirm-body" });
    body.appendChild(el("div", { class: "confirm-title", text: "Does this work for you?" }));
    body.appendChild(
      el("div", {
        class: "confirm-sub",
        text: `The group's leaning towards ${top.destination}, ${top.dateLabel}.`,
      })
    );

    // --- Date question ---
    const dq = el("div", { class: "confirm-q" });
    dq.appendChild(el("div", { class: "confirm-q-label", text: `📅 ${top.dateLabel} — does this date work?` }));
    dq.appendChild(yesNoRow(draft, "dateOk"));
    if (draft.dateOk === false) dq.appendChild(buildDatesGroup(p));
    body.appendChild(dq);

    // --- Destination question ---
    const xq = el("div", { class: "confirm-q" });
    xq.appendChild(el("div", { class: "confirm-q-label", text: `📍 ${top.destination} — does this place work?` }));
    xq.appendChild(yesNoRow(draft, "destOk"));
    if (draft.destOk === false) xq.appendChild(buildDestGroup(p));
    body.appendChild(xq);

    const continueBtn = el("button", {
      class: "btn",
      style: "width:100%;margin-top:16px",
      text: "Continue →",
      onClick: () => confirmSubmit(p, top, draft),
    });
    const hint = el("div", { class: "confirm-sub" });
    body.appendChild(continueBtn);
    body.appendChild(hint);

    // Both questions must be answered, and any "No" needs a real alternative.
    // This only toggles the button/hint text on the EXISTING nodes above (never
    // rebuilds the card), so it can safely run on every keystroke in the
    // date/place inputs without stealing focus mid-type.
    function updateContinueState() {
      const dateAnswered = draft.dateOk !== null;
      const destAnswered = draft.destOk !== null;
      const dateAltOk = draft.dateOk !== false || p.dates.some(E.isValidRange);
      const destAltOk = draft.destOk !== false || p.destinations.some((d) => d && d.trim());
      const canContinue = dateAnswered && destAnswered && dateAltOk && destAltOk;
      if (canContinue) continueBtn.removeAttribute("disabled");
      else continueBtn.setAttribute("disabled", "disabled");
      if (dateAnswered && !dateAltOk) hint.textContent = "Add at least one date you could do.";
      else if (destAnswered && !destAltOk) hint.textContent = "Add at least one place you'd like instead.";
      else hint.textContent = "";
    }
    updateContinueState();
    // Event delegation: catches typing in any nested date/place input (native
    // "input" events bubble) without needing buildDatesGroup/buildDestGroup to
    // know about this card.
    card.addEventListener("input", updateContinueState);

    card.appendChild(body);
    hero.appendChild(card);
  }

  // The #1 option as a hero: photo, name+date, why-it-won, scores, primary Lock.
  function renderWinner() {
    const hero = $("#winnerHero");
    hero.textContent = "";
    const combos = rankedCombos();
    const me = state.participants.find(isMe);
    // Guard combos.length here too: needsConfirmStep can stay true mid-flow
    // even if combos briefly become empty (e.g. clearing demo data while
    // mid-confirm), and combos[0] would otherwise be undefined.
    if (needsConfirmStep(me) && combos.length > 0) {
      renderConfirmStep(hero, me, combos[0]);
      return;
    }
    if (!combos.length) {
      const card = el("div", { class: "card empty-cta" });
      card.appendChild(el("div", { class: "empty-emoji", text: "🗓️" }));
      card.appendChild(el("div", { class: "empty-title", text: "Add your dates & places" }));
      card.appendChild(
        el("div", {
          class: "empty-sub",
          text: "Tell us when you're free and where you'd like to go — then invite the group and we'll find the best option.",
        })
      );
      const row = el("div", { class: "btn-row" });
      row.appendChild(
        el("button", { class: "btn", text: "➕ Add your availability", onClick: goEditMine })
      );
      row.appendChild(
        el("button", { class: "btn secondary", text: "📨 Invite people", onClick: openInviteModal })
      );
      card.appendChild(row);
      hero.appendChild(card);
      return;
    }
    maybeCelebrate(combos);
    const c = combos[0];
    const locked = lockState(c);
    const card = el("div", { class: "card winner-card stagger" });

    addRecPhoto(card, c.destination);

    const body = el("div", { class: "winner-body" });
    const whenLine = el("div", { class: "winner-when", text: `📅 ${c.dateLabel}` });
    // Be clear when the window was derived from overlapping availability
    // rather than proposed by someone.
    if (c.dateSuggested) {
      whenLine.appendChild(el("span", { class: "when-tag", text: "overlap" }));
    }
    body.appendChild(whenLine);
    body.appendChild(el("div", { class: "winner-reason", text: winnerReason(c) }));
    // Seasonality shown pre-lock, so nobody commits to monsoon season blind.
    const wNote = weatherNote(c.destination, c.dateRange.start, c.dateRange.end);
    if (wNote) body.appendChild(el("div", { class: "winner-weather", text: wNote }));

    const grid = el("div", { class: "score-grid" });
    grid.appendChild(scoreCell("Date", pct(c.dateScore), c.dateScore));
    grid.appendChild(scoreCell("Place", pct(c.destScore), c.destScore));
    grid.appendChild(scoreCell("Cost", pct(c.costScore), c.costScore));
    // Show the all-in per-person figure (travel + lodging) rather than airfare
    // alone — the fare on its own reads as "what the trip costs" and isn't.
    grid.appendChild(
      scoreCell(
        c.avgTripCost != null && c.nights > 0 ? "Per person" : "Avg fare",
        c.avgTripCost != null ? `$${Math.round(c.avgTripCost)}` : "—",
        null
      )
    );
    body.appendChild(grid);

    if (c.nights > 0 && c.lodgingMin != null && c.avgFare != null) {
      body.appendChild(
        el("div", {
          class: "cost-breakdown",
          text: `≈ $${Math.round(c.avgFare)} travel + $${c.lodgingMin}–$${c.lodgingMax} stay (${c.nights} night${c.nights === 1 ? "" : "s"}) · estimates, excludes food & activities`,
        })
      );
    }

    // Surface a budget clash BEFORE anyone locks the plan — this is the moment
    // it's cheap to change course, not after money's been spent.
    if (c.overBudgetCount > 0) {
      const names = c.overBudgetNames.slice(0, 3).join(", ");
      const more = c.overBudgetCount > 3 ? ` +${c.overBudgetCount - 3} more` : "";
      body.appendChild(
        el("div", {
          class: "budget-warn",
          text: `⚠️ Estimated travel + stay exceeds the stated budget for ${names}${more}. Worth checking before locking.`,
        })
      );
    }

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
      const perPerson = c.avgTripCost != null ? c.avgTripCost : c.avgFare;
      w.appendChild(
        el("div", {
          class: "alt-sub",
          text: `${c.dateLabel} · ~$${Math.round(perPerson || 0)} pp`,
        })
      );
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
    // Provenance badge: live / sandbox (test data) / searched / estimated.
    if (fare.source === "live") {
      fareRow.appendChild(el("span", { class: "badge good", text: "● live" }));
    } else if (fare.source === "sandbox") {
      // Amadeus sandbox returns fictional inventory — flag it as test data
      // rather than dressing it up as a real price.
      fareRow.appendChild(el("span", { class: "badge warn", text: "test data" }));
    } else if (fare.source === "searched") {
      fareRow.appendChild(
        el("span", { class: "badge good", text: `searched · ${fare.asOf}` })
      );
    } else if (fare.min !== 0) {
      fareRow.appendChild(el("span", { class: "badge warn", text: "estimated" }));
    }
    side.appendChild(fareRow);
    // Underneath: the same fare in YOUR home currency, so the organiser reading
    // the tab always has a familiar number to compare against.
    const home = state.currencyMode === "usd" ? "USD" : myCurrency();
    if (fare.min !== 0 && home !== code) {
      side.appendChild(
        el("div", { class: "cost-meta", text: `≈ ${E.formatRange(fare.min, fare.max, home)} for you (${home})` })
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

    // Be explicit about what these numbers are — and aren't. A family reading
    // "$215–$340" could easily assume that's the whole trip.
    list.appendChild(
      el("div", {
        class: "scope-note",
        text:
          "✈️ Return travel only — excludes accommodation, food and activities. " +
          `Non-USD amounts use approximate rates set ${D.RATES_AS_OF}.`,
      })
    );

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
  // Trip toolkit + smart itinerary (shown on Decide once a plan is locked)
  // -------------------------------------------------------------------------
  const weatherCache = new Map(); // "place|start" -> result or "pending"
  function fetchWeather(place, start, end, onDone) {
    const key = `${place}|${start}`;
    if (weatherCache.has(key)) return;
    weatherCache.set(key, "pending");
    const qs = new URLSearchParams({ place, start, end: end || start });
    fetch(`/api/weather?${qs}`)
      .then((r) => r.json())
      .then((w) => {
        weatherCache.set(key, w && w.ok ? w : null);
        (onDone || renderPlan)();
      })
      .catch(() => {
        // Leave a definitive "no data" rather than a stuck "pending", so the UI
        // stops showing a loading state if the weather API is down.
        weatherCache.set(key, null);
        (onDone || renderPlan)();
      });
  }

  /**
   * A short weather line for a candidate date+place, used on the recommendation
   * BEFORE anyone locks it — seasonality is exactly the kind of thing a group
   * should see while they can still change their minds.
   * Returns null while loading or when we have nothing useful to say.
   */
  function weatherNote(destination, dateStart, dateEnd) {
    if (!destination || !dateStart) return null;
    const w = weatherCache.get(`${destination}|${dateStart}`);
    if (w === undefined) {
      fetchWeather(destination, dateStart, dateEnd, renderWinner);
      return null;
    }
    if (!w || w === "pending") return null;
    const mode = w.mode === "forecast" ? "Forecast" : "Typically";
    let rain = "";
    if (w.rainPct != null) {
      rain = ` · ${w.rainPct}% rain risk`;
    } else if (w.wetDays != null && w.totalDays) {
      // Historical: "5 of 7 days saw rain" is the seasonality signal that
      // matters when picking dates months ahead.
      rain = ` · rain on ${w.wetDays} of ${w.totalDays} days last year`;
    }
    return `🌤️ ${mode} ${w.tMin}–${w.tMax}°C${rain}`;
  }

  // Download an .ics calendar file for the locked plan (all-day, end-exclusive).
  function downloadIcs() {
    const plan = state.lockedPlan;
    if (!plan) return;
    const clean = (iso) => (iso || "").replace(/-/g, "");
    const endD = new Date(plan.dateEnd + "T00:00:00");
    endD.setDate(endD.getDate() + 1); // DTEND is exclusive
    const endStr = endD.toISOString().slice(0, 10).replace(/-/g, "");
    const title = `${state.reunion.name || "Get-together"} — ${plan.destination}`;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Reunly//EN",
      "BEGIN:VEVENT",
      `UID:reunly-${clean(plan.dateStart)}-${Date.now()}@reunly`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${clean(plan.dateStart)}`,
      `DTEND;VALUE=DATE:${endStr}`,
      `SUMMARY:${title.replace(/[,;]/g, " ")}`,
      `LOCATION:${plan.destination.replace(/[,;]/g, " ")}`,
      "DESCRIPTION:Planned with Reunly",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar" });
    const a = el("a", {
      href: URL.createObjectURL(blob),
      download: `${(state.reunion.name || "reunly").replace(/[^\w-]+/g, "-")}.ics`,
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
    toast("Calendar file downloaded");
  }

  // Deterministic PRNG so the itinerary is stable until "shuffled".
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Activity interest -> concrete itinerary ideas. Each idea carries which
  // day-slots it suits (0 morning, 1 afternoon, 2 evening) so "sunset walk"
  // never lands in the morning.
  const IDEA_BANK = {
    "Beach": [
      ["🏖️", "Beach time at a top-rated spot", "best beaches near", [0, 1]],
      ["🌅", "Sunset walk on the shore", "beaches near", [2]],
    ],
    "Nightlife": [
      ["🍸", "Drinks & live music", "best bars near", [2]],
      ["🪩", "Night out at a popular club", "nightclubs near", [2]],
    ],
    "Sightseeing": [
      ["📸", "See the must-visit landmarks", "top attractions in", [0, 1]],
      ["🚶", "Guided walking tour", "walking tours in", [0, 1]],
    ],
    "Food & dining": [
      ["🍽️", "Group dinner at a local favourite", "best restaurants in", [2]],
      ["🥘", "Street-food tasting", "street food in", [1, 2]],
    ],
    "Nature / hiking": [
      ["🥾", "Hike with a view", "hiking trails near", [0]],
      ["🌿", "Explore a nature spot", "nature parks near", [0, 1]],
    ],
    "Relaxation": [
      ["💆", "Spa or wellness session", "spas in", [1]],
      ["☕", "Slow start at a great café", "best cafes in", [0]],
    ],
    "Adventure": [
      ["🚤", "Watersports or adventure activity", "adventure activities in", [0, 1]],
      ["🛶", "Try something adrenaline-fuelled", "things to do in", [1]],
    ],
    "Culture": [
      ["🏛️", "Museum or heritage visit", "museums in", [0, 1]],
      ["🎭", "Local culture & markets", "cultural attractions in", [1]],
    ],
    "Shopping": [
      ["🛍️", "Markets & shopping streets", "shopping in", [1]],
    ],
  };
  const SLOTS = ["Morning", "Afternoon", "Evening"];
  function buildItinerary(plan) {
    const s = E.summarizePrefs(state.participants);
    let interests = s.activitiesRanked.map(([label]) => label);
    if (!interests.length) interests = ["Sightseeing", "Food & dining", "Relaxation"];
    const rand = mulberry32(state.itinerarySeed * 7919 + interests.length);
    const start = new Date(plan.dateStart + "T00:00:00");
    const end = new Date(plan.dateEnd + "T00:00:00");
    const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const days = Math.min(totalDays, 5);
    const pool = [];
    interests.forEach((label) => (IDEA_BANK[label] || []).forEach((idea) => pool.push(idea)));
    const fallback = [
      ["📸", "See the must-visit landmarks", "top attractions in", [0, 1]],
      ["🍽️", "Group dinner at a local favourite", "best restaurants in", [2]],
    ];
    const out = [];
    for (let d = 0; d < days; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + d);
      const label = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const usedToday = new Set();
      const slots = SLOTS.map((_, slotIdx) => {
        let candidates = pool.filter(
          (idea) => idea[3].includes(slotIdx) && !usedToday.has(idea[1])
        );
        if (!candidates.length) candidates = pool.filter((idea) => idea[3].includes(slotIdx));
        if (!candidates.length) candidates = fallback.filter((idea) => idea[3].includes(slotIdx));
        const pick = candidates[Math.floor(rand() * candidates.length)];
        usedToday.add(pick[1]);
        return pick;
      });
      out.push({ label, slots });
    }
    return { days: out, extraDays: totalDays - days };
  }

  function toolLink(emoji, label, href) {
    const a = el("a", {
      class: "invite-opt tool-opt",
      href,
      target: "_blank",
      rel: "noopener noreferrer",
    });
    a.appendChild(el("span", { text: emoji }));
    a.appendChild(el("span", { text: label }));
    return a;
  }

  // ---- Reunly Pro (monetisation) ----
  const PRO_FEATURES = [
    "Downloadable Trip Pack — a printable one-pager for the whole group",
    "Unlimited memory-wall photos (free keeps 3)",
    "Priority live-fare refresh & AI itinerary re-rolls",
    "Custom event cover & themes · no ads",
  ];
  function renderProCard() {
    const panel = $("#proPanel");
    if (!panel) return;
    panel.textContent = "";
    if (state.pro) return; // no upsell once unlocked
    const card = el("div", { class: "card pro-card stagger" });
    card.appendChild(el("div", { class: "pro-emoji", text: "✨" }));
    card.appendChild(el("div", { class: "pro-title", text: "Reunly Pro" }));
    card.appendChild(
      el("div", { class: "pro-sub", text: "Everything to run the perfect trip — for the whole group." })
    );
    card.appendChild(
      el("button", { class: "btn", style: "margin-top:12px", text: "See Pro — £7.99/event", onClick: openProModal })
    );
    panel.appendChild(card);
  }
  let proOpener = null;
  function openProModal() {
    proOpener = document.activeElement;
    const list = $("#proFeatures");
    list.textContent = "";
    PRO_FEATURES.forEach((f) => list.appendChild(el("li", { text: f })));
    $("#proUnlock").textContent = state.pro ? "✓ Pro is active" : "Unlock Pro (demo)";
    $("#proUnlock").disabled = state.pro;
    $("#proModal").hidden = false;
    $("#proClose").focus();
  }
  function closeProModal() {
    $("#proModal").hidden = true;
    if (proOpener && proOpener.focus) proOpener.focus();
  }
  function unlockPro() {
    state.pro = true;
    saveState();
    closeProModal();
    toast("✨ Reunly Pro unlocked (demo)");
    renderAll();
  }
  function wireProModal() {
    $("#proClose").addEventListener("click", closeProModal);
    $("#proUnlock").addEventListener("click", unlockPro);
    $("#proModal").addEventListener("click", (e) => {
      if (e.target.id === "proModal") closeProModal();
    });
  }

  // Trip Pack: a self-contained, printable HTML summary the organiser can save
  // as PDF or share. Built from our own data with escaped user text.
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function downloadTripPack() {
    const plan = state.lockedPlan;
    if (!plan) return;
    const days = E.daysUntil(plan.dateStart);
    const it = buildItinerary(plan);
    const goers = state.participants.filter((p) => p.rsvp === "in");
    const rows = goers
      .filter((p) => p.city)
      .map((p) => {
        const f = fareProvider(p.city, plan.destination);
        const fare = f && f.min != null ? `$${f.min}–$${f.max}` : "—";
        return `<tr><td>${escapeHtml(p.name || "Guest")}</td><td>${escapeHtml(p.city)}</td><td>${fare}</td></tr>`;
      })
      .join("");
    const itHtml = it.days
      .map(
        (d) =>
          `<h4>${escapeHtml(d.label)}</h4><ul>` +
          d.slots.map((s, i) => `<li><b>${["Morning", "Afternoon", "Evening"][i]}:</b> ${escapeHtml(s[1])}</li>`).join("") +
          `</ul>`
      )
      .join("");
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Trip Pack — ${escapeHtml(state.reunion.name)}</title>` +
      `<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:680px;margin:32px auto;padding:0 20px;color:#1a2233}` +
      `h1{margin:0 0 4px}h2{border-bottom:2px solid #6366f1;padding-bottom:4px;margin-top:28px;color:#4f46e5}` +
      `.hero{background:linear-gradient(135deg,#6366f1,#ec4899);color:#fff;padding:24px;border-radius:16px}` +
      `.big{font-size:2.4rem;font-weight:800}table{width:100%;border-collapse:collapse;margin-top:8px}` +
      `td,th{text-align:left;padding:8px;border-bottom:1px solid #eee}ul{margin:4px 0 12px}` +
      `.foot{margin-top:32px;color:#888;font-size:12px}@media print{.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style>` +
      `</head><body>` +
      `<div class="hero"><div style="opacity:.85">Reunly Trip Pack</div>` +
      `<h1>${escapeHtml(state.reunion.name || "Our get-together")}</h1>` +
      `<div class="big">📍 ${escapeHtml(plan.destination)}</div>` +
      `<div>${escapeHtml(plan.dateLabel)}${days > 0 ? ` · ${days} days to go` : ""}</div></div>` +
      `<h2>Who's going (${goers.length})</h2><table><tr><th>Name</th><th>From</th><th>Est. fare</th></tr>${rows}</table>` +
      `<h2>Suggested itinerary</h2>${itHtml}` +
      `<div class="foot">Generated by Reunly · fares are estimates, confirm before booking.</div>` +
      `</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Reunly-TripPack-${(state.reunion.name || "trip").replace(/[^a-z0-9]+/gi, "-")}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Trip pack downloaded — open it to print or share");
  }

  function renderPlan() {
    const panel = $("#planPanel");
    if (!panel) return;
    panel.textContent = "";
    const plan = state.lockedPlan;
    if (!plan) return; // toolkit + itinerary only exist once the plan is locked

    const dest = plan.destination;

    // --- Trip toolkit ---
    const kit = el("div", { class: "card toolkit stagger" });
    kit.appendChild(el("div", { class: "toolkit-title", text: "🧰 Trip toolkit" }));

    // Weather line (async; live via proxy → Open-Meteo).
    const wkey = `${dest}|${plan.dateStart}`;
    const w = weatherCache.get(wkey);
    if (w === undefined) fetchWeather(dest, plan.dateStart, plan.dateEnd);
    if (w && w !== "pending") {
      const rain = w.rainPct != null ? ` · ${w.rainPct}% rain risk` : "";
      const mode = w.mode === "forecast" ? "Forecast" : "Typically";
      kit.appendChild(
        el("div", {
          class: "weather-line",
          text: `🌤️ ${mode} ${w.tMin}–${w.tMax}°C in ${dest.split(",")[0]} for your dates${rain}`,
        })
      );
    } else if (w === "pending" || w === undefined) {
      kit.appendChild(el("div", { class: "weather-line muted", text: "🌤️ Checking the weather…" }));
    }

    const grid = el("div", { class: "invite-grid tool-grid" });
    grid.appendChild(toolLink("🏨", "Hotels", `https://www.google.com/travel/hotels?q=${encodeURIComponent(dest)}`));
    grid.appendChild(toolLink("🏠", "Airbnb", `https://www.airbnb.com/s/${encodeURIComponent(dest)}/homes`));
    grid.appendChild(toolLink("🗺️", "Explore map", E.mapsSearchLink(dest)));
    grid.appendChild(toolLink("🍽️", "Restaurants", E.mapsSearchLink(`restaurants in ${dest}`)));
    kit.appendChild(grid);
    const kitBtns = el("div", { class: "btn-row" });
    kitBtns.appendChild(
      el("button", {
        class: "btn secondary sm", style: "flex:1",
        text: "📅 Add to calendar", onClick: downloadIcs,
      })
    );
    kitBtns.appendChild(
      el("button", {
        class: "btn secondary sm", style: "flex:1",
        text: state.pro ? "📄 Trip pack" : "📄 Trip pack ✨",
        onClick: () => (state.pro ? downloadTripPack() : openProModal()),
      })
    );
    kit.appendChild(kitBtns);
    panel.appendChild(kit);

    // --- Smart itinerary ---
    const it = buildItinerary(plan);
    const card = el("div", { class: "card itinerary stagger" });
    const head = el("div", { class: "itin-head" });
    head.appendChild(el("div", { class: "toolkit-title", text: "✨ Suggested itinerary" }));
    head.appendChild(
      el("button", {
        class: "btn ghost sm",
        text: "🎲 Shuffle",
        onClick: () => {
          state.itinerarySeed += 1;
          saveState();
          renderPlan();
        },
      })
    );
    card.appendChild(head);
    card.appendChild(
      el("div", {
        class: "itin-sub",
        text: "Built from the group's activity interests — every idea links to a live map search.",
      })
    );
    it.days.forEach((day) => {
      const d = el("div", { class: "itin-day" });
      d.appendChild(el("div", { class: "itin-date", text: day.label }));
      day.slots.forEach(([emoji, text, query], i) => {
        const row = el("a", {
          class: "itin-row",
          href: E.mapsSearchLink(`${query} ${dest}`),
          target: "_blank",
          rel: "noopener noreferrer",
        });
        row.appendChild(el("span", { class: "itin-slot", text: SLOTS[i] }));
        row.appendChild(el("span", { class: "itin-emoji", text: emoji }));
        row.appendChild(el("span", { class: "itin-text", text: text }));
        d.appendChild(row);
      });
      card.appendChild(d);
    });
    if (it.extraDays > 0) {
      card.appendChild(
        el("div", { class: "itin-sub", text: `…plus ${it.extraDays} more free day${it.extraDays === 1 ? "" : "s"} to play with.` })
      );
    }
    panel.appendChild(card);
  }

  // -------------------------------------------------------------------------
  // Expenses & settle-up (Costs tab)
  // -------------------------------------------------------------------------
  function money(n) {
    // Always two decimals — toLocaleString alone renders 1234.5 as "1,234.5",
    // which reads as a typo on a money figure.
    return `$${(Math.round(n * 100) / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  function addExpense(payerId, desc, amount, sharedWith) {
    const amt = parseFloat(amount);
    if (!payerId || !desc.trim() || Number.isNaN(amt) || amt <= 0) {
      toast("Enter a payer, description and amount");
      return;
    }
    // Pin WHO this expense applies to at the moment it's logged. Without this,
    // someone who joins next week would silently be back-charged for a dinner
    // they never attended (the old behaviour recomputed the split live).
    const applies =
      Array.isArray(sharedWith) && sharedWith.length
        ? sharedWith.slice()
        : splitBase().map((p) => p.id);
    state.expenses.unshift({
      id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      payerId,
      desc: desc.trim(),
      amount: amt,
      sharedWith: applies,
      ts: Date.now(),
    });
    saveState();
    renderExpenses();
  }
  function deleteExpense(id) {
    state.expenses = state.expenses.filter((x) => x.id !== id);
    saveState();
    renderExpenses();
  }
  /** Who a new expense defaults to being split between: the confirmed goers. */
  function splitBase() {
    const goers = state.participants.filter((p) => p.rsvp === "in");
    return goers.length >= 2 ? goers : state.participants;
  }
  /**
   * Balance = what you paid minus your share of each expense you're part of.
   *
   * Each expense carries its OWN sharedWith list (pinned when logged), so
   * shares can differ per expense and latecomers aren't retroactively charged.
   * Legacy expenses saved before this existed fall back to the current base.
   */
  function computeSplit() {
    const base = splitBase();
    const baseIds = base.map((p) => p.id);
    const alive = new Set(state.participants.map((p) => p.id));
    const total = state.expenses.reduce((s, x) => s + x.amount, 0);
    const paid = {};
    const owed = {};
    state.expenses.forEach((x) => {
      paid[x.payerId] = (paid[x.payerId] || 0) + x.amount;
      // Only split between people who still exist in the roster, so removing
      // someone can't strand part of an expense unassigned.
      let sharers = (Array.isArray(x.sharedWith) && x.sharedWith.length ? x.sharedWith : baseIds)
        .filter((id) => alive.has(id));
      if (!sharers.length) sharers = [x.payerId]; // degenerate: payer covers it
      const each = x.amount / sharers.length;
      sharers.forEach((id) => (owed[id] = (owed[id] || 0) + each));
    });
    const share = base.length ? total / base.length : 0; // display-only average
    const balances = new Map();
    const inBase = new Set(baseIds);
    // Include anyone who PAID as well as anyone still on the roster. If a payer
    // was removed we'd otherwise drop their credit while still charging their
    // share to everyone else — the debts would silently vanish and the
    // settle-up list would render empty while money was still owed.
    const relevant = new Set([
      ...state.participants.map((p) => p.id),
      ...Object.keys(paid),
    ]);
    relevant.forEach((id) => {
      const b = (paid[id] || 0) - (owed[id] || 0);
      if (Math.abs(b) > 0.005 || inBase.has(id)) balances.set(id, b);
    });
    // Greedy settle-up: biggest debtor pays biggest creditor.
    const debtors = [], creditors = [];
    balances.forEach((b, id) => {
      if (b < -0.01) debtors.push({ id, amt: -b });
      else if (b > 0.01) creditors.push({ id, amt: b });
    });
    debtors.sort((a, b) => b.amt - a.amt);
    creditors.sort((a, b) => b.amt - a.amt);
    const transfers = [];
    let di = 0, ci = 0;
    while (di < debtors.length && ci < creditors.length) {
      const pay = Math.min(debtors[di].amt, creditors[ci].amt);
      transfers.push({ from: debtors[di].id, to: creditors[ci].id, amount: pay });
      debtors[di].amt -= pay;
      creditors[ci].amt -= pay;
      if (debtors[di].amt < 0.01) di++;
      if (creditors[ci].amt < 0.01) ci++;
    }
    return { total, share, base, balances, transfers };
  }
  /**
   * Remember a departed participant's name so expenses they paid still read
   * sensibly ("Ana → Bob") instead of degrading to "Someone".
   */
  function rememberName(id, name) {
    if (!id || !name) return;
    state.pastNames = state.pastNames || {};
    state.pastNames[id] = name;
  }
  function pName(id) {
    const p = state.participants.find((x) => x.id === id);
    if (p) return p.name || "Unnamed";
    const past = state.pastNames && state.pastNames[id];
    return past ? `${past} (removed)` : "Someone";
  }
  function renderExpenses() {
    const panel = $("#expensePanel");
    if (!panel) return;
    panel.textContent = "";
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "toolkit-title", text: "💸 Expenses & settle-up" }));

    const { total, share, base, balances, transfers } = computeSplit();
    card.appendChild(
      el("div", {
        class: "itin-sub",
        text:
          `Amounts in USD · new expenses default to splitting between the ${base.length} ` +
          `${base.length === state.participants.length ? "people here" : "going"}. ` +
          "Untick anyone an expense shouldn't apply to.",
      })
    );

    // Add-expense form.
    const form = el("div", { class: "exp-form" });
    const payerSel = el("select", { "aria-label": "Who paid" });
    state.participants.forEach((p) => {
      const o = el("option", { value: p.id, text: p.name || "Unnamed" });
      if (p.id === state.me) o.selected = true;
      payerSel.appendChild(o);
    });
    const descIn = el("input", { type: "text", placeholder: "What for? e.g. Villa deposit" });
    const amtIn = el("input", { type: "number", min: "0", step: "0.01", placeholder: "USD", inputmode: "decimal" });
    form.appendChild(payerSel);
    form.appendChild(descIn);

    // Per-expense "split between" picker — this is what makes unequal shares
    // and late joiners work correctly (see addExpense/computeSplit).
    const baseIds = new Set(base.map((p) => p.id));
    const chosen = new Set(baseIds);
    const whoWrap = el("div", { class: "exp-who" });
    whoWrap.appendChild(el("div", { class: "exp-who-label", text: "Split between" }));
    const chips = el("div", { class: "chip-select" });
    state.participants.forEach((p) => {
      const on = chosen.has(p.id);
      chips.appendChild(
        el("button", {
          type: "button",
          class: `chip-toggle${on ? " on" : ""}`,
          text: p.name || "Unnamed",
          onClick: (e) => {
            if (chosen.has(p.id)) chosen.delete(p.id);
            else chosen.add(p.id);
            e.currentTarget.classList.toggle("on");
          },
        })
      );
    });
    whoWrap.appendChild(chips);
    form.appendChild(whoWrap);

    const row = el("div", { class: "exp-form-row" });
    row.appendChild(amtIn);
    row.appendChild(
      el("button", {
        class: "btn sm",
        text: "Add expense",
        onClick: () => {
          if (!chosen.size) {
            toast("Pick at least one person to split between");
            return;
          }
          addExpense(payerSel.value, descIn.value, amtIn.value, [...chosen]);
        },
      })
    );
    form.appendChild(row);
    card.appendChild(form);

    if (!state.expenses.length) {
      card.appendChild(el("div", { class: "empty", text: "No expenses yet — add the first one." }));
      panel.appendChild(card);
      return;
    }

    // Expense list.
    const list = el("div", { class: "exp-list" });
    state.expenses.forEach((x) => {
      const r = el("div", { class: "exp-item" });
      const w = el("div", { style: "flex:1;min-width:0" });
      w.appendChild(el("div", { class: "exp-desc", text: x.desc }));
      // Show the split scope so an unequal share is visible, not hidden.
      const alive = new Set(state.participants.map((q) => q.id));
      const sharers = (Array.isArray(x.sharedWith) ? x.sharedWith : []).filter((id) => alive.has(id));
      let scope = "";
      if (sharers.length && sharers.length !== state.participants.length) {
        scope =
          sharers.length <= 3
            ? ` · split between ${sharers.map(pName).join(", ")}`
            : ` · split ${sharers.length} ways`;
      }
      w.appendChild(el("div", { class: "exp-meta", text: `paid by ${pName(x.payerId)}${scope}` }));
      r.appendChild(w);
      r.appendChild(el("span", { class: "exp-amt", text: money(x.amount) }));
      if (state.role === "organizer" || x.payerId === state.me) {
        r.appendChild(
          el("button", { class: "icon-btn sm", "aria-label": "Delete expense", text: "✕", onClick: () => deleteExpense(x.id) })
        );
      }
      list.appendChild(r);
    });
    card.appendChild(list);
    // "each" is only meaningful when every expense is split the same way;
    // otherwise show the average so it isn't mistaken for an exact figure.
    const uniform = state.expenses.every((x) => {
      const s = Array.isArray(x.sharedWith) ? x.sharedWith : [];
      return !s.length || s.length === base.length;
    });
    card.appendChild(
      el("div", {
        class: "exp-total",
        text: `Total ${money(total)} · ${uniform ? `${money(share)} each` : `${money(share)} avg per person`}`,
      })
    );

    // Settle-up transfers.
    if (transfers.length) {
      card.appendChild(el("div", { class: "gl", text: "To settle up", style: "margin-top:12px" }));
      transfers.forEach((t) => {
        card.appendChild(
          el("div", {
            class: "exp-transfer",
            text: `${pName(t.from)} → ${pName(t.to)}  ${money(t.amount)}`,
          })
        );
      });
    }
    panel.appendChild(card);
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
    const proBadge = $("#proBadge");
    if (proBadge) proBadge.hidden = !state.pro;
    renderDemoBanner();
    const notifWrap = $("#notifWrap");
    if (notifWrap) notifWrap.hidden = state.role !== "organizer";
  }

  // ---- Notifications: "someone responded" (organiser only, cross-device) ----
  // Backed by a tiny in-memory endpoint on the server (see server.py /api/notify).
  // This is the one piece of Reunly that isn't purely local-device state — it's
  // how the organiser finds out an invitee (on a different phone entirely)
  // answered the confirm step. Best-effort: if the server is asleep/offline,
  // this silently does nothing and the rest of the app is unaffected.
  function renderNotifDot() {
    const dot = $("#notifDot");
    if (!dot) return;
    dot.hidden = !notifItems.some((n) => n.ts > state.notifSeen);
  }
  function renderNotifPanel() {
    const panel = $("#notifPanel");
    if (!panel) return;
    panel.textContent = "";
    if (!notifItems.length) {
      panel.appendChild(
        el("div", { class: "notif-empty", text: "No responses yet — they'll show up here as people confirm." })
      );
      return;
    }
    [...notifItems]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 30)
      .forEach((n) => {
        const item = el("div", { class: "notif-item" });
        item.appendChild(el("div", { class: "notif-name", text: `${n.name || "Someone"} responded` }));
        const bits = [];
        bits.push(n.destOk ? `✓ ${n.destination}` : `wants a different place`);
        bits.push(n.dateOk ? `✓ ${n.dateLabel}` : `different dates`);
        item.appendChild(el("div", { class: "notif-meta", text: bits.join(" · ") }));
        panel.appendChild(item);
      });
  }
  async function pollNotifications() {
    const code = state.reunion.code;
    if (state.role !== "organizer" || !code || code === "—") return;
    try {
      const res = await fetch(`/api/notify?code=${encodeURIComponent(code)}&since=0`);
      const data = await res.json();
      notifItems = Array.isArray(data.results) ? data.results : [];
      renderNotifDot();
      if (!$("#notifPanel").hidden) renderNotifPanel();
    } catch (e) {
      /* server asleep (Render free tier) or offline — try again next tick */
    }
  }
  function wireNotifBell() {
    const btn = $("#notifBtn");
    const panel = $("#notifPanel");
    if (!btn || !panel) return;
    btn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        renderNotifPanel();
        const newest = notifItems.reduce((m, n) => Math.max(m, n.ts), 0);
        if (newest > state.notifSeen) {
          state.notifSeen = newest;
          saveState();
        }
        renderNotifDot();
      }
    });
    document.addEventListener("click", (e) => {
      const wrap = $("#notifWrap");
      if (wrap && !panel.hidden && !wrap.contains(e.target)) panel.hidden = true;
    });
  }
  function startNotifPolling() {
    clearInterval(notifPollTimer);
    pollNotifications();
    notifPollTimer = setInterval(pollNotifications, 20000);
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
  // Jump to the People tab with the current user's own card open for editing.
  function goEditMine() {
    state.editingId = state.me;
    showPhase("people");
    renderAll();
    const node = document.getElementById(`pcard-${state.me}`);
    if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- Memory wall (real: photos + notes, author-tagged, on-device storage) ----
  const photoCap = () => (state.pro ? 40 : 3); // free tier: 3 photos; Pro: 40
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
    if (state.memories.filter((m) => m.type === "photo").length >= photoCap()) {
      if (!state.pro) {
        openProModal();
        return;
      }
      toast(`Photo limit reached (${photoCap()}) on this device`);
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
    renderPlan();
    // NOTE: renderWinner() is deliberately NOT called here (same reasoning as
    // renderParticipants() below) — its confirm-step can contain live text
    // inputs (the "No, here's my alternative" date/place editors), and
    // rebuilding them on every debounced keystroke would steal focus while
    // typing. It's refreshed explicitly wherever the confirm step itself
    // changes (Yes/No clicks, add/remove row) and by the full renderAll().
    renderVote();
    renderRecommendations();
    renderInsights();
    renderProCard();
    renderCosts();
    renderExpenses();
    renderMemories();
    saveState();
    refreshFares();
  }

  let recomputeTimer = null;
  function scheduleRecompute(edited) {
    // Every participant-field edit funnels through here, so this is the single
    // place that reliably marks "answers changed" for link merging. Pass the
    // participant being edited — an organiser may be filling in someone else's
    // card, in which case stamping "me" would mark the wrong record.
    if (edited) touchParticipant(edited);
    else touchMine();
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recomputeDerived, 200);
  }

  // Full render (used on structural changes: add/remove/edit toggle).
  function renderAll() {
    clearTimeout(recomputeTimer); // a structural render supersedes any pending debounce
    renderMeta();
    renderCountdown();
    renderPlan();
    renderWinner();
    renderVote();
    renderParticipants();
    renderRecommendations();
    renderInsights();
    renderProCard();
    renderCosts();
    renderExpenses();
    renderMemories();
    saveState();
    refreshFares();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function init() {
    populateEventTypes();
    wireRegister();
    wireChoose();
    wireReunionMeta();
    wirePhases();
    wirePhoneModal();
    wireProModal();
    wireNotifBell();
    registerServiceWorker();
    updateCurrencyToggle();
    startRotator();
    startFlight();
    initTheme();

    // Boot precedence: peek at BOTH a shared invite link and any saved local
    // session before applying either, so an invite link can never silently
    // overwrite progress already made on this device (see peekSavedState()).
    const hashData = peekHashPayload();
    const saved = peekSavedState();
    if (hashData && saved) {
      const savedCode = saved.reunion && saved.reunion.code;
      if (savedCode && savedCode === hashData.code) {
        // Same event, link opened again — resume local progress as-is and
        // just pick up anyone new who joined since.
        applySavedState(saved);
        const { added, updated } = mergeParticipantsFromHash(hashData);
        location.hash = "";
        if (state.user) {
          saveState();
          enterDashboard("resume", state.reunion.code);
          const bits = [];
          if (added) bits.push(`${added} new ${added === 1 ? "person" : "people"}`);
          if (updated) bits.push(`${updated} updated ${updated === 1 ? "reply" : "replies"}`);
          if (bits.length) toast(`Welcome back — ${bits.join(" · ")}.`);
        } else {
          showScreen("register");
        }
      } else {
        // A DIFFERENT event — never switch silently. Ask first.
        const currentName = (saved.reunion && saved.reunion.name) || "your current event";
        const incomingName = hashData.name || "this event";
        const swap = window.confirm(
          `You have "${currentName}" in progress on this device.\n\n` +
            `Opening this link will switch to "${incomingName}" and replace your current progress.\n\nContinue?`
        );
        location.hash = "";
        if (swap) {
          applyHashPayload(hashData);
          state.fromInvite = true;
          $("#choiceGreeting").textContent = `Joining "${state.reunion.name}"`;
          showScreen("register");
        } else {
          applySavedState(saved);
          if (state.user) {
            enterDashboard("resume", state.reunion.code);
          } else {
            showScreen("register");
          }
        }
      }
    } else if (hashData) {
      // First time seeing this device — normal join flow.
      applyHashPayload(hashData);
      state.fromInvite = true;
      // Pre-fill the share-link reunion name so the user sees what they're joining.
      $("#choiceGreeting").textContent = `Joining "${state.reunion.name}"`;
      showScreen("register");
    } else if (saved) {
      applySavedState(saved);
      if (state.user) {
        enterDashboard("resume", state.reunion.code);
      } else {
        showScreen("register");
      }
    } else {
      showScreen("register");
    }
    initOnboarding();
    startNotifPolling(); // no-ops until state.role === "organizer" with a real code
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

  // Ambient flight animation: pick a fresh random route each time the plane
  // completes its arc (on the CSS animation's iteration boundary).
  function startFlight() {
    const plane = document.querySelector(".flight-plane");
    const fromEl = $("#flightFrom");
    const toEl = $("#flightTo");
    if (!plane || !fromEl || !toEl) return;
    const cities = [
      "London", "Delhi", "New York", "Dubai", "Singapore", "Tokyo", "Paris",
      "Sydney", "Bangkok", "Mumbai", "Toronto", "Cape Town", "Rome", "Istanbul",
      "Bali", "Hong Kong", "Los Angeles", "Barcelona", "Goa",
    ];
    const roll = () => {
      const a = Math.floor(Math.random() * cities.length);
      let b = Math.floor(Math.random() * cities.length);
      while (b === a) b = Math.floor(Math.random() * cities.length);
      fromEl.textContent = cities[a];
      toEl.textContent = cities[b];
    };
    roll();
    plane.addEventListener("animationiteration", roll);
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
