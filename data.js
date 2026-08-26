/**
 * data.js — Static reference data for the Reunly prototype.
 *
 * Everything here is demo/seed data. No backend, no persistence beyond the
 * browser session. Coordinates power the (estimated) distance + fare math in
 * engine.js, and the city list drives the type-ahead suggestions so that every
 * user picks from the SAME canonical names — which keeps tallies consistent
 * across participants. Adding a city here makes it usable everywhere at once.
 */

/**
 * Known cities with approximate latitude/longitude.
 * Coverage is global so the trial works for participants based in the US,
 * UK, Singapore, UAE and across India, travelling to popular leisure hubs.
 * Naming convention: "City, Country" (US cities keep "City, ST").
 */
const CITY_COORDS = {
  // --- United States ---
  "New York, NY": { lat: 40.7128, lng: -74.006 },
  "San Francisco, CA": { lat: 37.7749, lng: -122.4194 },
  "Los Angeles, CA": { lat: 34.0522, lng: -118.2437 },
  "Chicago, IL": { lat: 41.8781, lng: -87.6298 },
  "Washington, DC": { lat: 38.9072, lng: -77.0369 },
  "Boston, MA": { lat: 42.3601, lng: -71.0589 },
  "Seattle, WA": { lat: 47.6062, lng: -122.3321 },
  "Atlanta, GA": { lat: 33.749, lng: -84.388 },
  "Dallas, TX": { lat: 32.7767, lng: -96.797 },
  // --- United Kingdom / Europe ---
  "London, UK": { lat: 51.5072, lng: -0.1276 },
  "Manchester, UK": { lat: 53.4808, lng: -2.2426 },
  "Paris, France": { lat: 48.8566, lng: 2.3522 },
  // --- Middle East ---
  "Dubai, UAE": { lat: 25.2048, lng: 55.2708 },
  "Abu Dhabi, UAE": { lat: 24.4539, lng: 54.3773 },
  // --- India ---
  "Delhi, India": { lat: 28.6139, lng: 77.209 },
  "Mumbai, India": { lat: 19.076, lng: 72.8777 },
  "Bangalore, India": { lat: 12.9716, lng: 77.5946 },
  "Chennai, India": { lat: 13.0827, lng: 80.2707 },
  "Hyderabad, India": { lat: 17.385, lng: 78.4867 },
  "Kolkata, India": { lat: 22.5726, lng: 88.3639 },
  "Pune, India": { lat: 18.5204, lng: 73.8567 },
  "Goa, India": { lat: 15.4909, lng: 73.8278 },
  // --- Southeast Asia / APAC (popular reunion destinations) ---
  "Singapore": { lat: 1.3521, lng: 103.8198 },
  "Bangkok, Thailand": { lat: 13.7563, lng: 100.5018 },
  "Bali, Indonesia": { lat: -8.6705, lng: 115.2126 },
  "Kuala Lumpur, Malaysia": { lat: 3.139, lng: 101.6869 },
  "Hong Kong": { lat: 22.3193, lng: 114.1694 },
  "Sydney, Australia": { lat: -33.8688, lng: 151.2093 },
};

/** Sorted list of city names for datalist suggestions. */
const CITY_LIST = Object.keys(CITY_COORDS).sort();

/** Landmark/flag emoji per city for visual flair (purely cosmetic). */
const CITY_EMOJI = {
  "New York, NY": "🗽", "San Francisco, CA": "🌉", "Los Angeles, CA": "🌴",
  "Chicago, IL": "🌆", "Washington, DC": "🏛️", "Boston, MA": "⚓",
  "Seattle, WA": "🌲", "Atlanta, GA": "🍑", "Dallas, TX": "🤠",
  "London, UK": "🎡", "Manchester, UK": "⚽", "Paris, France": "🗼",
  "Dubai, UAE": "🏙️", "Abu Dhabi, UAE": "🕌", "Delhi, India": "🛕",
  "Mumbai, India": "🌊", "Bangalore, India": "💻", "Chennai, India": "🏖️",
  "Hyderabad, India": "🍛", "Kolkata, India": "🌉", "Pune, India": "🏞️",
  "Goa, India": "🏝️", "Singapore": "🦁", "Bangkok, Thailand": "🛺",
  "Bali, Indonesia": "🌺", "Kuala Lumpur, Malaysia": "🗼", "Hong Kong": "🌃",
  "Sydney, Australia": "🌅",
};

