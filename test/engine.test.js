/**
 * engine.test.js — regression tests for the pure scoring engine.
 *
 * engine.js decides which date + destination the whole group ends up with, so a
 * silent change here quietly changes real people's plans. These tests pin the
 * behaviour that matters.
 *
 * Run with:  node --test test/
 * (No dependencies — data.js/engine.js attach to `window`, so we provide a
 * minimal shim and load them as plain scripts.)
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");


// ---- Load data.js + engine.js in a shared fake-browser context -------------
// Run them in THIS realm (vm.runInThisContext, not a fresh context) so arrays
// they return share Node's own Array.prototype — otherwise deepStrictEqual
// fails on cross-realm prototypes even when the values match.
const root = path.join(__dirname, "..");
globalThis.window = globalThis.window || {};
for (const file of ["data.js", "engine.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
}
const D = globalThis.window.ReunlyData;
const E = globalThis.window.ReunlyEngine;

// ---- Helpers ---------------------------------------------------------------
/** Build a participant without needing the full factory signature. */
function person(over = {}) {
  return D.normalizeParticipant(Object.assign({ id: "p_" + Math.random() }, over));
}
/** Deterministic fare provider so tests never depend on distance math. */
function fixedFares(table, fallback = { min: 100, max: 100, source: "estimated" }) {
  return (from, to) => table[`${from}|${to}`] || fallback;
}

// ---- rankPoints ------------------------------------------------------------
test("rankPoints decays 3,2,1 then floors at 1 so late choices still count", () => {
  assert.strictEqual(E.rankPoints(0), 3);
  assert.strictEqual(E.rankPoints(1), 2);
  assert.strictEqual(E.rankPoints(2), 1);
  assert.strictEqual(E.rankPoints(3), 1, "4th choice must not be worth zero");
  assert.strictEqual(E.rankPoints(9), 1, "10th choice must not be worth zero");
});

// ---- Date range helpers ----------------------------------------------------
test("isValidRange requires both ends and rejects a backwards range", () => {
  assert.ok(E.isValidRange({ start: "2026-08-01", end: "2026-08-05" }));
  assert.ok(!E.isValidRange({ start: "2026-08-01", end: "" }));
  assert.ok(!E.isValidRange({ start: "", end: "2026-08-05" }));
  assert.ok(!E.isValidRange({ start: "2026-08-09", end: "2026-08-02" }));
});

test("rangesOverlap matches partial overlaps, not just identical ranges", () => {
  const a = { start: "2026-08-01", end: "2026-08-10" };
  assert.ok(E.rangesOverlap(a, { start: "2026-08-08", end: "2026-08-20" }), "partial overlap");
  assert.ok(E.rangesOverlap(a, { start: "2026-08-10", end: "2026-08-11" }), "touching edge");
  assert.ok(!E.rangesOverlap(a, { start: "2026-08-11", end: "2026-08-20" }), "adjacent, no overlap");
});

// ---- Date window maths -----------------------------------------------------
test("rangeDays counts inclusively", () => {
  assert.strictEqual(E.rangeDays({ start: "2026-08-01", end: "2026-08-01" }), 1);
  assert.strictEqual(E.rangeDays({ start: "2026-08-01", end: "2026-08-07" }), 7);
  assert.strictEqual(E.rangeDays({ start: "", end: "" }), 0);
});

test("rangeIntersection finds the shared window", () => {
  const shared = E.rangeIntersection(
    { start: "2026-12-19", end: "2026-12-26" },
    { start: "2026-12-22", end: "2026-12-29" }
  );
  assert.deepStrictEqual(shared, { start: "2026-12-22", end: "2026-12-26" });
  assert.strictEqual(E.overlapDays({ start: "2026-12-19", end: "2026-12-26" }, { start: "2026-12-22", end: "2026-12-29" }), 5);
  assert.strictEqual(
    E.rangeIntersection({ start: "2026-08-01", end: "2026-08-05" }, { start: "2026-09-01", end: "2026-09-05" }),
    null
  );
});

test("dateCandidatesFor proposes the mutual window nobody typed", () => {
  // The whole point: Ann and Bob never entered Dec 22-26, but that's the
  // window a human organiser would suggest immediately.
  const people = [
    person({ dates: [{ start: "2026-12-19", end: "2026-12-26" }] }),
    person({ dates: [{ start: "2026-12-22", end: "2026-12-29" }] }),
  ];
  const cands = E.dateCandidatesFor(people);
  const labels = cands.map((c) => `${c.start}..${c.end}`);
  assert.ok(labels.includes("2026-12-22..2026-12-26"), `expected the overlap, got ${labels.join(" | ")}`);
  assert.ok(labels.includes("2026-12-19..2026-12-26"), "originals must still be candidates");
});

