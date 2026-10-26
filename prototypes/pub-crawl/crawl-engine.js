/*
 * crawl-engine.js — pure logic for the v0.9 pub-crawl / work-social prototype.
 * No DOM. Loaded by the page as window.CrawlEngine and by node --test.
 *
 * Times are "HH:MM" on the event's day. Evening events run past midnight, so
 * internally everything is minutes from 00:00 of the event day and a time
 * earlier than EARLY_MORNING (06:00) counts as the next morning (01:30 = 25:30).
 */
(function (root) {
  "use strict";

  const EARLY_MORNING = 6 * 60;
  const WALK_MPH = 3;
  const ROAD_FACTOR = 1.3; // streets are longer than the straight line
  const EARTH_RADIUS_MI = 3958.8;

  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 24 || min > 59) return null;
    const t = h * 60 + min;
    return t < EARLY_MORNING ? t + 24 * 60 : t;
  }

  function toHHMM(min) {
    const t = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }

  function milesBetween(a, b) {
    if (!a || !b) return null;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
  }

  /** Walking minutes between two stops, rounded up to the next 5. */
  function walkMinutes(a, b) {
    const mi = milesBetween(a, b);
    if (mi == null) return 0;
    return Math.ceil(((mi * ROAD_FACTOR) / WALK_MPH) * 60 / 5) * 5;
  }

  /**
   * Planned arrival/leave for every stop, from a start time, minutes spent at
   * each stop, and walking time between consecutive stops.
   */
  function scheduleStops(stops, startHHMM, dwellMin) {
    let t = toMin(startHHMM);
    if (t == null) return [];
    return stops.map((s, i) => {
      if (i > 0) t += walkMinutes(stops[i - 1], s);
      const arrive = t;
      const leave = t + dwellMin;
      t = leave;
      return { ...s, arrive, leave, arriveAt: toHHMM(arrive), leaveAt: toHHMM(leave) };
    });
  }

  /** Someone's window as minutes; "until" missing means "all night". */
  function windowOf(p) {
    const from = toMin(p.from);
    const until = p.until ? toMin(p.until) : Infinity;
    if (from == null) return null;
    return { from, until: until == null ? Infinity : until };
  }

  /**
   * Which stop each person will catch the group at, given their window.
   * Returns { stopIndex, late } or null if their window misses every stop.
   */
  function joinsAt(person, schedule) {
    const w = windowOf(person);
    if (!w) return null;
    for (let i = 0; i < schedule.length; i++) {
      const s = schedule[i];
      // They catch this stop if they arrive before the group leaves it and
      // haven't had to go home before the group gets there.
      if (w.from < s.leave && w.until > s.arrive) {
        return { stopIndex: i, late: w.from > s.arrive };
      }
    }
    return null;
  }

  /** Head count at each stop: everyone whose window overlaps it. */
  function headcounts(people, schedule) {
    return schedule.map((s) =>
      people.filter((p) => {
        if (p.status === "out") return false;
        const w = windowOf(p);
        return w && w.from < s.leave && w.until > s.arrive;
      }).length
    );
  }

  /**
   * The start time (15-minute steps, within ±range of the planned start) that
   * gets the most person-stops, tie-broken by most people at the first stop,
   * then by staying closest to what the organiser planned.
   */
  function bestStart(stops, people, plannedStart, dwellMin, rangeMin = 120) {
    const planned = toMin(plannedStart);
    if (planned == null || !stops.length) return null;
    let best = null;
    for (let d = -rangeMin; d <= rangeMin; d += 15) {
      const start = toHHMM(planned + d);
      const sched = scheduleStops(stops, start, dwellMin);
      const counts = headcounts(people, sched);
      const total = counts.reduce((a, b) => a + b, 0);
      const cand = { start, total, first: counts[0], counts, shift: Math.abs(d) };
      if (
        !best ||
        cand.total > best.total ||
        (cand.total === best.total && cand.first > best.first) ||
        (cand.total === best.total && cand.first === best.first && cand.shift < best.shift)
      ) {
        best = cand;
      }
    }
    return best;
  }

  // ---- Opening hours (the common subset of OSM's opening_hours syntax) ----
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  function expandDays(spec) {
    const out = new Set();
    for (const part of spec.split(",")) {
      const [a, b] = part.trim().split("-");
      const i = DAYS.indexOf(a);
      if (i < 0) return null;
      if (!b) {
        out.add(i);
        continue;
      }
      const j = DAYS.indexOf(b);
      if (j < 0) return null;
      for (let k = i; ; k = (k + 1) % 7) {
        out.add(k);
        if (k === j) break;
      }
    }
    return out;
  }

  /**
   * Is a place open on `isoDate` at `hhmm` (evening times past midnight
   * belong to the evening that started on isoDate)? Returns true / false /
   * null when the hours are missing or in a form we don't understand —
   * "unknown" must never be shown as "closed".
   */
  function isOpenAt(hours, isoDate, hhmm) {
    if (!hours) return null;
    const text = String(hours).trim();
    if (text === "24/7") return true;
    const t = toMin(hhmm);
    const date = Date.parse(isoDate + "T12:00:00Z");
    if (t == null || !Number.isFinite(date)) return null;
    const evening = (new Date(date).getUTCDay() + 6) % 7; // Mo = 0
    // A time past midnight is on the next calendar day.
    const day = t >= 1440 ? (evening + 1) % 7 : evening;
    const clock = t % 1440;
    const prevDay = (day + 6) % 7;

    // OSM semantics: later rules override earlier ones for the days they name.
    const byDay = new Map();
    for (const raw of text.split(";")) {
      const rule = raw.trim();
      if (!rule) continue;
      const m = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)?\s*(.*)$/.exec(rule);
      if (!m) return null;
      const days = m[1] ? expandDays(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
      if (!days) return null;
      const body = m[2].trim();
      let ranges;
      if (body === "off" || body === "closed") ranges = [];
      else {
        ranges = [];
        for (const r of body.split(",")) {
          const rm = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/.exec(r.trim());
          if (!rm) return null; // PH, sunrise, week numbers… → unknown
          const open = Number(rm[1]) * 60 + Number(rm[2]);
          let close = Number(rm[3]) * 60 + Number(rm[4]);
          if (close <= open) close += 1440; // runs past midnight
          ranges.push([open, close]);
        }
      }
      days.forEach((d) => byDay.set(d, ranges));
    }
    const today = byDay.get(day);
    const yesterday = byDay.get(prevDay);
    if (!byDay.size) return null;
    if (today && today.some(([o, c]) => clock >= o && clock < c)) return true;
    // Still inside yesterday's late opening (e.g. Fr 17:00-01:00 at 00:30 Sa).
    if (yesterday && yesterday.some(([o, c]) => c > 1440 && clock + 1440 < c && clock + 1440 >= o)) return true;
    // In opening_hours, a day the rules don't mention is a closed day:
    // "Fr-Su 12:00-23:00" means shut Monday to Thursday, not "unknown".
    return false;
  }

  /** Stops on the schedule that will be shut when the group gets there. */
  function closedStops(schedule, isoDate) {
    return schedule
      .map((s, i) => ({ i, open: isOpenAt(s.hours, isoDate, s.arriveAt) }))
      .filter((x) => x.open === false)
      .map((x) => x.i);
  }

  /** Two stops are the same place if they share a name and sit within ~60 m. */
  function sameStop(a, b) {
    if (!a || !b) return false;
    const close = milesBetween(a, b);
    return String(a.name || "").trim().toLowerCase() === String(b.name || "").trim().toLowerCase() &&
      close != null && close < 0.04;
  }

  // ---- Smart suggest ----------------------------------------------------
  // Rule-based, transparent scoring from what OpenStreetMap actually records
  // about each venue (pub vs bar, food, step-free access, outdoor seating,
  // real ale, live sport, opening hours) against who's coming. Every point
  // has a reason the organiser can read, rather than a black-box pick.

  /**
   * Score one venue for a group. `who` = { ageMin, ageMax, vibe: "chatty" |
   * "lively" | "mixed", needs: { food, stepFree, outdoor } }.
   * Returns { score, reasons[], blocked } — blocked means it fails a stated
   * need outright (e.g. step-free needed, venue says no access).
   */
  function scoreVenue(v, who) {
    const t = v.tags || {};
    const needs = who.needs || {};
    const older = (who.ageMax || 0) >= 45;
    const younger = (who.ageMin || 99) < 30;
    let score = 1;
    const reasons = [];
    let blocked = false;

    if (v.kind === "pub") {
      if (who.vibe === "chatty" || older) { score += 1; reasons.push("Proper pub"); }
    } else if (v.kind === "bar") {
      if (who.vibe === "lively" || (younger && !older)) { score += 0.6; reasons.push("Bar"); }
      else if (who.vibe === "chatty") score -= 0.3;
    }
    if (t.food === "yes") {
      score += needs.food ? 1.2 : 0.3;
      reasons.push("Food served");
    } else if (needs.food && t.food === "no") {
      score -= 1;
    }
    if (t.wheelchair === "yes") {
      score += needs.stepFree ? 1.5 : 0.2;
      reasons.push("Step-free");
    } else if (t.wheelchair === "limited") {
      score += needs.stepFree ? 0.3 : 0;
      if (needs.stepFree) reasons.push("Limited step-free access");
    } else if (t.wheelchair === "no" && needs.stepFree) {
      blocked = true;
    }
    if (t.outdoor_seating === "yes") {
      score += needs.outdoor ? 1 : 0.2;
      reasons.push("Outdoor seating");
    }
    if (t.real_ale === "yes" && (older || who.vibe === "chatty")) {
      score += 0.3;
      reasons.push("Real ale");
    }
    if (t.live_sport === "yes") {
      if (who.vibe === "chatty") score -= 0.4;
      else if (who.vibe === "lively") { score += 0.3; reasons.push("Shows sport"); }
    }
    return { score, reasons, blocked };
  }

  /**
   * Pick `count` stops forming a walkable route from `start` ({lat, lon}).
   * Greedy: the best-scoring venue near the start first, then each next stop
   * trades score against walking time (and must be under ~15 min away),
   * skipping anything shut when the group would arrive. Returns the chosen
   * venues in order, each with `why` (reasons + open check). Fewer than
   * `count` comes back if the area can't supply them — never padding with
   * closed or unsuitable places.
   */
  function suggestRoute(venues, start, who, plan) {
    const count = Math.max(1, Math.min(10, plan.count || 4));
    const pool = venues
      .map((v) => ({ v, s: scoreVenue(v, who) }))
      .filter((x) => !x.s.blocked);
    const chosen = [];
    let here = start;
    let clock = toMin(plan.start);
    while (chosen.length < count && pool.length) {
      let best = null;
      for (const x of pool) {
        const walk = chosen.length ? walkMinutes(here, x.v) : 0;
        if (chosen.length && walk > 15) continue;
        const startPenalty = chosen.length ? 0 : (milesBetween(start, x.v) || 0) * 1.5;
        const arrive = clock + walk;
        const open = isOpenAt(x.v.hours, plan.date, toHHMM(arrive));
        if (open === false) continue;
        const value = x.s.score - walk / 10 - startPenalty + (open === true ? 0.2 : 0);
        if (!best || value > best.value) best = { x, value, walk, open };
      }
      if (!best) break;
      const why = [...best.x.s.reasons];
      if (best.open === true) why.push("Open then");
      chosen.push({ ...best.x.v, why });
      pool.splice(pool.indexOf(best.x), 1);
      clock += best.walk + (plan.dwell || 50);
      here = best.x.v;
    }
    return chosen;
  }

  const api = {
    toMin, toHHMM, milesBetween, walkMinutes, scheduleStops, joinsAt,
    headcounts, bestStart, isOpenAt, closedStops, sameStop, scoreVenue, suggestRoute,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CrawlEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
