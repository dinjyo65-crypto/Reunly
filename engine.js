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

  // Round an estimate to ~1% granularity: rounded enough to read as an
  // estimate, fine enough that the step never changes the answer. The old
  // fixed thresholds were applied AFTER conversion, so the same trip lost far
  // more precision in one currency than another — $1,735 displayed as $1,750
  // but as £1,350 (£1,371 exact), a gap the exchange rate couldn't explain.
  function roundMoney(v) {
    const magnitude = Math.abs(v);
    if (magnitude < 1) return Math.round(v);
    const step = Math.max(1, Math.pow(10, Math.floor(Math.log10(magnitude)) - 2));
    return Math.round(v / step) * step;
  }

  /** Format a USD amount in a target currency, e.g. "₹17,850" or "$215". */
  function formatMoney(usd, code) {
    const c = CURRENCIES[code] || CURRENCIES.USD;
    return c.symbol + roundMoney(convertFromUSD(usd, code)).toLocaleString("en-US");
  }

  /** Convert an amount typed in the given currency back into USD storage. */
  function toUSD(amount, code) {
    const c = CURRENCIES[code] || CURRENCIES.USD;
    return amount / c.rate;
  }

  // Format to the exact cent, for the settle-up ledger. formatMoney's rounding
  // is right for estimates and wrong here: rounding each balance to the
  // nearest 5 would stop the transfers adding up to what was actually spent.
  function formatExact(usd, code) {
    const c = CURRENCIES[code] || CURRENCIES.USD;
    return (
      c.symbol +
      convertFromUSD(usd, code).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
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
  // Below this, people drive rather than fly. Used for pricing, for journey
  // time, and for deciding whether a trip can sensibly be a day trip — they
  // must agree, so there is one constant.
  const DRIVE_MILES = 300;

  function estimateFare(miles) {
    if (miles == null) return null;
    if (miles === 0) return { min: 0, max: 0, mode: "local" };
    const driving = miles <= DRIVE_MILES;
    // Fuel and tolls for the round trip, per car — no booking or airport
    // overhead, because a road trip doesn't have any.
    const base = driving ? 0 : 60;
    const perMile = driving ? 0.34 : 0.2; // round-trip fuel+tolls vs airfare
    const near = Math.min(miles, 600) * perMile;
    const far = Math.max(0, miles - 600) * 0.11; // beyond: ~$0.11/mi
    const mid = base + near + far;
    return {
      min: Math.round((mid * 0.82) / 5) * 5,
      max: Math.round((mid * 1.28) / 5) * 5,
      mode: driving ? "drive" : "flight",
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
   * Coarse seasonal pricing multiplier for a travel window.
   *
   * Fares and lodging were completely date-blind, so a Christmas-week trip
   * priced identically to mid-February — and the app's own examples default to
   * exactly that peak window, so it under-reported on the common case. These
   * are deliberately broad bands, not quoted prices; callers must label the
   * result as an estimate and say when a peak has been applied.
   *
   * Applied ONLY to our own estimates. A real captured fare already reflects
   * whatever season it was quoted for, and scaling it would corrupt real data.
   */
  /** Which pricing band a single calendar day falls in. */
  function seasonBandFor(iso) {
    const md = iso.slice(5); // "MM-DD"
    const month = Number(iso.slice(5, 7));
    const day = Number(iso.slice(8, 10));
    // Christmas / New Year: the sharpest, most reliable spike worldwide.
    if ((month === 12 && day >= 18) || (month === 1 && day <= 5)) {
      return { fare: 1.35, lodging: 1.5, label: "Christmas & New Year peak" };
    }
    // Northern-hemisphere summer holidays.
    if (month === 7 || month === 8) {
      return { fare: 1.2, lodging: 1.25, label: "summer peak" };
    }
    // Easter-ish shoulder spike.
    if (md >= "03-25" && md <= "04-15") {
      return { fare: 1.12, lodging: 1.15, label: "Easter holidays" };
    }
    return { fare: 1, lodging: 1, label: null };
  }

  /**
   * Blend the seasonal multipliers across every day of the window.
   *
   * Reading the band off day one alone priced a trip that straddles a peak as
   * if the peak did not exist: Dec 15-28 covers Christmas Day and got no uplift
   * at all, while Dec 19-Jan 1 got the full 1.35x — a 30% swing between two
   * near-identical windows. Because dateCandidatesFor synthesises windows from
   * overlapping availability, those off-by-a-few-days variants are generated
   * automatically and then compete on a 40%-weighted cost score.
   */
  // Memoised by window. tripCostFor calls this once per participant per
  // combination, and the day loop inside runs a Date + toISOString per night —
  // real work to repeat for an answer that depends only on the two dates.
  const seasonCache = new Map();
  function seasonFactorFor(dateRange) {
    if (!isValidRange(dateRange)) return { fare: 1, lodging: 1, label: null };
    const cacheKey = `${dateRange.start}|${dateRange.end}`;
    const hit = seasonCache.get(cacheKey);
    if (hit) return hit;
    const start = Date.parse(dateRange.start + "T00:00:00Z");
    const end = Date.parse(dateRange.end + "T00:00:00Z");
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { fare: 1, lodging: 1, label: null };
    }
    let fare = 0;
    let lodging = 0;
    let days = 0;
    let peakDays = 0;
    const labels = new Map();
    for (let t = start; t <= end && days < 400; t += 86400000) {
      const band = seasonBandFor(new Date(t).toISOString().slice(0, 10));
      fare += band.fare;
      lodging += band.lodging;
      days += 1;
      if (band.label) {
        peakDays += 1;
        labels.set(band.label, (labels.get(band.label) || 0) + 1);
      }
    }
    if (!days) return { fare: 1, lodging: 1, label: null };
    // Name the band that covers the most days, and say how much of the trip it
    // actually covers so a one-night brush with a peak doesn't read as a
    // full-price warning.
    let label = null;
    let best = 0;
    labels.forEach((n, name) => {
      if (n > best) {
        best = n;
        label = name;
      }
    });
    if (label && peakDays < days) label = `${label} (${best} of ${days} days)`;
    const result = { fare: fare / days, lodging: lodging / days, label, peakDays, days };
    if (seasonCache.size > 500) seasonCache.clear();
    seasonCache.set(cacheKey, result);
    return result;
  }

  /**
   * The fewest nights that make a journey worth taking. A 16-hour flight each
   * way for a single night isn't a trip, it's an ordeal — but the date scorer
   * can't see that, because a one-day window is trivially "fully attendable"
   * by everyone and therefore scores perfectly. Roughly one night per 8 hours
   * of round-trip flying, so a short hop stays flexible while long-haul
   * demands a real stay.
   */
  const DAY_TRIP_MILES = DRIVE_MILES;
  const GROUND_HOURS = 3.5; // airport transfers, check-in and security, both ends
  const CONNECTION_HOURS = 2.5; // typical layover on a route with no nonstop
  /**
   * Door-to-door hours one way — what someone actually gives up to get there.
   *
   * flightTimeHours is great-circle time in the air. Quoting that as the
   * journey made a trip to the other side of the world look like an afternoon:
   * Goa to Bali came out at 7h20m when there is no nonstop and the real answer
   * is 14-17 hours. It is not only a label — the same number gates trip
   * viability and decides how much of the first and last day to write off.
   */
  function journeyHours(miles) {
    if (miles == null || miles <= 0) return 0;
    if (miles <= DRIVE_MILES) return driveTimeHours(miles);
    const byAir = flightTimeHours(miles);
    // Below ~600mi driving is usually still quicker door to door.
    if (miles <= 600) return Math.min(driveTimeHours(miles), byAir + GROUND_HOURS);
    // Getting to the airport, checking in, security, and the same at the far
    // end. Beyond ~2,000mi assume a connection too: most such city pairs have
    // no nonstop, and the ones that do are the exception we'd rather
    // under-promise on than over-promise.
    return byAir + GROUND_HOURS + (miles > 2000 ? CONNECTION_HOURS : 0);
  }

  function minSensibleNights(miles) {
    if (miles == null || miles <= 0) return 0;
    // Anything within driving range can legitimately be a day trip — a local
    // wedding, a birthday lunch, a match. Demanding an overnight there vetoed
    // exactly the single-day events the app is meant to support.
    if (miles <= DAY_TRIP_MILES) return 0;
    return Math.min(7, Math.max(1, Math.round((journeyHours(miles) * 2) / 8)));
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
    const season = seasonFactorFor(dateRange);
    // Only skip the seasonal uplift for a price that was actually quoted for
    // THIS window — such a fare already embodies its own season, and scaling it
    // would corrupt a real observed value. A quote for a different departure
    // has no more claim to the season than our own estimate does; treating any
    // non-estimated fare as season-correct meant an August quote could be shown
    // for a Christmas trip with the 1.35x uplift suppressed, wearing the "live"
    // badge — the exact under-reporting seasonFactorFor exists to prevent.
    const quotedForThisWindow =
      f.source !== "estimated" && (!f.quotedFor || f.quotedFor === dateRange.start);
    const fareSeason = quotedForThisWindow ? 1 : season.fare;
    // A car costs the same with three people in it as with one, so a drive is
    // priced per VEHICLE. Multiplying it per head charged a family of three
    // $308 to drive 190 miles — three separate "fares", each carrying the $60
    // airport booking overhead that a road trip never incurs. That figure then
    // fed the budget check, producing spurious "over budget" warnings on drives.
    const driving = f.mode === "drive";
    const travel = ((f.min + f.max) / 2) * (driving ? 1 : party) * fareSeason;
    // Nights = nights slept, so one fewer than the inclusive day count.
    const nights = Math.max(0, rangeDays(dateRange) - 1);
    // "I don't need a bed" (staying with family, own place) means no lodging
    // cost — charging it anyway invents an expense they never face.
    const needsBed = !prefs || prefs.accommodation !== false;
    const lodge = needsBed ? estimateLodging(destination, nights) : null;
    // Children share the room rather than each taking a full rate.
    // Children share the room rather than each taking a full rate. A lone
    // adult, conversely, can't split a twin — the bands assume sharing.
    const roomFactor = kids > 0 ? 1 + kids * 0.5 : 1.6;
    const lodging = lodge ? ((lodge.min + lodge.max) / 2) * roomFactor * season.lodging : 0;
    return {
      travel, lodging, nights, party,
      total: travel + lodging,
      source: f.source,
      season: season.label,
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
    // Round to whole minutes FIRST, then split. Rounding the remainder on its
    // own let 6.995h print as "6h 60m".
    const total = Math.round(hrs * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
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
  function rankCombinations(allParticipants, weights = WEIGHTS, fareProvider = getFare) {
    // Someone who has said they aren't coming must not shape the trip. They
    // were still pulling the dates, the destination tally, the average cost and
    // the budget warning: on the shipped seed group one decliner pushed "avg
    // per person" from $873 to $1,071, put THEIR fare at the top of the "across
    // the group" range the card calls the deciding traveller, named them in the
    // over-budget warning for a trip they had declined, and reordered the
    // runners-up. splitBaseFor was fixed for this; the ranking was not.
    // "no_response" still counts — they may yet come.
    const participants = (allParticipants || []).filter((p) => p.rsvp !== "out");
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
        // The APPLIED split of that per-head figure. The card used to explain
        // its headline with the raw inputs — the fare before the party and
        // season multipliers, the nightly band before the room factor and the
        // festive uplift — so the breakdown could total less than half the
        // number printed directly above it, and it was the breakdown people
        // budgeted from. These are the figures that actually add up.
        const perTravel = [];
        const perLodging = [];
        for (const p of participants) {
          if (!p.city) continue;
          const trip = tripCostFor(p.city, dest, dateRange, fareProvider, p.prefs);
          if (!trip) continue;
          const head = Math.max(1, trip.party);
          perBooking.push(trip.total);
          perPerson.push(trip.total / head);
          perTravel.push(trip.travel / head);
          perLodging.push(trip.lodging / head);
        }
        const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
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
          // Per head, with every multiplier already applied, so
          // travelApplied + lodgingApplied === avgTripCost.
          travelApplied: mean(perTravel),
          lodgingApplied: mean(perLodging),
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
          season: seasonFactorFor(dateRange).label,
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

  // ---------------------------------------------------------------------------
  // Invite-link merge
  // ---------------------------------------------------------------------------

  /**
   * Has this row ever been filled in, or is it a placeholder somebody typed on
   * another device? Decides whether a name is safe to match on.
   */
  function isUnclaimedParticipant(p) {
    const hasDates = (p.dates || []).some((d) => d && d.start);
    const hasDest = (p.destinations || []).some((d) => d);
    return !hasDates && !hasDest && (!p.rsvp || p.rsvp === "no_response");
  }

  /**
   * Merge participants arriving on an invite link into the local roster.
   *
   * Identity is the whole problem here. Links carry a participant id but
   * deliberately never carry an email, so across devices there are only two
   * signals: the id, and the name. Matching on name alone silently destroyed
   * data — two guests called "Sam" collapsed into one row, and whichever Sam
   * merged second overwrote the first's city, which is what drives their fare.
   *
   * So: match by id (including ids a row has been known by on other devices),
   * and fall back to the name only to let someone claim a row that was typed
   * FOR them and never filled in. A claimed row keeps its local id — expenses
   * and RSVPs already point at it — and remembers the incoming id as an alias,
   * so every later merge matches by id rather than by name again.
   *
   * Mutates `current` in place (the caller holds the live roster) and returns
   * a tally. `fromPayload` converts one wire row into a normalized participant.
   */
  function mergeParticipants(current, rows, fromPayload) {
    let added = 0;
    let updated = 0;
    const byId = new Map();
    current.forEach((p) => {
      byId.set(p.id, p);
      (p.aliasIds || []).forEach((a) => byId.set(a, p));
    });
    const byName = new Map();
    current.forEach((p) => {
      const key = (p.name || "").trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, p);
    });

    (rows || []).forEach((x) => {
      const nameKey = (x.n || "").trim().toLowerCase();
      const incoming = fromPayload(x);
      let existing = x.id ? byId.get(x.id) : null;
      let claiming = false;
      if (!existing && nameKey) {
        const sameName = byName.get(nameKey);
        // No id at all means a legacy link, where the name is all there is.
        if (sameName && (!x.id || isUnclaimedParticipant(sameName))) {
          existing = sameName;
          claiming = !!x.id && x.id !== sameName.id;
        }
      }
      if (!existing) {
        if (!nameKey) return; // nothing to identify them by
        current.push(incoming);
        byId.set(incoming.id, incoming);
        if (!byName.has(nameKey)) byName.set(nameKey, incoming);
        added += 1;
        return;
      }
      if (claiming) {
        existing.aliasIds = Array.from(
          new Set([...(existing.aliasIds || []), x.id])
        ).filter(Boolean);
        byId.set(x.id, existing);
      }
      // Never let a stale copy overwrite fresher answers.
      if ((incoming.updatedAt || 0) <= (existing.updatedAt || 0)) return;
      // A link deliberately carries no email address, so `incoming.email` is
      // always "". Assigning it blanked the local one — and since a returning
      // user is identified BY email, they then failed to match their own row
      // and got a duplicate, splitting their RSVP and expenses across two ids.
      // Nothing the payload cannot express may be cleared by a merge.
      const keep = {
        id: existing.id,
        email: incoming.email || existing.email || "",
        aliasIds: existing.aliasIds,
      };
      Object.assign(existing, incoming, keep);
      if (!keep.aliasIds) delete existing.aliasIds;
      updated += 1;
    });
    return { added, updated };
  }

  /**
   * The things a group has to do between agreeing a trip and leaving for it,
   * with the lead time each one really needs.
   *
   * The app stopped at "we locked it", which is where real trips start going
   * wrong: nobody tracks who has booked, a non-refundable deposit falls due,
   * and someone discovers at week three that their passport has four months
   * left and the airline won't board them. These are prompts with links, never
   * assertions — entry rules depend on nationality and change, and this app
   * cannot know either.
   */
  const PREP_STEPS = [
    {
      id: "passport",
      byDays: 90,
      title: "Check everyone's passport",
      detail:
        "Many countries refuse entry with under six months' validity left, and " +
        "a renewal can take weeks. Check the expiry date, not just that it exists.",
      international: true,
    },
    {
      id: "visa",
      byDays: 75,
      title: "Check whether anyone needs a visa",
      detail:
        "Requirements depend on each person's nationality, not the group's. " +
        "Some need an appointment booked months ahead.",
      international: true,
    },
    {
      id: "book-travel",
      byDays: 60,
      title: "Book flights or transport",
      detail: "Prices climb closer in, and the group loses the option of sitting together.",
    },
    {
      id: "book-stay",
      byDays: 60,
      title: "Book the accommodation",
      detail: "Confirm who is paying the deposit and how they get repaid.",
    },
    {
      id: "insurance",
      byDays: 30,
      title: "Sort travel insurance",
      detail:
        "Cover for cancellation usually has to be in place well before the trip " +
        "to pay out — buying it the week before is often too late.",
      international: true,
    },
    {
      id: "balance",
      byDays: 14,
      title: "Settle the outstanding balance",
      detail: "Final payments are usually due before arrival, not on the day.",
    },
    {
      id: "details",
      byDays: 7,
      title: "Share arrival times and addresses",
      detail: "Who lands when, where everyone is staying, and one contact number.",
    },
  ];

  /**
   * The country part of a "City, Country" label. Our US entries are
   * "New York, NY" — a two-letter state code, not a country — so those all
   * resolve to the US rather than to seven different countries.
   */
  // Matching any two-letter tail as a state made "London, UK" American.
  const US_STATES = new Set(
    ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN " +
     "MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA " +
     "WV WI WY PR").split(" ")
  );
  // The curated city table says "London, UK" and "New York, NY"; the live
  // autocomplete (Nominatim) says "Bath, United Kingdom" and "Chicago, United
  // States". Comparing the raw tails meant any group mixing the two vocabularies
  // read as crossing a border — so an all-UK weekend was told its passport check
  // and visa appointment were overdue. Crying wolf there is worse than saying
  // nothing, because it trains people to ignore the prompt on the trip where it
  // matters.
  const COUNTRY_ALIASES = {
    uk: "gb", "united kingdom": "gb", "great britain": "gb", england: "gb",
    scotland: "gb", wales: "gb", "northern ireland": "gb",
    usa: "us", "united states": "us", "united states of america": "us", america: "us",
    uae: "ae", "united arab emirates": "ae",
    india: "in", singapore: "sg", france: "fr", germany: "de", spain: "es",
    italy: "it", netherlands: "nl", ireland: "ie", portugal: "pt",
    australia: "au", "new zealand": "nz", canada: "ca", japan: "jp",
    china: "cn", "hong kong": "hk", thailand: "th", indonesia: "id",
    malaysia: "my", vietnam: "vn", philippines: "ph", "south korea": "kr",
    turkey: "tr", "türkiye": "tr", egypt: "eg", "south africa": "za",
    brazil: "br", mexico: "mx", switzerland: "ch", austria: "at",
    belgium: "be", greece: "gr", "sri lanka": "lk", nepal: "np",
    qatar: "qa", "saudi arabia": "sa", oman: "om", bahrain: "bh", kuwait: "kw",
  };
  function normalizeCountry(raw) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) return "";
    if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
    // A bare ISO code from the geocoder ("gb", "in") is already canonical.
    if (/^[a-z]{2}$/.test(key)) return key;
    return key;
  }
  function countryOf(city) {
    const parts = String(city || "").split(",");
    if (parts.length < 2) return normalizeCountry(parts[0]);
    const tail = parts[parts.length - 1].trim();
    if (US_STATES.has(tail.toUpperCase())) return "us";
    return normalizeCountry(tail);
  }

  /** True when anyone on the trip is crossing a border to get there. */
  function isInternationalTrip(participants, destination) {
    const to = countryOf(destination);
    if (!to) return false;
    return (participants || []).some(
      (p) => p.city && p.rsvp !== "out" && countryOf(p.city) !== to
    );
  }

  /**
   * Which prep steps apply, and how urgent each is now.
   * `international` steps are dropped for a domestic trip.
   */
  function prepStepsFor(daysToGo, isInternational) {
    return PREP_STEPS.filter((step) => isInternational || !step.international).map((step) => {
      const slack = daysToGo == null ? null : daysToGo - step.byDays;
      let urgency = "later";
      if (slack != null) {
        if (slack < 0) urgency = "overdue";
        else if (slack <= 14) urgency = "soon";
      }
      return { ...step, slack, urgency };
    });
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

  // ---------------------------------------------------------------------------
  // Expense splitting / settle-up
  // ---------------------------------------------------------------------------

  /** Who an expense is shared between by default: confirmed goers, else all. */
  function splitBaseFor(participants) {
    const goers = participants.filter((p) => p.rsvp === "in");
    if (goers.length >= 2) return goers;
    // Before two people have confirmed, fall back to everyone who has not
    // actually declined. Falling back to the WHOLE roster charged people who
    // had already said no; and because addExpense pins the base into the
    // expense forever, a 12-person deposit logged one RSVP earlier pinned at
    // 12 ways and a minute later at 2 — neither of which is ever recomputed.
    const notOut = participants.filter((p) => p.rsvp !== "out");
    return notOut.length ? notOut : participants;
  }

  /**
   * Work out who owes whom. Pure so it can be tested — this is the only code in
   * the app that decides real money between real people.
   *
   * @param participants roster (used for the default split and to detect
   *                     people who have been removed)
   * @param expenses     [{ id, payerId, amount, sharedWith?, settlement? }]
   */
  function computeSettlement(participants, expenses) {
    const base = splitBaseFor(participants);
    const baseIds = base.map((p) => p.id);
    // Settlements move money between people; they are not new group spend.
    // Counting them inflated the trip total every time someone paid a debt.
    const spend = expenses.filter((x) => !x.settlement);
    const total = spend.reduce((s, x) => s + x.amount, 0);
    const paid = {};
    const owed = {};
    expenses.forEach((x) => {
      paid[x.payerId] = (paid[x.payerId] || 0) + x.amount;
      // Whoever an expense was pinned to at the time still owes their share,
      // whether or not they are on the roster now. Filtering to current members
      // rewrote settled history: removing a dropout quietly moved their share
      // onto everyone else, and removing a payer re-pointed a REPAYMENT at the
      // person who made it — so someone who had already handed over $300 was
      // then billed $450, more than before they paid. Leaving is not the same
      // as never having owed anything; forgiving a debt is a decision the group
      // has to make explicitly, not a side effect of tidying the roster.
      let sharers =
        Array.isArray(x.sharedWith) && x.sharedWith.length ? x.sharedWith : baseIds;
      // A settlement is one person repaying another. It must never collapse
      // onto its own payer, which would cancel the repayment entirely.
      if (!sharers.length) sharers = x.settlement ? [] : [x.payerId];
      if (!sharers.length) return;
      // Largest-remainder allocation in whole cents. A plain division leaves
      // orphan cents ($100 across 3 shows three $33.33s against a $100 total),
      // which makes a settle-up list quietly fail to balance.
      const cents = Math.round(x.amount * 100);
      const per = Math.floor(cents / sharers.length);
      const remainder = cents - per * sharers.length;
      sharers.forEach((id, i) => {
        owed[id] = (owed[id] || 0) + (per + (i < remainder ? 1 : 0)) / 100;
      });
    });
    // Divide by the people the money was actually allocated to, not by the
    // current roster. The two diverge as soon as anyone's RSVP changes — which
    // is the normal life of a trip. A 12-way £6,000 deposit followed by four
    // people dropping out printed "£750.00 avg per person" above eleven rows
    // that all said £500, so a treasurer chased the wrong number from everyone.
    const chargedIds = Object.keys(owed);
    const divisor = chargedIds.length || base.length;
    const share = divisor ? Math.round((total / divisor) * 100) / 100 : 0;
    const shareExact = divisor ? Math.round(total * 100) % divisor === 0 : true;
    const balances = new Map();
    const inBase = new Set(baseIds);
    // Anyone still on the roster, anyone who PAID, and anyone who OWES. Dropping
    // a removed payer lost their credit while still charging everyone else;
    // dropping a removed debtor left the creditor holding a balance with no
    // transfer against it, so the list stopped adding up and the gap was
    // unexplained. Someone who has left still appears until their debt is
    // settled or explicitly written off.
    const relevant = new Set([
      ...participants.map((p) => p.id),
      ...Object.keys(paid),
      ...Object.keys(owed),
    ]);
    relevant.forEach((id) => {
      const b = (paid[id] || 0) - (owed[id] || 0);
      if (Math.abs(b) > 0.005 || inBase.has(id)) balances.set(id, b);
    });
    // Greedy settle-up: biggest debtor pays biggest creditor.
    const debtors = [];
    const creditors = [];
    balances.forEach((b, id) => {
      if (b < -0.01) debtors.push({ id, amt: -b });
      else if (b > 0.01) creditors.push({ id, amt: b });
    });
    debtors.sort((a, b) => b.amt - a.amt);
    creditors.sort((a, b) => b.amt - a.amt);
    const transfers = [];
    let di = 0;
    let ci = 0;
    while (di < debtors.length && ci < creditors.length) {
      const pay = Math.min(debtors[di].amt, creditors[ci].amt);
      transfers.push({ from: debtors[di].id, to: creditors[ci].id, amount: pay });
      debtors[di].amt -= pay;
      creditors[ci].amt -= pay;
      if (debtors[di].amt < 0.01) di += 1;
      if (creditors[ci].amt < 0.01) ci += 1;
    }
    // chargedIds: who the money was actually allocated to. The UI needs it to
    // decide whether "each" is true — comparing LENGTHS let it print a definite
    // "$150.00 each" for a $300 dinner split between Ana and Bob after Ana was
    // removed, telling Cara she owed $150 when she owed nothing.
    return { total, share, shareExact, base, balances, transfers, spend, chargedIds };
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
    isUnclaimedParticipant,
    mergeParticipants,
    PREP_STEPS,
    prepStepsFor,
    countryOf,
    normalizeCountry,
    isInternationalTrip,
    convertFromUSD,
    toUSD,
    formatExact,
    formatMoney,
    formatRange,
    // geo/cost
    resolveCity,
    distanceMiles,
    estimateFare,
    getFare,
    flightTimeHours,
    journeyHours,
    driveTimeHours,
    formatHours,
    seasonFactorFor,
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
    splitBaseFor,
    computeSettlement,
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
