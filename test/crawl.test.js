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
