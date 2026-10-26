/*
 * crawl.js — v0.9 prototype UI: plan an evening (work social / pub crawl),
 * collect "from when, until when", finalise the start, and track the group
 * live so late arrivals can join at a later stop.
 *
 * Three views, chosen by the URL hash:
 *   (none)            builder — organiser plans the route
 *   #e=ID&k=HOSTKEY   host    — organiser / co-host: availability + check-ins
 *   #e=ID             guest   — say when you can come, then follow the tracker
 *
 * All user text goes through textContent (never innerHTML).
 */
(function () {
  "use strict";
  const C = window.CrawlEngine;
  const $ = (s) => document.querySelector(s);
  const POLL_MS = 15000;

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  const store = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k) || "null");
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        /* private mode: the prototype still works for this page view */
      }
    },
  };

  const rid = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

  async function api(path, body) {
    const res = await fetch(path, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* empty */
    }
    return { ok: res.ok, status: res.status, data };
  }

  // ---- Place suggestions (any place, via the app's existing /api/geosuggest) ----
  function attachSuggest(input, onPick, kind) {
    const wrap = input.parentElement;
    let menu = null;
    let timer = null;
    const close = () => {
      if (menu) menu.remove();
      menu = null;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) return close();
      timer = setTimeout(async () => {
        let data = null;
        try {
          data = (await api(`/api/geosuggest?q=${encodeURIComponent(q)}${kind ? "&kind=" + kind : ""}`)).data;
        } catch (e) {
          return; // no signal: just no suggestions
        }
        if (input.value.trim() !== q) return;
        close();
        const items = (data && data.results) || [];
        if (!items.length) return;
        menu = el("div", { class: "ac-menu" });
        items.slice(0, 6).forEach((s) =>
          menu.appendChild(
            el("div", {
              class: "ac-item",
              text: s.label,
              onMousedown: (e) => {
                e.preventDefault();
                input.value = s.label;
                close();
                onPick(s);
              },
            })
          )
        );
        wrap.appendChild(menu);
      }, 300);
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  }

  // Local date, not toISOString(): that's UTC and lands on the wrong day
  // for anyone east or west of London late in the evening.
  const nextThursday = () => {
    const d = new Date();
    d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // ---- Route map (Leaflet + OpenStreetMap tiles, vendored; no API key) ----
  // One persistent map per view: re-rendering the page re-attaches the same
  // card rather than rebuilding the map (and re-downloading tiles) every poll.
  const maps = {};
  function mapCard(key, title) {
    if (!window.L) return null; // map is a bonus; the route list stands alone
    if (!maps[key]) {
      const box = el("div", { class: "map", role: "img", "aria-label": "Map of the route" });
      const card = el("div", { class: "card map-card" }, [el("h2", { text: title }), box]);
      maps[key] = { card, box, map: null, layer: null, fitted: "" };
    }
    return maps[key];
  }
  function updateMap(key, stops, stateOf) {
    const m = maps[key];
    if (!m || !window.L) return;
    m.card.hidden = !stops.length;
    if (!stops.length) return;
    const L = window.L;
    if (!m.map) {
      m.map = L.map(m.box, { scrollWheelZoom: false, zoomControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors",
      }).addTo(m.map);
      m.layer = L.layerGroup().addTo(m.map);
    }
    m.layer.clearLayers();
    const pts = stops.map((s) => [s.lat, s.lon]);
    if (pts.length > 1) {
      L.polyline(pts, { color: "#a855f7", weight: 4, opacity: 0.85, dashArray: "6 8" }).addTo(m.layer);
    }
    stops.forEach((s, i) => {
      // Tooltip content as a DOM node: a string would be parsed as HTML, and
      // venue names come from OpenStreetMap.
      const tip = document.createElement("span");
      tip.textContent = `${i + 1}. ${s.name}${s.arriveAt ? " · " + s.arriveAt : ""}`;
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: `pin ${stateOf ? stateOf(i) : ""}`, html: String(i + 1), iconSize: [30, 30] }),
        title: s.name,
        keyboard: false,
      }).bindTooltip(tip, { direction: "top", offset: [0, -14] }).addTo(m.layer);
    });
    // Only re-frame when the route itself changes, so a guest who zoomed in
    // isn't yanked back every 15 seconds.
    const sig = pts.map((p) => p.join(",")).join("|");
    setTimeout(() => {
      m.map.invalidateSize();
      if (m.fitted !== sig) {
        m.map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 17 });
        m.fitted = sig;
      }
    }, 0);
  }

  function timeOptions(select, value, allowBlank) {
    if (allowBlank) select.appendChild(el("option", { value: "", text: "All night" }));
    for (let m = 16 * 60; m <= 26 * 60; m += 15) {
      const t = C.toHHMM(m);
      select.appendChild(el("option", { value: t, text: t, selected: t === value }));
    }
  }

  const TRANSPORT = [
    ["", "How are you getting home?"], ["walk", "Walking"], ["train", "Train / tube"],
    ["bus", "Night bus"], ["taxi", "Taxi / Uber"], ["lift", "Getting a lift"],
    ["drive", "Driving (not drinking)"], ["unsure", "Not sure yet"],
  ];
  const BOOKING = [["none", "Not contacted"], ["called", "Called — waiting"], ["booked", "Booked ✓"], ["walkin", "Walk-in is fine"]];

  /** A select of late-evening times, with a first option for "none". */
  function trainOptions(select, value, blankLabel) {
    select.appendChild(el("option", { value: "", text: blankLabel }));
    for (let m = 21 * 60; m <= 25 * 60 + 30; m += 15) {
      const t = C.toHHMM(m);
      select.appendChild(el("option", { value: t, text: t, selected: t === value }));
    }
  }

  const telHref = (phone) => `tel:${String(phone).replace(/[^0-9+]/g, "")}`;

  /**
   * Copy text and say so on the button. The Clipboard API only exists on
   * secure pages — a phone opening http://192.168… had none, and the old code
   * silently selected the text instead. Fall back to execCommand, and if even
   * that fails, select it and say how to copy by hand.
   */
  async function copyText(text, input, button) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok && input) {
      input.focus();
      input.select();
      input.setSelectionRange(0, text.length);
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
    }
    if (ok) {
      const was = button.textContent;
      button.textContent = "Copied ✓";
      setTimeout(() => { button.textContent = was; }, 1800);
      toast("Link copied — paste it into WhatsApp, a text or an email");
    } else {
      toast("Couldn't copy automatically — the link is selected, long-press it to copy");
    }
  }

  function scheduleOf(rec) {
    return C.scheduleStops(rec.stops, rec.finalStart || rec.plannedStart, rec.dwell);
  }

  function hoursNote(stop, date) {
    const open = C.isOpenAt(stop.hours, date, stop.arriveAt);
    if (open === false) return { text: `⚠️ Closed at ${stop.arriveAt} on that day (${stop.hours})`, bad: true };
    if (open === true) return { text: "Open then", bad: false };
    return { text: stop.hours ? "Hours not clear — check before you go" : "No opening hours listed", bad: false };
  }

  // =========================================================================
  // Builder (organiser, before the event exists)
  // =========================================================================
  function renderBuilder() {
    const fresh = {
      name: "", organizer: "", organizerPhone: "", lastTrain: "",
      organizerHome: null, organizerTransport: "", organizerLastTrain: "",
      date: nextThursday(), plannedStart: "17:30", dwell: 50, stops: [],
      target: 4,
      who: { size: 8, ageMin: 30, ageMax: 60, vibe: "mixed", needs: { food: false, stepFree: false, outdoor: false } },
    };
    const saved = store.get("crawl:draft");
    // A malformed or older draft must not break the builder.
    const draft = saved && typeof saved === "object" && Array.isArray(saved.stops)
      ? { ...fresh, ...saved, who: { ...fresh.who, ...(saved.who || {}), needs: { ...fresh.who.needs, ...((saved.who || {}).needs || {}) } } }
      : fresh;
    const save = () => store.set("crawl:draft", draft);
    const app = $("#app");
    app.textContent = "";
    $("#topSub").textContent = "Plan the evening";

    const basics = el("div", { class: "card" });
    basics.appendChild(el("h2", { text: "1 · The evening" }));
    const name = el("input", { id: "evName", placeholder: "e.g. Team drinks — Q4 wrap", value: draft.name });
    name.addEventListener("input", () => { draft.name = name.value; save(); });
    const org = el("input", { id: "evOrg", placeholder: "Your first name", value: draft.organizer });
    org.addEventListener("input", () => { draft.organizer = org.value; save(); });
    const date = el("input", { id: "evDate", type: "date", value: draft.date });
    date.addEventListener("change", () => { draft.date = date.value; save(); drawRoute(); });
    const start = el("select", { id: "evStart" });
    timeOptions(start, draft.plannedStart);
    start.addEventListener("change", () => { draft.plannedStart = start.value; save(); drawRoute(); });
    const dwell = el("select", { id: "evDwell" });
    [30, 45, 50, 60, 75, 90].forEach((m) =>
      dwell.appendChild(el("option", { value: m, text: `${m} min per stop`, selected: m === draft.dwell }))
    );
    dwell.addEventListener("change", () => { draft.dwell = Number(dwell.value); save(); drawRoute(); });
    basics.append(
      el("label", { for: "evName", text: "Name" }), name,
      el("label", { for: "evOrg", text: "Organiser" }), org,
      el("div", { class: "row" }, [
        el("div", {}, [el("label", { for: "evDate", text: "Date" }), date]),
        el("div", {}, [el("label", { for: "evStart", text: "Planned start" }), start]),
      ]),
      el("label", { for: "evDwell", text: "Time at each stop" }), dwell
    );
    // Getting home + being reachable on the night.
    const orgPhone = el("input", { id: "evOrgPhone", type: "tel", placeholder: "Optional — guests can call you on the night", value: draft.organizerPhone, autocomplete: "tel" });
    orgPhone.addEventListener("input", () => { draft.organizerPhone = orgPhone.value; save(); });
    const lastTrain = el("select", { id: "evLastTrain" });
    trainOptions(lastTrain, draft.lastTrain, "Not sure / not relevant");
    lastTrain.addEventListener("change", () => { draft.lastTrain = lastTrain.value; save(); drawRoute(); });
    // Where the organiser is travelling from — the night may be in another city.
    const homeWrap = el("div", { class: "ac" });
    const orgHome = el("input", { id: "evOrgHome", placeholder: "Your town or area — e.g. Manchester", autocomplete: "off",
      value: draft.organizerHome ? draft.organizerHome.label : "" });
    homeWrap.appendChild(orgHome);
    attachSuggest(orgHome, (pl) => { draft.organizerHome = { label: pl.label, lat: pl.lat, lon: pl.lon }; save(); }, "area");
    orgHome.addEventListener("input", () => {
      if (draft.organizerHome && orgHome.value !== draft.organizerHome.label) { draft.organizerHome = null; save(); }
    });
    const orgTransport = el("select", { id: "evOrgTransport" });
    TRANSPORT.forEach(([v, t]) => orgTransport.appendChild(el("option", { value: v, text: t, selected: v === draft.organizerTransport })));
    orgTransport.addEventListener("change", () => { draft.organizerTransport = orgTransport.value; save(); });
    const orgTrain = el("select", { id: "evOrgLastTrain" });
    trainOptions(orgTrain, draft.organizerLastTrain, "No last train");
    orgTrain.addEventListener("change", () => { draft.organizerLastTrain = orgTrain.value; save(); });
    basics.append(
      el("label", { for: "evOrgPhone", text: "Your phone (optional)" }), orgPhone,
      el("label", { for: "evOrgHome", text: "You're coming from" }), homeWrap,
      el("div", { class: "row" }, [
        el("div", {}, [el("label", { for: "evOrgTransport", text: "Getting home" }), orgTransport]),
        el("div", {}, [el("label", { for: "evOrgLastTrain", text: "Your last train" }), orgTrain]),
      ]),
      el("label", { for: "evLastTrain", text: "Last train / tube from the area" }), lastTrain
    );
    app.appendChild(basics);

    // --- Who's coming (drives smart suggest) ---
    const who = el("div", { class: "card", id: "whoCard" });
    who.appendChild(el("h2", { text: "2 · Who's coming" }));
    const sel = (id, options, value, onChange) => {
      const node = el("select", { id });
      options.forEach(([v, t]) => node.appendChild(el("option", { value: v, text: t, selected: String(v) === String(value) })));
      node.addEventListener("change", () => { onChange(node.value); save(); });
      return node;
    };
    const ages = [18, 21, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70].map((a) => [a, String(a)]);
    who.append(
      el("div", { class: "row" }, [
        el("div", {}, [el("label", { for: "whoSize", text: "Roughly how many" }),
          sel("whoSize", [2, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40].map((n) => [n, `${n} people`]), draft.who.size, (v) => { draft.who.size = Number(v); })]),
        el("div", {}, [el("label", { for: "whoStops", text: "How many stops" }),
          sel("whoStops", [2, 3, 4, 5, 6, 7, 8].map((n) => [n, `${n} stops`]), draft.target, (v) => { draft.target = Number(v); drawRoute(); })]),
      ]),
      el("div", { class: "row" }, [
        el("div", {}, [el("label", { for: "whoAgeMin", text: "Ages from" }), sel("whoAgeMin", ages, draft.who.ageMin, (v) => { draft.who.ageMin = Number(v); })]),
        el("div", {}, [el("label", { for: "whoAgeMax", text: "to" }), sel("whoAgeMax", ages, draft.who.ageMax, (v) => { draft.who.ageMax = Number(v); })]),
      ]),
      el("label", { for: "whoVibe", text: "Kind of night" }),
      sel("whoVibe", [["chatty", "Relaxed — somewhere we can talk"], ["mixed", "A bit of both"], ["lively", "Lively — buzz and music"]], draft.who.vibe, (v) => { draft.who.vibe = v; })
    );
    const needs = el("div", { class: "checks", role: "group", "aria-label": "Must have" });
    [["food", "Food"], ["stepFree", "Step-free access"], ["outdoor", "Outdoor space"]].forEach(([k, t]) => {
      const box = el("input", { type: "checkbox", id: `need_${k}`, checked: !!draft.who.needs[k] });
      box.addEventListener("change", () => { draft.who.needs[k] = box.checked; save(); });
      needs.appendChild(el("label", { class: "check", for: `need_${k}` }, [box, t]));
    });
    who.append(el("label", { text: "Must have" }), needs);
    app.appendChild(who);

    // --- Find pubs near a starting point ---
    const find = el("div", { class: "card" });
    find.appendChild(el("h2", { text: "3 · Add stops" }));
    const areaWrap = el("div", { class: "ac" });
    const area = el("input", { id: "evArea", placeholder: "Start near… (e.g. Bank, London or your office)", autocomplete: "off" });
    areaWrap.appendChild(area);
    const results = el("div", { class: "results", id: "pubResults" });
    const suggestBtn = el("button", {
      class: "btn", id: "suggestBtn", disabled: true,
      text: "✨ Suggest a route for this group",
    });
    find.append(
      el("label", { for: "evArea", text: "Pubs & bars near" }), areaWrap,
      el("div", { class: "btns" }, [suggestBtn]),
      el("div", { class: "muted", id: "suggestHint", text: "Pick a starting point, then let the app plan the stops — or add them yourself below." }),
      results
    );
    let pubsFound = [];
    let areaPoint = null;
    let showAll = false;
    const isOnRoute = (p) => draft.stops.some((s) => C.sameStop(s, p));
    const addStop = (p, why) => {
      draft.stops.push({
        id: rid(), name: p.name, lat: p.lat, lon: p.lon, hours: p.hours, kind: p.kind, address: p.address,
        phone: p.phone || "", website: p.website || "", why: why || [],
      });
    };
    function renderResults() {
      results.textContent = "";
      const list = showAll ? pubsFound : pubsFound.slice(0, 8);
      list.forEach((p) => {
        const sched = { ...p, arriveAt: draft.plannedStart };
        const note = hoursNote(sched, draft.date);
        const added = isOnRoute(p);
        const traits = C.scoreVenue(p, draft.who).reasons.filter((r) => r !== "Proper pub" && r !== "Bar");
        results.appendChild(
          el("div", { class: "result" }, [
            el("div", { class: "grow" }, [
              el("div", { class: "name", text: p.name }),
              el("div", { class: "muted", text: `${p.kind === "bar" ? "Bar" : "Pub"} · ${p.dist} m${p.address ? " · " + p.address : ""}` }),
              traits.length ? el("div", { class: "why", text: traits.join(" · ") }) : null,
              el("div", { class: note.bad ? "warn" : "muted", text: note.text }),
            ]),
            // Already on the route: say so, rather than letting it be added
            // again and again.
            el("button", {
              class: "btn sm secondary",
              text: added ? "Added ✓" : "Add",
              disabled: added,
              "aria-label": added ? `${p.name} is already on the route` : `Add ${p.name}`,
              onClick: () => {
                if (isOnRoute(p)) return;
                addStop(p);
                save();
                drawRoute();
                renderResults();
              },
            }),
          ])
        );
      });
      if (!showAll && pubsFound.length > 8) {
        results.appendChild(
          el("button", { class: "btn ghost", text: `Show all ${pubsFound.length}`, onClick: () => { showAll = true; renderResults(); } })
        );
      }
    }
    attachSuggest(area, async (s) => {
      results.textContent = "";
      results.appendChild(el("div", { class: "muted", text: "Finding pubs and bars nearby…" }));
      areaPoint = { lat: s.lat, lon: s.lon };
      showAll = false;
      let data = null;
      try {
        data = (await api(`/api/pubs?lat=${s.lat}&lon=${s.lon}`)).data;
      } catch (e) {
        data = { error: "offline" };
      }
      pubsFound = (data && data.results) || [];
      suggestBtn.disabled = !pubsFound.length;
      if (!pubsFound.length) {
        results.textContent = "";
        results.appendChild(el("div", { class: "muted", text: data && data.error ? "Pub search is busy — try again in a moment." : "No pubs found within ~700 m." }));
        return;
      }
      renderResults();
    });
    suggestBtn.addEventListener("click", () => {
      if (!pubsFound.length || !areaPoint) return;
      if (draft.stops.length && !window.confirm("Replace the stops you've added with a suggested route?")) return;
      const route = C.suggestRoute(pubsFound, areaPoint, draft.who, {
        count: draft.target, date: draft.date, start: draft.plannedStart, dwell: draft.dwell,
      });
      draft.stops = [];
      route.forEach((v) => addStop(v, v.why));
      save();
      drawRoute();
      renderResults();
      toast(route.length < draft.target
        ? `Found ${route.length} good stops nearby — add more by hand if you like`
        : `Planned ${route.length} stops — tweak anything below`);
    });
    // --- Or any place ---
    const anyWrap = el("div", { class: "ac" });
    const anyPlace = el("input", { id: "evAny", placeholder: "Any place — office, restaurant, karaoke…", autocomplete: "off" });
    anyWrap.appendChild(anyPlace);
    find.append(el("label", { for: "evAny", text: "Or add any place" }), anyWrap);
    attachSuggest(anyPlace, (s) => {
      const place = { name: s.label.split(",")[0], lat: s.lat, lon: s.lon };
      if (isOnRoute(place)) {
        anyPlace.value = "";
        toast(`${place.name} is already on the route`);
        return;
      }
      draft.stops.push({ id: rid(), name: place.name, lat: s.lat, lon: s.lon, hours: "", kind: "place", address: s.label });
      save();
      anyPlace.value = "";
      drawRoute();
      toast(`Added ${s.label.split(",")[0]}`);
    });
    app.appendChild(find);

    // --- The route with times ---
    const route = el("div", { class: "card", id: "routeCard" });
    app.appendChild(route);
    const builderMap = mapCard("builder", "Route map");
    if (builderMap) app.appendChild(builderMap.card);
    // Always-reachable summary + create, instead of a button at the very end.
    const summary = el("div", { class: "createbar-text", id: "createSummary" });
    const createBtn = el("button", { class: "btn", id: "createBtn", text: "Create event & get links" });
    app.appendChild(el("div", { class: "createbar" }, [summary, createBtn]));

    function drawRoute() {
      route.textContent = "";
      const n = draft.stops.length;
      route.appendChild(el("h2", { text: `4 · Route — ${n} of ${draft.target} stop${draft.target === 1 ? "" : "s"}` }));
      if (!draft.stops.length) {
        route.appendChild(el("div", { class: "muted", text: "Add at least two stops." }));
      }
      const sched = C.scheduleStops(draft.stops, draft.plannedStart, draft.dwell);
      const list = el("ol", { class: "stops" });
      sched.forEach((s, i) => {
        const note = hoursNote(s, draft.date);
        const walk = i > 0 ? C.walkMinutes(sched[i - 1], s) : 0;
        list.appendChild(
          el("li", { class: "stop" }, [
            el("div", { class: "dot" }),
            el("div", { class: "grow" }, [
              el("div", { class: "name", text: `${i + 1}. ${s.name}` }),
              el("div", { class: "note", text: i ? `🚶 ${walk} min from ${sched[i - 1].name}` : "Start here" }),
              s.why && s.why.length ? el("div", { class: "why", text: `Why: ${s.why.join(" · ")}` }) : null,
              el("div", { class: note.bad ? "warn" : "note", text: note.text }),
            ]),
            el("div", {}, [
              el("div", { class: "time", text: `${s.arriveAt}–${s.leaveAt}` }),
              el("div", { class: "mini" }, [
                el("button", { class: "btn ghost sm", "aria-label": `Move ${s.name} up`, text: "↑", disabled: i === 0, onClick: () => move(i, -1) }),
                el("button", { class: "btn ghost sm", "aria-label": `Move ${s.name} down`, text: "↓", disabled: i === sched.length - 1, onClick: () => move(i, 1) }),
                el("button", { class: "btn ghost sm", "aria-label": `Remove ${s.name}`, text: "✕", onClick: () => { draft.stops.splice(i, 1); save(); drawRoute(); } }),
              ]),
            ]),
          ])
        );
      });
      route.appendChild(list);
      // Getting home: does the plan run past the area's last train?
      const over = C.pastLastTrain(sched, draft.lastTrain);
      if (over > 0) {
        route.appendChild(el("div", { class: "warn", id: "lastTrainWarn",
          text: `🚆 Ends at ${sched[sched.length - 1].leaveAt} — after the last train (${draft.lastTrain}). Drop a stop, start earlier, or plan taxis.` }));
      }
      if ((draft.who.size || 0) >= C.BOOK_AHEAD_AT && sched.length) {
        route.appendChild(el("div", { class: "note", style: "margin-top:6px",
          text: `👥 ${draft.who.size} people — most pubs can't seat that many walk-ins together. You can track bookings stop by stop after creating.` }));
      }
      createBtn.disabled = draft.stops.length < 2;
      summary.textContent = sched.length
        ? `${sched.length} stop${sched.length === 1 ? "" : "s"} · ${sched[0].arriveAt}–${sched[sched.length - 1].leaveAt}`
        : "No stops yet";
      updateMap("builder", sched);
    }
    function move(i, d) {
      const [s] = draft.stops.splice(i, 1);
      draft.stops.splice(i + d, 0, s);
      save();
      drawRoute();
    }
    drawRoute();

    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      const record = {
        name: draft.name.trim() || "Evening out",
        organizer: draft.organizer.trim(),
        organizerPhone: draft.organizerPhone.trim(),
        organizerHome: draft.organizerHome,
        organizerTransport: draft.organizerTransport,
        organizerLastTrain: draft.organizerLastTrain,
        lastTrain: draft.lastTrain,
        date: draft.date,
        plannedStart: draft.plannedStart,
        finalStart: "",
        dwell: draft.dwell,
        stops: draft.stops,
        status: { phase: "planning", stop: -1, state: "at", since: null },
        log: [],
      };
      let res;
      try {
        res = await api("/api/live/create", { record });
      } catch (e) {
        res = { ok: false, status: 0 };
      }
      const { ok, data, status } = res;
      if (!ok) {
        // Say why, rather than a generic failure.
        toast(status === 429 ? "You've created a lot of events in the last hour — try again a bit later"
          : status === 0 ? "No connection — check your signal and try again"
          : "Couldn't create the event — try again");
        createBtn.disabled = false;
        return;
      }
      store.set(`crawl:host:${data.id}`, { key: data.key, record: stripPeople(data.record || record), people: [] });
      store.set("crawl:draft", null);
      location.hash = `e=${data.id}&k=${data.key}`;
    });
  }

  // =========================================================================
  // Event view (host or guest) — live
  // =========================================================================
  let pollTimer = null;
  let live = null; // last record from the server
  let ctx = null; // { id, key? }

  function parseHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    return { id: h.get("e") || "", key: h.get("k") || "" };
  }

  let offline = false;
  let lastOk = 0;
  async function refresh() {
    let res;
    try {
      res = await api(`/api/live?id=${encodeURIComponent(ctx.id)}`);
    } catch (e) {
      // Bad signal in a pub is normal: keep showing the last known state,
      // say how old it is, and keep trying.
      offline = true;
      renderEvent();
      return;
    }
    offline = false;
    const { ok, status, data } = res;
    if (ok) {
      lastOk = Date.now();
      live = data;
      if (ctx.key) {
        const h = store.get(`crawl:host:${ctx.id}`) || { key: ctx.key };
        h.record = stripPeople(data);
        h.people = data.people;
        store.set(`crawl:host:${ctx.id}`, h);
      }
    } else if (status === 404 && ctx.key) {
      // The server forgot (restart). The host's phone is the source of truth:
      // put it back, guests included.
      const h = store.get(`crawl:host:${ctx.id}`);
      if (h && h.record) {
        const r = await api("/api/live/update", {
          id: ctx.id, key: ctx.key, record: h.record, people: h.people || [], rev: h.record.rev || 0,
        });
        if (r.ok) live = r.data;
      }
    } else if (status === 404) {
      live = live || { missing: true };
    }
    renderEvent();
  }

  function stripPeople(rec) {
    const r = { ...rec };
    delete r.people;
    delete r.serverTime;
    delete r.rev;
    return r;
  }

  async function hostUpdate(mutate, retried) {
    const record = stripPeople(live);
    mutate(record);
    let res;
    try {
      res = await api("/api/live/update", {
        id: ctx.id, key: ctx.key, record, people: live.people || [], rev: live.rev,
      });
    } catch (e) {
      toast("No signal — try again in a moment");
      return;
    }
    const { ok, data, status } = res;
    if (status === 409 && data && data.current && !retried) {
      // A co-host changed it first: start from their version, not ours.
      live = data.current;
      toast("Your co-host just updated the plan — refreshed");
      renderEvent(true);
      return;
    }
    if (!ok) {
      toast(status === 403 ? "This link can't change the plan" : "Couldn't update — try again");
      return;
    }
    live = data;
    const h = store.get(`crawl:host:${ctx.id}`) || { key: ctx.key };
    h.record = stripPeople(data);
    h.people = data.people;
    store.set(`crawl:host:${ctx.id}`, h);
    renderEvent();
  }

  async function savePerson(person) {
    let res;
    try {
      res = await api("/api/live/person", { id: ctx.id, person });
    } catch (e) {
      toast("No signal — try again in a moment");
      return false;
    }
    const { ok, data, status } = res;
    if (!ok) {
      toast(status === 404 ? "The organiser's event isn't live yet — try again shortly" : "Couldn't save — try again");
      return false;
    }
    live = data;
    store.set(`crawl:me:${ctx.id}`, person);
    renderEvent();
    return true;
  }

  function startEvent() {
    ctx = parseHash();
    // The co-host key shouldn't sit in the address bar (or browser history)
    // once it's stored: keep it on this device, show #e=ID only.
    if (ctx.key) {
      const h = store.get(`crawl:host:${ctx.id}`) || {};
      h.key = ctx.key;
      store.set(`crawl:host:${ctx.id}`, h);
      history.replaceState(null, "", `${location.pathname}#e=${ctx.id}`);
    } else {
      const h = store.get(`crawl:host:${ctx.id}`);
      if (h && h.key) ctx.key = h.key;
    }
    clearInterval(pollTimer);
    refresh();
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
  }

  let lastSig = "";
  let lastWhere = "";
  function renderEvent(force) {
    const app = $("#app");
    // Only rebuild when something changed. Rebuilding every 15 s wiped what a
    // guest was typing, their scroll position and keyboard focus.
    const sig = JSON.stringify([live && { ...live, serverTime: 0 }, offline]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    // ...and if it did change, carry the guest's half-filled form across.
    const keep = {};
    // The "where to find us" box belongs to one stop: carry a half-typed note
    // across a refresh only while the group is still at that same stop.
    const where = live && live.status ? `${live.status.phase}|${live.status.stop}|${live.status.state}` : "";
    const keepIds = ["meName", "meFrom", "meUntil", "meTransport", "meLastTrain", "meHome"];
    if (where === lastWhere) keepIds.push("spotInput");
    lastWhere = where;
    keepIds.forEach((id) => {
      const n = document.getElementById(id);
      if (n) keep[id] = n.value;
    });
    const focused = document.activeElement && document.activeElement.id;
    app.textContent = "";
    if (!live || live.missing) {
      app.appendChild(
        el("div", { class: "card" }, [
          el("h2", { text: live ? "Waiting for the organiser…" : "Loading…" }),
          el("div", { class: "muted", text: "This event will appear as soon as the organiser's phone is online." }),
        ])
      );
      return;
    }
    const isHost = !!ctx.key;
    const sched = scheduleOf(live);
    const me = store.get(`crawl:me:${ctx.id}`);
    $("#topSub").textContent = `${live.name}${live.organizer ? " · by " + live.organizer : ""}`;

    if (offline) {
      const at = lastOk ? new Date(lastOk).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
      app.appendChild(el("div", { class: "offline", role: "status", text: `📶 Can't reach the server — showing what we knew at ${at}. Retrying…` }));
    }
    app.appendChild(statusBanner(live, sched));
    const planning = live.status.phase === "planning";
    // Right after creating it, sharing the link is the organiser's only job.
    if (isHost && planning) app.appendChild(linksCard());
    if (isHost) app.appendChild(hostControls(live, sched));
    else app.appendChild(guestPanel(live, sched, me));
    const liveMap = mapCard("event", "Map");
    if (liveMap) app.appendChild(liveMap.card);
    app.appendChild(trackerCard(live, sched, isHost));
    app.appendChild(peopleCard(live, sched, isHost));
    if (isHost && !planning) app.appendChild(linksCard());
    const st = live.status;
    updateMap("event", sched, (i) => {
      if (st.phase === "planning") return "";
      if (i < st.stop || (i === st.stop && (st.state === "moving" || st.phase === "done"))) return "done";
      if (i === st.stop) return "here";
      if (i === st.stop + 1) return "next";
      return "";
    });
    Object.entries(keep).forEach(([id, v]) => {
      const n = document.getElementById(id);
      if (n) n.value = v;
    });
    if (focused && document.getElementById(focused)) document.getElementById(focused).focus();
  }

  function statusBanner(rec, sched) {
    const st = rec.status;
    // The one place that announces changes to screen readers.
    const box = el("div", { class: "status", id: "statusBanner", role: "status", "aria-live": "polite" });
    const d = new Date(rec.date + "T12:00:00");
    const when = Number.isFinite(d.getTime())
      ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
      : "Date to be confirmed";
    if (st.phase === "planning") {
      box.append(
        el("div", { class: "big", text: `${when} · starts ${rec.finalStart || rec.plannedStart}` }),
        el("div", { class: "muted", text: rec.finalStart ? "Start time confirmed." : "Start time not confirmed yet — say when you can make it." })
      );
    } else if (st.phase === "done") {
      box.append(el("div", { class: "big", text: "That's a wrap 🍻" }), el("div", { class: "muted", text: "Get home safe!" }));
    } else {
      const here = sched[st.stop];
      const since = st.since ? new Date(st.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      if (st.state === "moving") {
        const next = sched[st.stop + 1];
        const walk = here && next ? C.walkMinutes(here, next) : 0;
        box.append(
          el("div", { class: "big", text: `🚶 Walking to ${next ? next.name : "the next stop"}` }),
          el("div", { class: "muted", text: `Left ${here ? here.name : ""} at ${since} · about ${walk} min` })
        );
      } else {
        box.append(
          el("div", { class: "big", text: `📍 Now at ${here ? here.name : "?"}` }),
          el("div", { class: "muted", text: `Since ${since}${here && here.address ? " · " + here.address : ""}` })
        );
        if (st.spot) box.appendChild(el("div", { class: "spot", text: `Find us: ${st.spot}` }));
      }
      const target = st.state === "moving" ? sched[st.stop + 1] : here;
      if (target) {
        box.appendChild(
          el("a", {
            class: "btn secondary",
            style: "margin-top:10px",
            target: "_blank",
            rel: "noopener noreferrer",
            href: `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${target.lat},${target.lon}`,
            text: `Directions to ${target.name}`,
          })
        );
      }
    }
    return box;
  }

  function trackerCard(rec, sched, isHost) {
    const card = el("div", { class: "card", id: "tracker" });
    card.appendChild(el("h2", { text: "The route" }));
    const st = rec.status;
    const expected = (rec.people || []).filter((p) => p.status !== "out").length;
    const needBooking = isHost ? C.bookingNeeded(rec.stops, expected) : [];
    if (isHost && needBooking.length) {
      card.appendChild(el("div", { class: "warn", id: "bookWarn",
        text: `👥 ${expected} coming — call ahead or book an area at ${needBooking.length} stop${needBooking.length === 1 ? "" : "s"} below.` }));
    }
    const lastTrainOver = C.pastLastTrain(sched, rec.lastTrain);
    if (lastTrainOver > 0) {
      card.appendChild(el("div", { class: "warn", text: `🚆 The plan ends after the area's last train (${rec.lastTrain}).` }));
    }
    const fmt = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
    const list = el("ol", { class: "stops" });
    sched.forEach((s, i) => {
      let cls = "stop";
      let note = `Planned ${s.arriveAt}–${s.leaveAt}`;
      const entry = (rec.log || []).filter((l) => l.stop === i).pop();
      if (st.phase === "live" || st.phase === "done") {
        if (i < st.stop || (i === st.stop && (st.state === "moving" || st.phase === "done"))) {
          cls += " done";
          note = entry ? `Was here ${fmt(entry.arrived)}–${fmt(entry.left)}` : "Done";
        } else if (i === st.stop) {
          cls += " here";
          note = `HERE NOW · since ${fmt(st.since)}`;
        } else if (i === st.stop + 1) {
          cls += " next";
          note = `Next · ~${C.walkMinutes(sched[i - 1], s)} min walk · planned ${s.arriveAt}`;
        }
      }
      const warn = hoursNote(s, rec.date);
      list.appendChild(
        el("li", { class: cls, "data-stop": i }, [
          el("div", { class: "dot" }),
          el("div", { class: "grow" }, [
            el("div", { class: "name", text: s.name }),
            el("div", { class: "note", text: note }),
            warn.bad ? el("div", { class: "warn", text: warn.text }) : null,
            isHost ? bookingRow(rec, i, needBooking.includes(i)) : null,
          ]),
          el("div", { class: "time", text: s.arriveAt }),
        ])
      );
    });
    card.appendChild(list);
    return card;
  }

  // Booking each stop (organiser / co-host only): status, reference, and a
  // quick way to call or check the venue.
  function bookingRow(rec, i, flagged) {
    const stop = rec.stops[i];
    const b = stop.booking || { status: "none", ref: "" };
    const row = el("div", { class: `booking${flagged ? " flagged" : ""}` });
    const select = el("select", { id: `book_${i}`, "aria-label": `Booking at ${stop.name}` });
    BOOKING.forEach(([v, t]) => select.appendChild(el("option", { value: v, text: t, selected: v === b.status })));
    select.addEventListener("change", () => hostUpdate((r) => {
      r.stops[i].booking = { ...(r.stops[i].booking || {}), status: select.value };
    }));
    row.appendChild(select);
    if (b.status === "booked") {
      const ref = el("input", { id: `bookref_${i}`, placeholder: "Booking name / ref", value: b.ref || "", "aria-label": `Booking reference at ${stop.name}` });
      ref.addEventListener("change", () => hostUpdate((r) => {
        r.stops[i].booking = { ...(r.stops[i].booking || {}), ref: ref.value.trim() };
      }));
      row.appendChild(ref);
    }
    const links = el("div", { class: "booking-links" });
    if (stop.phone) links.appendChild(el("a", { class: "btn ghost sm", href: telHref(stop.phone), text: `📞 ${stop.phone}` }));
    if (stop.website) {
      links.appendChild(el("a", { class: "btn ghost sm", href: stop.website, target: "_blank", rel: "noopener noreferrer", text: "🌐 Website" }));
    }
    if (!stop.phone && !stop.website) links.appendChild(el("span", { class: "muted", text: "No phone or website listed" }));
    row.appendChild(links);
    return row;
  }

  function peopleCard(rec, sched, isHost) {
    const card = el("div", { class: "card", id: "peopleCard" });
    const people = rec.people || [];
    const going = people.filter((p) => p.status !== "out");
    card.appendChild(el("h2", { text: `Who's coming (${going.length})` }));
    if (!people.length) {
      card.appendChild(el("div", { class: "muted", text: "Nobody has replied yet." }));
      return card;
    }
    const label = {
      here: "here", onway: "on the way", coming: "coming", out: "can't make it",
      late: "running late", home: "heading home", safe: "home safe ✓",
    };
    const chips = el("div", { class: "chips" });
    people.forEach((p) => {
      const j = p.status === "out" ? null : C.joinsAt(p, sched);
      // The plan's "joins at" only matters before the night starts.
      const planning = rec.status.phase === "planning";
      const where = !planning || p.status === "out" ? "" : j ? ` · joins at ${sched[j.stopIndex].name}` : " · misses the route";
      const window = p.status === "out" ? "" : ` (${p.from || "?"}–${p.until || "late"})`;
      const eta = p.status === "late" && p.eta ? ` (~${p.eta} min)` : "";
      const shown = ["late", "home", "safe", "here", "onway"].includes(p.status) ? "" : window;
      chips.appendChild(el("span", { class: `chip ${p.status}`, text: `${p.name}: ${label[p.status] || p.status}${eta}${shown}${isHost ? where : ""}` }));
    });
    card.appendChild(chips);

    if (isHost && rec.status.phase === "planning") {
      // Head count per stop + suggested start.
      const counts = C.headcounts(people, sched);
      const max = Math.max(1, ...counts);
      const bars = el("div", { class: "bars" });
      sched.forEach((s, i) =>
        bars.appendChild(
          el("div", { class: "bar" }, [
            el("span", { text: `${s.arriveAt} ${s.name}` }),
            el("span", { text: `${counts[i]} ${counts[i] === 1 ? "person" : "people"}` }),
            el("div", { class: "track" }, [el("div", { class: "fill", style: `width:${(counts[i] / max) * 100}%` })]),
          ])
        )
      );
      card.append(el("label", { text: "Head count at each stop" }), bars);
      const best = C.bestStart(rec.stops, people, rec.plannedStart, rec.dwell);
      const current = rec.finalStart || rec.plannedStart;
      if (best) {
        const nowFirst = counts[0];
        card.appendChild(
          el("div", { class: "muted", style: "margin-top:10px", id: "bestStart",
            text: best.start === current
              ? `✓ ${current} is the best start for who's replied (${best.first} at the first stop).`
              : `Suggested start: ${best.start} — ${best.first} at the first stop (vs ${nowFirst} at ${current}).` })
        );
      }
      // Two explicit choices. "Use 18:45" used to confirm silently and then
      // grey out the Confirm button beside it, which read as broken.
      card.appendChild(
        rec.finalStart
          ? el("div", { class: "muted", style: "margin-top:10px", id: "confirmed", text: `✓ Start confirmed: ${rec.finalStart}` })
          : el("div", { class: "btns" }, [
              best && best.start !== current
                ? el("button", { class: "btn", id: "useBest", text: `Confirm ${best.start} (best for the group)`,
                    onClick: () => hostUpdate((r) => { r.finalStart = best.start; }) })
                : null,
              el("button", { class: best && best.start !== current ? "btn ghost" : "btn", id: "confirmStart",
                text: best && best.start !== current ? `Keep ${current}` : `Confirm ${current}`,
                onClick: () => hostUpdate((r) => { r.finalStart = current; }) }),
            ])
      );
    }
    return card;
  }

  // The "where to find us" box, read at the moment a check-in is tapped.
  const spotNow = () => ((document.getElementById("spotInput") || {}).value || "").trim();
  function hostControls(rec, sched) {
    const card = el("div", { class: "card", id: "hostControls" });
    const st = rec.status;
    card.appendChild(el("h2", { text: "You're hosting" }));
    const btns = el("div", { class: "btns" });
    const now = Date.now();
    if (st.phase === "planning") {
      btns.appendChild(
        el("button", {
          class: "btn", id: "arriveFirst", text: `We've arrived at ${sched[0].name}`,
          onClick: () => hostUpdate((r) => {
            r.status = { phase: "live", stop: 0, state: "at", since: now, spot: spotNow() };
            r.log = [{ stop: 0, arrived: now, left: null }];
          }),
        })
      );
    } else if (st.phase === "live") {
      const last = st.stop >= sched.length - 1;
      if (st.state === "at") {
        btns.appendChild(
          last
            ? el("button", { class: "btn", id: "endNight", text: "End the night", onClick: () => hostUpdate((r) => {
                r.status = { ...r.status, phase: "done", since: now };
                r.log = (r.log || []).map((l) => (l.stop === r.status.stop && !l.left ? { ...l, left: now } : l));
              }) })
            : el("button", { class: "btn", id: "moveOn", text: `Moving on to ${sched[st.stop + 1].name}`, onClick: () => hostUpdate((r) => {
                r.log = (r.log || []).map((l) => (l.stop === r.status.stop && !l.left ? { ...l, left: now } : l));
                r.status = { ...r.status, state: "moving", since: now, spot: "" };
              }) })
        );
      } else {
        btns.appendChild(
          el("button", { class: "btn", id: "arriveNext", text: `We've arrived at ${sched[st.stop + 1].name}`, onClick: () => hostUpdate((r) => {
            const next = r.status.stop + 1;
            r.status = { phase: "live", stop: next, state: "at", since: now, spot: spotNow() };
            r.log = [...(r.log || []), { stop: next, arrived: now, left: null }];
          }) })
        );
      }
    }
    // "Where to find us" goes out with the check-in (and can be updated).
    if (st.phase !== "done") {
      const spot = el("input", { id: "spotInput", placeholder: "Where to find us — e.g. back room, by the fireplace", value: st.phase === "live" && st.state === "at" ? st.spot || "" : "" });
      card.appendChild(el("div", {}, [el("label", { for: "spotInput", text: "Where to find us (optional)" }), spot]));
      if (st.phase === "live" && st.state === "at") {
        btns.appendChild(el("button", { class: "btn ghost", id: "saveSpot", text: "Update note", onClick: () => hostUpdate((r) => { r.status = { ...r.status, spot: spot.value.trim() }; }) }));
      }
    }
    card.appendChild(btns);
    card.appendChild(el("div", { class: "muted", style: "margin-top:8px", text: "Everyone following the link sees this within about 15 seconds." }));
    // Everyone's way home from the last stop — the organiser's included — so
    // a long journey or a missing last train shows up while it can be fixed.
    const lastStop = sched[sched.length - 1];
    const ways = [];
    if (rec.organizerHome) {
      const t = C.homeTrip(lastStop, rec.organizerHome, rec.organizerTransport, rec.organizerLastTrain);
      if (t) ways.push([`${rec.organizer || "You"} (you)`, t]);
    }
    (rec.people || []).filter((pp) => pp.status !== "out" && pp.home).forEach((pp) => {
      const t = C.homeTrip(lastStop, pp.home, pp.transport, pp.lastTrain);
      if (t) ways.push([pp.name, t]);
    });
    if (ways.length) {
      const box = el("div", { class: "safety", id: "waysHome" }, [el("div", { class: "name", text: "Ways home from the last stop" })]);
      ways.forEach(([who, t]) => box.appendChild(el("div", { class: t.warn ? "warn" : "note", text: `${who}: ${t.text}` })));
      card.appendChild(box);
    }
    // Duty of care: who's still out, who's heading home, who's home safe.
    if (st.phase !== "planning") {
      const s = C.safetySummary(rec.people || []);
      const names = (list) => list.map((p) => p.name).join(", ") || "—";
      card.appendChild(el("div", { class: "safety", id: "safetyPanel" }, [
        el("div", { class: "name", text: st.phase === "done" ? "Getting everyone home" : "Getting home" }),
        el("div", { class: "note", text: `Still out: ${names(s.out)}` }),
        el("div", { class: "note", text: `Heading home: ${names(s.headingHome)}` }),
        el("div", { class: "note", text: `Home safe ✓: ${names(s.safe)}` }),
        st.phase === "done" && (s.out.length || s.headingHome.length)
          ? el("div", { class: "warn", text: `Waiting to hear from ${s.out.length + s.headingHome.length} — guests tap "Home safe" on their link.` })
          : null,
      ]));
    }
    return card;
  }

  let pickedHome = null; // the guest's "coming from" pick, survives re-renders
  function guestPanel(rec, sched, me) {
    const card = el("div", { class: "card", id: "guestPanel" });
    if (!me) {
      card.appendChild(el("h2", { text: rec.organizer ? `${rec.organizer} invited you` : "You're invited" }));
      card.appendChild(el("div", { class: "muted", text: "Say when you can make it — you can join the group at any stop." }));
      const name = el("input", { id: "meName", placeholder: "Your first name", autocomplete: "given-name" });
      const from = el("select", { id: "meFrom" });
      timeOptions(from, rec.finalStart || rec.plannedStart);
      const until = el("select", { id: "meUntil" });
      timeOptions(until, "", true);
      const transport = el("select", { id: "meTransport" });
      TRANSPORT.forEach(([v, t]) => transport.appendChild(el("option", { value: v, text: t })));
      const myTrain = el("select", { id: "meLastTrain" });
      trainOptions(myTrain, "", "No last train");
      const homeWrap = el("div", { class: "ac" });
      const myHome = el("input", { id: "meHome", placeholder: "Town or area — so we can check your way home", autocomplete: "off" });
      homeWrap.appendChild(myHome);
      attachSuggest(myHome, (pl) => { pickedHome = { label: pl.label, lat: pl.lat, lon: pl.lon }; }, "area");
      myHome.addEventListener("input", () => {
        if (pickedHome && myHome.value !== pickedHome.label) pickedHome = null;
      });
      card.append(
        el("label", { for: "meName", text: "Name" }), name,
        el("div", { class: "row" }, [
          el("div", {}, [el("label", { for: "meFrom", text: "I can be there from" }), from]),
          el("div", {}, [el("label", { for: "meUntil", text: "Until" }), until]),
        ]),
        el("label", { for: "meHome", text: "Coming from" }), homeWrap,
        el("div", { class: "row" }, [
          el("div", {}, [el("label", { for: "meTransport", text: "Getting home" }), transport]),
          el("div", {}, [el("label", { for: "meLastTrain", text: "My last train" }), myTrain]),
        ])
      );
      const join = (status) => {
        if (!name.value.trim()) {
          toast("Add your name first");
          name.focus();
          return;
        }
        savePerson({
          id: rid(), token: rid() + rid() + rid(), name: name.value.trim(), from: from.value, until: until.value, status,
          transport: transport.value, lastTrain: myTrain.value, home: pickedHome,
        }).then((ok) => {
          if (ok) toast(status === "out" ? "Thanks — the organiser will see you can't make it" : "You're on the list 🍻");
        });
      };
      card.appendChild(
        el("div", { class: "btns" }, [
          el("button", { class: "btn", id: "meIn", text: "I'm in", onClick: () => join("coming") }),
          el("button", { class: "btn ghost", id: "meOut", text: "Can't make it", onClick: () => join("out") }),
        ])
      );
      card.appendChild(
        el("div", { class: "muted", style: "margin-top:10px",
          text: "🔒 Everyone with this link sees first names, times and which stop the group is at — never anyone's location. The event is deleted after 2 days." })
      );
      return card;
    }
    const j = me.status === "out" ? null : C.joinsAt(me, sched);
    const st = rec.status;
    // Once the night is under way, the plan is history: say where the group
    // actually is. "You'll catch them at Core" after they'd left Core sent a
    // late joiner to an empty pub.
    let line;
    if (me.status === "out") line = "You said you can't make it.";
    else if (me.status === "here") line = "You're with the group 🍻";
    else if (st.phase === "live" && st.state === "moving" && sched[st.stop + 1]) line = `The group is walking to ${sched[st.stop + 1].name} — head there.`;
    else if (st.phase === "live" && sched[st.stop]) line = `The group is at ${sched[st.stop].name} right now — join them there.`;
    else if (st.phase === "done") line = "The night's over.";
    else if (j) line = `You'll probably catch the group at ${sched[j.stopIndex].name} (planned ${sched[j.stopIndex].arriveAt}).`;
    else line = "Your times miss the planned route — the organiser will see that.";
    if (me.status === "late") line = `You're running late${me.eta ? ` (~${me.eta} min)` : ""} — ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
    if (me.status === "home") line = "Heading home — tap Home safe when you're in.";
    if (me.status === "safe") line = "Home safe ✓ — thanks for letting everyone know.";
    card.appendChild(el("h2", { text: `Hi ${me.name}` }));
    card.appendChild(el("div", { class: "muted", text: line }));
    const set = (status, msg, extra) => savePerson({ ...me, status, ...(extra || {}) }).then((ok) => ok && toast(msg));

    // The night card: everything a guest needs in one place, on the night.
    const going = me.status !== "out";
    if (going && (st.phase === "live" || st.phase === "done")) {
      const target = st.state === "moving" ? sched[st.stop + 1] : sched[st.stop];
      const info = el("div", { class: "nightcard", id: "nightCard" });
      if (target && st.phase === "live") {
        // Node.append() would print a null as the text "null" — skip empties.
        [
          el("div", { class: "name", text: `${st.state === "moving" ? "Heading to" : "At"} ${target.name}` }),
          target.address ? el("div", { class: "note", text: target.address }) : null,
          st.state === "at" && st.spot ? el("div", { class: "spot", text: `Find us: ${st.spot}` }) : null,
        ].forEach((n) => n && info.appendChild(n));
      }
      const trip = C.homeTrip(sched[sched.length - 1], me.home, me.transport, me.lastTrain);
      const leave = C.leaveBy(me.lastTrain);
      if (trip) info.appendChild(el("div", { class: trip.warn ? "warn" : "note", text: `🏠 ${trip.text}` }));
      else if (leave) info.appendChild(el("div", { class: "note", text: `🚆 Leave by ${leave} for your ${me.lastTrain} train` }));
      if (rec.organizerPhone) {
        info.appendChild(el("a", { class: "btn ghost sm", href: telHref(rec.organizerPhone), text: `📞 Call ${rec.organizer || "the organiser"}` }));
      }
      card.appendChild(info);
    } else if (going && C.leaveBy(me.lastTrain)) {
      card.appendChild(el("div", { class: "note", text: `🚆 On the night: leave by ${C.leaveBy(me.lastTrain)} for your ${me.lastTrain} train.` }));
    }

    // Actions for the night, kept in a sticky bar so they're always in reach.
    if (going && st.phase === "live") {
      const eta = el("select", { id: "meEta", "aria-label": "How late" });
      [15, 30, 45, 60].forEach((m) => eta.appendChild(el("option", { value: m, text: `~${m} min`, selected: m === (me.eta || 30) })));
      card.appendChild(el("div", { class: "guestbar" }, [
        el("button", { class: "btn secondary", id: "meOnWay", text: "🚶 On my way", disabled: me.status === "onway", onClick: () => set("onway", "The group knows you're coming") }),
        el("button", { class: "btn", id: "meHere", text: "📍 I'm here", disabled: me.status === "here", onClick: () => set("here", "Welcome! 🍻") }),
        el("div", { class: "late" }, [
          eta,
          el("button", { class: "btn ghost", id: "meLate", text: "⏰ Running late", onClick: () => set("late", "The group knows you're running late", { eta: Number(eta.value) }) }),
        ]),
        el("button", { class: "btn ghost", id: "meHome", text: "🏠 Heading home", disabled: me.status === "home" || me.status === "safe", onClick: () => set("home", "Get home safe — tap Home safe when you're in") }),
      ]));
    }
    if (going && (me.status === "home" || st.phase === "done")) {
      card.appendChild(el("div", { class: "btns" }, [
        el("button", { class: "btn", id: "meSafe", text: me.status === "safe" ? "Home safe ✓" : "✅ I'm home safe", disabled: me.status === "safe", onClick: () => set("safe", "Thanks — the organiser can see you're home") }),
      ]));
    }
    card.appendChild(
      el("div", { class: "btns" }, [
        me.status === "out"
          ? el("button", { class: "btn ghost sm", text: "Actually, I can come", onClick: () => set("coming", "You're back on the list") })
          : el("button", { class: "btn ghost sm", id: "meCant", text: "Can't make it after all", onClick: () => set("out", "Thanks for letting them know") }),
      ])
    );
    return card;
  }

  function linksCard() {
    const card = el("div", { class: "card", id: "linksCard" });
    const base = location.origin + location.pathname;
    const guest = `${base}#e=${ctx.id}`;
    const cohost = `${base}#e=${ctx.id}&k=${ctx.key}`;
    const row = (id, label, url, hint) => {
      const input = el("input", { id, value: url, readonly: true });
      return el("div", {}, [
        el("label", { for: id, text: label }),
        el("div", { class: "linkbox" }, [
          input,
          el("button", {
            class: "btn sm secondary", text: "Copy", id: `${id}Copy`,
            onClick: (e) => copyText(url, input, e.currentTarget),
          }),
          // Phones: straight into WhatsApp / Messages / email.
          navigator.share
            ? el("button", {
                class: "btn sm secondary", text: "Share…",
                onClick: () => navigator.share({ title: live ? live.name : "Evening out", url }).catch(() => {}),
              })
            : null,
        ]),
        el("div", { class: "muted", text: hint }),
      ]);
    };
    card.append(
      el("h2", { text: "Share" }),
      row("guestLink", "Invite link — for everyone", guest, "People say when they can come and follow the group on the night."),
      row("cohostLink", "Co-host link — keep it private", cohost, "Can move the group along. Give it to one or two people in case you leave early.")
    );
    return card;
  }

  // =========================================================================
  function route() {
    clearInterval(pollTimer);
    live = null;
    const h = parseHash();
    if (h.id) startEvent();
    else renderBuilder();
  }
  window.addEventListener("hashchange", route);
  route();
})();
