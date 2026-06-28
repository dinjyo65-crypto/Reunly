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

  /** Points awarded by preference rank (index 0 = 1st choice). */
  const RANK_POINTS = [3, 2, 1]; // 1st, 2nd, 3rd
  // Use max (not [0]) so normalization stays correct even if points are reordered.
  const MAX_RANK_POINTS = Math.max(...RANK_POINTS);

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
        entry.points += RANK_POINTS[rank] || 0;
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
    let sum = 0;
    for (const p of participants) {
      let best = 0;
      p.dates.forEach((r, rank) => {
        if (rangesOverlap(r, candidateRange)) {
          best = Math.max(best, RANK_POINTS[rank] || 0);
        }
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
          best = Math.max(best, RANK_POINTS[rank] || 0);
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

  // ---------------------------------------------------------------------------
  // Combined ranking of (date range × destination) combinations
  // ---------------------------------------------------------------------------

  /**
   * Rank all candidate combinations of submitted date ranges × destinations.
   * Cost is normalized across candidates (cheapest avg fare => costScore 1).
   *
   * @returns array sorted by total desc:
   *   [{ destination, dateRange, dateLabel, dateScore, destScore, costScore,
   *      avgFare, total }]
   */
  function rankCombinations(participants, weights = WEIGHTS, fareProvider = getFare) {
    const dateCandidates = tallyDates(participants).map((d) => d.range);
    const destCandidates = tallyDestinations(participants).map((d) => d.destination);
    if (!dateCandidates.length || !destCandidates.length) return [];

    // Pre-compute average fares per destination so we can normalize cost.
    const fareByDest = new Map(); // dest -> avg fare (number) or null
    const searchedByDest = new Map(); // dest -> bool (any searched/live fare?)
    for (const dest of destCandidates) {
      const info = avgFareTo(dest, participants, fareProvider);
      fareByDest.set(dest, info ? info.avgFare : null);
      searchedByDest.set(dest, info ? info.anySearched || info.anyLive : false);
    }
    const knownFares = [...fareByDest.values()].filter((f) => f != null);
    const minFare = knownFares.length ? Math.min(...knownFares) : 0;
    const maxFare = knownFares.length ? Math.max(...knownFares) : 0;
    const fareSpread = maxFare - minFare;

    /** Cheapest = 1, most expensive = 0; neutral 0.5 when there's nothing to compare. */
    function costScoreFor(dest) {
      const fare = fareByDest.get(dest);
      if (fare == null) return 0.5; // unknown cost — stay neutral
      if (fareSpread === 0) return 1; // only one comparable fare (or all equal): best
      return 1 - (fare - minFare) / fareSpread;
    }

    const combos = [];
    for (const dest of destCandidates) {
      const destScore = destScoreFor(dest, participants);
      const costScore = costScoreFor(dest);
      const avgFare = fareByDest.get(dest);
      const fareSearched = searchedByDest.get(dest);
      for (const dateRange of dateCandidates) {
        const dateScore = dateScoreFor(dateRange, participants);
        const total =
          weights.date * dateScore +
          weights.destination * destScore +
          weights.cost * costScore;
        combos.push({
          destination: dest,
          dateRange,
          dateLabel: rangeLabel(dateRange),
          dateScore,
          destScore,
          costScore,
          avgFare,
          fareSearched,
          total,
        });
      }
    }
    return combos.sort((a, b) => b.total - a.total);
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
    RANK_POINTS,
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
    // tallies
    tallyDestinations,
    tallyDates,
    // scoring
    avgFareTo,
    rankCombinations,
    // links
    googleFlightsLink,
    rome2rioLink,
    mapsRouteLink,
    mapsSearchLink,
  };
})();
