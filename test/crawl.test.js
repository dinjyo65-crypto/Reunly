// Tests for the v0.9 pub-crawl prototype's pure logic.
const test = require("node:test");
const assert = require("node:assert");
const C = require("../prototypes/pub-crawl/crawl-engine.js");

// Four stops ~400 m apart around Bank, London.
const stops = [
  { name: "The Crown", lat: 51.5136, lon: -0.089 },
  { name: "The Swan", lat: 51.5150, lon: -0.0840 },
  { name: "The Old Bell", lat: 51.5139, lon: -0.1062 },
  { name: "Ye Olde Mitre", lat: 51.5185, lon: -0.1077 },
];

test("evening times past midnight sort after the evening", () => {
  assert.ok(C.toMin("00:30") > C.toMin("23:30"));
  assert.strictEqual(C.toHHMM(C.toMin("01:15")), "01:15");
});

test("stops are scheduled with time at each and walking between", () => {
  const s = C.scheduleStops(stops, "17:30", 50);
  assert.strictEqual(s[0].arriveAt, "17:30");
  assert.strictEqual(s[0].leaveAt, "18:20");
  assert.ok(s[1].arrive >= s[0].leave, "can't arrive before leaving the last one");
  assert.ok(s[2].arrive - s[1].leave >= 15, "the long hop west is a real walk");
});

test("someone arriving later joins at a later stop", () => {
  const s = C.scheduleStops(stops, "17:30", 50);
  assert.deepStrictEqual(C.joinsAt({ from: "17:30" }, s), { stopIndex: 0, late: false });
  const later = C.joinsAt({ from: "19:15" }, s);
  assert.ok(later.stopIndex >= 1, "catches the group further along");
  assert.strictEqual(C.joinsAt({ from: "17:00", until: "17:15" }, s), null, "gone before it starts");
});

test("head count per stop counts only people actually there", () => {
  const s = C.scheduleStops(stops, "17:30", 50);
  const people = [
    { from: "17:30", until: "19:00" },
    { from: "19:00" },
    { from: "17:00", status: "out" },
  ];
  const counts = C.headcounts(people, s);
  assert.strictEqual(counts[0], 1);
  assert.strictEqual(counts[counts.length - 1], 1, "only the late arrival is left at the end");
});

test("best start moves later when most people finish work late", () => {
  const people = [{ from: "18:30" }, { from: "18:30" }, { from: "18:45" }, { from: "17:30", until: "19:00" }];
  const best = C.bestStart(stops, people, "17:30", 45);
  assert.ok(C.toMin(best.start) > C.toMin("17:30"), `moved to ${best.start}`);
  assert.ok(best.first >= 3, "most of the group at the first stop");
});

test("opening hours: closed at weekends, open late, unknown stays unknown", () => {
  const city = "Mo-Fr 12:00-23:00; Sa,Su off"; // a City of London pub
  assert.strictEqual(C.isOpenAt(city, "2026-11-05", "18:00"), true, "Thursday evening");
  assert.strictEqual(C.isOpenAt(city, "2026-11-07", "18:00"), false, "Saturday");
  const late = "Mo-Th 12:00-23:00; Fr,Sa 12:00-01:00";
  assert.strictEqual(C.isOpenAt(late, "2026-11-06", "00:30"), true, "Friday night runs past midnight");
  assert.strictEqual(C.isOpenAt(late, "2026-11-05", "23:30"), false, "Thursday shuts at 23:00");
  assert.strictEqual(C.isOpenAt("Mo-Fr 12:00-23:00; PH off", "2026-11-05", "18:00"), null, "public-holiday rules → unknown");
  assert.strictEqual(C.isOpenAt(null, "2026-11-05", "18:00"), null);
});

test("closedStops flags a stop that will be shut when the group arrives", () => {
  const withHours = stops.map((s, i) => ({ ...s, hours: i === 2 ? "Mo-Fr 12:00-19:00" : "Mo-Su 11:00-23:00" }));
  const s = C.scheduleStops(withHours, "17:30", 50);
  assert.deepStrictEqual(C.closedStops(s, "2026-11-05"), [2]);
});

// ---- Duplicates & smart suggest ----
test("the same pub can't be added twice", () => {
  const a = { name: "The Crown", lat: 51.5136, lon: -0.089 };
  assert.ok(C.sameStop(a, { name: "the crown ", lat: 51.51362, lon: -0.08905 }));
  assert.ok(!C.sameStop(a, { name: "The Crown", lat: 51.53, lon: -0.12 }), "a different Crown elsewhere");
});

const venues = [
  { name: "Quiet Ale House", kind: "pub", lat: 51.5136, lon: -0.0890, tags: { food: "yes", wheelchair: "yes", real_ale: "yes" }, hours: "Mo-Su 11:00-23:00" },
  { name: "Neon Cocktails", kind: "bar", lat: 51.5139, lon: -0.0884, tags: { live_sport: "yes" }, hours: "" },
  { name: "Step Inn", kind: "pub", lat: 51.5142, lon: -0.0879, tags: { wheelchair: "no", food: "yes" }, hours: "" },
  { name: "Garden Arms", kind: "pub", lat: 51.5146, lon: -0.0872, tags: { outdoor_seating: "yes", wheelchair: "yes" }, hours: "" },
  { name: "Shut On Thursdays", kind: "pub", lat: 51.5137, lon: -0.0887, tags: { food: "yes", wheelchair: "yes" }, hours: "Fr-Su 12:00-23:00" },
  { name: "Far Away Tavern", kind: "pub", lat: 51.5400, lon: -0.1500, tags: { food: "yes", wheelchair: "yes" }, hours: "" },
];
const start = { lat: 51.5136, lon: -0.0890 };
const plan = { count: 3, date: "2026-11-05", start: "18:00", dwell: 50 };