/** Emoji for a city (case-insensitive), with a pin fallback. */
function cityEmoji(city) {
  if (!city) return "📍";
  const key = Object.keys(CITY_EMOJI).find(
    (k) => k.toLowerCase() === city.trim().toLowerCase()
  );
  return key ? CITY_EMOJI[key] : "📍";
}

/**
 * Real round-trip fare bands (USD) captured from live fare searches
 * (Skyscanner, KAYAK, Expedia, Google Flights, momondo, Trip.com) for 2026
 * travel. These are genuine "current point in time" ranges, NOT live API calls
 * — a client-side prototype can't query fare providers directly (CORS/CSP). The
 * engine prefers these over the distance estimate and labels them "searched
 * (as of FARES_AS_OF)" so they're never confused with the estimated fallback.
 * Key format: "From|To" using canonical CITY_COORDS names.
 */
const FARES_AS_OF = "2026-06-27";
const SEARCHED_FARES = {
  "Singapore|Bangkok, Thailand": { min: 150, max: 310 },
  "Dubai, UAE|Bali, Indonesia": { min: 520, max: 980 },
  "Mumbai, India|Goa, India": { min: 65, max: 150 },
  "London, UK|Dubai, UAE": { min: 380, max: 685 },
  "Delhi, India|Bangkok, Thailand": { min: 230, max: 320 },
  "New York, NY|London, UK": { min: 430, max: 650 },
};

/** Base currency all stored fares are expressed in. */
const CURRENCY = "USD";

/**
 * Display currencies for region-aware fare formatting. `rate` is units per 1
 * USD (approximate, static — clearly labelled "approx" in the UI). Add a code
 * here and map a country to it in COUNTRY_CURRENCY to extend coverage.
 */
// When the rates below were last set by hand. Surfaced in the UI so a stale
// rate is visible rather than silently skewing every converted number.
const RATES_AS_OF = "2026-06-27";
const CURRENCIES = {
  USD: { symbol: "$", rate: 1 },
  INR: { symbol: "₹", rate: 83 },
  GBP: { symbol: "£", rate: 0.79 },
  SGD: { symbol: "S$", rate: 1.35 },
  AED: { symbol: "AED ", rate: 3.67 },
  EUR: { symbol: "€", rate: 0.92 },
  THB: { symbol: "฿", rate: 36 },
  IDR: { symbol: "Rp", rate: 16300 },
  MYR: { symbol: "RM", rate: 4.7 },
  HKD: { symbol: "HK$", rate: 7.8 },
  AUD: { symbol: "A$", rate: 1.52 },
  JPY: { symbol: "¥", rate: 157 },
  CNY: { symbol: "CN¥", rate: 7.2 },
  CAD: { symbol: "C$", rate: 1.36 },
  CHF: { symbol: "CHF ", rate: 0.88 },
};

/**
 * Map a city's country (parsed from its name) to a display currency code.
 * Includes the short forms our own city list uses AND the full country names
 * the live geocoder (OpenStreetMap) returns, so typed suggestions work too.
 */
const COUNTRY_CURRENCY = {
  India: "INR",
  UK: "GBP", "United Kingdom": "GBP", England: "GBP", Scotland: "GBP", Wales: "GBP",
  UAE: "AED", "United Arab Emirates": "AED",
  France: "EUR", Germany: "EUR", Spain: "EUR", Italy: "EUR", Ireland: "EUR",
  Netherlands: "EUR", Portugal: "EUR", Greece: "EUR", Belgium: "EUR", Austria: "EUR",
  Thailand: "THB",
  Indonesia: "IDR",
  Malaysia: "MYR",
  Australia: "AUD",
  Singapore: "SGD",
  "Hong Kong": "HKD",
  Japan: "JPY", China: "CNY", Canada: "CAD", Switzerland: "CHF",
  "United States": "USD", USA: "USD", "United States of America": "USD",
};

/** ISO-3166 country code → currency (used with live reverse/suggest geocoding). */
const CC_CURRENCY = {
  us: "USD", gb: "GBP", in: "INR", ae: "AED", sg: "SGD", hk: "HKD",
  fr: "EUR", de: "EUR", es: "EUR", it: "EUR", ie: "EUR", nl: "EUR", pt: "EUR",
  gr: "EUR", be: "EUR", at: "EUR", th: "THB", id: "IDR", my: "MYR", au: "AUD",
  jp: "JPY", cn: "CNY", ca: "CAD", ch: "CHF",
};

/**
 * Pick the local display currency for a city name. Uses the country segment
 * (after the last comma). Falls back to USD for anything unmapped.
 */
