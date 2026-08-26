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
  const dates = [{ start: "2026-08-01", end: "2026-08-05" }];
  const people = [
    person({ name: "A", city: "London, UK", destinations: ["Cheapville", "Pricey"], dates, prefs: { budget: "400" } }),
    person({ name: "B", city: "Paris, France", destinations: ["Pricey", "Cheapville"], dates, prefs: { budget: "400" } }),
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
    person({ prefs: { budget: "", kids: 0 } }),
    person({ prefs: { budget: "300" } }),
  ];
  const s = E.summarizePrefs(people);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.budgets.length, 2, "blank budget is skipped, not counted as 0");
  assert.strictEqual(s.minBudget, 100);
  assert.strictEqual(s.maxBudget, 300);
  assert.strictEqual(s.kids, 2);
  assert.strictEqual(s.accommodation, 1);
});
