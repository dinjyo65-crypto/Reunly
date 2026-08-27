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
  const people = [
    person({ city: "Paris, France", destinations: ["London, UK", "Goa, India"], dates }),
    person({ city: "London, UK", destinations: ["Goa, India", "London, UK"], dates }),
  ];
  // Nearby London has the cheaper flight; far Goa is far cheaper to stay in.
  const fares = fixedFares({
    "Paris, France|London, UK": { min: 100, max: 100, source: "estimated" },
    "London, UK|London, UK": { min: 0, max: 0, source: "estimated" },
    "Paris, France|Goa, India": { min: 600, max: 600, source: "estimated" },
    "London, UK|Goa, India": { min: 600, max: 600, source: "estimated" },
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

test("a real captured fare is never scaled by our seasonal guess", () => {
  // A searched fare already reflects whatever season it was quoted for;
  // multiplying it would corrupt observed data.
  const searched = fixedFares({ "London, UK|Goa, India": { min: 500, max: 500, source: "searched" } });
  const quiet = E.tripCostFor("London, UK", "Goa, India", { start: "2026-05-04", end: "2026-05-11" }, searched);
  const xmas = E.tripCostFor("London, UK", "Goa, India", { start: "2026-12-20", end: "2026-12-27" }, searched);
  assert.strictEqual(quiet.travel, 500);
  assert.strictEqual(xmas.travel, 500, "searched fares stay exactly as captured");
  assert.ok(xmas.lodging > quiet.lodging, "but our own lodging estimate still moves");
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