function currencyForCity(city) {
  const name = (city || "").trim();
  if (!name) return "USD";
  if (name === "Singapore") return "SGD";
  if (name === "Hong Kong") return "HKD";
  const tail = name.includes(",") ? name.split(",").pop().trim() : name;
  return COUNTRY_CURRENCY[tail] || "USD";
}

/**
 * Get-together types. Reunly is positioned broadly — any group deciding when,
 * where and how to meet — so this spans far beyond classic reunions.
 */
const EVENT_TYPES = [
  "Friends meetup",
  "Family gathering",
  "School reunion",
  "University / alumni",
  "Office / work",
  "Wedding",
  "Holiday / group trip",
  "Sports club",
  "Birthday",
  "Other",
];

/** Dietary options collected per person and rolled up for the host. */
const FOOD_OPTIONS = [
  "No preference",
  "Vegetarian",
  "Vegan",
  "Halal",
  "Kosher",
  "Gluten-free",
  "Pescatarian",
];

/** Activity interests collected per person (multi-select) and rolled up. */
const ACTIVITY_OPTIONS = [
  "Beach",
  "Nightlife",
  "Sightseeing",
  "Food & dining",
  "Nature / hiking",
  "Relaxation",
  "Adventure",
  "Culture",
  "Shopping",
];

/** Default preference block for a participant. */
function defaultPrefs() {
  return {
    budget: "", // max spend per person, in USD (number as string)
    food: "No preference",
    accommodation: false, // needs a place to stay?
    kids: 0, // number of children attending
    accessibility: "", // free-text access needs
    activities: [], // subset of ACTIVITY_OPTIONS
  };
}

/**
 * Factory for a blank participant. Dates and destinations are now VARIABLE
 * length — people add as many ranked options as they like (index 0 = top
 * choice). A fresh participant starts with one empty row of each.
 */
function makeParticipant(overrides = {}) {
  return {
    name: "",
    email: "",
    city: "",
    dates: [{ start: "", end: "" }],
    destinations: [""],
    prefs: defaultPrefs(),
    rsvp: "no_response", // "in" | "out" | "no_response"
    // Answers to "does the group's current top date/place work for you?" —
    // null = not asked yet, true = accepted the group pick, false = provided
    // their own alternative instead. Set once via the Decide-tab confirm step.
    dateConfirmed: null,
    destConfirmed: null,
    ...overrides,
    // AFTER the spread: an explicit `id: undefined` in overrides must not
    // clobber the generated id. Participants from invite links carry no id,
    // and without one they can't be referenced by expenses, votes or RSVP.
    id: (overrides && overrides.id) || `p_${Math.random().toString(36).slice(2, 9)}`,
  };
}

/**
 * Merge a (possibly older / partial) participant object onto the current shape,
 * filling any missing fields. Used after loadState/import so data saved by an
 * earlier version never breaks the new UI. Preserves variable-length lists and
 * guarantees at least one row of each.
 */
function normalizeParticipant(p) {
  const base = makeParticipant({ id: p && p.id });
  const out = { ...base, ...(p || {}) };
  // Spreading `p` can clobber the generated id with an explicit `undefined`
  // (e.g. participants arriving from an invite link, which carries no ids).
  // Without an id they can't be referenced by expenses, votes or RSVP.
  if (!out.id) out.id = base.id;
  const rawDates = p && Array.isArray(p.dates) ? p.dates : [];
  out.dates = rawDates.map((d) => ({ start: (d && d.start) || "", end: (d && d.end) || "" }));
  if (!out.dates.length) out.dates = [{ start: "", end: "" }];
  const rawDest = p && Array.isArray(p.destinations) ? p.destinations : [];
  out.destinations = rawDest.map((d) => d || "");
  if (!out.destinations.length) out.destinations = [""];
  out.prefs = { ...defaultPrefs(), ...((p && p.prefs) || {}) };
  out.prefs.activities = Array.isArray(out.prefs.activities) ? out.prefs.activities : [];
  out.rsvp = (p && p.rsvp) || "no_response";
  // Preserve explicit true/false — collapse missing/undefined to null (not-yet-asked).
  out.dateConfirmed = p && p.dateConfirmed !== undefined ? p.dateConfirmed : null;
  out.destConfirmed = p && p.destConfirmed !== undefined ? p.destConfirmed : null;
  return out;
}

