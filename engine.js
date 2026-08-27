/**
 * engine.js — Pure, UI-free recommendation engine for Reunly.
 *
 * Every function here is deterministic and side-effect free: give it
 * participants, get back tallies / scores. No DOM, no globals mutated. That
 * makes the engine independently testable and reusable (CLI, server, tests).
 *
 * Scoring philosophy (cost-conscious profile, confirmed with the user):
 *   total = 0.30 * dateScore + 0.30 * destScore + 0.40 * costScore
 * All sub-scores are normalized to 0..1 so weights are directly comparable.
 */

(function () {
  "use strict";

  const { CITY_COORDS, SEARCHED_FARES, FARES_AS_OF, CURRENCIES } = window.ReunlyData;

  // ---------------------------------------------------------------------------
  // Currency (display only — all stored fares are USD)
  // ---------------------------------------------------------------------------

  /** Convert a USD amount into the given currency code. */
  function convertFromUSD(usd, code) {
    const c = CURRENCIES[code] || CURRENCIES.USD;
    return usd * c.rate;
  }

  /** Round to a sensible step for the magnitude (keeps big-currency values clean). */
  function roundMoney(v) {
    if (v >= 100000) return Math.round(v / 5000) * 5000;
    if (v >= 10000) return Math.round(v / 500) * 500;
    if (v >= 1000) return Math.round(v / 50) * 50;
    return Math.round(v / 5) * 5;
  }

  /** Format a USD amount in a target currency, e.g. "₹17,850" or "$215". */
  function formatMoney(usd, code) {
    const c = CURRENCIES[code] || CURRENCIES.USD;
    return c.symbol + roundMoney(convertFromUSD(usd, code)).toLocaleString("en-US");
  }

  /** Format a USD min–max band in a target currency, e.g. "₹17,850–₹28,200". */
  function formatRange(usdMin, usdMax, code) {
    const c = CURRENCIES[code] || CURRENCIES.USD;
    const lo = roundMoney(convertFromUSD(usdMin, code)).toLocaleString("en-US");
    const hi = roundMoney(convertFromUSD(usdMax, code)).toLocaleString("en-US");
    return `${c.symbol}${lo}–${c.symbol}${hi}`;
  }

  // Case-insensitive city resolution: maps any-cased user input back to the
  // canonical CITY_COORDS key, so "goa, india" and "Goa, India" behave the same.
  const CITY_LOOKUP = {};
  for (const key of Object.keys(CITY_COORDS)) CITY_LOOKUP[key.toLowerCase()] = key;
  function resolveCity(name) {
    return CITY_LOOKUP[(name || "").trim().toLowerCase()] || null;
  }

  /** Tunable weights. Kept as named constants so they're easy to retune. */
  const WEIGHTS = { date: 0.3, destination: 0.3, cost: 0.4 };

  /**
   * Points awarded by preference rank (index 0 = 1st choice). Now that people
   * can add ANY number of ranked dates/places, this is a function with a floor
   * of 1 — the top three decay 3→2→1 and every extra still counts (weight 1),
   * so a long list never produces zero-weight (ignored) preferences.
   */
  const MAX_RANK_POINTS = 3;
  function rankPoints(rank) {
    return Math.max(1, MAX_RANK_POINTS - rank);
  }

  // ---------------------------------------------------------------------------
  // Geo + cost estimation (all ESTIMATES — never presented as live fares)
  // ---------------------------------------------------------------------------

  const EARTH_RADIUS_MI = 3958.8;
  const toRad = (deg) => (deg * Math.PI) / 180;

  /** Great-circle distance in miles between two known cities (case-insensitive). */
  function distanceMiles(cityA, cityB) {
    const keyA = resolveCity(cityA);
    const keyB = resolveCity(cityB);
    const a = CITY_COORDS[keyA];
    const b = CITY_COORDS[keyB];
    if (!a || !b) return null;
    if (keyA === keyB) return 0;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
  }

  /**
   * Estimated round-trip fare band from distance. Transparent heuristic, NOT a
   * quoted price. Uses a diminishing per-mile rate so it stays realistic across
   * scales: short hops are priced higher per mile than long-haul (where fares
   * flatten out). Callers must label the result "estimated".
   */
  function estimateFare(miles) {
    if (miles == null) return null;
    if (miles === 0) return { min: 0, max: 0, mode: "local" };
    const base = 60; // booking/airport overhead
    const near = Math.min(miles, 600) * 0.2; // first 600 mi: ~$0.20/mi
    const far = Math.max(0, miles - 600) * 0.11; // beyond: ~$0.11/mi
    const mid = base + near + far;
    return {
      min: Math.round((mid * 0.82) / 5) * 5,
      max: Math.round((mid * 1.28) / 5) * 5,
      mode: miles > 300 ? "flight" : "drive",
    };
  }

  /**
   * Rough per-person nightly lodging bands (USD, sharing a twin room). Mirrors
   * NIGHTLY_RATES in server.py — keep the two in step. Deliberately coarse: the
   * UI must present these as estimates, never as quoted prices.
   */
  const DEFAULT_NIGHTLY = [70, 130];
  const NIGHTLY_RATES = {
    // Pricier hubs
    "london, uk": [110, 210], "paris, france": [105, 200],
    "new york, ny": [130, 250], "san francisco, ca": [130, 240],
    "los angeles, ca": [115, 215], "washington, dc": [110, 200],
    "boston, ma": [115, 215], "seattle, wa": [105, 195],
    "singapore": [95, 180], "dubai, uae": [90, 190],
    "abu dhabi, uae": [80, 170], "hong kong": [95, 180],
    "sydney, australia": [100, 190], "tokyo, japan": [85, 165],
    "zurich, switzerland": [140, 260],
    // Mid
    "rome, italy": [80, 150], "barcelona, spain": [80, 150],
    "lisbon, portugal": [70, 135], "berlin, germany": [75, 140],
    "toronto, on": [95, 175], "chicago, il": [100, 185],
    "atlanta, ga": [85, 155], "dallas, tx": [85, 155],
    "manchester, uk": [75, 140],
    // Value
    "bangkok, thailand": [35, 80], "bali, indonesia": [30, 75],
    "goa, india": [30, 70], "delhi, india": [30, 70],
    "mumbai, india": [40, 90], "bangalore, india": [32, 75],
    "chennai, india": [28, 65], "hyderabad, india": [28, 65],
    "kolkata, india": [25, 60], "pune, india": [28, 65],
    "kuala lumpur, malaysia": [35, 80],
    "istanbul, turkey": [45, 95], "mexico city, mexico": [45, 95],
  };

  /** Estimated per-person lodging for a stay, or null if not applicable. */
  function estimateLodging(destination, nights) {
    if (!destination || !nights || nights <= 0) return null;
    const key = (destination || "").trim().toLowerCase();
    const band = NIGHTLY_RATES[key];
    // A generic fallback can be badly wrong in either direction (it was ~2.5x
    // reality for Indian cities), so say when we're guessing rather than
    // presenting it with the same confidence as a known rate.
    return {
      min: Math.round((band || DEFAULT_NIGHTLY)[0] * nights),
      max: Math.round((band || DEFAULT_NIGHTLY)[1] * nights),
      source: "estimated",
      approximate: !band,
    };
  }

  /**
   * The fewest nights that make a journey worth taking. A 16-hour flight each
   * way for a single night isn't a trip, it's an ordeal — but the date scorer
   * can't see that, because a one-day window is trivially "fully attendable"
   * by everyone and therefore scores perfectly. Roughly one night per 8 hours
   * of round-trip flying, so a short hop stays flexible while long-haul
   * demands a real stay.
   */
  const DAY_TRIP_MILES = 300; // same threshold estimateFare uses for drive vs fly
  function minSensibleNights(miles) {
    if (miles == null || miles <= 0) return 0;
    // Anything within driving range can legitimately be a day trip — a local
    // wedding, a birthday lunch, a match. Demanding an overnight there vetoed
    // exactly the single-day events the app is meant to support.
    if (miles <= DAY_TRIP_MILES) return 0;
    // Beyond that, base the bar on the journey people actually face: a long
    // drive is a long day even though flight time would call it trivial.
    const byAir = flightTimeHours(miles);
    const byRoad = driveTimeHours(miles);
    // Below ~600mi most groups drive; past that flying wins.
    const oneWayHours = miles <= 600 ? Math.min(byRoad, byAir) : byAir;
    return Math.min(7, Math.max(1, Math.round((oneWayHours * 2) / 8)));
  }

  /**
   * How defensible a window's length is for the journey involved: 1 when the
   * stay clears the bar for everyone, sliding down as it falls short. The
   * longest journey in the group sets the bar — a weekend that works for the
   * person driving an hour is still absurd for the one flying 16.
   */
  function tripViabilityFor(destination, participants, dateRange, wasSubmitted = false) {
    const nights = Math.max(0, rangeDays(dateRange) - 1);
    let required = 0;
    for (const p of participants) {
      if (!p.city) continue;
      const miles = distanceMiles(p.city, destination);
      required = Math.max(required, minSensibleNights(miles));
    }
    if (!required || nights >= required) return { viability: 1, nights, required };
    const shortfall = nights / required;
    // Somebody explicitly asked for this window. Even if it looks short for
    // the journey, that's a stated preference (a destination wedding really
    // can be one night) — discount it gently instead of ruling it out.
    if (wasSubmitted) return { viability: Math.max(0.85, shortfall), nights, required };
    // A window WE derived from overlapping availability gets the full check:
    // kept visible, but clearly beaten.
    return { viability: Math.max(0.15, shortfall), nights, required };
  }

  /**
   * Total estimated per-person trip cost: travel + lodging for the nights of
   * the chosen window. Budget checks that ignore lodging systematically
   * under-report what a trip actually costs, which is exactly the number
   * people compare against their stated budget.
   */
  function tripCostFor(fromCity, destination, dateRange, fareProvider = getFare, prefs = null) {
    const f = fareProvider(fromCity, destination);
    if (!f || f.min == null) return null;
    // Someone bringing two children books three seats, not one. Costing every
    // participant as a lone adult understates exactly the families most likely
    // to be priced out.
    const kids = Math.max(0, parseInt((prefs && prefs.kids) || 0, 10) || 0);
    const party = 1 + kids;
    const travel = ((f.min + f.max) / 2) * party;
    // Nights = nights slept, so one fewer than the inclusive day count.
    const nights = Math.max(0, rangeDays(dateRange) - 1);
    // "I don't need a bed" (staying with family, own place) means no lodging
    // cost — charging it anyway invents an expense they never face.
    const needsBed = !prefs || prefs.accommodation !== false;
    const lodge = needsBed ? estimateLodging(destination, nights) : null;
    // Children share the room rather than each taking a full rate.
    const roomFactor = 1 + kids * 0.5;
    const lodging = lodge ? ((lodge.min + lodge.max) / 2) * roomFactor : 0;
    return { travel, lodging, nights, party, total: travel + lodging, source: f.source };
  }

  /**
   * Resolve a fare for a route, preferring a real searched fare and falling
   * back to the distance estimate. Always tags the result with its provenance:
   *   { min, max, mode, source: "searched"|"estimated", asOf? }
   * so the UI can clearly distinguish current searched fares from estimates.
   */
  function getFare(fromCity, toCity) {
    const from = resolveCity(fromCity) || fromCity;
    const to = resolveCity(toCity) || toCity;
    const searched = SEARCHED_FARES[`${from}|${to}`];
    if (searched) {
      return { min: searched.min, max: searched.max, mode: "flight", source: "searched", asOf: FARES_AS_OF };
    }
    const est = estimateFare(distanceMiles(fromCity, toCity));
    if (!est) return null;
    return { ...est, source: "estimated" };
  }

  /** Rough flight time (hrs): taxi/climb overhead + cruise at ~500 mph. */
  function flightTimeHours(miles) {
    if (miles == null) return null;
    return 0.75 + miles / 500;
  }

  /** Rough drive time (hrs) at ~60 mph average. */
  function driveTimeHours(miles) {
    if (miles == null) return null;
    return miles / 60;
  }

  /** Format an hours value as "2h 15m". */
  function formatHours(hrs) {
    if (hrs == null) return "—";
    const h = Math.floor(hrs);
    const m = Math.round((hrs - h) * 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  // ---------------------------------------------------------------------------
  // Date range helpers
  // ---------------------------------------------------------------------------

  /**
   * A date range is "valid" only when both ends are filled in AND chronological.
   * Native <input type="date"> doesn't enforce start <= end, so we do.
   */
  function isValidRange(r) {
    return Boolean(r && r.start && r.end && r.start <= r.end);
  }

  /** Stable key for grouping identical date ranges in a tally. */
  function rangeKey(r) {
    return `${r.start}_${r.end}`;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** "2026-08-14" -> "Aug 14". Returns the raw string if it can't be parsed. */
  function formatDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "";
    return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  }

  /** Compact human label, e.g. "Aug 14 – 17" or "Aug 28 – Sep 2". */
  function rangeLabel(r) {
    if (!r || !r.start || !r.end) return `${r ? r.start : ""} → ${r ? r.end : ""}`;
    const sameMonth = r.start.slice(0, 7) === r.end.slice(0, 7);
    const endLabel = sameMonth ? Number(r.end.slice(8, 10)).toString() : formatDay(r.end);
    return `${formatDay(r.start)} – ${endLabel}`;
  }

  /** Do two inclusive date ranges overlap at all? */
  function rangesOverlap(a, b) {
    if (!isValidRange(a) || !isValidRange(b)) return false;
    return a.start <= b.end && b.start <= a.end;
  }

  const MS_PER_DAY = 86400000;
  /** Inclusive length of a range in days (a single-day range === 1). */
  function rangeDays(r) {
    if (!isValidRange(r)) return 0;
    const start = Date.parse(r.start + "T00:00:00Z");
    const end = Date.parse(r.end + "T00:00:00Z");
    if (Number.isNaN(start) || Number.isNaN(end)) return 0;
    return Math.round((end - start) / MS_PER_DAY) + 1;
  }
  /** The shared window between two ranges, or null when they don't overlap. */
  function rangeIntersection(a, b) {
    if (!rangesOverlap(a, b)) return null;
    return {
      start: a.start > b.start ? a.start : b.start,
      end: a.end < b.end ? a.end : b.end,
    };
  }
  /** How many days two ranges share (0 when they don't overlap). */
  function overlapDays(a, b) {
    return rangeDays(rangeIntersection(a, b));
  }

  // ---------------------------------------------------------------------------
  // Tallies — the core "loop through participants and count" logic
  // ---------------------------------------------------------------------------

  /**
   * Generic rank-weighted tally. Loops through every participant's ranked list,
   * groups by `keyOf`, and accumulates points/votes/firstChoices. Both the
   * destination and date tallies are thin wrappers over this — add a new ranked
   * dimension by calling it with the right accessors.
   *
   * @param participants  list of participants
   * @param itemsOf       (p) => ranked array for this dimension
   * @param keyOf         (item) => grouping key, or null/"" to skip the item
   * @param baseEntry     (item, key) => fields to seed a new tally entry with
   */
  function tallyRanked(participants, itemsOf, keyOf, baseEntry) {
    const tally = new Map();
    for (const p of participants) {
      itemsOf(p).forEach((item, rank) => {
        const key = keyOf(item);
        if (!key) return;
        const entry =
          tally.get(key) || { ...baseEntry(item, key), points: 0, votes: 0, firstChoices: 0 };
        entry.points += rankPoints(rank);
        entry.votes += 1;
        if (rank === 0) entry.firstChoices += 1;
        tally.set(key, entry);
      });
    }
    return [...tally.values()].sort((a, b) => b.points - a.points);
  }

  /**
   * Tally destination popularity, weighted by preference rank.
   * Returns array sorted by points desc: [{ destination, points, votes, firstChoices }]
   */
  function tallyDestinations(participants) {
    // Group case-insensitively; display the canonical city name when known.
    return tallyRanked(
      participants,
      (p) => p.destinations,
      (dest) => (dest || "").trim().toLowerCase(),
      (dest) => ({ destination: resolveCity(dest) || (dest || "").trim() })
    );
  }

  /**
   * Tally availability by exact date range, weighted by preference rank.
   * Returns array sorted by points desc: [{ key, range, label, points, votes, firstChoices }]
   */
  function tallyDates(participants) {
    return tallyRanked(
      participants,
      (p) => p.dates,
      (range) => (isValidRange(range) ? rangeKey(range) : null),
      (range, key) => ({ key, range, label: rangeLabel(range) })
    );
  }

  /**
   * Candidate date windows to score.
   *
   * The ranges people literally typed are rarely the answer. If Ann is free
   * Dec 19-26 and Bob Dec 22-29, a human organiser instantly suggests Dec
   * 22-26 — but that window appears in nobody's list, so scoring only the
   * submitted ranges could never surface it. This adds the pairwise
   * intersections (the windows where people genuinely coincide) alongside the
   * originals.
   *
   * @param minDays  ignore slivers shorter than this (default 2 — a single
   *                 shared day is rarely a trip)
   */
  // Pairing is O(n^2) in submitted ranges, and every extra candidate multiplies
  // the scoring work behind it. Unbounded, a 60-person group with 12 ranges
  // each produced 28,000 candidates and took ~105 SECONDS on the main thread —
  // reachable from a crafted invite link, which is a denial of service, not
  // just slowness. tallyDates returns most-wanted first, so capping keeps the
  // windows people actually asked for and drops the long tail.
  const MAX_PAIRED_RANGES = 30; // how many submitted ranges get paired up
  const MAX_DATE_CANDIDATES = 60; // total windows handed to scoring

  function dateCandidatesFor(participants, minDays = 2) {
    const submitted = tallyDates(participants).map((d) => d.range);
    const seen = new Set(submitted.map(rangeKey));
    const out = submitted.slice(0, MAX_DATE_CANDIDATES);
    // Pairwise intersections of the most-wanted submitted ranges.
    const pairable = submitted.slice(0, MAX_PAIRED_RANGES);
    for (let i = 0; i < pairable.length; i++) {
      if (out.length >= MAX_DATE_CANDIDATES) break;
      for (let j = i + 1; j < pairable.length; j++) {
        if (out.length >= MAX_DATE_CANDIDATES) break;
        const shared = rangeIntersection(pairable[i], pairable[j]);
        if (!shared) continue;
        if (rangeDays(shared) < minDays) continue;
        const key = rangeKey(shared);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(shared);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Per-candidate scoring
  // ---------------------------------------------------------------------------

  /**
   * Date sub-score (0..1) for a candidate range: average across participants of
   * their best rank-points for any of their ranges that OVERLAP the candidate.
   * Overlap (not exact match) keeps it realistic when ranges differ slightly.
   */
  function dateScoreFor(candidateRange, participants) {
    if (!participants.length) return 0;
    const candidateLength = rangeDays(candidateRange) || 1;
    let sum = 0;
    for (const p of participants) {
      let best = 0;
      p.dates.forEach((r, rank) => {
        const shared = overlapDays(r, candidateRange);
        if (!shared) return;
        // Weight by HOW MUCH of the candidate window this person can actually
        // make. Treating a single shared day the same as the whole week made
        // "works for most people" routinely untrue.
        const coverage = Math.min(1, shared / candidateLength);
        best = Math.max(best, rankPoints(rank) * coverage);
      });
      sum += best / MAX_RANK_POINTS;
    }
    return sum / participants.length;
  }

  /** Destination sub-score (0..1): average rank-points for that destination. */
  function destScoreFor(candidateDest, participants) {
    if (!participants.length) return 0;
    const target = candidateDest.trim().toLowerCase();
    let sum = 0;
    for (const p of participants) {
      let best = 0;
      p.destinations.forEach((d, rank) => {
        if ((d || "").trim().toLowerCase() === target) {
          best = Math.max(best, rankPoints(rank));
        }
      });
      sum += best / MAX_RANK_POINTS;
    }
    return sum / participants.length;
  }

  /**
   * Average fare to a destination across all participants with a known home
   * city, preferring real searched fares over estimates.
   * Returns { avgFare, anySearched, fares:[{id, city, fare, source}] } or null.
   */
  function avgFareTo(destination, participants, fareProvider = getFare) {
    const fares = [];
    let anySearched = false;
    let anyLive = false;
    for (const p of participants) {
      if (!p.city) continue;
      const f = fareProvider(p.city, destination);
      if (!f || f.min == null) continue;
      if (f.source === "searched") anySearched = true;
      if (f.source === "live") anyLive = true;
      fares.push({ id: p.id, city: p.city, fare: (f.min + f.max) / 2, source: f.source });
    }
    if (!fares.length) return null;
    const avgFare = fares.reduce((s, f) => s + f.fare, 0) / fares.length;
    return { avgFare, anySearched, anyLive, fares };
  }

  /**
   * How well a destination fits what people actually said they can spend.
   *
   * Each participant's own estimated fare is compared against their own stated
   * `prefs.budget` (a per-person ceiling in USD). We deliberately compare
   * per-person rather than against the group average, because an average hides
   * exactly the person most likely to drop out.
   *
   * Returns { fit, overCount, overNames, checked } where `fit` is 0..1
   * (1 = comfortably inside everyone's budget), or null when nobody supplied a
   * budget — in which case callers should stay neutral rather than guess.
   */
  function budgetFitFor(destination, participants, fareProvider = getFare, dateRange = null) {
    const ratios = [];
    const overNames = [];
    for (const p of participants) {
      const budget = parseFloat(p.prefs && p.prefs.budget);
      if (!p.city || Number.isNaN(budget) || budget <= 0) continue;
      // Compare against the whole trip (travel + lodging) when we know the
      // dates — that's the number people actually have to find.
      const trip = dateRange
        ? tripCostFor(p.city, destination, dateRange, fareProvider, p.prefs)
        : null;
      let cost;
      if (trip) {
        // The budget field asks for a PER-PERSON figure, so compare like with
        // like. Measuring a family's whole-party total against it flagged
        // parents as priced out even when their per-head cost was LOWER than a
        // solo traveller's (kids share a room), and one such family capped the
        // cost score for the entire group.
        cost = trip.total / Math.max(1, trip.party);
      } else {
        const f = fareProvider(p.city, destination);
        if (!f || f.min == null) continue;
        cost = (f.min + f.max) / 2;
      }
      const ratio = cost / budget; // <1 = affordable, >1 = over budget
      ratios.push(ratio);
      if (ratio > 1) overNames.push(p.name || "Someone");
    }
    if (!ratios.length) return null;
    // Score each person: full marks while the trip stays comfortably inside
    // their budget, sliding to 0 as it reaches/exceeds the ceiling.
    //
    // Even the all-in figure EXCLUDES food, local transport and activities, so
    // "80% of budget spent on travel + beds" is not comfortable — it leaves a
    // week's spending money in the low tens. Keep real headroom, and more of it
    // when the figure is travel-only.
    const comfort = dateRange ? 0.6 : 0.45;
    const perPerson = ratios.map((r) => {
      if (r <= comfort) return 1;
      if (r >= 1) return 0;
      return 1 - (r - comfort) / (1 - comfort);
    });
    let fit = perPerson.reduce((s, v) => s + v, 0) / perPerson.length;
    // An average re-hides the very person this check exists to protect: four
    // comfortable travellers can average out one who's priced out entirely.
    // Cap the score whenever anyone is over, so the UI can never claim a
    // destination "fits stated budgets" while also warning that it doesn't.
    if (overNames.length) fit = Math.min(fit, 0.45);
    return { fit, overCount: overNames.length, overNames, checked: ratios.length };
  }

  // ---------------------------------------------------------------------------
  // Combined ranking of (date range × destination) combinations
  // ---------------------------------------------------------------------------

  /**
   * Rank all candidate combinations of submitted date ranges × destinations.
   *
   * The cost component blends two things: how cheap a destination is *relative
   * to the other candidates* (normalized fare), and how well it fits the
   * budgets people actually stated (budgetFitFor). Without the second half,
   * "cheapest of the options" could still be unaffordable for the group and the
   * UI would misleadingly call it budget-friendly.
   *
   * @returns array sorted by total desc:
   *   [{ destination, dateRange, dateLabel, dateScore, destScore, costScore,
   *      avgFare, budgetFit, overBudgetCount, overBudgetNames, total }]
   */
  function rankCombinations(participants, weights = WEIGHTS, fareProvider = getFare) {
    // Includes windows where people's availability overlaps, not just the
    // ranges they typed — see dateCandidatesFor().
    const dateCandidates = dateCandidatesFor(participants);
    // Same reasoning as the date cap: most-wanted first, bounded work.
    const MAX_DEST_CANDIDATES = 15;
    const destCandidates = tallyDestinations(participants)
      .slice(0, MAX_DEST_CANDIDATES)
      .map((d) => d.destination);
    if (!dateCandidates.length || !destCandidates.length) return [];
    // Which candidates did somebody actually type, vs which did we derive from
    // overlapping availability? The UI should say so rather than presenting a
    // computed window as though someone proposed it.
    const submittedKeys = new Set(tallyDates(participants).map((d) => rangeKey(d.range)));

    // Pre-compute average fares per destination so we can normalize cost.
    const fareByDest = new Map(); // dest -> avg fare (number) or null
    const searchedByDest = new Map(); // dest -> bool (any searched/live fare?)
    for (const dest of destCandidates) {
      const info = avgFareTo(dest, participants, fareProvider);
      fareByDest.set(dest, info ? info.avgFare : null);
      searchedByDest.set(dest, info ? info.anySearched || info.anyLive : false);
    }
    // Pass 1 — describe every combination, including what it actually costs.
    // Cost can't be normalized yet: lodging depends on the window's length, so
    // the cheapest option is only known once every (place, window) pair exists.
    const draft = [];
    for (const dest of destCandidates) {
      const destScore = destScoreFor(dest, participants);
      const avgFare = fareByDest.get(dest);
      const fareSearched = searchedByDest.get(dest);
      for (const dateRange of dateCandidates) {
        const dateScore = dateScoreFor(dateRange, participants);
        // Budget fit depends on the window as well as the place: a longer stay
        // means more nights of lodging, so it's evaluated per combination.
        const budget = budgetFitFor(dest, participants, fareProvider, dateRange);
        const { viability, nights, required } = tripViabilityFor(
          dest, participants, dateRange, submittedKeys.has(rangeKey(dateRange))
        );
        const lodge = estimateLodging(dest, nights);
        // What each individual actually faces — an average hides the person
        // flying furthest, who is usually the one at risk of dropping out.
        // Keep PER-HEAD figures here: a family's booking total isn't
        // comparable to a solo traveller's, and labelling it "per person"
        // made a $1,533 family of three look like one person's share.
        const perPerson = []; // per head
        const perBooking = []; // what each household actually pays
        for (const p of participants) {
          if (!p.city) continue;
          const trip = tripCostFor(p.city, dest, dateRange, fareProvider, p.prefs);
          if (!trip) continue;
          perBooking.push(trip.total);
          perPerson.push(trip.total / Math.max(1, trip.party));
        }
        const avgTripCost = perPerson.length
          ? perPerson.reduce((s, v) => s + v, 0) / perPerson.length
          : avgFare;
        draft.push({
          destination: dest, dateRange, dateLabel: rangeLabel(dateRange),
          // True when we derived this window from overlapping availability
          // rather than someone proposing it outright.
          dateSuggested: !submittedKeys.has(rangeKey(dateRange)),
          dateScore, destScore,
          budgetFit: budget ? budget.fit : null,
          overBudgetCount: budget ? budget.overCount : 0,
          overBudgetNames: budget ? budget.overNames : [],
          budgetChecked: budget ? budget.checked : 0,
          avgFare, fareSearched, nights,
          lodgingMin: lodge ? lodge.min : null,
          lodgingMax: lodge ? lodge.max : null,
          lodgingApproximate: lodge ? Boolean(lodge.approximate) : false,
          avgTripCost,
          minTripCost: perPerson.length ? Math.min(...perPerson) : null,
          maxTripCost: perPerson.length ? Math.max(...perPerson) : null,
          // Largest single booking in the group — what the biggest household
          // is actually asked to find.
          maxBookingCost: perBooking.length ? Math.max(...perBooking) : null,
          viability, minNights: required,
        });
      }
    }

    // Pass 2 — rank cost on the ALL-IN figure, but compare like with like.
    //
    // Normalizing across EVERY combination made cost a proxy for trip length:
    // lodging scales with nights, so a 2-night sliver scored 1.00 and an
    // 8-night stay 0.00 for the same place and people, and at 40% weight that
    // silently decided the trip. Cost's job is "which DESTINATION is easier on
    // the group", so normalize within each date window. How long to go for is
    // expressed through people's date ranges, and a stay nobody can afford is
    // still caught by budgetFit, which works in absolute terms.
    const byWindow = new Map();
    for (const c of draft) {
      const key = rangeKey(c.dateRange);
      if (!byWindow.has(key)) byWindow.set(key, []);
      byWindow.get(key).push(c);
    }
    for (const group of byWindow.values()) {
      const knownCosts = group.map((c) => c.avgTripCost).filter((v) => v != null);
      const minCost = knownCosts.length ? Math.min(...knownCosts) : 0;
      const maxCost = knownCosts.length ? Math.max(...knownCosts) : 0;
      const costSpread = maxCost - minCost;
      for (const c of group) {
        if (c.avgTripCost == null) c.relCostScore = 0.5; // unknown — stay neutral
        else if (costSpread === 0) c.relCostScore = 1; // nothing to compare against
        else c.relCostScore = 1 - (c.avgTripCost - minCost) / costSpread;
      }
    }
    for (const c of draft) {
      const relCost = c.relCostScore;
      // Blend "cheap vs the alternatives" with "actually affordable for the
      // people going". When nobody stated a budget we fall back to the
      // relative measure alone rather than inventing an affordability signal.
      const costScore = c.budgetFit != null ? relCost * 0.5 + c.budgetFit * 0.5 : relCost;
      c.costScore = costScore;
      c.total =
        (weights.date * c.dateScore +
          weights.destination * c.destScore +
          weights.cost * costScore) *
        // A stay too short for the journey can't be allowed to win on the
        // strength of being trivially attendable and cheap.
        c.viability;
    }
    return draft.sort((a, b) => b.total - a.total);
  }

  /**
   * Roll up participant preferences for the host's "group insights" panel.
   * Returns counts/medians that are safe to render even when fields are blank.
   */
  function summarizePrefs(participants) {
    const out = {
      total: participants.length,
      accommodation: 0,
      kids: 0,
      withKids: 0,
      budgets: [],
      medianBudget: null,
      food: {},
      activities: {},
      accessibility: [],
    };
    for (const p of participants) {
      const pr = p.prefs || {};
      // null (unanswered) counts as needing a bed, matching the cost model.
      if (pr.accommodation !== false) out.accommodation += 1;
      const k = Number(pr.kids) || 0;
      if (k > 0) {
        out.kids += k;
        out.withKids += 1;
      }
      const b = parseFloat(pr.budget);
      if (!Number.isNaN(b) && b > 0) out.budgets.push(b);
      if (pr.food && pr.food !== "No preference") out.food[pr.food] = (out.food[pr.food] || 0) + 1;
      (pr.activities || []).forEach((a) => (out.activities[a] = (out.activities[a] || 0) + 1));
      if (pr.accessibility && pr.accessibility.trim()) {
        out.accessibility.push({ name: p.name || "Someone", note: pr.accessibility.trim() });
      }
    }
    if (out.budgets.length) {
      const sorted = [...out.budgets].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      out.medianBudget =
        sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      out.minBudget = sorted[0];
      out.maxBudget = sorted[sorted.length - 1];
    }
    // Sort food/activity tallies into ranked [label, count] arrays.
    out.foodRanked = Object.entries(out.food).sort((a, b) => b[1] - a[1]);
    out.activitiesRanked = Object.entries(out.activities).sort((a, b) => b[1] - a[1]);
    return out;
  }

  /** Whole days from today until an ISO date (negative if past). */
  function daysUntil(iso) {
    if (!iso) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(iso + "T00:00:00");
    if (Number.isNaN(target.getTime())) return null;
    return Math.round((target - today) / 86400000);
  }

  // External deep-link builders (verification, not integration).
  // encodeURIComponent guards against query-string injection.
  function googleFlightsLink(from, to) {
    return `https://www.google.com/travel/flights?q=${encodeURIComponent(
      `Flights from ${from} to ${to}`
    )}`;
  }
  function rome2rioLink(from, to) {
    return `https://www.rome2rio.com/s/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
  }
  function mapsRouteLink(from, to) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      from
    )}&destination=${encodeURIComponent(to)}`;
  }
  function mapsSearchLink(query) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  window.ReunlyEngine = {
    WEIGHTS,
    rankPoints,
    // currency
    convertFromUSD,
    formatMoney,
    formatRange,
    // geo/cost
    resolveCity,
    distanceMiles,
    estimateFare,
    getFare,
    flightTimeHours,
    driveTimeHours,
    formatHours,
    // dates
    isValidRange,
    rangesOverlap,
    rangeLabel,
    rangeDays,
    rangeIntersection,
    overlapDays,
    dateCandidatesFor,
    // tallies
    tallyDestinations,
    tallyDates,
    summarizePrefs,
    daysUntil,
    // scoring
    avgFareTo,
    budgetFitFor,
    estimateLodging,
    tripCostFor,
    rankCombinations,
    // links
    googleFlightsLink,
    rome2rioLink,
    mapsRouteLink,
    mapsSearchLink,
  };
})();
