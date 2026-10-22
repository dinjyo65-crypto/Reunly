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
  function attachSuggest(input, onPick) {
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
        const { data } = await api(`/api/geosuggest?q=${encodeURIComponent(q)}`);
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

  const nextThursday = () => {
    const d = new Date();
    d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7));
    return d.toISOString().slice(0, 10);
  };

  function timeOptions(select, value, allowBlank) {
    if (allowBlank) select.appendChild(el("option", { value: "", text: "All night" }));
    for (let m = 16 * 60; m <= 26 * 60; m += 15) {
      const t = C.toHHMM(m);
      select.appendChild(el("option", { value: t, text: t, selected: t === value }));
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
    const draft = store.get("crawl:draft") || {
      name: "", organizer: "", date: nextThursday(), plannedStart: "17:30", dwell: 50, stops: [],
    };
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
    app.appendChild(basics);

    // --- Find pubs near a starting point ---
    const find = el("div", { class: "card" });
    find.appendChild(el("h2", { text: "2 · Add stops" }));
    const areaWrap = el("div", { class: "ac" });
    const area = el("input", { id: "evArea", placeholder: "Start near… (e.g. Bank, London or your office)", autocomplete: "off" });
    areaWrap.appendChild(area);
    const results = el("div", { class: "results", id: "pubResults" });
    find.append(el("label", { for: "evArea", text: "Pubs & bars near" }), areaWrap, results);
    attachSuggest(area, async (s) => {
      results.textContent = "";
      results.appendChild(el("div", { class: "muted", text: "Finding pubs and bars nearby…" }));
      const { data } = await api(`/api/pubs?lat=${s.lat}&lon=${s.lon}`);
      results.textContent = "";
      const pubs = (data && data.results) || [];
      if (!pubs.length) {
        results.appendChild(el("div", { class: "muted", text: data && data.error ? "Pub search is busy — try again in a moment." : "No pubs found within ~700 m." }));
        return;
      }
      pubs.forEach((p) => {
        const sched = { ...p, arriveAt: draft.plannedStart };
        const note = hoursNote(sched, draft.date);
        results.appendChild(
          el("div", { class: "result" }, [
            el("div", { class: "grow" }, [
              el("div", { class: "name", text: p.name }),
              el("div", { class: "muted", text: `${p.kind === "bar" ? "Bar" : "Pub"} · ${p.dist} m${p.address ? " · " + p.address : ""}` }),
              el("div", { class: note.bad ? "warn" : "muted", text: note.text }),
            ]),
            el("button", {
              class: "btn sm secondary",
              text: "Add",
              onClick: () => {
                draft.stops.push({ id: rid(), name: p.name, lat: p.lat, lon: p.lon, hours: p.hours, kind: p.kind, address: p.address });
                save();
                drawRoute();
                toast(`Added ${p.name}`);
              },
            }),
          ])
        );
      });
    });
    // --- Or any place ---
    const anyWrap = el("div", { class: "ac" });
    const anyPlace = el("input", { id: "evAny", placeholder: "Any place — office, restaurant, karaoke…", autocomplete: "off" });
    anyWrap.appendChild(anyPlace);
    find.append(el("label", { for: "evAny", text: "Or add any place" }), anyWrap);
    attachSuggest(anyPlace, (s) => {
      draft.stops.push({ id: rid(), name: s.label.split(",")[0], lat: s.lat, lon: s.lon, hours: "", kind: "place", address: s.label });
      save();
      anyPlace.value = "";
      drawRoute();
      toast(`Added ${s.label.split(",")[0]}`);
    });
    app.appendChild(find);

    // --- The route with times ---
    const route = el("div", { class: "card", id: "routeCard" });
    app.appendChild(route);
    const createBtn = el("button", { class: "btn", id: "createBtn", text: "Create event & get links" });
    app.appendChild(createBtn);

    function drawRoute() {
      route.textContent = "";
      route.appendChild(el("h2", { text: `3 · Route (${draft.stops.length} stop${draft.stops.length === 1 ? "" : "s"})` }));
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
              el("div", { class: "name", text: s.name }),
              el("div", { class: "note", text: i ? `🚶 ${walk} min from ${sched[i - 1].name}` : "Start here" }),
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
      createBtn.disabled = draft.stops.length < 2;
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
        date: draft.date,
        plannedStart: draft.plannedStart,
        finalStart: "",
        dwell: draft.dwell,
        stops: draft.stops,
        status: { phase: "planning", stop: -1, state: "at", since: null },
        log: [],
      };
      const { ok, data } = await api("/api/live/create", { record });
      if (!ok) {
        toast("Couldn't create the event — try again");
        createBtn.disabled = false;
        return;
      }
      store.set(`crawl:host:${data.id}`, { key: data.key, record, people: [] });
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

  async function refresh() {
    const { ok, status, data } = await api(`/api/live?id=${encodeURIComponent(ctx.id)}`);
    if (ok) {
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
        const r = await api("/api/live/update", { id: ctx.id, key: ctx.key, record: h.record, people: h.people || [] });
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
    return r;
  }

  async function hostUpdate(mutate) {
    const record = stripPeople(live);
    mutate(record);
    const { ok, data, status } = await api("/api/live/update", {
      id: ctx.id, key: ctx.key, record, people: live.people || [],
    });
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
    const { ok, data, status } = await api("/api/live/person", { id: ctx.id, person });
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
    clearInterval(pollTimer);
    refresh();
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
  }

  function renderEvent() {
    const app = $("#app");
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

    app.appendChild(statusBanner(live, sched));
    if (isHost) app.appendChild(hostControls(live, sched));
    else app.appendChild(guestPanel(live, sched, me));
    app.appendChild(trackerCard(live, sched));
    app.appendChild(peopleCard(live, sched, isHost));
    if (isHost) app.appendChild(linksCard());
  }

  function statusBanner(rec, sched) {
    const st = rec.status;
    const box = el("div", { class: "status", id: "statusBanner" });
    const when = new Date(rec.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
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

  function trackerCard(rec, sched) {
    const card = el("div", { class: "card", id: "tracker" });
    card.appendChild(el("h2", { text: "The route" }));
    const st = rec.status;
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
          ]),
          el("div", { class: "time", text: s.arriveAt }),
        ])
      );
    });
    card.appendChild(list);
    return card;
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
    const label = { here: "here", onway: "on the way", coming: "coming", out: "can't make it" };
    const chips = el("div", { class: "chips" });
    people.forEach((p) => {
      const j = p.status === "out" ? null : C.joinsAt(p, sched);
      // The plan's "joins at" only matters before the night starts.
      const planning = rec.status.phase === "planning";
      const where = !planning || p.status === "out" ? "" : j ? ` · joins at ${sched[j.stopIndex].name}` : " · misses the route";
      const window = p.status === "out" ? "" : ` (${p.from || "?"}–${p.until || "late"})`;
      chips.appendChild(el("span", { class: `chip ${p.status}`, text: `${p.name}: ${label[p.status]}${window}${isHost ? where : ""}` }));
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
            r.status = { phase: "live", stop: 0, state: "at", since: now };
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
                r.status = { ...r.status, state: "moving", since: now };
              }) })
        );
      } else {
        btns.appendChild(
          el("button", { class: "btn", id: "arriveNext", text: `We've arrived at ${sched[st.stop + 1].name}`, onClick: () => hostUpdate((r) => {
            const next = r.status.stop + 1;
            r.status = { phase: "live", stop: next, state: "at", since: now };
            r.log = [...(r.log || []), { stop: next, arrived: now, left: null }];
          }) })
        );
      }
    }
    card.appendChild(btns);
    card.appendChild(el("div", { class: "muted", style: "margin-top:8px", text: "Everyone following the link sees this within about 15 seconds." }));
    return card;
  }

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
      card.append(
        el("label", { for: "meName", text: "Name" }), name,
        el("div", { class: "row" }, [
          el("div", {}, [el("label", { for: "meFrom", text: "I can be there from" }), from]),
          el("div", {}, [el("label", { for: "meUntil", text: "Until" }), until]),
        ])
      );
      const join = (status) => {
        if (!name.value.trim()) {
          toast("Add your name first");
          name.focus();
          return;
        }
        savePerson({ id: rid(), name: name.value.trim(), from: from.value, until: until.value, status }).then((ok) => {
          if (ok) toast(status === "out" ? "Thanks — the organiser will see you can't make it" : "You're on the list 🍻");
        });
      };
      card.appendChild(
        el("div", { class: "btns" }, [
          el("button", { class: "btn", id: "meIn", text: "I'm in", onClick: () => join("coming") }),
          el("button", { class: "btn ghost", id: "meOut", text: "Can't make it", onClick: () => join("out") }),
        ])
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
    card.appendChild(el("h2", { text: `Hi ${me.name}` }));
    card.appendChild(el("div", { class: "muted", text: line }));
    const set = (status, msg) => savePerson({ ...me, status }).then((ok) => ok && toast(msg));
    if (rec.status.phase === "live" && me.status !== "out") {
      card.appendChild(
        el("div", { class: "btns" }, [
          el("button", { class: "btn secondary", id: "meOnWay", text: "🚶 On my way", disabled: me.status === "onway", onClick: () => set("onway", "The group knows you're coming") }),
          el("button", { class: "btn", id: "meHere", text: "📍 I'm here", disabled: me.status === "here", onClick: () => set("here", "Welcome! 🍻") }),
        ])
      );
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
            class: "btn sm secondary", text: "Copy",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(url);
                toast("Copied");
              } catch (e) {
                input.select();
              }
            },
          }),
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
