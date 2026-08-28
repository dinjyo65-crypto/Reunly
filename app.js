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
    // When the lock last changed, in ms. Locking and UNLOCKING both stamp it,
    // so an invite link can carry "the plan moved" and "the plan was called
    // off" as distinct, orderable facts rather than only "there is a plan".
    lockTs: 0,
    // Prep checklist and per-person booking status, each stored as
    // { [key]: { on: bool, ts: ms } }. A bare boolean unioned on merge, which
    // meant a mis-tap could never be undone: the person unticked it, then the
    // next link from any device still holding the tick put it back — and the
    // organiser went on believing someone had booked a flight they hadn't.
    // Stamping each key lets the most recent decision win in both directions.
    prepDone: {},
    booked: {},
    // When the agreed plan last changed, and which prep steps survived it.
    // Ticks older than this describe a trip that was cancelled or moved.
    planTs: 0,
    planKeepIds: [],
    // Participant removals, as timestamped flags like the others. A removal
    // only wins over an incoming row if it is NEWER than that row's own edit —
    // someone re-adding themselves after being removed should stick.
    removedPeople: {},
    ballot: null, // { open, openedBy, options:[...], votesByParticipant:{ id:{optionId} } }
    memories: [], // [{ id, authorId, authorName, type:"note"|"photo", text, dataUrl?, ts }]
    expenses: [], // [{ id, payerId, desc, amount(USD), ts, settlement? }]
    deletedExpenses: [], // ids of removed expenses, so a merge can't resurrect them
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
  const SVG_NS = "http://www.w3.org/2000/svg";

  // What the all-in figure does NOT include. Enumerating three items made the
  // list read as complete while omitting visas and travel insurance — the two
  // costs the app's own prep checklist instructs international groups to buy.
  // They also differ in kind from food and activities: mandatory, pre-departure
  // and non-discretionary. One string, so the three places that disclose this
  // can't drift apart again.
  const COST_EXCLUSIONS = "food, activities, local transport, visas and travel insurance";

  /** How stale a dated reference is, in whole days (negative = future). */
  function ageInDays(iso) {
    const days = E.daysUntil(iso);
    return days == null ? null : -days;
  }

  // Timestamped on/off flags, used for the prep checklist and booking status.
  // Accepts the old bare-boolean shape so existing saves and older links still
  // load — an untimestamped tick is treated as very old, so any real decision
  // beats it.
  function normalizeFlags(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object") {
        if (Number.isFinite(v.ts)) out[k] = { on: !!v.on, ts: v.ts };
      } else if (v) {
        out[k] = { on: true, ts: 1 };
      }
    }
    return out;
  }
  /**
   * Is this flag on, and still about the trip we're actually taking?
   *
   * Ticks made before the plan last moved are ignored rather than deleted, so
   * the rule holds on every device without needing the clear to propagate.
   */
  function flagOn(map, key) {
    const f = map && map[key];
    if (!f || !f.on) return false;
    const planTs = state.planTs || 0;
    if (!planTs || (f.ts || 0) >= planTs) return true;
    return (state.planKeepIds || []).includes(key);
  }

  /** Wire form -> ballot. */
  function ballotFromPayload(b) {
    if (!b || !Array.isArray(b.options) || !b.options.length) return null;
    const votesByParticipant = {};
    (b.votes || []).forEach(([pid, optionId, ts]) => {
      votesByParticipant[pid] = { optionId, ts: ts || 0 };
    });
    return {
      open: !!b.open,
      openedBy: b.openedBy || "",
      ts: b.ts || 0,
      options: b.options,
      votesByParticipant,
    };
  }

  /**
   * Merge two ballots. Votes are per-voter last-write-wins, exactly like
   * participant answers; whether voting is open is the organiser's call, so the
   * newest stamp wins outright. A ballot re-opened with different options
   * replaces the old one — its votes were cast on questions that no longer
   * exist, so carrying them over would be inventing answers.
   */
  function mergeBallot(mine, theirs) {
    if (!theirs) return mine;
    if (!mine) return theirs;
    const sameQuestions =
      mine.options.length === theirs.options.length &&
      mine.options.every((o, i) => o.id === theirs.options[i].id);
    if (!sameQuestions) return (theirs.ts || 0) > (mine.ts || 0) ? theirs : mine;
    const votes = { ...mine.votesByParticipant };
    Object.entries(theirs.votesByParticipant).forEach(([pid, vote]) => {
      if (!votes[pid] || (vote.ts || 0) > (votes[pid].ts || 0)) votes[pid] = vote;
    });
    const newer = (theirs.ts || 0) > (mine.ts || 0) ? theirs : mine;
    return { ...newer, options: mine.options, votesByParticipant: votes };
  }
  function setFlag(mapName, key, on) {
    state[mapName] = { ...(state[mapName] || {}) };
    state[mapName][key] = { on, ts: Date.now() };
  }
  /** Newest write per key wins, in both directions. */
  function mergeFlags(mine, theirs) {
    const out = { ...(mine || {}) };
    for (const [k, v] of Object.entries(theirs || {})) {
      if (!out[k] || (v.ts || 0) > (out[k].ts || 0)) out[k] = v;
    }
    return out;
  }

  // Fare provider injected into the engine: prefer a fetched (live/searched)
  // fare from the proxy cache, fall back to the synchronous engine estimate.
  // The engine calls this with two arguments, so the window comes from here
  // rather than being threaded through every call site.
  // Memoised behind the same flag as the ranking. fareProvider is the innermost
  // function in rankCombinations — called once per destination x window x
  // participant, three times over — and each call was rebuilding and sorting a
  // tally of every participant's every date row to find a start date that
  // cannot change during the pass. That put the O(n^2) blow-up the candidate
  // caps were added to prevent straight back in through another door: a
  // 12-person group froze the main thread for ~1s on every keystroke, 20 people
  // for 8s, and a crafted 60-person link for 47s.
  let pricingWindowCache = null;
  const fareDate = () => {
    if (pricingWindowCache === null) pricingWindowCache = { w: pricingWindow() };
    return pricingWindowCache.w ? pricingWindowCache.w.start : null;
  };
  // Whether people needing a bed on their own can pair up in a twin — which is
  // the basis the nightly bands are quoted on. Everything that prices lodging
  // must agree on this, or the Costs tab, the winner card and the Trip Pack
  // quote different stays for the same trip.
  // Per destination: everyone is local to somewhere, so whether the people
  // needing a bed can pair up depends on where the trip is.
  const tripOpts = (destination) => ({
    canShare: E.soloBedCount(state.participants, destination, fareProvider) >= 2,
  });

  const fareProvider = (from, to) =>
    window.ReunlyFares.getCached(from, to, fareDate()) || E.getFare(from, to);

  // ---- Persistence ----
  const LS_STATE = "reunly_state_v1";
  // Bumped when stored data needs interpreting differently. v2: `accommodation`
  // became tri-state — a stored `false` from v1 meant "checkbox untouched",
  // NOT "I'm sorted", and must not be read as an opt-out.
  const STATE_VERSION = 2;
  function migrateSaved(saved) {
    if (!saved || typeof saved !== "object") return saved;
    if ((saved.v || 1) < 2 && Array.isArray(saved.participants)) {
      saved.participants.forEach((p) => {
        if (p && p.prefs && p.prefs.accommodation === false) p.prefs.accommodation = null;
      });
    }
    saved.v = STATE_VERSION;
    return saved;
  }
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
          v: STATE_VERSION,
          user: state.user,
          reunion: state.reunion,
          participants: state.participants,
          me: state.me,
          role: state.role,
          phase: state.phase,
          currencyMode: state.currencyMode,
          demoMode: state.demoMode,
          lockedPlan: state.lockedPlan,
          lockTs: state.lockTs,
          planTs: state.planTs,
          planKeepIds: state.planKeepIds,
          removedPeople: state.removedPeople,
          pastNames: state.pastNames,
          prepDone: state.prepDone,
          booked: state.booked,
          ballot: state.ballot,
          memories: state.memories,
          expenses: state.expenses,
          deletedExpenses: state.deletedExpenses,
          itinerarySeed: state.itinerarySeed,
          pastNames: state.pastNames,
          pro: state.pro,
          notifSeen: state.notifSeen,
        })
      );
      if (storageFailed) {
        // A later write succeeded (e.g. after deleting a photo) — stop
        // claiming the device is full.
        storageFailed = false;
        renderStorageWarning();
      }
      return true;
    } catch (e) {
      // Silence here meant every later edit, RSVP and expense vanished on
      // reload with no hint anything was wrong. Tell the user once.
      if (!storageFailed) {
        storageFailed = true;
        try {
          toast("Out of space — changes aren't being saved on this device");
        } catch (_) {
          /* toast may not exist yet during boot */
        }
      }
      renderStorageWarning();
      return false;
    }
  }
  let storageFailed = false;
  function renderStorageWarning() {
    const bar = document.getElementById("storageWarning");
    if (!bar) return;
    bar.hidden = !storageFailed;
    if (storageFailed && !bar.textContent) {
      bar.textContent =
        "⚠️ This device is out of storage, so new changes aren't being saved. Remove some memory-wall photos to free space.";
    }
  }
  // Parse saved localStorage state WITHOUT applying it to `state` yet — boot
  // needs to compare this against an incoming invite link (see init()) before
  // deciding which one should actually win, so an invite link can never
  // silently wipe out progress someone already made on this device.
  function peekSavedState() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_STATE) || "null");
      if (s && Array.isArray(s.participants)) return migrateSaved(s);
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
    state.lockTs = s.lockTs || 0;
    state.planTs = s.planTs || 0;
    state.planKeepIds = Array.isArray(s.planKeepIds) ? s.planKeepIds : [];
    state.removedPeople = normalizeFlags(s.removedPeople);
    state.prepDone = normalizeFlags(s.prepDone);
    state.booked = normalizeFlags(s.booked);
    state.ballot = s.ballot || null;
    state.memories = Array.isArray(s.memories) ? s.memories : [];
    state.expenses = Array.isArray(s.expenses) ? s.expenses : [];
    state.deletedExpenses = Array.isArray(s.deletedExpenses) ? s.deletedExpenses : [];
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
  // Only a version mismatch between cached files justifies wiping the cache.
  // Reloading on ANY error hid real bugs behind a mystery refresh and threw
  // away offline capability as a side effect.
  const STALE_ASSET = /(ReunlyEngine|ReunlyData|ReunlyFares)\b[^]{0,40}(is not defined|undefined)/i;
  function looksLikeStaleAssets(evt) {
    const msg =
      (evt && evt.message) ||
      (evt && evt.reason && (evt.reason.message || String(evt.reason))) ||
      "";
    return STALE_ASSET.test(String(msg));
  }
  async function selfHeal(evt) {
    if (evt && !looksLikeStaleAssets(evt)) return; // a real bug — let it surface
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
      // Only people holding the link can read or post notifications.
      nt: notifyToken(),
      name: state.reunion.name,
      type: state.reunion.type,
      // The agreed plan travels with the link, so a joiner sees what was
      // decided rather than an apparently-undecided event.
      locked: state.lockedPlan || null,
      // Sent even when `locked` is null: that combination is how a link says
      // "the plan was unlocked", which the old payload simply could not express.
      lts: state.lockTs || 0,
      pts: state.planTs || 0,
      pk: (state.planKeepIds || []).slice(0, 8),
      // The ballot travels. Everything else the group shares was deliberately
      // made to round-trip; the vote was missed, which left the whole feature
      // inert in the only mode that matters — recipients saw a blank vote area,
      // their votes could never come back, and the organiser's card read
      // "1 of 9 voted" forever while offering to lock a tally of one.
      b: state.ballot
        ? {
            o: state.ballot.open ? 1 : 0,
            by: state.ballot.openedBy || "",
            ts: state.ballot.ts || 0,
            opts: (state.ballot.options || []).slice(0, 8).map((x) => [
              x.id, x.destination, x.dateStart, x.dateEnd, x.dateLabel,
            ]),
            v: Object.entries(state.ballot.votesByParticipant || {})
              .slice(0, MAX_PEOPLE)
              .map(([pid, vote]) => [pid, vote.optionId, vote.ts || 0]),
          }
        : null,
      // Removals travel, with the names so a departed payer doesn't degrade to
      // "Someone" on every other device.
      rm: Object.entries(state.removedPeople || {})
        .filter(([, v]) => v.on)
        .slice(0, MAX_PEOPLE)
        .map(([id, v]) => [id, v.ts || 0, str((state.pastNames || {})[id] || "", 80)]),
      // Prep progress travels too: "who has booked?" is only useful as one
      // shared answer, not a private note on each person's phone. Sent as
      // [key, on, ts] triples — sending only the keys that were true made an
      // untick unrepresentable, so it could never propagate.
      pd: Object.entries(state.prepDone || {}).slice(0, 40)
        .map(([k, v]) => [k, v.on ? 1 : 0, v.ts || 0]),
      bk: Object.entries(state.booked || {}).slice(0, MAX_PEOPLE)
        .map(([k, v]) => [k, v.on ? 1 : 0, v.ts || 0]),
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
      // The ledger travels too. Expenses are append-only with stable ids, so
      // merging is a union rather than a conflict — but without them every
      // device kept a private ledger while the UI called it the group's.
      x: state.expenses.slice(0, MAX_EXPENSES).map((e) => ({
        id: e.id, by: e.payerId, d: e.desc, a: e.amount,
        w: e.sharedWith, s: e.settlement ? 1 : 0, ts: e.ts || 0,
      })),
      // Deletions travel with the ledger; otherwise a union-merge from an
      // older link brings removed expenses back.
      xd: (state.deletedExpenses || []).slice(-MAX_EXPENSES),
    };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return `${location.origin}${location.pathname}#r=${b64}`;
  }
  // Parse an invite-link hash WITHOUT applying it — see peekSavedState() above
  // for why boot needs to look at both before it leaps.
  // An invite link is untrusted input: it can be edited, truncated, or crafted.
  // Everything downstream (date maths, .ics export, rendering) assumes strings
  // and sane sizes, so clamp the payload at the door rather than letting a bad
  // link throw somewhere far away — or hang the tab with a huge date list.
  const MAX_PEOPLE = 60;
  const MAX_EXPENSES = 200;
  const MAX_ROWS = 12; // ranked dates / destinations per person
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  // Five minutes of slack absorbs ordinary clock drift between devices.
  const clampTs = (v) =>
    Number.isFinite(v) ? Math.min(Math.max(0, v), Date.now() + 5 * 60 * 1000) : 0;
  // The shape alone is not enough: "2026-13-45" matches the pattern, and once
  // it reaches lockedPlan the calendar export throws RangeError — which the
  // global error handler treats as corruption and responds to by clearing
  // every cache and reloading. Require the date to survive a round trip.
  const isoOrEmpty = (v) => {
    if (typeof v !== "string" || !ISO_DATE.test(v)) return "";
    const t = Date.parse(v + "T00:00:00Z");
    if (!Number.isFinite(t)) return "";
    return new Date(t).toISOString().slice(0, 10) === v ? v : "";
  };

  function sanitizePayload(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.p)) return null;
    const clean = {
      code: str(data.code, 40),
      nt: str(data.nt, 64),
      name: str(data.name, 120),
      type: str(data.type, 60),
      p: data.p.slice(0, MAX_PEOPLE).map((x) => {
        const src = x && typeof x === "object" ? x : {};
        const dates = Array.isArray(src.d) ? src.d.slice(0, MAX_ROWS) : [];
        const dests = Array.isArray(src.x) ? src.x.slice(0, MAX_ROWS) : [];
        const pr = src.pr && typeof src.pr === "object" ? src.pr : {};
        return {
          id: str(src.id, 40),
          n: str(src.n, 80),
          e: str(src.e, 120),
          c: str(src.c, 120),
          d: dates.map((d) => ({
            start: isoOrEmpty(d && d.start),
            end: isoOrEmpty(d && d.end),
          })),
          x: dests.map((d) => str(d, 120)),
          pr: {
            budget: str(String(pr.budget == null ? "" : pr.budget), 12),
            food: str(pr.food, 40),
            // A v1 link's `false` was the untouched default, not an opt-out.
            accommodation:
              pr.accommodation === true
                ? true
                : pr.accommodation === false && Number(data.v) >= 2
                ? false
                : null,
            kids: Math.max(0, Math.min(20, parseInt(pr.kids, 10) || 0)),
            accessibility: str(pr.accessibility, 200),
            activities: Array.isArray(pr.activities)
              ? pr.activities.slice(0, 20).map((a) => str(a, 40)).filter(Boolean)
              : [],
          },
          rsvp: ["in", "out", "no_response"].includes(src.rsvp) ? src.rsvp : "no_response",
          dc: src.dc === true || src.dc === false ? src.dc : null,
          xc: src.xc === true || src.xc === false ? src.xc : null,
          // Clamp the clock. updatedAt is only ever written as Date.now(), so
          // a row arriving from a future date wins last-write-wins FOREVER and
          // every genuine reply after it is silently discarded — the merge
          // reports "0 updated" and the person thinks they replied. A phone
          // with its clock set wrong is enough; no attacker required.
          ts: clampTs(src.ts),
        };
      }),
    };
    if (Array.isArray(data.x)) {
      clean.x = data.x
        .slice(0, MAX_EXPENSES)
        .map((e) => {
          const src = e && typeof e === "object" ? e : {};
          const amount = Number(src.a);
          return {
            id: str(src.id, 60),
            by: str(src.by, 40),
            d: str(src.d, 120),
            a: Number.isFinite(amount) ? amount : NaN,
            w: Array.isArray(src.w) ? src.w.slice(0, MAX_PEOPLE).map((i) => str(i, 40)).filter(Boolean) : [],
            s: src.s === 1,
            ts: clampTs(src.ts),
          };
        })
        // Drop anything unusable rather than letting a NaN poison every balance.
        // Negative amounts are legitimate — a refund line — so only zero and
        // non-numbers are rejected. Requiring > 0 here silently deleted every
        // refund the moment the ledger travelled through an invite link.
        .filter((e) => e.id && e.by && Number.isFinite(e.a) && e.a !== 0);
    }
    if (Array.isArray(data.xd)) {
      clean.xd = data.xd.slice(0, MAX_EXPENSES).map((i) => str(i, 60)).filter(Boolean);
    }
    // Carried even when there is no lock: `locked: null` with a newer stamp is
    // how a link says the organiser called the plan off.
    clean.lts = Number.isFinite(data.lts) ? data.lts : 0;
    clean.pts = clampTs(data.pts);
    clean.pk = Array.isArray(data.pk)
      ? data.pk.slice(0, 8).map((i) => str(i, 40)).filter(Boolean)
      : [];
    // Accepts both the [key, on, ts] triples and the older bare-key arrays.
    const flags = (arr, cap) =>
      Array.isArray(arr)
        ? arr.slice(0, cap).reduce((acc, row) => {
            if (Array.isArray(row)) {
              const k = str(row[0], 40);
              if (k) acc[k] = { on: row[1] === 1, ts: clampTs(row[2]) };
            } else {
              const k = str(row, 40);
              if (k) acc[k] = { on: true, ts: 1 };
            }
            return acc;
          }, {})
        : {};
    if (data.b && typeof data.b === "object" && Array.isArray(data.b.opts)) {
      const opts = data.b.opts
        .slice(0, 8)
        .filter((o) => Array.isArray(o) && str(o[0], 60))
        .map((o) => ({
          id: str(o[0], 60),
          destination: str(o[1], 120),
          dateStart: isoOrEmpty(o[2]),
          dateEnd: isoOrEmpty(o[3]),
          dateLabel: str(o[4], 60),
        }))
        .filter((o) => o.destination && o.dateStart && o.dateEnd);
      if (opts.length) {
        const known = new Set(opts.map((o) => o.id));
        clean.b = {
          open: data.b.o === 1,
          openedBy: str(data.b.by, 40),
          ts: clampTs(data.b.ts),
          options: opts,
          // Drop votes for options this ballot doesn't contain.
          votes: (Array.isArray(data.b.v) ? data.b.v : [])
            .slice(0, MAX_PEOPLE)
            .filter((v) => Array.isArray(v) && str(v[0], 40) && known.has(str(v[1], 60)))
            .map((v) => [str(v[0], 40), str(v[1], 60), clampTs(v[2])]),
        };
      }
    }
    clean.rm = Array.isArray(data.rm)
      ? data.rm
          .slice(0, MAX_PEOPLE)
          .filter((r) => Array.isArray(r) && str(r[0], 40))
          .map((r) => [str(r[0], 40), clampTs(r[1]), str(r[2], 80)])
      : [];
    clean.pd = flags(data.pd, 40);
    clean.bk = flags(data.bk, MAX_PEOPLE);
    if (data.locked && typeof data.locked === "object") {
      const l = data.locked;
      const start = isoOrEmpty(l.dateStart);
      const end = isoOrEmpty(l.dateEnd);
      const dest = str(l.destination, 120);
      // Only accept a lock that's actually usable; a half-formed one would
      // surface as a broken countdown or a crash in the calendar export.
      if (start && end && dest) {
        clean.locked = { destination: dest, dateStart: start, dateEnd: end, dateLabel: str(l.dateLabel, 60) };
      }
    }
    return clean;
  }

  function peekHashPayload() {
    const m = (location.hash || "").match(/^#r=(.+)$/);
    if (!m) return null;
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      return sanitizePayload(data);
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
      // Inherited from the link — without it a joiner can't see or post
      // notifications for this group.
      notifyToken: data.nt || "",
    };
    state.participants = data.p.map(participantFromPayload);
    if (data.locked) state.lockedPlan = data.locked;
    state.lockTs = data.lts || 0;
    state.planTs = data.pts || 0;
    state.planKeepIds = data.pk || [];
    state.removedPeople = {};
    state.pastNames = { ...(state.pastNames || {}) };
    (data.rm || []).forEach(([id, ts, name]) => {
      state.removedPeople[id] = { on: true, ts };
      if (name) state.pastNames[id] = name;
    });
    state.ballot = ballotFromPayload(data.b);
    state.prepDone = normalizeFlags(data.pd);
    state.booked = normalizeFlags(data.bk);
    // A first-time joiner previously arrived with an EMPTY ledger while the
    // UI called settle-up the group's shared record.
    state.expenses = Array.isArray(data.x)
      ? data.x.map((e) => ({
          id: e.id, payerId: e.by, desc: e.d, amount: e.a,
          sharedWith: e.w, settlement: e.s, ts: e.ts,
        }))
      : [];
    state.deletedExpenses = Array.isArray(data.xd) ? data.xd.slice() : [];
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
    // The identity rules live in the engine so they can be tested directly —
    // this merge is the other place in the app that has silently lost data.
    const { added, updated } = E.mergeParticipants(
      state.participants,
      data.p,
      participantFromPayload,
      // A removal only wins over an incoming row if it happened AFTER that
      // row's own last edit — someone re-adding themselves should stick.
      state.removedPeople
    );
    // Drop anyone this device has since removed, in case they arrived on a link
    // that predates the removal.
    state.participants = state.participants.filter((p) => {
      const rm = (state.removedPeople || {})[p.id];
      return !(rm && rm.on && (rm.ts || 0) > (p.updatedAt || 0));
    });
    // The plan itself was merged only when this device had no lock at all, so
    // a organiser who moved the dates could never tell anyone: every guest who
    // had already opened the first link stayed pinned to the dead plan, with
    // their countdown, .ics and Trip Pack all quoting it. Newest write wins,
    // exactly as participant answers already do.
    // Take on their removals before merging people, so a row this link is
    // carrying can be dropped rather than re-added.
    state.removedPeople = { ...(state.removedPeople || {}) };
    state.pastNames = { ...(state.pastNames || {}) };
    (data.rm || []).forEach(([id, ts, name]) => {
      const mine = state.removedPeople[id];
      if (!mine || ts > (mine.ts || 0)) state.removedPeople[id] = { on: true, ts };
      if (name && !state.pastNames[id]) state.pastNames[id] = name;
    });
    state.ballot = mergeBallot(state.ballot, ballotFromPayload(data.b));
    // Newest write per key wins, so an untick propagates like a tick does.
    state.prepDone = mergeFlags(state.prepDone, normalizeFlags(data.pd));
    state.booked = mergeFlags(state.booked, normalizeFlags(data.bk));
    let lockChanged = null;
    const incomingLockTs = data.lts || 0;
    if (incomingLockTs > (state.lockTs || 0)) {
      const before = state.lockedPlan;
      state.lockedPlan = data.locked || null;
      state.lockTs = incomingLockTs;
      // The cutoff travels with the plan it belongs to.
      if ((data.pts || 0) > (state.planTs || 0)) {
        state.planTs = data.pts || 0;
        state.planKeepIds = data.pk || [];
      }
      const same =
        before &&
        state.lockedPlan &&
        before.destination === state.lockedPlan.destination &&
        before.dateStart === state.lockedPlan.dateStart &&
        before.dateEnd === state.lockedPlan.dateEnd;
      if (!same) lockChanged = state.lockedPlan;
    } else if (!state.lockedPlan && data.locked && !incomingLockTs) {
      // A link made before locks were stamped. Better than dropping the plan.
      state.lockedPlan = data.locked;
    }
    // Union the ledgers by id. Expenses are append-only, so anything we
    // haven't seen is simply new — no conflict resolution needed.
    let expensesAdded = 0;
    // Deletions from either side win over the union, so removing an expense
    // sticks instead of reappearing from whichever link is opened next.
    if (Array.isArray(data.xd) && data.xd.length) {
      state.deletedExpenses = Array.from(
        new Set([...(state.deletedExpenses || []), ...data.xd])
      );
    }
    const tombstoned = new Set(state.deletedExpenses || []);
    if (tombstoned.size) {
      state.expenses = state.expenses.filter((e) => !tombstoned.has(e.id));
    }
    if (Array.isArray(data.x) && data.x.length) {
      const haveExpense = new Set(state.expenses.map((e) => e.id));
      data.x.forEach((e) => {
        if (haveExpense.has(e.id) || tombstoned.has(e.id)) return;
        state.expenses.push({
          id: e.id, payerId: e.by, desc: e.d, amount: e.a,
          sharedWith: e.w, settlement: e.s, ts: e.ts,
        });
        haveExpense.add(e.id);
        expensesAdded += 1;
      });
      // Keep the list newest-first, matching how it's added locally.
      state.expenses.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    return { added, updated, expensesAdded, lockChanged };
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
    // A participant sending their answers back is not inviting anyone. The
    // modal was written entirely from the organiser's side, which is part of
    // why nothing ever prompted the return trip.
    if (state.role !== "organizer") {
      return `Here are my dates & preferences for ${name}: ${buildShareUrl()}`;
    }
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
  // The single answer to "which currency is this reader seeing?". The USD
  // toggle wins; otherwise everything follows their home currency. Every
  // estimate on screen goes through est()/estRange(), so the winner card, the
  // ballot and the printable pack can no longer quote the same trip in three
  // different currencies — or, worse, put a "$" in front of a rupee figure.
  function displayCode() {
    return state.currencyMode === "usd" ? "USD" : myCurrency();
  }
  /** Format a USD estimate in the reader's display currency. */
  function est(usd) {
    return E.formatMoney(usd || 0, displayCode());
  }
  /** Format a USD min-max estimate in the reader's display currency. */
  function estRange(lo, hi) {
    return E.formatRange(lo || 0, hi || 0, displayCode());
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
    // Only track position while the menu is actually open, and always detach.
    // Attaching on every render leaked a listener per input, each holding a
    // detached node and firing on every scroll frame.
    const track = () => place();
    const startTracking = () => {
      window.addEventListener("scroll", track, true);
      window.addEventListener("resize", track);
    };
    const stopTracking = () => {
      window.removeEventListener("scroll", track, true);
      window.removeEventListener("resize", track);
    };
    input.addEventListener("focus", startTracking);
    input.addEventListener("blur", () => setTimeout(stopTracking, 200));
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

  /**
   * A short invite code is ~9,000 guesses across a handful of prefixes, which
   * is fine for "type this to join" but hopeless as an access control: it also
   * keyed the notification feed, so anyone could enumerate codes and read a
   * group's names, destinations and dates — or inject fake "plan locked"
   * alerts. Notifications now use a separate high-entropy token that only ever
   * travels inside the invite link.
   */
  function generateNotifyToken() {
    const bytes = new Uint8Array(16); // 128 bits
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function notifyToken() {
    if (!state.reunion.notifyToken) state.reunion.notifyToken = generateNotifyToken();
    return state.reunion.notifyToken;
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
    const myEmail = (state.user.email || "").trim().toLowerCase();
    let mine = myEmail
      ? state.participants.find((p) => (p.email || "").toLowerCase() === myEmail)
      : null;
    // Invite links deliberately carry no email, so every row that arrives from
    // one has email "" and can never match. A guest the organiser pre-added by
    // name therefore got a SECOND row on their own device — and stayed
    // duplicated there, double-counting in the destination vote, in the average
    // cost, and in every expense split they were part of. The engine already
    // has the rule for this (name matches an unclaimed placeholder); the app
    // simply never applied it on the joiner's side.
    if (!mine) {
      const myName = (state.user.name || "").trim().toLowerCase();
      const placeholder = myName
        ? state.participants.find(
            (p) =>
              !(p.email || "").trim() &&
              (p.name || "").trim().toLowerCase() === myName &&
              E.isUnclaimedParticipant(p)
          )
        : null;
      if (placeholder) {
        // Claim it in place: expenses, RSVPs and booking chips already point
        // at this id on other devices.
        placeholder.email = state.user.email;
        if (!placeholder.city) placeholder.city = state.user.city;
        touchParticipant(placeholder);
        mine = placeholder;
      }
    }
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
      // Currency is no longer a Costs-tab concern: the winner card, the ballot,
      // the people summary and the expense ledger all read displayCode() now,
      // so re-rendering only the fares left the rest of the app quoting the
      // currency the reader had just switched away from.
      renderAll();
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
            // Stamped so it can propagate. Expenses got tombstones for exactly
            // this reason ("so removing an expense sticks instead of
            // reappearing from whichever link is opened next"); people didn't,
            // so any other member's link put them straight back — with their
            // old RSVP, which quietly re-entered them into splitBaseFor as a
            // default sharer on every expense logged afterwards.
            setFlag("removedPeople", p.id, true);
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
              touchParticipant(p);
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
              touchParticipant(p);
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
    // Budgets are STORED in USD (everything compares in one currency) but are
    // entered in the person's own. Asking an Indian traveller for USD while
    // every other figure showed rupees invited "50000" meaning rupees, which
    // became a $50,000 ceiling — and that failure is silent, because an
    // impossibly high budget simply never triggers the over-budget warning.
    const bWrap = el("div");
    const budgetCode = D.currencyForCity(p.city);
    const toLocal = (usd) => {
      const n = parseFloat(usd);
      if (Number.isNaN(n) || n <= 0) return "";
      return String(Math.round(E.convertFromUSD(n, budgetCode)));
    };
    bWrap.appendChild(
      el("label", { text: `Max budget / person (${budgetCode})` })
    );
    bWrap.appendChild(
      el("input", {
        type: "number", min: "0", inputmode: "numeric",
        value: toLocal(pr.budget),
        placeholder: budgetCode === "USD" ? "e.g. 800" : "in " + budgetCode,
        onInput: (e) => {
          const local = parseFloat(e.target.value);
          // Store back in USD so scoring never has to guess a currency.
          pr.budget =
            Number.isNaN(local) || local <= 0
              ? ""
              : String(Math.round(local / (D.CURRENCIES[budgetCode] || D.CURRENCIES.USD).rate));
          scheduleRecompute(p);
        },
      })
    );
    if (budgetCode !== "USD") {
      const usd = parseFloat(pr.budget);
      bWrap.appendChild(
        el("div", {
          class: "field-note",
          text: Number.isNaN(usd) || usd <= 0 ? "Compared in USD behind the scenes." : `≈ $${Math.round(usd)} USD`,
        })
      );
    }
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
      // A trip can't be planned into the past. Without this the picker happily
      // accepted a window that has already gone, which could then be locked —
      // and the countdown just read "Past".
      min: new Date().toISOString().slice(0, 10),
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
  function addRecPhoto(card, dest, pinText) {
    const cached = window.ReunlyFares.getCachedPhoto(dest);
    const banner = el("div", { class: "rec-photo" });
    // This is the only spot that builds CSS from a fetched string. A value
    // containing a quote or paren would break out of url() and inject
    // declarations, so accept plain https URLs only.
    const safePhoto =
      typeof cached === "string" && /^https:\/\/[^"')\s]+$/.test(cached) ? cached : null;
    if (safePhoto) {
      banner.style.backgroundImage =
        `linear-gradient(180deg, rgba(8,11,22,0.15), rgba(8,11,22,0.85)), url("${safePhoto}")`;
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
    // Once a plan is locked the hero shows the AGREED option, which may not be
    // the top-ranked one any more — calling it the top pick would contradict
    // the note directly below saying something else now scores higher.
    banner.appendChild(el("span", { class: "rec-photo-pin", text: pinText || "Top pick" }));
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
    // Compare real dates, not the display label: rangeLabel drops the year, so
    // matching on it made Dec 19-26 2026 and 2027 the same plan.
    return Boolean(
      state.lockedPlan &&
        state.lockedPlan.destination === c.destination &&
        state.lockedPlan.dateStart === c.dateRange.start &&
        state.lockedPlan.dateEnd === c.dateRange.end
    );
  }
  /**
   * The single place the agreed plan changes. Both the winner card and the
   * ballot lock through here.
   *
   * Two things have to happen together and neither is optional. The stamp:
   * lockBallotOption used to set lockedPlan without touching lockTs, and since
   * the merge is strictly newest-wins, a plan locked from a vote could never
   * reach anyone — every guest already held a stamp >= the stale one, so they
   * stayed pinned to the previous destination while the push notification told
   * them it had changed. And the reset: nothing cleared the prep checklist when
   * the plan moved, so a trip rescheduled from Rome in December to Lisbon in
   * February still showed "Book flights ✓" and "Everyone's booked."
   */
  function applyLock(plan) {
    const before = state.lockedPlan;
    const movedTo =
      !plan ||
      !before ||
      before.destination !== plan.destination ||
      before.dateStart !== plan.dateStart ||
      before.dateEnd !== plan.dateEnd;
    state.lockedPlan = plan;
    state.lockTs = Date.now();
    if (!movedTo) return;
    // When the plan moved. Anything ticked BEFORE this is about a trip that no
    // longer exists, so it stops counting — a read-time rule rather than a
    // stamping pass.
    //
    // Stamping a clear per key looked equivalent and wasn't, in two ways. It
    // ran only here, and a guest learns the plan moved through the invite
    // merge, which never calls applyLock — so their side reset nothing. And it
    // could only clear keys this device could already see, so a tick that
    // existed solely on someone else's phone produced no stamp for mergeFlags
    // to beat, and came back on their next link. Comparing against planTs
    // needs neither the device nor the key to be present.
    state.planTs = state.lockTs;
    // Passport and visa depend on the destination country rather than the
    // dates, so a reschedule within the same country doesn't void them.
    const sameCountry =
      before && plan && E.countryOf(before.destination) === E.countryOf(plan.destination);
    state.planKeepIds = sameCountry ? ["passport", "visa"] : [];
  }

  function toggleLock(c) {
    const locked = lockState(c);
    // The role check only guarded LOCKING, and the button renders for everyone
    // as "✓ Locked — tap to unlock" (plus a second trigger on every runner-up
    // row). So any guest could cancel the group's agreed plan — and because the
    // unlock stamps lockTs and the merge takes the newest write, their next
    // shared link wiped the lock from the organiser's device too, announced as
    // though the organiser had done it.
    if (state.role !== "organizer") {
      toast(locked ? "Only the organiser can unlock the plan" : "Only the organiser can lock the plan");
      return;
    }
    if (locked) {
      if (!window.confirm(
        `Unlock ${c.destination} on ${c.dateLabel}?

` +
          "Everyone who opens the link after this will be told the plan is off."
      )) return;
    } else if (state.lockedPlan) {
      if (!window.confirm(`Lock ${c.destination} on ${c.dateLabel} for everyone?`)) return;
    }
    applyLock(
      locked
        ? null
        : {
            destination: c.destination,
            dateStart: c.dateRange.start,
            dateEnd: c.dateRange.end,
            dateLabel: c.dateLabel,
          }
    );
    state.phase = "decide";
    renderAll();
    if (!locked) {
      confetti();
      // The decision people were waiting on shouldn't depend on the organiser
      // remembering to re-send the link.
      notifyPlanLocked(state.lockedPlan);
    }
  }

  function notifyPlanLocked(plan) {
    if (!plan) return;
    try {
      fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: notifyToken(),
          name: meName(),
          destination: plan.destination,
          dateLabel: plan.dateLabel,
          kind: "locked",
        }),
      }).catch(() => {});
    } catch (e) {
      /* best-effort — locking must work with or without the server */
    }
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
  // Ranking is the most expensive thing the app does, and a single render
  // asks for it from the winner card, the runners-up, the ballot, the costs
  // tab and the trip plan. Memoise per render pass; invalidateCombos() is
  // called whenever state changes so this can never serve a stale answer.
  let combosCache = null;
  function invalidateCombos() {
    combosCache = null;
    pricingWindowCache = null;
  }
  function rankedCombos() {
    if (combosCache) return combosCache;
    // Someone who has said they can't make it shouldn't still be steering the
    // group's date, destination or budget warnings. Keep everyone else,
    // including people who haven't replied yet.
    const relevant = state.participants.filter((p) => p.rsvp !== "out");
    // Pin the agreed plan so it can never fall out of the ranking. Candidate
    // windows are derived from overlapping availability, so a locked window
    // stops being generated as soon as anyone widens their dates — and the
    // hero would then quietly show a different trip as the "Top pick".
    combosCache = E.rankCombinations(
      relevant.length ? relevant : state.participants,
      undefined,
      fareProvider,
      state.lockedPlan
        ? {
            pinned: {
              destination: state.lockedPlan.destination,
              dateRange: {
                start: state.lockedPlan.dateStart,
                end: state.lockedPlan.dateEnd,
              },
            },
          }
        : null
    );
    return combosCache;
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
          code: notifyToken(),
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

  function confirmSubmit(p, top, draft, isAgreed) {
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
    // Only a yes to BOTH questions is an RSVP. Round 8 set "in" unconditionally
    // to fix a roster that always read "0 in", and overshot: saying the agreed
    // dates don't work recorded the person as confirmed going. They were then
    // counted in the head count, printed in the Trip Pack with no "not yet
    // confirmed" mark, and — because splitBaseFor takes rsvp === "in" — pinned
    // as a default sharer on every expense logged afterwards, so they were
    // billed for a villa on a week they had just said they couldn't make.
    if (p.rsvp !== "out") {
      if (draft.dateOk && draft.destOk) {
        p.rsvp = "in";
      } else if (isAgreed) {
        // The plan is settled and they can't make it. Proposing an alternative
        // to a locked trip isn't an option, so this is a decline.
        p.rsvp = "out";
      } else {
        // Still deciding: they've proposed something else, which is an answer
        // but not an acceptance. Leave them undecided rather than guessing.
        p.rsvp = "no_response";
      }
    }
    // These answers ARE this person's response — losing the stamp meant the
    // organiser's copy silently ignored the whole confirm step on merge.
    touchParticipant(p);
    saveState();
    notifyOrganiser(p, top, draft);
    toast(
      p.rsvp === "out"
        ? "Thanks — the organiser will see you can't make these dates"
        : "Thanks! Just a few more details…"
    );
    goEditMine();
  }

  // The Yes/No confirm card itself: reuses the photo banner + the existing
  // flexible date/destination editors for the "No, here's my alternative" path.
  function renderConfirmStep(hero, p, top, isAgreed) {
    const draft = getConfirmDraft(p.id);
    const card = el("div", { class: "card confirm-card stagger" });
    addRecPhoto(card, top.destination);

    const body = el("div", { class: "confirm-body" });
    body.appendChild(el("div", { class: "confirm-title", text: "Does this work for you?" }));
    body.appendChild(
      el("div", {
        class: "confirm-sub",
        // "Leaning towards" understates a decision that has been made, and
        // invites an alternative nobody is going to act on.
        text: isAgreed
          ? `The group has agreed on ${top.destination}, ${top.dateLabel}.`
          : `The group's leaning towards ${top.destination}, ${top.dateLabel}.`,
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
      onClick: () => confirmSubmit(p, top, draft, isAgreed),
    });
    const hint = el("div", { class: "confirm-sub" });
    body.appendChild(continueBtn);
    // Yes-or-propose-something-else was the only way through. Someone who
    // simply can't come was forced to invent alternative dates for a trip that
    // was already settled — and until they did, they counted as undecided.
    body.appendChild(
      el("button", {
        class: "btn ghost",
        style: "width:100%;margin-top:8px",
        text: "I can't make it",
        onClick: () => {
          p.rsvp = "out";
          p.dateConfirmed = false;
          p.destConfirmed = false;
          touchParticipant(p);
          saveState();
          invalidateCombos();
          toast("Thanks for letting the group know");
          renderAll();
        },
      })
    );
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

  // A combo-shaped object for a locked plan that no longer appears in the
  // ranking (its destination dropped out of the tally, say). Enough for the
  // confirm card to ask about the right trip.
  function syntheticCombo(plan) {
    return {
      destination: plan.destination,
      dateLabel: plan.dateLabel || `${plan.dateStart} – ${plan.dateEnd}`,
      dateRange: { start: plan.dateStart, end: plan.dateEnd },
    };
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
      // The same drift the hero was fixed for, on the ONE card a fresh invitee
      // actually sees. Showing combos[0] meant a guest opening the link could
      // be asked to confirm a different city and week from the one the group
      // had locked — and answering "Yes" overwrote their answers with it, so
      // someone who agreed to the trip was recorded as preferring somewhere
      // else. Their own arrival can reorder the ranking before they have said
      // a word, so this is not a rare case.
      const agreed = state.lockedPlan
        ? combos.find(lockState) || syntheticCombo(state.lockedPlan)
        : combos[0];
      renderConfirmStep(hero, me, agreed, !!state.lockedPlan);
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
    // Once a plan is locked, the hero IS the locked plan. Rendering combos[0]
    // regardless meant a late invitee's preferences could push another option
    // to the top, and the Decide tab — the headline screen — would then show a
    // different destination, its photo and its costs, complete with a "Lock
    // this plan" button, while the banner above it counted down to the plan
    // that was actually agreed and the Costs tab priced that one. In a group
    // where people book their own flights, that is money spent on the wrong
    // city. A ranking that has moved is worth saying, but it is a prompt, not
    // a replacement.
    const lockedCombo = state.lockedPlan
      ? combos.find((x) => lockState(x)) || null
      : null;
    const c = lockedCombo || combos[0];
    const locked = lockState(c);
    // The top-ranked option is no longer what the group agreed to.
    const driftedTo =
      state.lockedPlan && lockedCombo && combos[0] !== lockedCombo ? combos[0] : null;
    const card = el("div", { class: "card winner-card stagger" });

    addRecPhoto(card, c.destination, locked ? "Agreed" : "Top pick");

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
    // Show what the VIEWER actually faces, not a group average nobody pays —
    // the spread between the nearest and furthest traveller is often 2-5x.
    const myTrip = (() => {
      const me = state.participants.find(isMe);
      if (!me || !me.city) return null;
      return E.tripCostFor(me.city, c.destination, c.dateRange, fareProvider, me.prefs, tripOpts(c.destination));
    })();
    // Headline and breakdown come from ONE rounding pass, so the digits on
    // screen add up. Rounding the total separately from its parts printed
    // "$533 travel + $980 stay" under a $1,510 headline.
    const brTravelUsd = myTrip ? myTrip.travel : c.travelApplied;
    const brStayUsd = myTrip ? myTrip.lodging : c.lodgingApplied;
    const money3 =
      brTravelUsd != null && brStayUsd != null
        ? E.formatParts([brTravelUsd, brStayUsd], displayCode())
        : null;
    grid.appendChild(
      scoreCell(
        // For a family, "your cost" is the whole booking — that's the number
        // they have to find, so show it and say who it covers.
        myTrip ? (myTrip.party > 1 ? `Your ${myTrip.party}` : "Your cost")
          : c.nights > 0 ? "Avg per person" : "Avg fare",
        money3
          ? money3.total
          : myTrip
          ? est(myTrip.total)
          : c.avgTripCost != null
          ? est(c.avgTripCost)
          : "—",
        null
      )
    );
    body.appendChild(grid);

    // Break down the SAME number the headline shows. The headline switches to
    // the reader's own booking when we know their city, so a breakdown of the
    // group average sat directly under a personal total and read as an
    // explanation of it. (It also used to print the raw fare and raw nightly
    // band — before party size, room factor and festive uplift — so it could
    // total less than half the figure above it.)
    if (c.nights > 0 && money3) {
      body.appendChild(
        el("div", {
          class: "cost-breakdown",
          text:
            `≈ ${money3.parts[0]} travel + ${money3.parts[1]} stay ` +
            `(${c.nights} night${c.nights === 1 ? "" : "s"}` +
            // Say what the stay assumed about occupancy. It's the single
            // biggest lever on the figure and people can't sanity-check it
            // without knowing which way it went.
            (myTrip && myTrip.sharing === "twin" ? ", sharing a twin" : "") +
            (myTrip && myTrip.sharing === "single" ? ", own room" : "") +
            `) · estimates, excludes ${COST_EXCLUSIONS}` +
            // Don't present a generic fallback rate with the same confidence
            // as one we actually hold for that city.
            (c.season ? ` · ${c.season} — prices run higher` : "") +
            (c.lodgingApproximate ? " · no local rate for this city, using a rough average" : ""),
        })
      );
    }
    if (driftedTo) {
      const note = el("div", { class: "alert-inline" });
      note.appendChild(
        el("span", {
          text:
            `Since you locked this, ${driftedTo.destination} (${driftedTo.dateLabel}) ` +
            "now scores higher — answers have changed.",
        })
      );
      if (state.role === "organizer") {
        note.appendChild(
          el("button", {
            class: "btn ghost sm",
            style: "width:auto",
            text: "Review",
            onClick: () => {
              const alts = document.getElementById("recList");
              if (alts) alts.scrollIntoView({ behavior: "smooth", block: "center" });
            },
          })
        );
      }
      body.appendChild(note);
    }
    // The range matters more than the mean: it's the furthest traveller who
    // decides whether the trip actually happens.
    if (c.minTripCost != null && c.maxTripCost != null && Math.round(c.maxTripCost) > Math.round(c.minTripCost)) {
      body.appendChild(
        el("div", {
          class: "cost-breakdown",
          text:
            `Across the group: ${estRange(c.minTripCost, c.maxTripCost)} per person, ` +
            "depending on where they're travelling from" +
            (c.maxBookingCost != null && Math.round(c.maxBookingCost) > Math.round(c.maxTripCost)
              ? ` · largest single booking ${est(c.maxBookingCost)}`
              : ""),
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
    // Who is coming from where, and how. Placed after the numbers rather than
    // before them: it's the human summary of everything above, and on a real
    // group it's the first thing that makes the spread of origins obvious.
    renderJourneyMap(body, { destination: c.destination });
    card.appendChild(body);
    hero.appendChild(card);
  }

  // The runners-up (combos 2 & 3): compact rows, no photo/medal noise.
  function renderRecommendations() {
    const list = $("#recList");
    list.textContent = "";
    // Exclude whatever the hero is showing. With a plan locked the hero is the
    // LOCKED option, which is not necessarily rank 1, so a plain slice(1, 3)
    // could list it a second time as its own runner-up.
    const ranked = rankedCombos();
    const heroCombo = state.lockedPlan ? ranked.find(lockState) || ranked[0] : ranked[0];
    const others = ranked.filter((c) => c !== heroCombo).slice(0, 2);
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
          text: `${c.dateLabel} · ~${est(perPerson)} pp`,
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
        s.medianBudget != null ? est(s.medianBudget) : "—",
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
      const resolved = window.ReunlyFares.isResolved(p.city, toCity, fareDate());
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
        // A captured fare doesn't stay true. It was badged green forever — the
        // same treatment a genuinely live quote gets — so a price from months
        // ago read as freshly confirmed. Past a month it says how old it is.
        (() => {
          const age = ageInDays(fare.asOf);
          const stale = age != null && age > 30;
          return el("span", {
            class: `badge ${stale ? "warn" : "good"}`,
            text: stale ? `searched · ${age} days old` : `searched · ${fare.asOf}`,
          });
        })()
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
    // Their own all-in figure. The winner card headlines travel + stay, so a
    // Costs tab showing airfare alone contradicted it for the same trip.
    const plan = opts.plan || state.lockedPlan || (rankedCombos()[0] || null);
    const window_ = plan
      ? { start: plan.dateStart || (plan.dateRange && plan.dateRange.start),
          end: plan.dateEnd || (plan.dateRange && plan.dateRange.end) }
      : null;
    if (window_ && window_.start && window_.end && fare.min !== 0) {
      const trip = E.tripCostFor(p.city, toCity, window_, fareProvider, p.prefs, tripOpts(toCity));
      if (trip && trip.nights > 0) {
        const partyNote = trip.party > 1 ? ` · ${trip.party} travelling` : "";
        const stayNote =
          trip.lodging > 0
            ? `incl. ${trip.nights} night${trip.nights === 1 ? "" : "s"}`
            : "no stay needed";
        side.appendChild(
          el("div", {
            class: "cost-allin",
            text: `${E.formatMoney(trip.total, code)} all-in — ${stayNote}${partyNote}`,
          })
        );
      }
    }
    // Distance + time. Drive time only shown when plausibly drivable (<= 800 mi),
    // so overseas routes don't display a nonsensical multi-day "drive".
    if (info.miles != null) {
      const metaParts = [`${Math.round(info.miles)} mi`];
      // Ask the cost model how this person is getting there — a third copy of
      // the drive/fly threshold lived here and had drifted. chooseTravel decides
      // from distance AND party size, so this line printed a door-to-door
      // FLIGHT narrative over Bangalore-to-Goa (306mi) while the fare beside it
      // was one tank of fuel, and drew a plane over a $73 London-Paris drive.
      // Great-circle air time also isn't the journey, so say which is which.
      if (info.miles > 0) {
        const fare = fareProvider(p.city, toCity);
        const party = 1 + Math.max(0, parseInt((p.prefs && p.prefs.kids) || 0, 10) || 0);
        const mode = fare && fare.min != null
          ? E.chooseTravel(info.miles, (fare.min + fare.max) / 2, party).mode
          : "flight";
        const door = E.journeyHours(info.miles);
        if (mode === "drive") {
          metaParts.push(`🚗 ${E.formatHours(info.drive)} each way`);
        } else if (mode === "flight") {
          metaParts.push(
            door > info.flight + 0.4
              ? `✈ ${E.formatHours(info.flight)} in the air · ~${E.formatHours(door)} door to door`
              : `✈ ${E.formatHours(info.flight)}`
          );
          // Offer the road as an alternative only where it's actually one.
          if (info.miles <= 800) metaParts.push(`or 🚗 ${E.formatHours(info.drive)}`);
        }
      }
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
    // Destination and dates must come from the SAME plan. Taking the place
    // from the top ranking while the window came from a locked plan priced
    // flights to one city using another city's dates, under a heading naming
    // the first.
    const agreed = state.lockedPlan || (combos.length ? combos[0] : null);
    const groupBest = agreed
      ? agreed.destination
      : combos.length
      ? combos[0].destination
      : null;
    // Name the destination ONCE in the heading instead of on every card.
    $("#costsHeading").textContent = groupBest
      ? `Getting to ${D.cityEmoji(groupBest)} ${groupBest}${state.lockedPlan ? "" : " (top pick so far)"}`
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
          "Estimates only. The all-in figure covers return travel plus an " +
          `estimated stay for the chosen dates — it excludes ${COST_EXCLUSIONS}. ` +
          `Fares priced ${D.FARES_AS_OF}; non-USD amounts use approximate rates ` +
          `set ${D.RATES_AS_OF}.`,
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
      card.appendChild(costCardSide(p, groupBest, null, { showDest: false, plan: agreed }));
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
    return `🌤️ ${mode} ${w.tMin}–${w.tMax}°C${rainPhrase(w)}`;
  }

  /**
   * How the rain signal reads. The proxy returns rainPct ONLY inside the
   * 15-day forecast horizon and wetDays/totalDays only beyond it — never both.
   * The locked-plan toolkit checked rainPct alone, so for every trip planned
   * further out than a fortnight (which is essentially all of them) it printed
   * temperature and nothing else. That is the monsoon case the archive branch
   * exists to flag, lost on the one card people keep.
   */
  function rainPhrase(w) {
    if (!w || w === "pending") return "";
    if (w.rainPct != null) return ` · ${w.rainPct}% rain risk`;
    if (w.wetDays != null && w.totalDays) {
      return ` · rain on ${w.wetDays} of ${w.totalDays} days last year`;
    }
    return "";
  }

  // Download an .ics calendar file for the locked plan (all-day, end-exclusive).
  function downloadIcs() {
    const plan = state.lockedPlan;
    if (!plan) return;
    const clean = (iso) => (iso || "").replace(/-/g, "");
    // Parse as UTC. "2026-12-26T00:00:00" with no suffix is LOCAL midnight,
    // and toISOString() then converts back to UTC — so at any positive offset
    // (all of Europe, India, Asia, Australia) the incremented day landed back
    // on the 26th, and because DTEND is exclusive the trip ended on the 25th.
    const endStr = new Date(Date.parse(plan.dateEnd + "T00:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    // The event name and destination both come from the invite hash. Stripping
    // "," and ";" left newlines intact, so a crafted link could close VEVENT
    // and append its own event — into a file the victim imports into their real
    // calendar. Escape per RFC 5545 instead of filtering two characters.
    const ical = (v) =>
      String(v == null ? "" : v)
        .replace(/\\/g, "\\\\")
        .replace(/[;,]/g, "\\$&")
        .replace(/\r?\n/g, "\\n");
    // A malformed date reaches here only if it slipped past isoOrEmpty, but
    // this is a download the user triggered — fail quietly, don't throw.
    if (!Number.isFinite(Date.parse(plan.dateStart + "T00:00:00Z"))) {
      toast("That plan's dates look wrong — re-lock it before exporting");
      return;
    }
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
      `SUMMARY:${ical(title)}`,
      `LOCATION:${ical(plan.destination)}`,
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
  // never lands in the morning, plus tags the generator filters on:
  //   adult    — not something to put in front of a group travelling with kids
  //   active   — needs real mobility, so it's dropped when someone has told us
  //              they can't manage that
  //   outdoor  — the first thing to swap out when the forecast is bad
  //   food     — gets the group's dietary note attached
  const IDEA_BANK = {
    "Beach": [
      ["🏖️", "Beach time at a top-rated spot", "best beaches near", [0, 1], ["outdoor"]],
      ["🌅", "Sunset walk on the shore", "beaches near", [2], ["outdoor"]],
      ["🏐", "Beach games and a picnic", "beaches near", [1], ["outdoor"]],
    ],
    "Nightlife": [
      ["🍸", "Drinks & live music", "best bars near", [2], ["adult"]],
      ["🪩", "Night out at a popular club", "nightclubs near", [2], ["adult", "active"]],
      ["🎤", "Karaoke or a games bar", "karaoke bars in", [2], ["adult"]],
    ],
    "Sightseeing": [
      ["📸", "See the must-visit landmarks", "top attractions in", [0, 1], ["outdoor"]],
      ["🚶", "Guided walking tour", "walking tours in", [0, 1], ["outdoor", "active"]],
      ["🚌", "Hop-on bus or boat tour", "sightseeing tours in", [0, 1], []],
      ["🌇", "Viewpoint at golden hour", "best viewpoints in", [2], ["outdoor"]],
    ],
    "Food & dining": [
      ["🍽️", "Group dinner at a local favourite", "best restaurants in", [2], ["food"]],
      ["🥘", "Street-food tasting", "street food in", [1, 2], ["food", "outdoor"]],
      ["🥐", "Long breakfast somewhere good", "best breakfast in", [0], ["food"]],
      ["👨‍🍳", "Cooking class together", "cooking classes in", [1], ["food"]],
    ],
    "Nature / hiking": [
      ["🥾", "Hike with a view", "hiking trails near", [0], ["outdoor", "active"]],
      ["🌿", "Explore a nature spot", "nature parks near", [0, 1], ["outdoor"]],
      ["🦜", "Wildlife or botanical garden", "botanical gardens near", [0, 1], ["outdoor"]],
    ],
    "Relaxation": [
      ["💆", "Spa or wellness session", "spas in", [1], []],
      ["☕", "Slow start at a great café", "best cafes in", [0], ["food"]],
      ["📖", "Unstructured afternoon — no plans", null, [1], []],
    ],
    "Adventure": [
      ["🚤", "Watersports or adventure activity", "adventure activities in", [0, 1], ["outdoor", "active"]],
      ["🛶", "Try something adrenaline-fuelled", "things to do in", [1], ["outdoor", "active"]],
      ["🚴", "Cycle or scooter tour", "bike tours in", [0, 1], ["outdoor", "active"]],
    ],
    "Culture": [
      ["🏛️", "Museum or heritage visit", "museums in", [0, 1], []],
      ["🎭", "Local culture & markets", "cultural attractions in", [1], []],
      ["🎟️", "Show, gig or local performance", "live music venues in", [2], []],
    ],
    "Shopping": [
      ["🛍️", "Markets & shopping streets", "shopping in", [1], ["outdoor"]],
      ["🎁", "Pick up gifts to take home", "souvenir shops in", [1], []],
    ],
  };
  const SLOTS = ["Morning", "Afternoon", "Evening"];
  const FALLBACK_IDEAS = [
    ["📸", "See the must-visit landmarks", "top attractions in", [0, 1], ["outdoor"]],
    ["🏛️", "Museum or heritage visit", "museums in", [0, 1], []],
    ["🍽️", "Group dinner at a local favourite", "best restaurants in", [2], ["food"]],
  ];

  /**
   * Longest one-way journey anyone in the group faces to reach the destination.
   * Day one of a trip is not a blank slate: if half the group lands at 3pm
   * after eleven hours in the air, an itinerary that opens with a sunrise hike
   * is worse than no itinerary at all.
   */
  function longestJourneyHours(destination) {
    let worst = 0;
    for (const p of state.participants) {
      if (p.rsvp === "out" || !p.city) continue;
      const miles = E.distanceMiles(p.city, destination);
      if (miles == null) continue;
      const hours = E.journeyHours(miles);
      if (hours > worst) worst = hours;
    }
    return worst;
  }

  function buildItinerary(plan) {
    const s = E.summarizePrefs(state.participants);
    const notes = [];
    let interests = s.activitiesRanked.map(([label]) => label);
    if (!interests.length) interests = ["Sightseeing", "Food & dining", "Relaxation"];
    const rand = mulberry32(state.itinerarySeed * 7919 + interests.length);
    const start = new Date(plan.dateStart + "T00:00:00");
    const end = new Date(plan.dateEnd + "T00:00:00");
    const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
    // On a long trip we don't list every day, but the day people travel home
    // is not an optional detail — show the opening run AND the real last day,
    // with the gap called out between them.
    const CAP = 7;
    const dayIndices =
      totalDays <= CAP
        ? Array.from({ length: totalDays }, (_, i) => i)
        : Array.from({ length: CAP - 1 }, (_, i) => i).concat(totalDays - 1);

    // --- What the group has actually told us, applied as filters. -----------
    const withKids = s.withKids > 0;
    const accessNeeds = s.accessibility.length > 0;
    // Trip-level weather, if the proxy has answered. It is an average over the
    // window rather than per-day, so it can only justify a lean towards indoor
    // plans, not a claim about any particular afternoon.
    const w = weatherCache.get(`${plan.destination}|${plan.dateStart}`);
    const weather = w && w !== "pending" ? w : null;
    const wetPct = weather
      ? weather.rainPct != null
        ? weather.rainPct
        : weather.wetDays != null && weather.totalDays
        ? Math.round((weather.wetDays / weather.totalDays) * 100)
        : null
      : null;
    const washout = wetPct != null && wetPct >= 50;
    const freezing = !!weather && weather.tMax != null && weather.tMax < 8;
    const scorching = !!weather && weather.tMax != null && weather.tMax > 34;
    const preferIndoor = washout || freezing || scorching;

    const pool = [];
    interests.forEach((label) => (IDEA_BANK[label] || []).forEach((idea) => pool.push(idea)));
    const tagsOf = (idea) => idea[4] || [];
    const allowed = pool.filter((idea) => {
      const tags = tagsOf(idea);
      if (withKids && tags.includes("adult")) return false;
      if (accessNeeds && tags.includes("active")) return false;
      return true;
    });
    // Never filter the pool down to nothing: a group of club-goers with a
    // toddler should still get an itinerary, just not that one.
    const usable = allowed.length ? allowed : FALLBACK_IDEAS;

    if (withKids) {
      notes.push(
        `Nothing adults-only, since ${s.kids} ${s.kids === 1 ? "child is" : "children are"} coming.`
      );
    }
    if (accessNeeds) {
      const who = s.accessibility.map((a) => a.name).join(", ");
      notes.push(`Strenuous activities left out — check the plan works for ${who}.`);
    }
    if (s.foodRanked.length) {
      notes.push(
        `Book somewhere that handles ${s.foodRanked.map(([f, n]) => `${f} (${n})`).join(", ")}.`
      );
    }
    if (preferIndoor) {
      notes.push(
        washout
          ? `Leaning indoors — roughly ${wetPct}% chance of rain across these dates.`
          : freezing
          ? "Leaning indoors — it is cold enough that outdoor plans need a backup."
          : "Leaning indoors — midday heat makes outdoor plans hard work."
      );
    }

    // --- Fixed bookends. ----------------------------------------------------
    const journey = longestJourneyHours(plan.destination);
    // A short hop leaves the day usable; a long-haul flight eats it.
    const bookendSlots = totalDays === 1 ? 0 : journey >= 6 ? 2 : journey >= 2 ? 1 : 0;
    const arriveIdea = ["🛬", "Arrive, check in and settle", null, [], []];
    const settleIdea = ["🧭", "Easy first look around the neighbourhood", "things to do in", [], []];
    const packIdea = ["🧳", "Pack up and check out", null, [], []];
    const departIdea = ["🛫", "Head home — leave buffer for traffic", null, [], []];

    // Prefer ideas nobody has seen yet. The old version only avoided repeats
    // WITHIN a day, so on a week-long trip Wednesday was often a copy of
    // Monday: the most obvious tell that nothing had really been planned.
    const usedEver = new Set();
    function pick(slotIdx, usedToday) {
      const fits = (list) => list.filter((i) => (i[3] || []).includes(slotIdx));
      let candidates = fits(usable).filter((i) => !usedToday.has(i[1]) && !usedEver.has(i[1]));
      if (preferIndoor) {
        const indoor = candidates.filter((i) => !tagsOf(i).includes("outdoor"));
        if (indoor.length) candidates = indoor;
      }
      if (!candidates.length) {
        // Every idea that suits this slot has now been used once. Start a
        // fresh cycle rather than picking at random from the whole pool —
        // random re-picks put "botanical garden" on four mornings running.
        fits(usable).forEach((i) => usedEver.delete(i[1]));
        candidates = fits(usable).filter((i) => !usedToday.has(i[1]));
      }
      if (!candidates.length) candidates = fits(usable);
      if (!candidates.length) candidates = fits(FALLBACK_IDEAS);
      if (!candidates.length) candidates = [FALLBACK_IDEAS[0]];
      const chosen = candidates[Math.floor(rand() * candidates.length)];
      usedToday.add(chosen[1]);
      usedEver.add(chosen[1]);
      return chosen;
    }

    const out = [];
    dayIndices.forEach((d, position) => {
      const date = new Date(start);
      date.setDate(date.getDate() + d);
      const label = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const isFirst = d === 0;
      const isLast = d === totalDays - 1 && totalDays > 1;
      // True when days were skipped immediately before this one.
      const gapBefore = position > 0 && d !== dayIndices[position - 1] + 1;
      const usedToday = new Set();
      const slots = SLOTS.map((_, slotIdx) => {
        if (isFirst && slotIdx < bookendSlots) {
          return slotIdx === 0 ? arriveIdea : settleIdea;
        }
        if (isLast && slotIdx >= SLOTS.length - bookendSlots) {
          return slotIdx === SLOTS.length - 1 ? departIdea : packIdea;
        }
        return pick(slotIdx, usedToday);
      });
      out.push({ label, slots, isFirst, isLast, gapBefore });
    });
    return { days: out, extraDays: totalDays - dayIndices.length, notes };
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
    // Anyone who hasn't declined. Filtering to rsvp === "in" printed a pack
    // headed "Who's going (0)" with an empty cost table and no group total
    // whenever people hadn't used the People tab's RSVP pills — which was
    // everyone, since nothing else set them. Unconfirmed people are listed and
    // marked rather than silently dropped.
    const goers = state.participants.filter((p) => p.rsvp !== "out");
    // This is the document people actually budget from, so it must show the
    // same all-in figure as the app — printing airfare alone here contradicted
    // both the winner card and the Costs tab.
    const window_ = { start: plan.dateStart, end: plan.dateEnd };
    // Collect first, format once. Accumulating exact totals and rounding at the
    // end left the printed column summing to something other than the printed
    // group total ($6,935 of rows under a $6,930 total).
    const packRows = [];
    const rows = goers
      .filter((p) => p.city)
      .map((p) => {
        const f = fareProvider(p.city, plan.destination);
        const trip = E.tripCostFor(p.city, plan.destination, window_, fareProvider, p.prefs, tripOpts(plan.destination));
        // Show the travel figure that's actually inside the all-in total —
        // party size and seasonal uplift included. The raw fare band beside a
        // scaled total made the pack contradict itself for a family or a
        // peak-season trip, and the pack is what people budget from.
        const fare = trip ? est(trip.travel) : f && f.min != null ? estRange(f.min, f.max) : "—";
        let allIn = "—";
        if (trip) {
          packRows.push(trip.total);
          allIn = E.formatParts([trip.total], displayCode()).parts[0];
          if (trip.party > 1) allIn += ` (${trip.party} people)`;
        }
        // Say who has actually confirmed. Listing an unconfirmed guest without
        // a mark reads as a headcount the organiser can book against.
        const unconfirmed = p.rsvp !== "in" ? " <i>(not yet confirmed)</i>" : "";
        return (
          `<tr><td>${escapeHtml(p.name || "Guest")}${unconfirmed}</td><td>${escapeHtml(p.city)}</td>` +
          `<td>${fare}</td><td><b>${allIn}</b></td></tr>`
        );
      })
      .join("");
    // The group total is the sum of the ROUNDED rows, so the column adds up.
    // --- The ledger, if there is one. ---------------------------------------
    const split = computeSplit();
    let ledgerHtml = "";
    if (split.spend.length) {
      const posRows = split.positions
        .map(
          (pos) =>
            `<tr><td>${escapeHtml(pName(pos.id))}${pos.paidNothing ? " <i>(paid in nothing)</i>" : ""}` +
            `${pos.onRoster ? "" : " <i>(left)</i>"}</td>` +
            `<td>${escapeHtml(money(pos.paid))}</td><td>${escapeHtml(money(pos.share))}</td>` +
            `<td><b>${escapeHtml(
              pos.net > 0.005
                ? `owed ${money(pos.net)}`
                : pos.net < -0.005
                ? `owes ${money(-pos.net)}`
                : "square"
            )}</b></td></tr>`
        )
        .join("");
      const owingRows = split.transfers
        .map(
          (t) =>
            `<li>${escapeHtml(pName(t.from))} → ${escapeHtml(pName(t.to))}: ` +
            `<b>${escapeHtml(money(t.amount))}</b></li>`
        )
        .join("");
      ledgerHtml =
        `<h2>Money</h2><p>Shared costs total <b>${escapeHtml(money(split.total))}</b>.</p>` +
        `<table><tr><th>Name</th><th>Paid</th><th>Share</th><th>Position</th></tr>${posRows}</table>` +
        (owingRows
          ? `<h4>To settle up</h4><ul>${owingRows}</ul>`
          : `<p><b>Everyone's square.</b></p>`);
    }

    const packFooter = packRows.length
      ? `<tr><td colspan="3"><b>Group total</b></td><td><b>` +
        `${E.formatParts(packRows, displayCode()).total}</b></td></tr>`
      : "";
    const itHtml = it.days
      .map(
        (d) =>
          `<h4>${escapeHtml(d.label)}</h4><ul>` +
          d.slots.map((s, i) => `<li><b>${["Morning", "Afternoon", "Evening"][i]}:</b> ${escapeHtml(s[1])}</li>`).join("") +
          `</ul>` +
          // The pack is what people actually carry, so the reasons the plan
          // looks the way it does have to travel with it.
          (d.isFirst && it.notes.length
            ? `<p><i>${it.notes.map(escapeHtml).join(" ")}</i></p>`
            : "")
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
      `<h2>Who's going (${goers.filter((p) => p.rsvp === "in").length} confirmed of ${goers.length})</h2>` +
      `<table><tr><th>Name</th><th>From</th>` +
      `<th>Travel</th><th>Travel + stay</th></tr>${rows}${packFooter}</table>` +
      `<h2>Suggested itinerary</h2>${itHtml}` +
      // The document people reconcile from had no ledger in it at all — only
      // estimates and the itinerary. If money has changed hands, it belongs
      // here alongside them.
      ledgerHtml +
      // The pack is printed and re-read weeks later, so it has to carry enough
      // for its reader to judge the numbers: when it was made, what currency
      // they're in, and how old the fares and exchange rates behind them are.
      `<div class="foot">Generated by Reunly on ${escapeHtml(new Date().toISOString().slice(0, 10))} · ` +
      `estimates only. "Travel + stay" covers return travel plus an estimated stay for these ` +
      `dates; it excludes ${escapeHtml(COST_EXCLUSIONS)}. Amounts in ` +
      `${escapeHtml(displayCode())}, converted at rates set ${escapeHtml(D.RATES_AS_OF)}; ` +
      `fares priced ${escapeHtml(D.FARES_AS_OF)}. Confirm real prices before booking.</div>` +
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

  /**
   * What still has to happen before anyone leaves.
   *
   * The app used to stop at "we locked it", which is exactly where real trips
   * come apart: nobody tracks who has booked, a non-refundable deposit falls
   * due, and someone finds out too late that their passport is inside the
   * six-month window and they will not be boarded. Everything here is a prompt
   * with a link, never an assertion — entry rules depend on nationality and
   * change, and the app cannot know either.
   */
  function renderPrep(panel, plan) {
    const days = E.daysUntil(plan.dateStart);
    if (days == null || days < 0) return; // the trip has been and gone
    const international = E.isInternationalTrip(state.participants, plan.destination);
    const steps = E.prepStepsFor(days, international);
    const outstanding = steps.filter((st) => !flagOn(state.prepDone, st.id));

    const card = el("div", { class: "card toolkit stagger" });
    const head = el("div", { class: "itin-head" });
    head.appendChild(
      el("div", {
        class: "toolkit-title",
        text: `✅ Before you go — ${days} day${days === 1 ? "" : "s"} to go`,
      })
    );
    card.appendChild(head);
    card.appendChild(
      el("div", {
        class: "itin-sub",
        text: outstanding.length
          ? `${outstanding.length} of ${steps.length} still to do. Lead times are typical, not rules — check the ones that apply to you.`
          : "Everything on the list is ticked off.",
      })
    );

    steps.forEach((st) => {
      const isDone = flagOn(state.prepDone, st.id);
      const row = el("div", { class: `prep-row${isDone ? " done" : ""}` });
      const box = el("button", {
        type: "button",
        class: `prep-check${isDone ? " on" : ""}`,
        "aria-pressed": isDone ? "true" : "false",
        "aria-label": `${isDone ? "Undo" : "Mark done"}: ${st.title}`,
        text: isDone ? "✓" : "",
        onClick: () => {
          setFlag("prepDone", st.id, !isDone);
          saveState();
          renderPlan();
        },
      });
      row.appendChild(box);
      const body = el("div", { class: "prep-body" });
      const title = el("div", { class: "prep-title" });
      title.appendChild(el("span", { text: st.title }));
      if (!isDone && st.urgency !== "later") {
        title.appendChild(
          el("span", {
            class: `badge ${st.urgency === "overdue" ? "warn" : ""}`,
            text:
              st.urgency === "overdue"
                ? `${Math.abs(st.slack)} day${Math.abs(st.slack) === 1 ? "" : "s"} past the usual point`
                : "due about now",
          })
        );
      }
      body.appendChild(title);
      body.appendChild(el("div", { class: "prep-detail", text: st.detail }));
      row.appendChild(body);
      card.appendChild(row);
    });

    // Who has actually booked. The single question an organiser is asked most
    // and the one the app could never answer.
    const goers = state.participants.filter((p) => p.rsvp !== "out");
    if (goers.length) {
      card.appendChild(el("div", { class: "prep-sub", text: "Who's booked" }));
      const chips = el("div", { class: "chip-select" });
      goers.forEach((p) => {
        const on = flagOn(state.booked, p.id);
        chips.appendChild(
          el("button", {
            type: "button",
            class: `chip-toggle${on ? " on" : ""}`,
            "aria-pressed": on ? "true" : "false",
            text: `${on ? "✓ " : ""}${p.name || "Unnamed"}`,
            onClick: () => {
              if (state.role !== "organizer" && !isMe(p)) {
                toast("Only you or the organiser can change this");
                return;
              }
              setFlag("booked", p.id, !on);
              saveState();
              renderPlan();
            },
          })
        );
      });
      card.appendChild(chips);
      const bookedCount = goers.filter((p) => flagOn(state.booked, p.id)).length;
      card.appendChild(
        el("div", {
          class: "itin-sub",
          text:
            bookedCount === goers.length
              ? "Everyone's booked."
              : `${bookedCount} of ${goers.length} booked · share the invite link to sync this with the group.`,
        })
      );
    }
    panel.appendChild(card);
  }

  function renderPlan() {
    const panel = $("#planPanel");
    if (!panel) return;
    panel.textContent = "";
    const plan = state.lockedPlan;
    if (!plan) return; // toolkit + itinerary only exist once the plan is locked

    const dest = plan.destination;

    renderPrep(panel, plan);

    // --- Trip toolkit ---
    const kit = el("div", { class: "card toolkit stagger" });
    kit.appendChild(el("div", { class: "toolkit-title", text: "🧰 Trip toolkit" }));

    // Weather line (async; live via proxy → Open-Meteo).
    const wkey = `${dest}|${plan.dateStart}`;
    const w = weatherCache.get(wkey);
    if (w === undefined) fetchWeather(dest, plan.dateStart, plan.dateEnd);
    if (w && w !== "pending") {
      const rain = rainPhrase(w);
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
    // Say out loud which of the group's answers changed the plan. A filtered
    // itinerary that doesn't explain itself just looks like a thin one.
    it.notes.forEach((n) => card.appendChild(el("div", { class: "itin-note", text: `• ${n}` })));
    it.days.forEach((day) => {
      // The skipped middle of a long trip belongs between the days it sits
      // between, not tacked on after the departure day.
      if (day.gapBefore && it.extraDays > 0) {
        card.appendChild(
          el("div", {
            class: "itin-gap",
            text: `+ ${it.extraDays} free day${it.extraDays === 1 ? "" : "s"} in between to play with`,
          })
        );
      }
      const d = el("div", { class: "itin-day" });
      d.appendChild(el("div", { class: "itin-date", text: day.label }));
      day.slots.forEach(([emoji, text, query], i) => {
        // Arrival and departure rows have nothing to search for — rendering
        // them as links sent people to a map of "null Goa, India".
        const row = query
          ? el("a", {
              class: "itin-row",
              href: E.mapsSearchLink(`${query} ${dest}`),
              target: "_blank",
              rel: "noopener noreferrer",
            })
          : el("div", { class: "itin-row itin-fixed" });
        row.appendChild(el("span", { class: "itin-slot", text: SLOTS[i] }));
        row.appendChild(el("span", { class: "itin-emoji", text: emoji }));
        row.appendChild(el("span", { class: "itin-text", text: text }));
        d.appendChild(row);
      });
      card.appendChild(d);
    });
    // Only if no day carried the gap marker (i.e. the trip ended without one).
    if (it.extraDays > 0 && !it.days.some((d) => d.gapBefore)) {
      card.appendChild(
        el("div", { class: "itin-sub", text: `…plus ${it.extraDays} more free day${it.extraDays === 1 ? "" : "s"} to play with.` })
      );
    }
    panel.appendChild(card);
  }

  // -------------------------------------------------------------------------
  // Expenses & settle-up (Costs tab)
  // -------------------------------------------------------------------------
  // Expenses are stored in USD so the maths (and the invite-link merge) has one
  // canonical unit, but a group splitting a villa in Goa should be reading
  // rupees, not converting in their heads.
  function money(n) {
    return E.formatExact(n, displayCode());
  }
  /**
   * Parse a hand-typed money amount, tolerating the thousands separators our
   * own prompts display. Returns NaN for anything that isn't a clean number,
   * so the caller can reject it rather than silently coercing a wrong value.
   */
  function parseAmount(raw) {
    const cleaned = String(raw == null ? "" : raw)
      .trim()
      .replace(/[\s ]/g, "")
      // Grouping separators only. The lookahead requires exactly three digits
      // followed by a non-digit, so "1,2345" stays malformed and is rejected
      // below rather than silently becoming 12345.
      .replace(/,(?=\d{3}(\D|$))/g, "");
    if (!/^-?\d*\.?\d+$/.test(cleaned)) return NaN;
    return parseFloat(cleaned);
  }
  // Record "A paid B back": a transfer that settles part of a balance rather
  // than a shared cost. Modelled as an expense that only the recipient shares,
  // so the existing balance maths handles it without a special case.
  function addSettlement(fromId, toId, amount, kind) {
    const amt = parseFloat(amount);
    if (!fromId || !toId || fromId === toId || Number.isNaN(amt) || amt <= 0) return;
    // Both a repayment and a contribution to the kitty are one person handing
    // money to another rather than group spend — same maths, different words.
    const paidIn = kind === "contribution";
    state.expenses.unshift({
      id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      payerId: fromId,
      desc: paidIn ? `Paid in to ${pName(toId)}` : `Repaid ${pName(toId)}`,
      amount: amt,
      sharedWith: [toId],
      settlement: true,
      ts: Date.now(),
    });
    saveState();
    renderExpenses();
    toast(paidIn ? "Payment recorded" : "Repayment recorded");
  }

  function addExpense(payerId, desc, amount, sharedWith) {
    const amt = parseFloat(amount);
    // Negatives are allowed on purpose: a deposit refund, a cancelled booking
    // or a mistyped amount all need correcting, and the only way to do that
    // without a negative line was to delete the original and lose the record
    // of what was actually paid. Zero is still rejected — it changes nothing.
    if (!payerId || !desc.trim() || Number.isNaN(amt) || amt === 0) {
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
  /**
   * Forgive a departed member's debt. Recorded as a labelled settlement so the
   * ledger still shows what was spent and who owed it — deleting the original
   * expense would clear the balance by destroying the evidence.
   */
  function writeOffBalance(id, amount) {
    const amt = parseFloat(amount);
    if (!id || !Number.isFinite(amt) || amt <= 0) return;
    // Spread across whoever is still owed money, in proportion to what they're
    // owed, so the group absorbs it the way it actually falls.
    const { balances } = computeSplit();
    const creditors = [...balances.entries()].filter(([, b]) => b > 0.005);
    if (!creditors.length) return;
    const owedTotal = creditors.reduce((sum, [, b]) => sum + b, 0);
    creditors.forEach(([creditorId, b]) => {
      state.expenses.unshift({
        id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        payerId: id,
        desc: `Written off — ${pName(id)}`,
        amount: Math.round(amt * (b / owedTotal) * 100) / 100,
        sharedWith: [creditorId],
        settlement: true,
        ts: Date.now(),
      });
    });
    saveState();
    renderExpenses();
    toast(`Wrote off ${money(amt)} owed by ${pName(id)}`);
  }

  function deleteExpense(id) {
    state.expenses = state.expenses.filter((x) => x.id !== id);
    // Tombstone it. The merge is a union by id, so without a record of the
    // deletion any older invite link would silently bring the expense back —
    // and the money with it.
    state.deletedExpenses = state.deletedExpenses || [];
    if (!state.deletedExpenses.includes(id)) state.deletedExpenses.push(id);
    saveState();
    renderExpenses();
  }
  /** Who a new expense defaults to being split between: the confirmed goers. */
  const splitBase = () => E.splitBaseFor(state.participants);
  /**
   * Balance = what you paid minus your share of each expense you're part of.
   *
   * Each expense carries its OWN sharedWith list (pinned when logged), so
   * shares can differ per expense and latecomers aren't retroactively charged.
   * Legacy expenses saved before this existed fall back to the current base.
   */
  // Thin wrapper: the settle-up maths lives in engine.js so it can be tested
  // directly — it's the only code in the app that decides real money.
  function computeSplit() {
    return E.computeSettlement(state.participants, state.expenses);
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

    const {
      total, share, shareExact, base, balances, transfers, spend, chargedIds,
      positions, allSquare,
    } = computeSplit();
    card.appendChild(
      el("div", {
        class: "itin-sub",
        text:
          `Amounts in ${displayCode()}` +
          (displayCode() === "USD" ? "" : ` (converted at ${D.RATES_AS_OF} rates)`) +
          ` · new expenses default to splitting between the ${base.length} ` +
          `${base.length === state.participants.length ? "people here" : "going"}. ` +
          "Untick anyone an expense shouldn't apply to. " +
          "Expenses travel with the invite link — share it again to sync the " +
          "ledger with everyone else.",
      })
    );

    // Add-expense form.
    // Anyone the ledger still has money with. Building the pickers from the
    // roster alone meant that once a dropout was removed, no correcting or
    // refund line could ever be assigned to them — while computeSettlement
    // went on (correctly) showing their balance, with no way to clear it.
    const ledgerPeople = [
      ...state.participants.map((p) => ({ id: p.id, name: p.name || "Unnamed" })),
      ...[...balances.keys()]
        .filter((id) => !state.participants.some((p) => p.id === id))
        .map((id) => ({ id, name: pName(id) })),
    ];

    const form = el("div", { class: "exp-form" });
    // Two kinds of line, because they mean different things to the maths: a
    // shared cost is group spend, money handed to the treasurer is not.
    let entryMode = "spend";
    const modeRow = el("div", { class: "chip-select exp-mode" });
    const modeBtns = [
      ["spend", "Shared cost"],
      ["collect", "Money in"],
    ].map(([mode, label]) =>
      el("button", {
        type: "button",
        class: `chip-toggle${entryMode === mode ? " on" : ""}`,
        "aria-pressed": entryMode === mode ? "true" : "false",
        text: label,
        onClick: () => {
          entryMode = mode;
          modeBtns.forEach((b, i) => {
            const on = (i === 0 ? "spend" : "collect") === entryMode;
            b.classList.toggle("on", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });
          syncMode();
        },
      })
    );
    modeBtns.forEach((b) => modeRow.appendChild(b));
    form.appendChild(modeRow);

    const payerSel = el("select", { "aria-label": "Who paid" });
    ledgerPeople.forEach((p) => {
      const o = el("option", { value: p.id, text: p.name });
      if (p.id === state.me) o.selected = true;
      payerSel.appendChild(o);
    });
    // Who the money went TO, when it's a contribution rather than a cost.
    const toSel = el("select", { "aria-label": "Paid to" });
    ledgerPeople.forEach((p) => {
      const o = el("option", { value: p.id, text: p.name });
      if (p.id === state.me) o.selected = true;
      toSel.appendChild(o);
    });
    const descIn = el("input", { type: "text", placeholder: "What for? e.g. Villa deposit" });
    const amtIn = el("input", {
      // No min: a refund is entered as a negative line.
      type: "number", step: "0.01", placeholder: displayCode(), inputmode: "decimal",
    });
    form.appendChild(payerSel);
    form.appendChild(descIn);

    // Per-expense "split between" picker — this is what makes unequal shares
    // and late joiners work correctly (see addExpense/computeSplit).
    const baseIds = new Set(base.map((p) => p.id));
    const chosen = new Set(baseIds);
    const whoWrap = el("div", { class: "exp-who" });
    whoWrap.appendChild(el("div", { class: "exp-who-label", text: "Split between" }));
    const chips = el("div", { class: "chip-select" });
    ledgerPeople.forEach((p) => {
      const on = chosen.has(p.id);
      chips.appendChild(
        el("button", {
          type: "button",
          class: `chip-toggle${on ? " on" : ""}`,
          text: p.name,
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
    const toWrap = el("div", { class: "exp-who" });
    toWrap.appendChild(el("div", { class: "exp-who-label", text: "Paid to" }));
    toWrap.appendChild(toSel);
    form.appendChild(toWrap);

    const row = el("div", { class: "exp-form-row" });
    row.appendChild(amtIn);
    const submit = el("button", {
      class: "btn sm",
      text: "Add expense",
      onClick: () => {
        const amt = E.toUSD(parseAmount(amtIn.value), displayCode());
        if (!Number.isFinite(amt) || amt === 0) {
          toast("Enter an amount");
          return;
        }
        if (entryMode === "collect") {
          // Money handed to the treasurer is a transfer between two people, not
          // group spend. Recording it as an ordinary expense was the only route
          // available and it inflated the headline: a 12-person trip where the
          // treasurer collected $250 each before paying a $2,400 deposit showed
          // "Total $5,150 · $429.17 avg per person" for $2,400 of actual spend.
          if (payerSel.value === toSel.value) {
            toast("Pick two different people");
            return;
          }
          addSettlement(payerSel.value, toSel.value, Math.abs(amt), "contribution");
          descIn.value = "";
          amtIn.value = "";
          return;
        }
        if (!chosen.size) {
          toast("Pick at least one person to split between");
          return;
        }
        // Typed in whatever currency the ledger is showing; stored in USD.
        addExpense(payerSel.value, descIn.value, amt, [...chosen]);
      },
    });
    row.appendChild(submit);
    form.appendChild(row);

    // Show only the fields the chosen kind of line actually needs.
    function syncMode() {
      const collecting = entryMode === "collect";
      whoWrap.hidden = collecting;
      toWrap.hidden = !collecting;
      descIn.hidden = collecting;
      payerSel.setAttribute("aria-label", collecting ? "Who paid in" : "Who paid");
      submit.textContent = collecting ? "Record payment" : "Add expense";
      descIn.placeholder = "What for? e.g. Villa deposit";
    }
    syncMode();
    card.appendChild(form);

    if (!state.expenses.length) {
      card.appendChild(el("div", { class: "empty", text: "No expenses yet — add the first one." }));
      panel.appendChild(card);
      return;
    }

    // Expense list.
    const list = el("div", { class: "exp-list" });
    // Costs and transfers are different things and were rendered identically,
    // so the rows never summed to the printed Total and nothing said why. The
    // "Money in" mode made it stark: a treasurer collecting $250 from eleven
    // people before a $2,400 deposit saw twelve rows adding to $5,150 above a
    // line reading "Total $2,400". Two sections now, each labelled.
    const costRows = state.expenses.filter((x) => !x.settlement);
    const moveRows = state.expenses.filter((x) => x.settlement);
    const buildRow = (x) => {
      const r = el("div", { class: `exp-item${x.settlement ? " exp-transfer-row" : ""}` });
      const w = el("div", { style: "flex:1;min-width:0" });
      w.appendChild(el("div", { class: "exp-desc", text: x.desc }));
      // Show the split scope so an unequal share is visible, not hidden.
      // Show the FULL pinned set. Filtering to people still on the roster made
      // the label disagree with the maths: a $300 dinner split between Ana and
      // Bob read "split between Bob" after Ana was removed — claiming Bob bore
      // all $300 — while he was charged $150 and a transfer row directly below
      // said Ana still owed him the rest. pName() already renders a departed
      // person as "Ana (removed)".
      const sharers = Array.isArray(x.sharedWith) ? x.sharedWith : [];
      // Compare WHO, not how many. Same-size-but-different-people hid the
      // scope entirely: a dinner split between Ana and Bob showed no scope at
      // all on a roster of Bob and Cara, so the row read as everyone's.
      const coversRoster =
        sharers.length === state.participants.length &&
        sharers.every((id) => state.participants.some((q) => q.id === id));
      let scope = "";
      if (sharers.length && !coversRoster) {
        scope =
          sharers.length <= 3
            ? ` · split between ${sharers.map(pName).join(", ")}`
            : ` · split ${sharers.length} ways`;
      }
      w.appendChild(
        el("div", {
          class: "exp-meta",
          text: x.settlement
            ? `${pName(x.payerId)} → ${sharers.map(pName).join(", ") || "the group"}`
            : `paid by ${pName(x.payerId)}${scope}`,
        })
      );
      r.appendChild(w);
      r.appendChild(
        el("span", {
          class: `exp-amt${x.amount < 0 ? " refund" : ""}`,
          text: x.amount < 0 ? `refund ${money(Math.abs(x.amount))}` : money(x.amount),
        })
      );
      if (state.role === "organizer" || x.payerId === state.me) {
        r.appendChild(
          el("button", { class: "icon-btn sm", "aria-label": "Delete expense", text: "✕", onClick: () => deleteExpense(x.id) })
        );
      }
      return r;
    };

    if (costRows.length) {
      list.appendChild(el("div", { class: "exp-group-label", text: "Shared costs" }));
      costRows.forEach((x) => list.appendChild(buildRow(x)));
    }
    if (moveRows.length) {
      list.appendChild(
        el("div", {
          class: "exp-group-label",
          text: "Money moved between people — not part of the total",
        })
      );
      moveRows.forEach((x) => list.appendChild(buildRow(x)));
    }
    card.appendChild(list);

    // The settle-up list nets everything down to the fewest payments, which
    // hides who actually carried the trip. A treasurer closing the books needs
    // to see that Bo fronted £900 and Cy has paid in nothing.
    if (positions.length && spend.length) {
      card.appendChild(el("div", { class: "prep-sub", text: "Where everyone stands" }));
      const table = el("div", { class: "pos-list" });
      positions.forEach((pos) => {
        const row = el("div", { class: "pos-row" });
        const name = el("div", { class: "pos-name" });
        name.appendChild(el("span", { text: pName(pos.id) }));
        if (pos.paidNothing) {
          name.appendChild(el("span", { class: "badge warn", text: "paid in nothing" }));
        }
        if (!pos.onRoster) {
          name.appendChild(el("span", { class: "badge", text: "left" }));
        }
        row.appendChild(name);
        row.appendChild(
          el("div", {
            class: "pos-detail",
            text: `paid ${money(pos.paid)} · share ${money(pos.share)}`,
          })
        );
        const net = el("div", {
          class: `pos-net ${pos.net > 0.005 ? "up" : pos.net < -0.005 ? "down" : ""}`,
          text:
            pos.net > 0.005
              ? `owed ${money(pos.net)}`
              : pos.net < -0.005
              ? `owes ${money(-pos.net)}`
              : "square",
        });
        row.appendChild(net);
        // Forgiving a debt is a decision the group makes, so it needs to be an
        // explicit, recorded act — not a deleted expense, which would destroy
        // the record of what was actually paid.
        if (state.role === "organizer" && !pos.onRoster && pos.net < -0.005) {
          row.appendChild(
            el("button", {
              class: "btn ghost sm",
              style: "width:auto",
              text: "Write off",
              onClick: () => {
                if (!window.confirm(
                  `Write off ${money(-pos.net)} owed by ${pName(pos.id)}?\n\n` +
                    "The group absorbs it. The original expenses stay on the books."
                )) return;
                writeOffBalance(pos.id, -pos.net);
              },
            })
          );
        }
        table.appendChild(row);
      });
      card.appendChild(table);
    }
    if (allSquare) {
      card.appendChild(
        el("div", { class: "exp-square", text: "🎉 Everyone's square — the books are closed." })
      );
    }
    // "each" is only meaningful when every expense is split the same way;
    // otherwise show the average so it isn't mistaken for an exact figure.
    // "each" is a definite claim, so check WHO each expense was split between,
    // not just how many. Comparing lengths printed "$150.00 each" for a $300
    // dinner split between Ana and Bob after Ana was removed — telling Cara,
    // who owed nothing, that she owed $150.
    const charged = new Set(chargedIds);
    const roster = new Set(state.participants.map((p) => p.id));
    // "each" is read by everyone looking at the card, so it may only appear
    // when it is true FOR everyone looking at the card. A $300 dinner split
    // between Ana and Bob is genuinely "$150 each" — for Ana and Bob — but
    // after Ana is removed, Cara reads the same line as her own debt.
    const chargedIsWholeRoster =
      charged.size === roster.size && [...charged].every((id) => roster.has(id));
    const uniform =
      shareExact &&
      chargedIsWholeRoster &&
      spend.every((x) => {
        const ids = Array.isArray(x.sharedWith) ? x.sharedWith : [];
        return !ids.length || (ids.length === charged.size && ids.every((id) => charged.has(id)));
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
        const row = el("div", { class: "exp-transfer" });
        row.appendChild(
          el("span", { text: `${pName(t.from)} → ${pName(t.to)}  ${money(t.amount)}` })
        );
        // Without a way to record the repayment, this list could never be
        // cleared and stayed permanently accusatory after the money moved.
        if (state.role === "organizer" || t.from === state.me || t.to === state.me) {
          row.appendChild(
            el("button", {
              class: "btn ghost sm settle-btn",
              text: "Mark paid",
              onClick: () => {
                // Prefilled with the full balance but editable. People repay in
                // round numbers and in instalments, and the settle-up maths has
                // always handled a partial correctly — the UI just had no way to
                // enter one, so the only options were to record money that was
                // never handed over or to lose the record entirely.
                const full = Math.round(E.convertFromUSD(t.amount, displayCode()) * 100) / 100;
                const typed = window.prompt(
                  `How much did ${pName(t.from)} pay ${pName(t.to)}?
` +
                    `Full balance is ${money(t.amount)} (${displayCode()}).`,
                  String(full)
                );
                if (typed === null) return;
                // The prompt shows the balance grouped ("83,000.00"), so people
                // type it back the same way — and bare parseFloat stops at the
                // first comma, recording 83 instead of 83,000. It passed both
                // guards and reported success.
                const amt = E.toUSD(parseAmount(typed), displayCode());
                if (!Number.isFinite(amt) || amt <= 0) {
                  toast("Enter an amount greater than zero");
                  return;
                }
                if (amt > t.amount + 0.005) {
                  toast(`That's more than the ${money(t.amount)} outstanding`);
                  return;
                }
                addSettlement(t.from, t.to, amt);
              },
            })
          );
        }
        card.appendChild(row);
      });
    }
    panel.appendChild(card);
  }

  // -------------------------------------------------------------------------
  // Voting ("Decide" — the group converges; engine score is the seed/tiebreak)
  // -------------------------------------------------------------------------
  function optionId(c) {
    // Year-bearing, so ballots can't merge two different years' options.
    return `${c.destination}|${c.dateRange.start}_${c.dateRange.end}`;
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
      // Stamped so the ballot can travel and merge like everything else: a
      // vote is one person's answer (newest per voter wins) and open/closed is
      // the organiser's (newest wins outright).
      ts: Date.now(),
    };
    renderAll();
    toast("Voting opened — cast your vote!");
  }
  function closeBallot() {
    if (state.ballot) {
      state.ballot.open = false;
      state.ballot.ts = Date.now();
    }
    renderAll();
  }
  function reopenBallot() {
    if (state.ballot) {
      state.ballot.open = true;
      state.ballot.ts = Date.now();
    }
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
    state.ballot.votesByParticipant[state.me] = { optionId: id, ts: Date.now() };
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
      state.ballot.votesByParticipant[p.id] = { optionId: opts[idx].id, ts: Date.now() };
    });
    saveState();
    renderVote();
  }
  function lockBallotOption(o) {
    // Locking from the ballot is the same act as locking from the winner card,
    // so it needs the same permission check and the same announcement.
    if (state.role !== "organizer") {
      toast("Only the organiser can lock the plan");
      return;
    }
    if (!window.confirm(`Lock ${o.destination} on ${o.dateLabel} for everyone?`)) return;
    applyLock({
      destination: o.destination,
      dateStart: o.dateStart,
      dateEnd: o.dateEnd,
      dateLabel: o.dateLabel,
    });
    state.phase = "decide";
    renderAll();
    confetti();
    notifyPlanLocked(state.lockedPlan);
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
      } else if (state.role !== "organizer" && combos.length >= 2) {
        // A guest used to get a completely blank vote area with no explanation.
        panel.appendChild(
          el("div", {
            class: "card vote-cta",
            text: "🗳️ No vote open. If the group can't agree, the organiser can start one.",
          })
        );
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
    // People who've said they can't come aren't waiting to vote, so counting
    // them made the tally permanently incomplete.
    const eligible = state.participants.filter((p) => p.rsvp !== "out").length;
    head.appendChild(
      el("span", { class: "hint", text: `${totalVotes} of ${eligible} voted` })
    );
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
  /**
   * Participants answer on their own device and their answers stay there until
   * they send a link back. Nothing in the app ever asked them to — the only
   * affordance that produces a link is the organiser-worded "Invite people"
   * button — so the common outcome was a group where everyone had filled the
   * app in and the organiser's roster was still empty. Meanwhile a push
   * notification told the organiser they had responded.
   */
  function renderSendBack() {
    const host = $("#sendBackBar");
    if (!host) return;
    host.textContent = "";
    const me = state.participants.find(isMe);
    const show = state.role !== "organizer" && me && hasResponded(me);
    host.hidden = !show;
    if (!show) return;
    const bar = el("div", { class: "sendback" });
    bar.appendChild(
      el("div", {
        class: "sendback-text",
        text: "Your answers are only on this device — send them to the organiser.",
      })
    );
    bar.appendChild(
      el("button", {
        class: "btn sm",
        style: "width:auto",
        text: "📤 Send my answers",
        onClick: openInviteModal,
      })
    );
    host.appendChild(bar);
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
    renderSendBack();
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
        const locked = n.kind === "locked";
        item.appendChild(
          el("div", {
            class: "notif-name",
            text: locked
              ? `🔒 ${n.name || "The organiser"} locked the plan`
              : `${n.name || "Someone"} responded`,
          })
        );
        const bits = [];
        if (locked) {
          bits.push(`${n.destination} · ${n.dateLabel}`);
        } else {
          bits.push(n.destOk ? `✓ ${n.destination}` : `wants a different place`);
          bits.push(n.dateOk ? `✓ ${n.dateLabel}` : `different dates`);
        }
        item.appendChild(el("div", { class: "notif-meta", text: bits.join(" · ") }));
        panel.appendChild(item);
      });
    // The notification says somebody answered; their answers are still on their
    // phone. Presenting it as receipt of the data was the app asserting
    // something it had no way to back up — the organiser's roster stays
    // unchanged until that person sends their link back.
    if (notifItems.some((n) => n.kind !== "locked")) {
      panel.appendChild(
        el("div", {
          class: "notif-empty",
          text: "Their answers arrive when they send their link back — ask anyone whose card still looks empty.",
        })
      );
    }
  }
  async function pollNotifications() {
    const code = state.reunion.notifyToken;
    // No token means this group predates the change (or the link carried none);
    // polling the old guessable code would defeat the point.
    if (state.role !== "organizer" || !code) return;
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
    // Through applyLock so the stamp moves and the prep checklist is cleared —
    // otherwise dropping the demo data left "Everyone's booked" over a plan
    // that no longer exists.
    applyLock(null);
    invalidateCombos();
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
      t.setAttribute("tabindex", on ? "0" : "-1");
    });
    saveState();
  }
  function wirePhases() {
    const tabs = [...document.querySelectorAll(".phase-tab")];
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => {
        showPhase(t.getAttribute("data-phase"));
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      // A tablist should be arrow-navigable, with only the active tab in the
      // tab order — otherwise keyboard users tab through every panel header.
      t.addEventListener("keydown", (e) => {
        const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const next = tabs[(i + dir + tabs.length) % tabs.length];
        showPhase(next.getAttribute("data-phase"));
        next.focus();
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
  /**
   * The window we should be pricing. Live fares were requested with no date at
   * all, so the proxy fell back to a hard-coded departure — a date that has
   * since passed — and quoted August prices for a Christmas trip while badging
   * them "live". Deliberately fare-independent (locked plan, else the group's
   * most-wanted submitted window) so asking for fares can't depend on a
   * ranking that depends on fares.
   */
  function pricingWindow() {
    if (state.lockedPlan && state.lockedPlan.dateStart) {
      return { start: state.lockedPlan.dateStart, end: state.lockedPlan.dateEnd };
    }
    const wanted = E.tallyDates(state.participants);
    return wanted.length && wanted[0].range.start ? wanted[0].range : null;
  }

  function neededRoutes() {
    // Seed the same way the ranking does. A locked destination LEAVES the tally
    // as soon as its nominators edit their lists or decline — that's exactly
    // why rankCombinations pins it — so the agreed plan was never fetched from
    // the proxy and competed against live-priced rivals on a crude offline
    // estimate, inside a cost score normalised within the window at 40% weight.
    const relevant = state.participants.filter((p) => p.rsvp !== "out");
    const dests = E.tallyDestinations(relevant.length ? relevant : state.participants)
      .map((d) => d.destination);
    if (state.lockedPlan && !dests.includes(state.lockedPlan.destination)) {
      dests.unshift(state.lockedPlan.destination);
    }
    const win = pricingWindow();
    const date = win ? win.start : null;
    const nights = win ? Math.max(1, E.rangeDays(win) - 1) : null;
    const routes = [];
    for (const p of state.participants) {
      if (!p.city) continue;
      for (const dest of dests) routes.push([p.city, dest, date, nights]);
    }
    return routes;
  }
  let fareFetchPending = false;
  let fareFetchDirty = false;
  function refreshFares() {
    // A request that arrives mid-flight used to be DROPPED, not queued, and the
    // completion callback never re-entered here. Boot fires ~90-180 fare
    // lookups with 8-10s upstream timeouts, so anything that changes which
    // routes are needed during that window — locking a plan (which moves the
    // pricing window, and therefore every cache key), or adding someone from a
    // new city — was silently lost until the next user-triggered render. For a
    // geocoded city that left the Costs tab showing "Estimating fare…" forever
    // and that person contributing nothing to the ranking.
    if (fareFetchPending) {
      fareFetchDirty = true;
      return;
    }
    fareFetchPending = true;
    fareFetchDirty = false;
    window.ReunlyFares.ensureFares(neededRoutes(), () => {
      // New fares arrived — re-render derived sections (not inputs). Must drop
      // the memoised ranking first, or the whole point of fetching real fares
      // is lost to a stale cached answer.
      invalidateCombos();
      renderMeta();
      renderWinner();
      renderRecommendations();
      renderCosts();
    }).finally(() => {
      fareFetchPending = false;
      // ensureFares dedupes per key, so a follow-up pass only requests what is
      // genuinely still missing.
      if (fareFetchDirty) refreshFares();
    });
  }

  // Recompute only the derived sections (recs + costs) — leaves participant
  // inputs untouched so focus/caret isn't lost while typing.
  function recomputeDerived() {
    invalidateCombos(); // state may have changed since the last pass
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
    invalidateCombos(); // state may have changed since the last pass
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
        const { added, updated, expensesAdded, lockChanged } =
          mergeParticipantsFromHash(hashData);
        location.hash = "";
        if (state.user) {
          saveState();
          enterDashboard("resume", state.reunion.code);
          const bits = [];
          if (added) bits.push(`${added} new ${added === 1 ? "person" : "people"}`);
          if (updated) bits.push(`${updated} updated ${updated === 1 ? "reply" : "replies"}`);
          if (expensesAdded)
            bits.push(`${expensesAdded} new ${expensesAdded === 1 ? "expense" : "expenses"}`);
          if (bits.length) toast(`Welcome back — ${bits.join(" · ")}.`);
          // A moved or cancelled trip must never arrive quietly — this is the
          // one change where saying nothing gets people to the wrong airport
          // in the wrong week. Announce it after the merge summary.
          if (lockChanged !== null) {
            setTimeout(() => {
              toast(
                lockChanged
                  ? `📌 The plan changed — now ${lockChanged.destination}, ${lockChanged.dateLabel}`
                  : "📌 The organiser unlocked the plan — nothing is fixed yet"
              );
            }, bits.length ? 2600 : 0);
          }
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

  // ---------------------------------------------------------------------------
  // Journey map: everyone converging on one destination
  // ---------------------------------------------------------------------------

  // How each traveller gets there. Deliberately derived from the SAME rule the
  // cost model uses (engine estimateFare's drive/flight threshold), so the
  // picture can never contradict the price beside it — showing a train for a
  // journey costed as a flight would be exactly the kind of confident-but-
  // unfounded claim the rest of the app works hard to avoid.
  const TRAVEL_MODES = {
    walk: { glyph: "\u{1F6B6}", label: "already there", arc: 0.12 },
    drive: { glyph: "\u{1F697}", label: "driving", arc: 0.3 },
    flight: { glyph: "\u{2708}\u{FE0F}", label: "flying", arc: 1 },
  };
  // Fixed order so the caption reads the same way on every render.
  const MODE_ORDER = ["flight", "drive", "walk"];

  function travelModeFor(fromCity, toCity, prefs) {
    if (!fromCity || !toCity) return "flight";
    const miles = E.distanceMiles(fromCity, toCity);
    if (miles == null) return "flight"; // unknown city — don't invent a road
    if (miles < 25) return "walk";
    // Ask the cost model, not the distance. Whether a journey is driven now
    // depends on party size as well as distance, so reading the raw
    // drive/fly threshold would draw a plane beside a fare priced as one car.
    const f = fareProvider(fromCity, toCity);
    if (!f || f.min == null) return "flight";
    const party = 1 + Math.max(0, parseInt((prefs && prefs.kids) || 0, 10) || 0);
    return E.chooseTravel(miles, (f.min + f.max) / 2, party).mode === "drive"
      ? "drive"
      : "flight";
  }

  /**
   * Build the convergence animation: several origins, one destination, each
   * traveller moving by the mode their distance implies.
   *
   * `travellers` is [{ name, city }]. Returns an SVG element, or null if there
   * is nothing worth drawing.
   */
  function buildJourneyMap(travellers, destination) {
    const people = (travellers || []).filter((t) => t.city).slice(0, 6);
    if (!people.length || !destination) return null;

    const W = 400;
    const H = 190;
    const HUB = { x: 316, y: H / 2 };
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");

    const mk = (tag, attrs) => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };

    // Origins fan out down the left, curving so the ones furthest from the
    // middle also sit furthest left — it reads as converging rather than as a
    // list of parallel flights.
    const n = people.length;
    const gap = n === 1 ? 0 : Math.min(34, (H - 56) / (n - 1));
    people.forEach((person, i) => {
      const offset = i - (n - 1) / 2;
      const y = H / 2 + offset * gap;
      const x = 46 + Math.abs(offset) * 9;
      const mode = TRAVEL_MODES[travelModeFor(person.city, destination, person.prefs)];
      // Lift the control point for a flight and keep a road route low, so the
      // shape of the line already says how they're getting there.
      const midX = (x + HUB.x) / 2;
      const lift = 26 + Math.abs(offset) * 6;
      const cy = y + (HUB.y - y) / 2 - lift * mode.arc;
      const d = `M ${x} ${y} Q ${midX} ${cy.toFixed(1)} ${HUB.x} ${HUB.y}`;

      svg.appendChild(mk("path", { class: "jm-arc", d, fill: "none" }));
      svg.appendChild(mk("circle", { class: "jm-origin", cx: x, cy: y, r: 3.4 }));

      const label = mk("text", {
        class: "jm-label", x: x - 8, y: y + 3.5, "text-anchor": "end",
      });
      label.textContent = shortPlace(person.city);
      svg.appendChild(label);

      const glyph = mk("text", { class: "jm-mover", x: 0, y: 0 });
      glyph.textContent = mode.glyph;
      // offset-path takes the same path string, so the glyph tracks the line
      // exactly rather than approximating it.
      glyph.style.offsetPath = `path("${d}")`;
      glyph.style.animationDelay = `${(i * 0.55).toFixed(2)}s`;
      svg.appendChild(glyph);
    });

    // The destination last, so it sits above every arrival.
    svg.appendChild(mk("circle", { class: "jm-hub-ring", cx: HUB.x, cy: HUB.y, r: 15 }));
    svg.appendChild(mk("circle", { class: "jm-hub", cx: HUB.x, cy: HUB.y, r: 7 }));
    const destLabel = mk("text", {
      class: "jm-dest", x: HUB.x, y: HUB.y + 32, "text-anchor": "middle",
    });
    destLabel.textContent = `${D.cityEmoji(destination)} ${shortPlace(destination)}`;
    svg.appendChild(destLabel);
    return svg;
  }

  /** "Goa, India" -> "Goa". Labels have very little room. */
  function shortPlace(name) {
    return String(name || "").split(",")[0].trim();
  }

  // The registration screen has no group yet, so it borrows a plausible one and
  // rotates it. Same component, so what a visitor sees before signing up is the
  // same thing they'll see with their own friends in it.
  const SAMPLE_TRIPS = [
    { dest: "Goa, India", from: ["London, UK", "Dubai, UAE", "Mumbai, India", "Pune, India", "Singapore"] },
    { dest: "Bali, Indonesia", from: ["Sydney, Australia", "Singapore", "Hong Kong", "Bangkok, Thailand"] },
    { dest: "Paris, France", from: ["London, UK", "New York, NY", "Dubai, UAE", "Manchester, UK"] },
    { dest: "New York, NY", from: ["Boston, MA", "Chicago, IL", "London, UK", "Washington, DC"] },
  ];
  let sampleIdx = Math.floor(Math.random() * SAMPLE_TRIPS.length);
  function startFlight() {
    const host = document.querySelector(".flight-anim");
    if (!host) return;
    const draw = () => {
      const trip = SAMPLE_TRIPS[sampleIdx % SAMPLE_TRIPS.length];
      sampleIdx += 1;
      const map = buildJourneyMap(trip.from.map((c) => ({ city: c })), trip.dest);
      host.textContent = "";
      if (map) host.appendChild(map);
    };
    draw();
    // Rotate only while the tab is visible and motion is welcome; a background
    // tab firing a timer forever is the kind of thing that drains a phone.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setInterval(() => {
      if (document.visibilityState === "visible" && host.isConnected) draw();
    }, 9000);
  }

  // The real thing: this group, their actual cities, converging on the plan.
  function renderJourneyMap(container, plan) {
    if (!container || !plan) return;
    const goers = state.participants.filter((p) => p.rsvp !== "out" && p.city);
    const map = buildJourneyMap(goers, plan.destination);
    if (!map) return;
    const wrap = el("div", { class: "journey-map" });
    wrap.appendChild(map);
    // Count by mode rather than listing them. "3 flying · 1 driving" says
    // something about the group; "flying and by road and on foot" was clumsy
    // and told you nothing about how many people face each journey.
    const tally = {};
    goers.forEach((p) => {
      const m = travelModeFor(p.city, plan.destination, p.prefs);
      tally[m] = (tally[m] || 0) + 1;
    });
    const parts = MODE_ORDER.filter((m) => tally[m]).map(
      (m) => `${tally[m]} ${TRAVEL_MODES[m].label}`
    );
    // The tally covers everyone, but only six fit on the map — say which is
    // which, or "9 flying" reads as nine planes on a picture showing six.
    if (goers.length > 6) parts.push(`showing 6 of ${goers.length}`);
    wrap.appendChild(el("div", { class: "jm-caption", text: parts.join(" · ") }));
    container.appendChild(wrap);
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