test("candidate generation stays bounded on a hostile-sized group", () => {
  // Pairing is O(n^2) in submitted ranges. Unbounded, 60 people x 12 distinct
  // ranges produced ~28,000 candidates and blocked the main thread for ~105
  // SECONDS — reachable from a crafted invite link, so this is a DoS guard,
  // not a nicety. sanitizePayload permits exactly these dimensions.
  const people = [];
  let k = 0;
  for (let i = 0; i < 60; i++) {
    const dates = [];
    for (let j = 0; j < 12; j++) {
      const start = new Date(Date.UTC(2026, 0, 1 + k));
      const end = new Date(Date.UTC(2026, 0, 41 + k));
      k += 1;
      dates.push({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
    }
    people.push(person({ city: "London, UK", destinations: ["Goa, India", "Bali, Indonesia"], dates }));
  }
  const candidates = E.dateCandidatesFor(people);
  assert.ok(candidates.length <= 60, `expected <=60 candidates, got ${candidates.length}`);
  const started = Date.now();
  const combos = E.rankCombinations(people);
  const elapsed = Date.now() - started;
  assert.ok(combos.length > 0, "still produces a ranking");
  assert.ok(elapsed < 3000, `ranking took ${elapsed}ms — the O(n^2) blow-up is back`);
});

test("dateCandidatesFor ignores slivers below the minimum", () => {
  // A single shared day isn't a trip; don't pollute the candidate list.
  const people = [
    person({ dates: [{ start: "2026-08-01", end: "2026-08-05" }] }),
    person({ dates: [{ start: "2026-08-05", end: "2026-08-10" }] }),
  ];
  const labels = E.dateCandidatesFor(people).map((c) => `${c.start}..${c.end}`);
  assert.ok(!labels.includes("2026-08-05..2026-08-05"), "1-day sliver should be skipped");
});

test("a one-night stopover can't win a long-haul trip", () => {
  // Regression: coverage-weighted date scoring made SHORT windows trivially
  // "fully attendable" (everyone covers 100% of a single day) and short stays
  // are also cheapest — so the engine happily proposed flying 16 hours to Bali
  // for one night, beating both real week-long windows.
  const people = [
    person({ city: "London, UK", destinations: ["Bali, Indonesia"], dates: [{ start: "2026-12-19", end: "2026-12-23" }] }),
    person({ city: "New York, NY", destinations: ["Bali, Indonesia"], dates: [{ start: "2026-12-22", end: "2026-12-29" }] }),
  ];
  const combos = E.rankCombinations(people);
  const top = combos[0];
  assert.ok(top.nights >= 3, `top pick was only ${top.nights} night(s): ${top.dateLabel}`);
  const stopover = combos.find((c) => c.nights === 1);
  if (stopover) {
    assert.ok(stopover.total < top.total, "a 1-night long-haul must not outrank a real stay");
    assert.ok(stopover.viability < 1, "an unviable stay should be marked as such");
  }
});

test("a one-day local event is not treated as an unviable trip", () => {
  // A wedding, birthday or match is legitimately a single day. The viability
  // rule (added for long-haul stopovers) must not veto them.
  const day = [{ start: "2027-02-13", end: "2027-02-13" }];
  const people = [
    person({ city: "Mumbai, India", destinations: ["Pune, India"], dates: day }),
    person({ city: "Pune, India", destinations: ["Pune, India"], dates: day }),
  ];
  const top = E.rankCombinations(people)[0];
  assert.strictEqual(top.viability, 1, "a local day event needs no overnight");
  assert.strictEqual(top.nights, 0);
});

test("a window someone actually proposed is discounted, never vetoed", () => {
  // We invent overlap windows, so a derived sliver deserves the full check —
  // but a range a person deliberately entered is a stated preference.
  const people = [
    person({ city: "London, UK", destinations: ["Bali, Indonesia"], dates: [{ start: "2026-12-19", end: "2026-12-23" }] }),
    person({ city: "New York, NY", destinations: ["Bali, Indonesia"], dates: [{ start: "2026-12-22", end: "2026-12-29" }] }),
  ];
  const combos = E.rankCombinations(people);
  const submitted = combos.find((c) => c.dateRange.start === "2026-12-19" && c.dateRange.end === "2026-12-23");
  const derived = combos.find((c) => c.nights === 1);
  assert.ok(submitted.viability >= 0.85, "a proposed window keeps most of its score");
  assert.ok(derived.viability <= 0.25, "a derived sliver is still clearly beaten");
});

test("viability doesn't punish a short trip that needs no flying", () => {
  // The same rule must not make a weekend away look unreasonable.
  const people = [
    person({ city: "London, UK", destinations: ["Paris, France"], dates: [{ start: "2026-08-01", end: "2026-08-03" }] }),
    person({ city: "Paris, France", destinations: ["Paris, France"], dates: [{ start: "2026-08-01", end: "2026-08-03" }] }),
  ];
  const top = E.rankCombinations(people)[0];
  assert.strictEqual(top.viability, 1, "a 2-night trip next door is perfectly sensible");
});

test("cost ranks on the all-in figure, not airfare alone", () => {
  // Cheap to reach but expensive to sleep in must not read as the bargain.
  const dates = [{ start: "2026-08-01", end: "2026-08-08" }];
  // Everyone travels to BOTH candidates — nobody lives in either. A resident
  // here would (correctly) pay no lodging at home, which would prove nothing
  // about whether lodging is counted for the people who do travel.
  const people = [
    person({ city: "Paris, France", destinations: ["London, UK", "Goa, India"], dates }),
    person({ city: "Manchester, UK", destinations: ["Goa, India", "London, UK"], dates }),
  ];
  // Nearby London has the cheaper flight; far Goa is far cheaper to stay in.
  const fares = fixedFares({
    "Paris, France|London, UK": { min: 100, max: 100, source: "estimated" },
    "Manchester, UK|London, UK": { min: 100, max: 100, source: "estimated" },
    "Paris, France|Goa, India": { min: 600, max: 600, source: "estimated" },
    "Manchester, UK|Goa, India": { min: 600, max: 600, source: "estimated" },
  });
  const combos = E.rankCombinations(people, undefined, fares);
  const london = combos.find((c) => c.destination === "London, UK");
  const goa = combos.find((c) => c.destination === "Goa, India");
  assert.ok(london.avgFare < goa.avgFare, "London is the cheaper flight");
  assert.ok(
    london.avgTripCost > goa.avgTripCost,
    "but 7 nights in London outweighs the airfare saving"
  );
  assert.ok(goa.relCostScore > london.relCostScore, "cost score must follow the all-in figure");
});

test("a window everyone fully covers beats one only partly covered", () => {
  // Both are real candidates; the mutual window should win because everyone
  // can make all of it, whereas the longer window only suits one person fully.
  const people = [
    person({ city: "London, UK", destinations: ["Rome"], dates: [{ start: "2026-12-19", end: "2026-12-26" }] }),
    person({ city: "Paris, France", destinations: ["Rome"], dates: [{ start: "2026-12-22", end: "2026-12-29" }] }),
  ];
  const combos = E.rankCombinations(people, undefined, fixedFares({}));
  const top = combos[0];
  assert.strictEqual(top.dateRange.start, "2026-12-22");
  assert.strictEqual(top.dateRange.end, "2026-12-26");
});

test("partial availability scores below full availability", () => {
  const week = { start: "2026-08-01", end: "2026-08-07" };
  const fullyFree = [
    person({ city: "London, UK", destinations: ["Rome"], dates: [week] }),
    person({ city: "Paris, France", destinations: ["Rome"], dates: [week] }),
  ];
  const partly = [
    person({ city: "London, UK", destinations: ["Rome"], dates: [week] }),
    // Only overlaps one day of the candidate week.
    person({ city: "Paris, France", destinations: ["Rome"], dates: [{ start: "2026-08-07", end: "2026-08-12" }] }),
  ];
  const a = E.rankCombinations(fullyFree, undefined, fixedFares({})).find(
    (c) => c.dateRange.start === "2026-08-01" && c.dateRange.end === "2026-08-07"
  );
  const b = E.rankCombinations(partly, undefined, fixedFares({})).find(
    (c) => c.dateRange.start === "2026-08-01" && c.dateRange.end === "2026-08-07"
  );
  assert.ok(a.dateScore > b.dateScore, "one shared day must not count as a full week");
});

// ---- Tallies ---------------------------------------------------------------
test("tallyDestinations ranks by weighted points, not raw vote count", () => {
  // "Rome" is one person's top pick (3pts); "Oslo" is two people's 3rd (1+1).
  const people = [
    person({ destinations: ["Rome", "x", "Oslo"] }),
    person({ destinations: ["y", "z", "Oslo"] }),
  ];
  const tally = E.tallyDestinations(people);
  const rome = tally.find((t) => t.destination === "Rome");
  const oslo = tally.find((t) => t.destination === "Oslo");
  assert.strictEqual(rome.points, 3);
  assert.strictEqual(oslo.points, 2);
  assert.strictEqual(oslo.votes, 2, "Oslo still records two mentions");
  assert.ok(tally[0].destination === "Rome", "higher points ranks first");
});

test("tallyDestinations groups case/whitespace variants together", () => {
  const people = [person({ destinations: ["Paris"] }), person({ destinations: [" paris "] })];
  const tally = E.tallyDestinations(people);
  assert.strictEqual(tally.length, 1, "should not split into two destinations");
  assert.strictEqual(tally[0].votes, 2);
});

test("tallies ignore blank entries", () => {
  const people = [person({ destinations: ["", "  ", "Lisbon"] })];
  assert.strictEqual(E.tallyDestinations(people).length, 1);
  const noDates = [person({ dates: [{ start: "", end: "" }] })];
  assert.strictEqual(E.tallyDates(noDates).length, 0);
});

// ---- Edge cases that must not throw ---------------------------------------
test("rankCombinations returns [] instead of throwing on empty input", () => {
  assert.deepStrictEqual(E.rankCombinations([]), []);
  assert.deepStrictEqual(E.rankCombinations([person({})]), [], "no dates or destinations");
  assert.deepStrictEqual(
    E.rankCombinations([person({ destinations: ["Rome"] })]),
    [],
    "destination but no valid dates"
  );
});

test("rankCombinations works with a single participant", () => {
  const solo = [
    person({
      city: "London, UK",
      destinations: ["Rome"],
      dates: [{ start: "2026-08-01", end: "2026-08-05" }],
    }),
  ];
  const combos = E.rankCombinations(solo, undefined, fixedFares({}));
  assert.strictEqual(combos.length, 1);
  assert.strictEqual(combos[0].destination, "Rome");
  assert.ok(combos[0].total > 0);
});

// ---- Scoring behaviour -----------------------------------------------------
test("a date everyone can make outranks one only some can", () => {
  const shared = { start: "2026-08-01", end: "2026-08-05" };
  const onlyOne = { start: "2026-12-01", end: "2026-12-05" };
  const people = [
    person({ city: "London, UK", destinations: ["Rome"], dates: [shared] }),
    person({ city: "Paris, France", destinations: ["Rome"], dates: [shared, onlyOne] }),
  ];
  const combos = E.rankCombinations(people, undefined, fixedFares({}));
  assert.strictEqual(combos[0].dateLabel, E.rangeLabel(shared));
  assert.ok(
    combos[0].dateScore > combos[combos.length - 1].dateScore,
    "shared date must score higher than the one-person date"
  );
});

// ---- Budget awareness (the fix these tests exist to protect) ---------------
test("budgetFitFor returns null when nobody stated a budget", () => {
  const people = [person({ city: "London, UK", destinations: ["Rome"] })];
  assert.strictEqual(E.budgetFitFor("Rome", people, fixedFares({})), null);
});

test("budgetFitFor flags people whose fare exceeds their stated budget", () => {
  const people = [
    person({ name: "Skint", city: "London, UK", prefs: { budget: "100" } }),
    person({ name: "Flush", city: "Paris, France", prefs: { budget: "5000" } }),
  ];
  const fares = fixedFares({
    "London, UK|Rome": { min: 900, max: 900, source: "estimated" },
    "Paris, France|Rome": { min: 900, max: 900, source: "estimated" },
  });
  const fit = E.budgetFitFor("Rome", people, fares);
  assert.strictEqual(fit.overCount, 1);
  assert.deepStrictEqual(fit.overNames, ["Skint"]);
  assert.strictEqual(fit.checked, 2);
  assert.ok(fit.fit < 1, "someone over budget must drag the fit below perfect");
});

test("an affordable destination outranks one that busts stated budgets", () => {
  // Both destinations are equally popular and share the same dates, so the
  // ONLY differentiator is affordability against what people said they'd spend.
  // Budgets are all-in (travel + lodging), so they're sized to cover a 4-night
  // stay at the unlisted-city default (~$70-130/night) plus the cheap fare.
  const dates = [{ start: "2026-08-01", end: "2026-08-05" }];
  const people = [
    person({ name: "A", city: "London, UK", destinations: ["Cheapville", "Pricey"], dates, prefs: { budget: "1200" } }),
    person({ name: "B", city: "Paris, France", destinations: ["Pricey", "Cheapville"], dates, prefs: { budget: "1200" } }),
  ];
  const fares = fixedFares({
    "London, UK|Cheapville": { min: 150, max: 150, source: "estimated" },
    "Paris, France|Cheapville": { min: 150, max: 150, source: "estimated" },
    "London, UK|Pricey": { min: 900, max: 900, source: "estimated" },
    "Paris, France|Pricey": { min: 900, max: 900, source: "estimated" },
  });
  const combos = E.rankCombinations(people, undefined, fares);
  assert.strictEqual(combos[0].destination, "Cheapville");
  assert.strictEqual(combos[0].overBudgetCount, 0);
  const pricey = combos.find((c) => c.destination === "Pricey");
  assert.strictEqual(pricey.overBudgetCount, 2, "both travellers are over budget");
});

test("peak seasons cost more than quiet ones", () => {
  // Fares and lodging were completely date-blind, so a Christmas trip priced
  // the same as mid-February — and the app's own examples default to exactly
  // that peak window.
  const fares = fixedFares({ "London, UK|Goa, India": { min: 400, max: 400, source: "estimated" } });
  const quiet = E.tripCostFor("London, UK", "Goa, India", { start: "2026-05-04", end: "2026-05-11" }, fares);
  const xmas = E.tripCostFor("London, UK", "Goa, India", { start: "2026-12-20", end: "2026-12-27" }, fares);
  assert.ok(xmas.total > quiet.total, "Christmas week must not price like May");
  assert.strictEqual(quiet.season, null, "an ordinary week carries no peak label");
  assert.ok(/Christmas/i.test(xmas.season), "the peak is named so the UI can say why");
});

test("a fare quoted for these dates isn't scaled by our seasonal guess", () => {
  // A live quote FOR this departure already reflects that departure's season;
  // multiplying it would corrupt observed data.
  const live = fixedFares({
    "London, UK|Goa, India":
      { min: 500, max: 500, source: "live", quotedFor: "2026-12-20" },
  });
  const xmas = E.tripCostFor("London, UK", "Goa, India", { start: "2026-12-20", end: "2026-12-27" }, live);
  assert.strictEqual(xmas.travel, 500, "a quote for these dates stays exactly as observed");
});

test("a captured fare with no departure date is still seasonally adjusted", () => {
  // The curated SEARCHED_FARES table was captured once, months ago, with no
  // departure attached — `asOf` is when we looked it up, not what it priced.
  // Treating that as "already seasonal" let those routes escape the Christmas
  // uplift entirely while every estimated fare paid it, handing the handful of
  // curated destinations a standing advantage in a 40%-weighted cost score.
  const searched = fixedFares({
    "London, UK|Goa, India": { min: 500, max: 500, source: "searched" },
  });
  const quiet = E.tripCostFor("London, UK", "Goa, India", { start: "2026-05-04", end: "2026-05-11" }, searched);
  const xmas = E.tripCostFor("London, UK", "Goa, India", { start: "2026-12-20", end: "2026-12-27" }, searched);
  assert.strictEqual(quiet.travel, 500, "off-peak is the captured figure");
  assert.ok(xmas.travel > quiet.travel, "an unknown season must not be assumed to be this one");
  assert.ok(xmas.lodging > quiet.lodging, "and our own lodging estimate still moves");
});

test("a lone adult isn't charged half a room", () => {
  // The nightly bands are quoted per person SHARING a twin; a solo traveller
  // pays most of the room, not half of it.
  const fares = fixedFares({ "London, UK|Goa, India": { min: 300, max: 300, source: "estimated" } });
  const win = { start: "2026-05-04", end: "2026-05-08" };
  const solo = E.tripCostFor("London, UK", "Goa, India", win, fares, { kids: 0 });
  const band = E.estimateLodging("Goa, India", 4);
  const shared = (band.min + band.max) / 2;
  assert.ok(solo.lodging > shared, "solo occupancy costs more than a shared rate");
});

test("estimateLodging scales with nights and knows pricey vs value cities", () => {
  const oneNight = E.estimateLodging("London, UK", 1);
  const threeNights = E.estimateLodging("London, UK", 3);
  assert.ok(threeNights.min > oneNight.min, "more nights must cost more");
  assert.strictEqual(threeNights.min, oneNight.min * 3);
  // A value destination should undercut an expensive one for the same stay.
  const goa = E.estimateLodging("Goa, India", 3);
  assert.ok(goa.max < threeNights.max, "Goa should be cheaper than London");
  assert.strictEqual(E.estimateLodging("London, UK", 0), null);
});

test("tripCostFor adds lodging on top of travel", () => {
  const fares = fixedFares({ "London, UK|Goa, India": { min: 400, max: 400, source: "estimated" } });
  // 2026-08-01..2026-08-05 is 5 inclusive days = 4 nights slept.
  // Use an off-peak window so the seasonal multiplier doesn't muddy the point.
  const trip = E.tripCostFor("London, UK", "Goa, India", { start: "2026-05-04", end: "2026-05-08" }, fares);
  assert.strictEqual(trip.travel, 400);
  assert.strictEqual(trip.nights, 4);
  assert.ok(trip.lodging > 0, "lodging must be counted");
  assert.strictEqual(trip.total, trip.travel + trip.lodging);
});

test("a cheap flight to a pricey city can still bust the budget once lodging counts", () => {
  // The whole point of including lodging: airfare alone said "affordable".
  const dates = [{ start: "2026-08-01", end: "2026-08-08" }]; // 7 nights
  const people = [
    person({ name: "A", city: "Paris, France", destinations: ["London, UK"], dates, prefs: { budget: "500" } }),
  ];
  const fares = fixedFares({ "Paris, France|London, UK": { min: 120, max: 120, source: "estimated" } });
  const combos = E.rankCombinations(people, undefined, fares);
  const top = combos[0];
  assert.ok(top.avgTripCost > top.avgFare, "all-in cost must exceed the fare alone");
  assert.strictEqual(top.overBudgetCount, 1, "£120 flight + 7 nights in London busts a 500 budget");
});

test("combos carry lodging + all-in figures for the UI", () => {
  const dates = [{ start: "2026-08-01", end: "2026-08-05" }];
  const people = [
    person({ city: "London, UK", destinations: ["Goa, India"], dates }),
    person({ city: "Paris, France", destinations: ["Goa, India"], dates }),
  ];
  const combos = E.rankCombinations(people, undefined, fixedFares({}));
  const top = combos[0];
  assert.strictEqual(top.nights, 4);
  assert.ok(top.lodgingMin > 0 && top.lodgingMax > top.lodgingMin);
  assert.ok(top.avgTripCost > top.avgFare);
});

test("budget fit leaves headroom for the costs it doesn't count", () => {
  // The all-in figure excludes food, local transport and activities. Spending
  // ~75% of a budget on travel + beds must NOT read as comfortable.
  const dates = { start: "2026-08-01", end: "2026-08-08" }; // 7 nights
  const fares = fixedFares({ "London, UK|Goa, India": { min: 400, max: 400, source: "estimated" } });
  const trip = E.tripCostFor("London, UK", "Goa, India", dates, fares, {});
  // Pick a budget where the trip eats ~75% of it.
  const budget = String(Math.round(trip.total / 0.75));
  const people = [person({ name: "A", city: "London, UK", destinations: ["Goa, India"], dates: [dates], prefs: { budget } })];
  const fit = E.budgetFitFor("Goa, India", people, fares, dates);
  assert.ok(fit.fit < 1, `75% of budget on travel+stay should not score full marks (got ${fit.fit})`);
  assert.strictEqual(fit.overCount, 0, "but it isn't over budget either");
});

test("combos expose budget fields so the UI can warn before locking", () => {
  const dates = [{ start: "2026-08-01", end: "2026-08-05" }];
  const people = [person({ name: "A", city: "London, UK", destinations: ["Rome"], dates, prefs: { budget: "100" } })];
  const fares = fixedFares({ "London, UK|Rome": { min: 800, max: 800, source: "estimated" } });
  const c = E.rankCombinations(people, undefined, fares)[0];
  assert.ok(c.budgetFit != null, "budgetFit must be populated when a budget exists");
  assert.deepStrictEqual(c.overBudgetNames, ["A"]);
  assert.ok(typeof c.relCostScore === "number", "relative cost kept separately for honest copy");
});

test("scoring stays neutral (no crash, no fake signal) when budgets are absent", () => {
  const dates = [{ start: "2026-08-01", end: "2026-08-05" }];
  const people = [person({ city: "London, UK", destinations: ["Rome"], dates })];
  const c = E.rankCombinations(people, undefined, fixedFares({}))[0];
  assert.strictEqual(c.budgetFit, null);
  assert.strictEqual(c.overBudgetCount, 0);
  assert.strictEqual(c.costScore, c.relCostScore, "falls back to the relative measure alone");
});

test("one priced-out traveller caps the budget fit, even among comfortable ones", () => {
  // An average would let four comfortable travellers hide the one person who
  // literally can't afford it — the exact case this check exists to catch.
  const people = [
    person({ name: "Rich1", city: "London, UK", prefs: { budget: "5000" } }),
    person({ name: "Rich2", city: "Paris, France", prefs: { budget: "5000" } }),
    person({ name: "Rich3", city: "Rome", prefs: { budget: "5000" } }),
    person({ name: "Rich4", city: "Madrid", prefs: { budget: "5000" } }),
    person({ name: "Skint", city: "Berlin", prefs: { budget: "100" } }),
  ];
  const fit = E.budgetFitFor("Somewhere", people, fixedFares({}, { min: 300, max: 300, source: "estimated" }));
  assert.strictEqual(fit.overCount, 1);
  assert.deepStrictEqual(fit.overNames, ["Skint"]);
  assert.ok(
    fit.fit < 0.6,
    "must stay below the 'fits stated budgets' threshold so the UI can't contradict its own warning"
  );
});

// ---- Participant normalization --------------------------------------------
test("normalizeParticipant always assigns an id, even with none supplied", () => {
  // Invite-link payloads carry no ids. Without one, a participant can't be
  // referenced by expenses, votes or RSVP — they silently break.
  const fromLink = D.normalizeParticipant({ name: "NewPerson", city: "Paris, France" });
  assert.ok(fromLink.id, "must generate an id");
  const explicitUndefined = D.normalizeParticipant({ id: undefined, name: "X" });
  assert.ok(explicitUndefined.id, "explicit undefined id must not survive");
  const kept = D.normalizeParticipant({ id: "p_keepme", name: "Y" });
  assert.strictEqual(kept.id, "p_keepme", "an existing id must be preserved");
  const a = D.normalizeParticipant({ name: "A" });
  const b = D.normalizeParticipant({ name: "B" });
  assert.notStrictEqual(a.id, b.id, "generated ids must be unique");
});

// ---- Money formatting ------------------------------------------------------
test("currency conversion uses the configured rate", () => {
  const gbp = E.convertFromUSD(100, "GBP");
  assert.ok(Math.abs(gbp - 100 * D.CURRENCIES.GBP.rate) < 0.001);
  assert.strictEqual(E.convertFromUSD(100, "USD"), 100);
  assert.strictEqual(E.convertFromUSD(100, "NOPE"), 100, "unknown code must not NaN");
});

test("summarizePrefs rolls up budgets and flags without crashing on blanks", () => {
  const people = [
    person({ prefs: { budget: "100", kids: 2, accommodation: true } }),
    person({ prefs: { budget: "", kids: 0 } }), // never answered -> needs a bed
    person({ prefs: { budget: "300", accommodation: false } }), // sorted
  ];
  const s = E.summarizePrefs(people);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.budgets.length, 2, "blank budget is skipped, not counted as 0");
  assert.strictEqual(s.minBudget, 100);
  assert.strictEqual(s.maxBudget, 300);
  assert.strictEqual(s.kids, 2);
  // Only an explicit "I'm sorted" opts out; silence must not be read as one.
  assert.strictEqual(s.accommodation, 2);
});

test("lodging is only skipped when someone explicitly opts out", () => {
  const dates = { start: "2026-08-01", end: "2026-08-05" };
  const fares = fixedFares({ "London, UK|Goa, India": { min: 200, max: 200, source: "estimated" } });
  const unanswered = E.tripCostFor("London, UK", "Goa, India", dates, fares, { accommodation: null });
  const sorted = E.tripCostFor("London, UK", "Goa, India", dates, fares, { accommodation: false });
  assert.ok(unanswered.lodging > 0, "silence must not zero out lodging");
  assert.strictEqual(sorted.lodging, 0, "an explicit opt-out skips lodging");
});

test("a parent with kids is costed for the whole party", () => {
  const dates = { start: "2026-08-01", end: "2026-08-05" };
  const fares = fixedFares({ "London, UK|Goa, India": { min: 300, max: 300, source: "estimated" } });
  const solo = E.tripCostFor("London, UK", "Goa, India", dates, fares, { kids: 0 });
  const family = E.tripCostFor("London, UK", "Goa, India", dates, fares, { kids: 2 });
  assert.strictEqual(solo.party, 1);
  assert.strictEqual(family.party, 3);
  assert.strictEqual(family.travel, solo.travel * 3, "three seats, not one");
  assert.ok(family.lodging > solo.lodging, "a bigger room costs more");
  assert.ok(family.total > solo.total * 2, "a family of three is not a rounding error");
});

// ---- Settle-up (real money, so pin the edge cases) --------------------------
/** Roster helper: everyone confirmed "in". */
function goers(...names) {
  return names.map((n) => person({ id: n, name: n, rsvp: "in" }));
}
const sumTransfers = (t) => t.reduce((s, x) => s + x.amount, 0);

test("an even split leaves nobody owing anything", () => {
  const people = goers("a", "b");
  const r = E.computeSettlement(people, [
    { id: "x1", payerId: "a", amount: 100, sharedWith: ["a", "b"] },
    { id: "x2", payerId: "b", amount: 100, sharedWith: ["a", "b"] },
  ]);
  assert.strictEqual(r.total, 200);
  assert.strictEqual(r.transfers.length, 0, "square already — no transfers");
});

test("an indivisible amount still balances to the cent", () => {
  // $100 across 3 was the reported symptom: three $33.33 shares against a
  // $100 total, so the ledger silently failed to reconcile.
  const people = goers("a", "b", "c");
  const r = E.computeSettlement(people, [
    { id: "x1", payerId: "a", amount: 100, sharedWith: ["a", "b", "c"] },
  ]);
  const credit = r.balances.get("a");
  assert.ok(Math.abs(sumTransfers(r.transfers) - credit) < 0.005,
    "transfers must exactly repay the payer");
  const owedTotal = ["a", "b", "c"].reduce((s, id) => s - Math.min(0, r.balances.get(id)), 0);
  assert.ok(Math.abs(owedTotal - credit) < 0.005, "no orphan cents");
  assert.strictEqual(r.shareExact, false, "and the UI is told it doesn't divide evenly");
});

test("a repayment settles the debt without becoming group spend", () => {
  const people = goers("a", "b");
  const base = [{ id: "x1", payerId: "a", amount: 100, sharedWith: ["a", "b"] }];
  const before = E.computeSettlement(people, base);
  assert.strictEqual(before.transfers.length, 1);
  assert.strictEqual(Math.round(before.transfers[0].amount), 50);
  // b pays a back — recorded as a settlement, not a new cost.
  const after = E.computeSettlement(people, [
    ...base,
    { id: "s1", payerId: "b", amount: 50, sharedWith: ["a"], settlement: true },
  ]);
  assert.strictEqual(after.total, 100, "repaying a debt must not inflate the trip total");
  assert.strictEqual(after.transfers.length, 0, "and the debt is cleared");
});

test("an expense only charges the people it was scoped to", () => {
  const people = goers("a", "b", "c");
  const r = E.computeSettlement(people, [
    { id: "x1", payerId: "a", amount: 60, sharedWith: ["a", "b"] }, // c wasn't there
  ]);
  assert.strictEqual(r.balances.get("c"), 0, "c owes nothing for a dinner they skipped");
  assert.strictEqual(Math.round(r.transfers[0].amount), 30);
  assert.strictEqual(r.transfers[0].from, "b");
});

test("removing someone doesn't make their debt vanish", () => {
  // The payer left the roster; the money they fronted is still owed.
  const remaining = goers("b", "c");
  const r = E.computeSettlement(remaining, [
    { id: "x1", payerId: "gone", amount: 90, sharedWith: ["b", "c"] },
  ]);
  assert.ok(r.transfers.length > 0, "debts must not silently disappear");
  assert.ok(Math.abs(sumTransfers(r.transfers) - 90) < 0.005, "the full amount is still owed");
  assert.ok(r.transfers.every((t) => t.to === "gone"), "and it's owed to whoever paid");
});

test("splitBaseFor falls back to everyone before anyone has RSVP'd", () => {
  const undecided = [person({ id: "a" }), person({ id: "b" })];
  assert.strictEqual(E.splitBaseFor(undecided).length, 2, "don't split between nobody");
  const mixed = [person({ id: "a", rsvp: "in" }), person({ id: "b", rsvp: "in" }), person({ id: "c", rsvp: "out" })];
  assert.deepStrictEqual(E.splitBaseFor(mixed).map((p) => p.id), ["a", "b"]);
});

// ---- Display currency ------------------------------------------------------
test("the same estimate keeps its value across currencies", () => {
  // Rounding runs after conversion, so a coarse step used to cost far more
  // precision in one currency than another: $1,735 showed as $1,750 but as
  // £1,350 against a £1,371 true value.
  for (const usd of [95, 215, 1735, 4200, 18000]) {
    for (const code of ["USD", "GBP", "INR", "EUR", "JPY"]) {
      const shown = Number(E.formatMoney(usd, code).replace(/[^\d.]/g, ""));
      const exact = E.convertFromUSD(usd, code);
      assert.ok(Math.abs(shown - exact) / exact < 0.01,
        `${usd} USD in ${code}: showed ${shown}, exact ${exact}`);
    }
  }
});

test("a ledger amount survives the round trip through USD storage", () => {
  for (const code of ["USD", "GBP", "INR", "EUR"]) {
    const typed = 8000;
    const stored = E.toUSD(typed, code);
    assert.strictEqual(E.formatExact(stored, code).replace(/[^\d.]/g, ""), "8,000.00".replace(",", ""));
  }
});

test("the ledger shows exact cents, not rounded estimates", () => {
  assert.strictEqual(E.formatExact(33.333, "USD"), "$33.33");
  assert.strictEqual(E.formatExact(1234.5, "USD"), "$1,234.50",
    "trailing zero must survive — 1,234.5 reads as a typo on money");
});

test("an unknown currency code falls back to USD instead of NaN", () => {
  assert.strictEqual(E.formatExact(10, "ZZZ"), "$10.00");
  assert.strictEqual(E.toUSD(10, "ZZZ"), 10);
});

test("a refund reduces what the group owes the payer", () => {
  const people = goers("a", "b");
  // a fronts a £200 deposit, then £50 of it comes back.
  const r = E.computeSettlement(people, [
    { id: "x1", payerId: "a", amount: 200, sharedWith: ["a", "b"] },
    { id: "x2", payerId: "a", amount: -50, sharedWith: ["a", "b"] },
  ]);
  assert.strictEqual(r.total, 150, "the group spent 150 net");
  assert.strictEqual(r.transfers.length, 1);
  assert.strictEqual(Math.round(r.transfers[0].amount), 75, "b owes half of the net, not half of the gross");
  assert.strictEqual(r.transfers[0].from, "b");
});

test("a refund to the wrong person flips who owes whom", () => {
  // b was refunded for something a paid for — so b now owes a more, not less.
  const people = goers("a", "b");
  const r = E.computeSettlement(people, [
    { id: "x1", payerId: "a", amount: 100, sharedWith: ["a", "b"] },
    { id: "x2", payerId: "b", amount: -20, sharedWith: ["a", "b"] },
  ]);
  assert.strictEqual(r.total, 80);
  assert.strictEqual(r.transfers[0].from, "b");
  assert.strictEqual(Math.round(r.transfers[0].amount), 60, "b's 40 share plus the 20 they pocketed");
});

// ---- Invite-link merge (the other place that has silently lost data) -------
/** Wire row -> normalized participant, mirroring app.js participantFromPayload. */
function fromWire(x) {
  return person({
    id: x.id, name: x.n, email: x.e || "", city: x.c, dates: x.d, destinations: x.x,
    prefs: x.pr, rsvp: x.rsvp, updatedAt: x.ts || 0,
  });
}
const merge = (current, rows) => E.mergeParticipants(current, rows, fromWire);
const shape = (list) => list.map((p) => `${p.id}:${p.name}:${p.city}`);

test("two guests who share a first name stay two people", () => {
  // Matching on name alone deleted whichever Sam merged first, taking their
  // city with them — and city is what drives their fare.
  const roster = [person({
    id: "p_1", name: "Sam", city: "London, UK", rsvp: "in", updatedAt: 100,
    dates: [{ start: "2026-12-19", end: "2026-12-26" }],
  })];
  const r = merge(roster, [{ id: "p_2", n: "Sam", c: "Delhi, India", ts: 200, rsvp: "in" }]);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(roster.length, 2);
  assert.deepStrictEqual(shape(roster), ["p_1:Sam:London, UK", "p_2:Sam:Delhi, India"]);
});

test("someone can still claim a placeholder that was typed for them", () => {
  // The organiser typed "Sam" with nothing filled in; Sam joins on their own
  // device, which gives them a fresh id. They must not become a second row.
  const roster = [person({ id: "p_1", name: "Sam", city: "", updatedAt: 0 })];
  const r = merge(roster, [{
    id: "p_9", n: "Sam", c: "Delhi, India", ts: 200, rsvp: "in",
    d: [{ start: "2027-01-16", end: "2027-01-23" }],
  }]);
  assert.strictEqual(roster.length, 1, "claimed the placeholder rather than duplicating");
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(roster[0].id, "p_1", "keeps the local id — expenses already point at it");
  assert.strictEqual(roster[0].city, "Delhi, India");
  assert.ok(roster[0].aliasIds.includes("p_9"), "and remembers the id they use elsewhere");
});

test("a claimed placeholder is matched by id from then on", () => {
  // Without the alias, the row is no longer 'unclaimed', so the next link
  // from the same person would fail the name check and duplicate them.
  const roster = [person({ id: "p_1", name: "Sam", city: "", updatedAt: 0 })];
  merge(roster, [{ id: "p_9", n: "Sam", c: "Delhi, India", ts: 200, rsvp: "in",
                   d: [{ start: "2027-01-16", end: "2027-01-23" }] }]);
  merge(roster, [{ id: "p_9", n: "Sam", c: "Mumbai, India", ts: 300, rsvp: "in",
                   d: [{ start: "2027-01-16", end: "2027-01-23" }] }]);
  assert.strictEqual(roster.length, 1, "same person, still one row");
  assert.strictEqual(roster[0].city, "Mumbai, India", "and their update landed");
  assert.ok(roster[0].aliasIds.includes("p_9"), "the alias survives the update");
});

test("a legacy link with no ids still matches by name", () => {
  const roster = [person({ id: "p_1", name: "Sam", city: "London, UK", rsvp: "in", updatedAt: 100 })];
  const r = merge(roster, [{ n: "Sam", c: "Paris, France", ts: 500 }]);
  assert.strictEqual(roster.length, 1, "old links carry no id — the name is all there is");
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(roster[0].city, "Paris, France");
});

test("a stale copy never overwrites fresher answers", () => {
  const roster = [person({ id: "p_1", name: "Sam", city: "London, UK", updatedAt: 900 })];
  const r = merge(roster, [{ id: "p_1", n: "Sam", c: "Stale City", ts: 100 }]);
  assert.strictEqual(r.updated, 0);
  assert.strictEqual(roster[0].city, "London, UK");
});

test("a nameless row is ignored rather than added as a blank person", () => {
  const roster = [];
  const r = merge(roster, [{ id: "p_7", n: "   ", c: "Goa, India", ts: 5 }]);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(roster.length, 0);
});

test("a merge never clears a field the invite link cannot carry", () => {
  // Links deliberately omit email addresses, so `incoming.email` is always "".
  // Assigning it blanked the local one — and a returning user is identified BY
  // email, so they stopped matching their own row and got a duplicate,
  // splitting their RSVP and their expenses across two ids.
  const roster = [person({
    id: "p_a", name: "Ana", email: "ana@example.com", city: "London, UK", updatedAt: 100,
  })];
  const r = merge(roster, [{ id: "p_a", n: "Ana", c: "Paris, France", ts: 500, rsvp: "in" }]);
  assert.strictEqual(r.updated, 1, "the update still applies");
  assert.strictEqual(roster[0].city, "Paris, France");
  assert.strictEqual(roster[0].email, "ana@example.com", "but the email survives");
});

test("an incoming email fills in a blank one without overwriting a real one", () => {
  const roster = [person({ id: "p_a", name: "Ana", email: "", updatedAt: 100 })];
  merge(roster, [{ id: "p_a", n: "Ana", e: "ana@example.com", c: "Paris, France", ts: 500 }]);
  assert.strictEqual(roster[0].email, "ana@example.com");
});

// ---- Roster changes must not rewrite settled history -----------------------
test("removing someone who dropped out doesn't move their debt onto everyone else", () => {
  const exp = [{ id: "x1", payerId: "A", amount: 900, sharedWith: ["A", "B", "C"] }];
  const before = E.computeSettlement(goers("A", "B", "C"), exp);
  const after = E.computeSettlement(goers("A", "B"), exp);
  assert.strictEqual(before.balances.get("B"), -300);
  assert.strictEqual(after.balances.get("B"), -300, "B's share must not change because C left");
  assert.strictEqual(after.balances.get("C"), -300, "and C still owes it");
  assert.strictEqual(after.balances.get("A"), 600, "A is still owed the full 600");
  assert.ok(Math.abs(sumTransfers(after.transfers) - 600) < 0.005,
    "the transfers still add up to what A actually fronted");
});

test("removing a payer never voids a repayment that already happened", () => {
  // B handed A 300 in cash. Then A is removed from the roster. B must not be
  // asked for MORE than they owed before paying.
  const exp = [
    { id: "x1", payerId: "A", amount: 900, sharedWith: ["A", "B", "C"] },
    { id: "s1", payerId: "B", amount: 300, sharedWith: ["A"], settlement: true },
  ];
  const withA = E.computeSettlement(goers("A", "B", "C"), exp);
  assert.ok(!withA.transfers.some((t) => t.from === "B"), "B is square after repaying");
  const noA = E.computeSettlement(goers("B", "C"), exp);
  assert.ok(!noA.transfers.some((t) => t.from === "B"),
    "and stays square when the person they repaid is removed");
  assert.strictEqual(noA.transfers.length, 1);
  assert.strictEqual(noA.transfers[0].from, "C");
});

test("an expense logged before two people confirm doesn't charge someone who declined", () => {
  const roster = [
    person({ id: "org", rsvp: "in" }),
    person({ id: "nope", rsvp: "out" }),
    person({ id: "quiet1" }),
    person({ id: "quiet2" }),
  ];
  const ids = E.splitBaseFor(roster).map((p) => p.id);
  assert.ok(!ids.includes("nope"), "someone who said no is never in the default split");
  assert.deepStrictEqual(ids, ["org", "quiet1", "quiet2"]);
});

test("the cost breakdown adds up to the headline it explains", () => {
  // The card showed the RAW fare and the RAW nightly band — before party size,
  // the single-room factor and the festive uplift — beside a fully-scaled
  // total. On the shipped seed data that read "$405 travel + $210-$490 stay"
  // under a "$1,071" headline, understating the stay by roughly half. The
  // breakdown is the line people budget from, so it has to close.
  const combos = E.rankCombinations(D.SEED_PARTICIPANTS.map(D.normalizeParticipant));
  assert.ok(combos.length, "seed data should produce ranked options");
  for (const c of combos.slice(0, 5)) {
    if (c.travelApplied == null || c.lodgingApplied == null) continue;
    const sum = c.travelApplied + c.lodgingApplied;
    assert.ok(Math.abs(sum - c.avgTripCost) < 0.01,
      `${c.destination} ${c.dateLabel}: breakdown ${sum.toFixed(2)} vs headline ${c.avgTripCost.toFixed(2)}`);
  }
});

// ---- Journeys and seasons --------------------------------------------------
test("durations never print sixty minutes", () => {
  // Rounding the fractional part on its own made 6.995h render as "6h 60m".
  for (let i = 0; i < 2000; i++) {
    const out = E.formatHours(i * 0.01337);
    assert.ok(!/\b60m\b/.test(out), `formatHours(${i * 0.01337}) => ${out}`);
  }
  assert.strictEqual(E.formatHours(6.995), "7h");
  assert.strictEqual(E.formatHours(13.33), "13h 20m");
});

test("a long-haul journey counts more than time in the air", () => {
  // Great-circle air time alone made the other side of the world look like an
  // afternoon, and the same figure gates viability and the itinerary bookends.
  const goaBali = E.distanceMiles("Goa, India", "Bali, Indonesia");
  assert.ok(E.journeyHours(goaBali) > E.flightTimeHours(goaBali) + 4,
    "airport time and a connection must be counted on a 3,000-mile route");
  assert.ok(E.journeyHours(goaBali) > 12, "Goa-Bali is a whole day, not 7 hours");
  // Short hops stay short — the day-trip case must not be vetoed.
  const shortHop = E.distanceMiles("Boston, MA", "New York, NY");
  assert.ok(E.journeyHours(shortHop) < 4, "a 190-mile drive is still a morning");
});

test("a window straddling a peak is priced for the nights it actually covers", () => {
  // Reading the band off day one alone priced Dec 15-28 — which covers
  // Christmas Day — as completely off-peak, a 30% swing against Dec 19-Jan 1.
  const straddling = E.seasonFactorFor({ start: "2026-12-15", end: "2026-12-28" });
  const squarelyOn = E.seasonFactorFor({ start: "2026-12-19", end: "2027-01-01" });
  const offPeak = E.seasonFactorFor({ start: "2026-10-05", end: "2026-10-12" });
  assert.ok(straddling.fare > 1.2, "most of the window is in the peak");
  assert.ok(straddling.fare < squarelyOn.fare, "but less than a window entirely inside it");
  assert.strictEqual(offPeak.fare, 1, "and an off-peak window is untouched");
  assert.match(straddling.label, /11 of 14 days/, "the label says how much is affected");
});

test("a drive is priced per car, not per passenger", () => {
  // A 190-mile drive with two children cost $308 of 'travel' — three per-head
  // fares, each carrying a $60 airport booking overhead a road trip never has.
  const range = { start: "2027-03-01", end: "2027-03-03" };
  const solo = E.tripCostFor("Boston, MA", "New York, NY", range, E.getFare, { kids: 0 });
  const family = E.tripCostFor("Boston, MA", "New York, NY", range, E.getFare, { kids: 2 });
  assert.strictEqual(Math.round(solo.travel), Math.round(family.travel),
    "the car costs the same however many people are in it");
  assert.ok(family.travel < 120, `a 190-mile drive should not cost ${family.travel}`);
  // A flight is still charged per seat.
  const air = E.tripCostFor("London, UK", "Goa, India", range, E.getFare, { kids: 2 });
  const airSolo = E.tripCostFor("London, UK", "Goa, India", range, E.getFare, { kids: 0 });
  assert.ok(air.travel > airSolo.travel * 2.5, "three seats cost about three fares");
});

test("a partial repayment reduces the debt without clearing it", () => {
  // The engine always handled this; the UI had no amount field, so a treasurer
  // recording a £100 instalment against a £300 debt had to either log £300 that
  // was never paid — inventing a credit — or lose the record.
  const people = goers("a", "b");
  const base = [{ id: "x1", payerId: "a", amount: 600, sharedWith: ["a", "b"] }];
  const before = E.computeSettlement(people, base);
  assert.strictEqual(Math.round(before.transfers[0].amount), 300);
  const after = E.computeSettlement(people, [
    ...base,
    { id: "s1", payerId: "b", amount: 100, sharedWith: ["a"], settlement: true },
  ]);
  assert.strictEqual(after.transfers.length, 1, "still owed something");
  assert.strictEqual(after.transfers[0].from, "b");
  assert.strictEqual(Math.round(after.transfers[0].amount), 200, "300 less the 100 paid");
  assert.strictEqual(after.total, 600, "and the repayment isn't counted as spend");
});

// ---- Before-you-go prep ----------------------------------------------------
test("a domestic trip isn't asked about passports and visas", () => {
  const home = [person({ city: "Delhi, India", rsvp: "in" }), person({ city: "Mumbai, India", rsvp: "in" })];
  assert.strictEqual(E.isInternationalTrip(home, "Goa, India"), false);
  const ids = E.prepStepsFor(60, false).map((s) => s.id);
  assert.ok(!ids.includes("passport") && !ids.includes("visa"));
  assert.ok(ids.includes("book-travel"), "but the booking steps still apply");
});

test("one person crossing a border makes it an international trip", () => {
  const mixed = [person({ city: "Delhi, India", rsvp: "in" }), person({ city: "London, UK", rsvp: "in" })];
  assert.strictEqual(E.isInternationalTrip(mixed, "Goa, India"), true);
  // Someone who has declined doesn't drag the whole group across a border.
  const declined = [person({ city: "Delhi, India", rsvp: "in" }), person({ city: "London, UK", rsvp: "out" })];
  assert.strictEqual(E.isInternationalTrip(declined, "Goa, India"), false);
});

test("US state suffixes aren't mistaken for countries", () => {
  // "New York, NY" is a state, but "London, UK" is not — matching any
  // two-letter tail as a state made London American.
  // Countries normalise to ISO codes so the curated table ("London, UK") and
  // the live autocomplete ("Bath, United Kingdom") can be compared at all.
  assert.strictEqual(E.countryOf("New York, NY"), "us");
  assert.strictEqual(E.countryOf("Boston, MA"), "us");
  assert.strictEqual(E.countryOf("London, UK"), "gb");
  assert.strictEqual(E.countryOf("Dubai, UAE"), "ae");
  assert.strictEqual(
    E.isInternationalTrip([person({ city: "Boston, MA", rsvp: "in" })], "New York, NY"),
    false, "a US domestic trip needs no passport prompt"
  );
});

test("prep urgency reflects how close the trip is", () => {
  const far = E.prepStepsFor(200, true);
  assert.ok(far.every((s) => s.urgency === "later"), "nothing is urgent six months out");
  const close = E.prepStepsFor(43, true);
  const passport = close.find((s) => s.id === "passport");
  assert.strictEqual(passport.urgency, "overdue", "90-day passport check is past at 43 days");
  const insurance = close.find((s) => s.id === "insurance");
  assert.strictEqual(insurance.urgency, "soon", "30-day insurance step is due about now");
});

// ---- People who declined must not shape the trip ---------------------------
test("someone who said no doesn't drive the ranking, the costs or the warnings", () => {
  // splitBaseFor was fixed for this in round 7; the ranking was not. On the
  // shipped seed group one decliner pushed "avg per person" from $873 to
  // $1,071, put their own fare at the top of the "across the group" range the
  // card calls the deciding traveller, named them in the over-budget warning
  // for a trip they had declined, and reordered the runners-up.
  const all = D.SEED_PARTICIPANTS.map(D.normalizeParticipant);
  const declined = all.filter((p) => p.rsvp === "out");
  assert.ok(declined.length, "seed data should contain a decliner for this test");
  const withThem = E.rankCombinations(all);
  const withoutThem = E.rankCombinations(all.filter((p) => p.rsvp !== "out"));
  assert.strictEqual(withThem.length, withoutThem.length);
  assert.strictEqual(
    Math.round(withThem[0].avgTripCost), Math.round(withoutThem[0].avgTripCost),
    "the average must not move when a decliner is dropped — they were never in it"
  );
  assert.deepStrictEqual(
    withThem.slice(0, 3).map((c) => c.destination + c.dateLabel),
    withoutThem.slice(0, 3).map((c) => c.destination + c.dateLabel),
    "and the ordering must not depend on them"
  );
  for (const name of declined.map((p) => p.name)) {
    assert.ok(!withThem[0].overBudgetNames.includes(name),
      `${name} declined — don't warn the group about their budget`);
  }
});

test("someone who hasn't replied yet still counts", () => {
  // "no_response" is not "no": they may well come, and excluding them would
  // hide the person whose fare decides whether the trip is affordable.
  const base = D.SEED_PARTICIPANTS.map(D.normalizeParticipant).filter((p) => p.rsvp !== "out");
  const quiet = base.map((p, i) => (i === 0 ? { ...p, rsvp: "no_response" } : p));
  assert.strictEqual(
    Math.round(E.rankCombinations(base)[0].avgTripCost),
    Math.round(E.rankCombinations(quiet)[0].avgTripCost)
  );
});

test("country names from the two vocabularies compare equal", () => {
  // The curated table says "London, UK"; the live autocomplete says
  // "Bath, United Kingdom". Comparing raw tails made an all-UK weekend read as
  // international, so its prep card declared passport and visa steps overdue —
  // and crying wolf there trains people to ignore the prompt when it matters.
  const P = (city) => person({ city, rsvp: "in" });
  assert.strictEqual(E.isInternationalTrip([P("London, UK")], "Bath, United Kingdom"), false);
  assert.strictEqual(E.isInternationalTrip([P("New York, NY")], "Chicago, United States"), false);
  assert.strictEqual(E.isInternationalTrip([P("London, UK")], "Goa, India"), true);
  assert.strictEqual(E.normalizeCountry("gb"), "gb", "an ISO code is already canonical");
});

test("a group trip doesn't bill everyone a single-room supplement", () => {
  // NIGHTLY_RATES is quoted per person SHARING A TWIN, then every childless
  // participant was charged 1.6x it. Two friends travelling together are two
  // such records, so they were billed 3.2x the band for one room — and three
  // people in a family room came out cheaper per head than one adult.
  const range = { start: "2026-11-21", end: "2026-11-28" };
  const cost = (kids, canShare) =>
    E.tripCostFor("Mumbai, India", "Goa, India", range, E.getFare,
      { kids, accommodation: true }, { canShare });
  const shared = cost(0, true);
  const alone = cost(0, false);
  const family = cost(2, true);
  assert.ok(shared.lodging < alone.lodging, "sharing must cost less than not sharing");
  assert.strictEqual(shared.sharing, "twin");
  assert.strictEqual(alone.sharing, "single");
  // Someone sharing pays the band as quoted — no supplement on top. The
  // supplement is 1.6x, so this is the whole fix in one number.
  assert.ok(Math.abs(alone.lodging / shared.lodging - 1.6) < 0.01,
    "the single supplement should be the only difference between the two");
  // A family room IS cheaper per head than a twin — children share a bed. What
  // was wrong before is that a LONE ADULT cost 2.4x a child's head; now the gap
  // is the ordinary one between an adult bed and a child sharing.
  assert.ok(shared.lodging < alone.lodging &&
    family.lodging / family.party < shared.lodging,
    "kids cheapest, then an adult sharing, then an adult alone");
});

test("who can share is decided by the group, not assumed", () => {
  const bed = (kids) => person({ city: "Mumbai, India", rsvp: "in", prefs: { kids } });
  assert.strictEqual(E.soloBedCount([bed(0), bed(0)]), 2, "two lone adults can pair up");
  assert.strictEqual(E.soloBedCount([bed(0)]), 1, "one lone adult cannot");
  assert.strictEqual(E.soloBedCount([bed(0), bed(2)]), 1, "a parent already shares with their kids");
  const declined = person({ city: "Mumbai, India", rsvp: "out", prefs: { kids: 0 } });
  assert.strictEqual(E.soloBedCount([bed(0), declined]), 1, "someone not coming can't share a room");
  const noBed = person({ city: "Mumbai, India", rsvp: "in", prefs: { kids: 0, accommodation: false } });
  assert.strictEqual(E.soloBedCount([bed(0), noBed]), 1, "nor can someone staying with family");
});

// ---- Labels people book from ----------------------------------------------
test("a date label says which year when it isn't this one", () => {
  // The label is what people read on the confirm card they say yes to, the
  // countdown, the lock dialog and the Trip Pack. Groups plan Christmas the
  // better part of a year ahead, and "Dec 19 – 26" doesn't say which December.
  const year = new Date().getFullYear();
  const thisYear = E.rangeLabel({ start: `${year}-09-05`, end: `${year}-09-12` });
  assert.ok(!/\d{4}/.test(thisYear), "no year clutter for the current year");
  const next = E.rangeLabel({ start: `${year + 1}-01-16`, end: `${year + 1}-01-23` });
  assert.match(next, new RegExp(String(year + 1)), "a future year must be stated");
  const straddling = E.rangeLabel({ start: `${year}-12-28`, end: `${year + 1}-01-02` });
  assert.match(straddling, new RegExp(String(year)));
  assert.match(straddling, new RegExp(String(year + 1)), "both years when it crosses");
});

test("someone who declined doesn't shape the itinerary or the insights", () => {
  // summarizePrefs drives the itinerary's idea pool AND its constraints, so a
  // family dropping out still stripped every adults-only idea — and the card
  // asserted "since 2 children are coming" about children who weren't.
  const going = person({ rsvp: "in", prefs: { kids: 0, activities: ["Nightlife"] } });
  const gone = person({ rsvp: "out", prefs: { kids: 2, accessibility: "Uses a wheelchair" } });
  const s = E.summarizePrefs([going, gone]);
  assert.strictEqual(s.total, 1, "headline tiles must not count decliners");
  assert.strictEqual(s.withKids, 0, "their children aren't coming either");
  assert.strictEqual(s.kids, 0);
  assert.strictEqual(s.accessibility.length, 0, "nor their access needs");
  assert.deepStrictEqual(s.activitiesRanked, [["Nightlife", 1]]);
});

// ---- Drive or fly is a party decision, not a distance one ------------------
test("one extra mile doesn't triple a family's travel cost", () => {
  // A hard switch at 300 miles meant 300mi cost a family $107.50 (one car) and
  // 301mi cost $382.50 (three seats). Real pairs sit on the line — Bangalore to
  // Goa is 306 miles — and cost is 40% of the ranking, so a member typing a
  // home city six miles further out could reorder the group's destinations.
  const cost = (miles, party) => {
    const f = E.estimateFare(miles);
    return E.chooseTravel(miles, (f.min + f.max) / 2, party).cost;
  };
  for (const party of [1, 3]) {
    const before = cost(300, party);
    const after = cost(301, party);
    assert.ok(Math.abs(after - before) / before < 0.05,
      `party of ${party}: ${before} -> ${after} across the boundary`);
  }
});

test("a family drives where a lone traveller flies", () => {
  // The choice depends on how many people are in the car, which is why a single
  // distance threshold could never be right.
  const f = E.estimateFare(500);
  const mid = (f.min + f.max) / 2;
  assert.strictEqual(E.chooseTravel(500, mid, 1).mode, "flight", "one seat is cheaper than the fuel");
  assert.strictEqual(E.chooseTravel(500, mid, 4).mode, "drive", "four seats are not");
  // Beyond road range nobody drives, however big the party.
  assert.strictEqual(E.chooseTravel(3000, mid, 6).mode, "flight");
});

test("an unmeasurable journey is priced, not made free", () => {
  // Falling through to "local" on a null distance would have handed out free
  // trips for any city pair the coordinate table doesn't know.
  assert.strictEqual(E.chooseTravel(null, 200, 2).mode, "flight");
  assert.strictEqual(E.chooseTravel(null, 200, 2).cost, 400);
  assert.strictEqual(E.chooseTravel(0, 200, 2).cost, 0, "but the same city really is free");
});

test("a fare always carries the distance it was priced for", () => {
  // tripCostFor decides drive-vs-fly from f.miles; a fare object without it
  // silently reverted the whole journey to per-seat pricing.
  for (const [a, b] of [["London, UK", "Goa, India"], ["Boston, MA", "New York, NY"]]) {
    const f = E.getFare(a, b);
    assert.ok(Number.isFinite(f.miles), `${a} -> ${b} fare must carry miles`);
  }
});

// ---- The agreed plan must never fall out of the ranking --------------------
test("a locked window survives someone widening their availability", () => {
  // Candidate windows are DERIVED from overlapping availability, so the moment
  // anyone widens their dates the locked overlap stops being generated. The
  // Decide hero then fell back to combos[0] — a different week, under a "Top
  // pick" ribbon, one tap from a Lock button that wipes everyone's bookings.
  const mk = (id, dates) => person({ id, city: "London, UK", rsvp: "in",
    destinations: ["Goa, India"], dates });
  const pinned = { destination: "Goa, India", dateRange: { start: "2026-12-22", end: "2026-12-26" } };
  const has = (list) => list.some((c) =>
    c.destination === "Goa, India" && c.dateRange.start === "2026-12-22" && c.dateRange.end === "2026-12-26");
  const widened = [
    mk("ann", [{ start: "2026-12-01", end: "2026-12-31" }]),
    mk("bob", [{ start: "2026-12-22", end: "2026-12-29" }]),
  ];
  assert.strictEqual(has(E.rankCombinations(widened)), false, "the window really does drop out");
  assert.ok(has(E.rankCombinations(widened, undefined, E.getFare, { pinned })),
    "but pinning keeps the agreed plan present and fully scored");
});

test("a locked destination survives everyone changing their minds", () => {
  const mk = (id, dests) => person({ id, city: "London, UK", rsvp: "in", destinations: dests,
    dates: [{ start: "2026-12-22", end: "2026-12-26" }] });
  const pinned = { destination: "Goa, India", dateRange: { start: "2026-12-22", end: "2026-12-26" } };
  const moved = [mk("ann", ["Bali, Indonesia"]), mk("bob", ["Bali, Indonesia"])];
  const ranked = E.rankCombinations(moved, undefined, E.getFare, { pinned });
  assert.ok(ranked.some((c) => c.destination === "Goa, India"),
    "the agreed destination stays visible even once nobody is nominating it");
});

test("distance resolves the same way for cost and for viability", () => {
  // The live autocomplete returns "London, United Kingdom" while CITY_COORDS
  // holds "London, UK", so distanceMiles was null for anyone who used the
  // type-ahead — and minSensibleNights(null) is 0, which silently switched off
  // the rule that stops a 2-night window winning a 16-hour-flight trip.
  const geocoded = "London, United Kingdom";
  assert.strictEqual(E.distanceMiles(geocoded, "Bali, Indonesia"), null, "not in the local table");
  const proxy = () => ({ min: 600, max: 900, mode: "flight", source: "estimated", miles: 7767 });
  assert.strictEqual(E.milesBetween(geocoded, "Bali, Indonesia", proxy), 7767,
    "the provider's mileage is used when ours is missing");
  assert.ok(E.milesBetween("London, UK", "Bali, Indonesia", proxy) > 7000,
    "and the local table still wins when it knows");

  const traveller = person({ id: "p", city: geocoded, rsvp: "in",
    destinations: ["Bali, Indonesia"], dates: [{ start: "2027-03-05", end: "2027-03-07" }] });
  const withProxy = E.rankCombinations([traveller], undefined, proxy)[0];
  assert.ok(withProxy.viability < 1, "a 2-night trip to Bali is not waved through");
  assert.ok(withProxy.minNights >= 5);
});

test("money collected into a kitty isn't counted as group spend", () => {
  // A treasurer collecting a float before booking anything had no way to record
  // it except as an ordinary expense, which inflated the headline: 12 people
  // paying $250 each before a $2,400 deposit showed "Total $5,150 · $429.17
  // avg per person" for $2,400 of actual spend. As settlements it's exact.
  const people = Array.from({ length: 12 }, (_, i) => person({ id: `p${i}`, rsvp: "in" }));
  const ids = people.map((p) => p.id);
  const ledger = [];
  for (let i = 1; i < 12; i++) {
    ledger.push({ id: `c${i}`, payerId: `p${i}`, amount: 250, sharedWith: ["p0"], settlement: true });
  }
  ledger.push({ id: "villa", payerId: "p0", amount: 2400, sharedWith: ids });
  const r = E.computeSettlement(people, ledger);
  assert.strictEqual(r.total, 2400, "only the villa is group spend");
  assert.strictEqual(r.share, 200);
  assert.strictEqual(r.shareExact, true);
  // Everyone paid 250 towards a 200 share, so each is owed 50 back.
  assert.strictEqual(r.transfers.length, 11);
  assert.ok(r.transfers.every((t) => Math.round(t.amount) === 50 && t.from === "p0"),
    "the treasurer refunds the difference");
});

test("a departed member's balance can still be corrected", () => {
  // The pickers were built from the roster alone, so once someone was removed
  // no refund or correction could be assigned to them — while their balance
  // stayed on the books with no way to clear it.
  const roster = goers("a", "b");
  const ledger = [{ id: "x1", payerId: "a", amount: 400, sharedWith: ["a", "gone"] }];
  const before = E.computeSettlement(roster, ledger);
  assert.strictEqual(before.balances.get("gone"), -200, "they still owe");
  // A correcting settlement assigned to them clears it.
  const after = E.computeSettlement(roster, [
    ...ledger,
    { id: "s1", payerId: "gone", amount: 200, sharedWith: ["a"], settlement: true },
  ]);
  // Once square they drop off the books entirely, which is the right outcome —
  // balances only lists people still owed or owing.
  const settled = after.balances.get("gone");
  assert.ok(settled === undefined || Math.abs(settled) < 0.005, "and it can be settled");
  assert.strictEqual(after.transfers.length, 0, "nothing left outstanding");
  assert.ok(Math.abs(after.balances.get("a")) < 0.005, "the payer is made whole");
});

test("nobody pays for a hotel in the town they live in", () => {
  // chooseTravel already knew the trip was local; the lodging branch wasn't
  // asking. Six Londoners planning a London weekend were each billed for a
  // hotel in their own city, and then all six were flagged as priced out of it.
  const win = { start: "2026-12-19", end: "2026-12-26" };
  const home = E.tripCostFor("London, UK", "London, UK", win, E.getFare,
    { kids: 0, accommodation: true }, { canShare: true });
  assert.strictEqual(home.travel, 0, "no journey");
  assert.strictEqual(home.lodging, 0, "and no bed to book");
  assert.strictEqual(home.sharing, "home");
  // Someone travelling to the same place still pays for both.
  const away = E.tripCostFor("Paris, France", "London, UK", win, E.getFare,
    { kids: 0, accommodation: true }, { canShare: true });
  assert.ok(away.travel > 0 && away.lodging > 0);
});

test("recording a repayment doesn't change what the trip cost", () => {
  // A settlement's sharedWith is its recipient, so folding those ids into the
  // divisor let money moving between people alter the reported spend.
  const people = goers("ana", "bo", "cy");
  const base = [{ id: "x1", payerId: "ana", amount: 300, sharedWith: ["bo", "cy"] }];
  const before = E.computeSettlement(people, base);
  const after = E.computeSettlement(people, [
    ...base,
    { id: "s1", payerId: "bo", amount: 150, sharedWith: ["ana"], settlement: true },
  ]);
  assert.strictEqual(before.share, 150);
  assert.strictEqual(after.share, 150, "the same $300 of spend, split the same way");
  assert.strictEqual(after.total, 300);
  assert.deepStrictEqual(after.chargedIds.sort(), ["bo", "cy"], "only spend charges people");
});

test("a destination we couldn't price can't outrank one we could", () => {
  // relCostScore 0.5 was meant to be neutral, but the scale is normalised
  // min-to-max within the window, so it landed on the median of the reachable
  // options and beat a real, reachable destination.
  const dates = [{ start: "2026-12-19", end: "2026-12-26" }];
  const dests = ["Atlantis, Nowhere", "Paris, France", "Bali, Indonesia"];
  const people = [
    person({ id: "a", city: "London, UK", destinations: dests, dates, rsvp: "in" }),
    person({ id: "b", city: "London, UK", destinations: dests, dates, rsvp: "in" }),
  ];
  const ranked = E.rankCombinations(people);
  const unknown = ranked.find((c) => c.destination === "Atlantis, Nowhere");
  const cheapest = ranked.find((c) => c.destination === "Paris, France");
  assert.strictEqual(unknown.avgTripCost, null, "we really can't price it");
  assert.strictEqual(unknown.costUnknown, true, "and it says so");
  assert.ok(unknown.total < cheapest.total,
    "an unpriced option must not tie the cheapest real one");
});

test("someone already at the destination can't share a room with the visitor", () => {
  // canShare means "two or more people need their own bed, so they can split a
  // twin". Counting locals — who are sleeping at home — priced the one actual
  // hotel guest at the shared rate.
  const local = (id) => person({ id, city: "London, UK", rsvp: "in", prefs: { kids: 0 } });
  const group = ["a", "b", "c", "d", "e"].map(local)
    .concat(person({ id: "f", city: "Paris, France", rsvp: "in", prefs: { kids: 0 } }));
  assert.strictEqual(E.soloBedCount(group), 6, "without a destination it can only count heads");
  assert.strictEqual(E.soloBedCount(group, "London, UK", E.getFare), 1,
    "but only the visitor needs a bed in London");
  const win = { start: "2026-11-21", end: "2026-11-28" };
  const alone = E.tripCostFor("Paris, France", "London, UK", win, E.getFare,
    { kids: 0, accommodation: true }, { canShare: false });
  const shared = E.tripCostFor("Paris, France", "London, UK", win, E.getFare,
    { kids: 0, accommodation: true }, { canShare: true });
  assert.ok(alone.lodging > shared.lodging, "and nobody is there to share with");
  assert.strictEqual(alone.sharing, "single");
});

test("a removal isn't undone by a link that predates it", () => {
  // Expenses have had tombstones since round 7; people did not, so any other
  // member's link put a removed person straight back — with their old RSVP,
  // which quietly re-entered them into splitBaseFor as a default sharer.
  const roster = [person({ id: "keep", name: "Keep", rsvp: "in", updatedAt: 100 })];
  const removed = { gone: { on: true, ts: 500 } };
  const stale = [{ id: "gone", n: "Gone", c: "London, UK", ts: 200, rsvp: "in" }];
  E.mergeParticipants(roster, stale, fromWire, removed);
  assert.strictEqual(roster.length, 1, "a link older than the removal can't resurrect them");
  // But somebody re-adding themselves AFTER the removal does stick.
  const rejoined = [{ id: "gone", n: "Gone", c: "London, UK", ts: 900, rsvp: "in" }];
  E.mergeParticipants(roster, rejoined, fromWire, removed);
  assert.strictEqual(roster.length, 2, "a newer edit beats the removal");
});