test("a 30-60 chatty group gets pubs with food first, not the sports bar", () => {
  const who = { ageMin: 30, ageMax: 60, vibe: "chatty", needs: { food: true } };
  const route = C.suggestRoute(venues, start, who, plan);
  assert.strictEqual(route.length, 3);
  assert.strictEqual(route[0].name, "Quiet Ale House");
  assert.ok(route[0].why.includes("Food served"));
  assert.ok(!route.some((v) => v.name === "Neon Cocktails" && route.indexOf(v) === 0));
});

test("step-free need rules out a pub that says no access; closed and far places are skipped", () => {
  const who = { ageMin: 30, ageMax: 60, vibe: "mixed", needs: { stepFree: true } };
  const route = C.suggestRoute(venues, start, who, { ...plan, count: 6 });
  const names = route.map((v) => v.name);
  assert.ok(!names.includes("Step Inn"), "no step-free access");
  assert.ok(!names.includes("Shut On Thursdays"), "shut that evening");
  assert.ok(!names.includes("Far Away Tavern"), "over 15 minutes' walk");
});

test("a lively younger group can get the bar", () => {
  const who = { ageMin: 22, ageMax: 28, vibe: "lively", needs: {} };
  const s = C.scoreVenue(venues[1], who);
  assert.ok(s.score > 1.5 && s.reasons.includes("Shows sport"));
});

// ---- Getting home, booking ----
test("leave-by is 15 minutes before the last train, past midnight too", () => {
  assert.strictEqual(C.leaveBy("23:45"), "23:30");
  assert.strictEqual(C.leaveBy("00:10"), "23:55");
  assert.strictEqual(C.leaveBy(""), null);
});

test("a plan running past the area's last train is flagged", () => {
  const s = C.scheduleStops(stops, "19:00", 60); // ends after 23:00
  assert.ok(C.pastLastTrain(s, "23:00") > 0);
  assert.strictEqual(C.pastLastTrain(s, "01:30"), 0);
  assert.strictEqual(C.pastLastTrain(s, ""), null);
});

test("the end-of-night list shows who isn't home safe yet", () => {
  const people = [
    { name: "A", status: "here" }, { name: "B", status: "home" }, { name: "C", status: "safe" },
    { name: "D", status: "out" }, { name: "E", status: "coming" },
  ];
  const s = C.safetySummary(people);
  assert.deepStrictEqual(s.out.map((p) => p.name), ["A"]);
  assert.deepStrictEqual(s.headingHome.map((p) => p.name), ["B"]);
  assert.deepStrictEqual(s.safe.map((p) => p.name), ["C"]);
});

test("a group of 12+ is told to book stops that aren't booked or walk-in", () => {
  const route = [{ booking: { status: "booked" } }, { booking: { status: "called" } }, {}, { booking: { status: "walkin" } }];
  assert.deepStrictEqual(C.bookingNeeded(route, 14), [1, 2]);
  assert.deepStrictEqual(C.bookingNeeded(route, 8), [], "small groups can walk in");
});

test("way home from the last stop depends on where you live and how you travel", () => {
  const last = { name: "Last pub", lat: 51.5136, lon: -0.089 };
  const manchester = { label: "Manchester, England, United Kingdom", lat: 53.4808, lon: -2.2426 };
  const islington = { label: "Islington, London", lat: 51.5362, lon: -0.1033 };
  const t1 = C.homeTrip({ ...last, leave: 23 * 60 }, manchester, "train", "");
  assert.ok(t1.auto && t1.lastTrain === "21:30" && t1.early && t1.warn, t1.text);
  assert.ok(/about 21:30, estimated/.test(t1.text) && /before the night ends at 23:00/.test(t1.text), t1.text);
  const t2 = C.homeTrip(last, manchester, "train", "21:30");
  assert.ok(/leave by 21:15 for the 21:30 train/.test(t2.text) && !t2.warn && !t2.auto, t2.text);
  const t3 = C.homeTrip(last, islington, "walk", "");
  assert.ok(/min walk home to Islington/.test(t3.text), t3.text);
  assert.strictEqual(C.homeTrip(last, null, "walk", ""), null, "no home given → nothing to say");
});

test("last train is estimated from distance, later locally at weekends", () => {
  assert.strictEqual(C.estimateLastTrain(3, "2026-10-29"), "23:45"); // Thursday
  assert.strictEqual(C.estimateLastTrain(3, "2026-10-30"), "00:15"); // Friday
  assert.strictEqual(C.estimateLastTrain(25), "23:30");
  assert.strictEqual(C.estimateLastTrain(160), "21:30");
  assert.strictEqual(C.estimateLastTrain(null), null);
});