// Common candidate date ranges (festive/holiday windows) reused across the
// demo participants so availability tallies have meaningful overlap.
const D = {
  xmas: { start: "2026-12-19", end: "2026-12-26" },
  jan: { start: "2027-01-16", end: "2027-01-23" },
  nov: { start: "2026-11-21", end: "2026-11-28" },
};

/** Demo participants spread across the trial regions (US, UK, UAE, SG, India). */
const SEED_PARTICIPANTS = [
  makeParticipant({
    id: "p_seed_1",
    name: "Aisha Al-Farsi",
    email: "aisha@example.com",
    city: "Dubai, UAE",
    dates: [D.xmas, D.jan, D.nov],
    destinations: ["Bali, Indonesia", "Bangkok, Thailand", "Singapore"],
    prefs: { budget: "1200", food: "Halal", accommodation: true, kids: 2, accessibility: "", activities: ["Beach", "Relaxation", "Food & dining"] },
  }),
  makeParticipant({
    id: "p_seed_2",
    name: "Wei Lim",
    email: "wei@example.com",
    city: "Singapore",
    dates: [D.xmas, D.nov, D.jan],
    destinations: ["Bangkok, Thailand", "Bali, Indonesia", "Goa, India"],
    prefs: { budget: "900", food: "No preference", accommodation: true, kids: 0, accessibility: "", activities: ["Nightlife", "Food & dining", "Adventure"] },
  }),
  makeParticipant({
    id: "p_seed_3",
    name: "James Carter",
    email: "james@example.com",
    city: "London, UK",
    dates: [D.jan, D.xmas, D.nov],
    destinations: ["Dubai, UAE", "Goa, India", "Singapore"],
    prefs: { budget: "1500", food: "No preference", accommodation: true, kids: 0, accessibility: "", activities: ["Sightseeing", "Culture", "Food & dining"] },
  }),
  makeParticipant({
    id: "p_seed_4",
    name: "Priya Sharma",
    email: "priya@example.com",
    city: "Mumbai, India",
    dates: [D.xmas, D.jan, D.nov],
    destinations: ["Goa, India", "Dubai, UAE", "Bangkok, Thailand"],
    prefs: { budget: "600", food: "Vegetarian", accommodation: false, kids: 1, accessibility: "", activities: ["Beach", "Relaxation"] },
  }),
  makeParticipant({
    id: "p_seed_5",
    name: "Rohan Mehta",
    email: "rohan@example.com",
    city: "Delhi, India",
    dates: [D.xmas, D.nov, D.jan],
    destinations: ["Goa, India", "Bangkok, Thailand", "Dubai, UAE"],
    prefs: { budget: "700", food: "Vegetarian", accommodation: true, kids: 0, accessibility: "", activities: ["Nightlife", "Beach", "Adventure"] },
  }),
  makeParticipant({
    id: "p_seed_6",
    name: "Emily Davis",
    email: "emily@example.com",
    city: "New York, NY",
    dates: [D.nov, D.xmas, D.jan],
    destinations: ["London, UK", "Bali, Indonesia", "Bangkok, Thailand"],
    prefs: { budget: "2000", food: "Pescatarian", accommodation: true, kids: 0, accessibility: "Step-free access preferred", activities: ["Culture", "Sightseeing", "Shopping"] },
  }),
  makeParticipant({
    id: "p_seed_7",
    name: "Ananya Reddy",
    email: "ananya@example.com",
    city: "Bangalore, India",
    dates: [D.xmas, D.jan, D.nov],
    destinations: ["Goa, India", "Singapore", "Bangkok, Thailand"],
    prefs: { budget: "800", food: "Vegan", accommodation: false, kids: 0, accessibility: "", activities: ["Beach", "Nature / hiking", "Relaxation"] },
  }),
];

// Give the sample group some RSVP variety (most in, one undecided, one out).
SEED_PARTICIPANTS.forEach((p, i) => {
  p.rsvp = i === 6 ? "no_response" : i === 5 ? "out" : "in";
});

// Expose for non-module script usage (loaded via plain <script> tags).
window.ReunlyData = {
  CITY_COORDS,
  CITY_LIST,
  FARES_AS_OF,
  SEARCHED_FARES,
  CURRENCY,
  CURRENCIES,
  RATES_AS_OF,
  CC_CURRENCY,
  currencyForCity,
  cityEmoji,
  EVENT_TYPES,
  FOOD_OPTIONS,
  ACTIVITY_OPTIONS,
  defaultPrefs,
  makeParticipant,
  normalizeParticipant,
  SEED_PARTICIPANTS,
};
