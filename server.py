"""
server.py — Reunly static host + tiny fare proxy.

Serves the PWA files AND exposes a same-origin fare API the front end calls:

  GET /api/health            -> { ok, live, asOf }
  GET /api/fare?from=&to=&date=
                             -> { min, max, currency, source, asOf? }

Fare resolution order (honest, never fabricated):
  1. LIVE  — Amadeus Flight Offers Search, IF AMADEUS_CLIENT_ID / _SECRET env
             vars are set (free self-service tier). source = "live".
  2. SEARCHED — curated real round-trip ranges captured from fare sites.
  3. ESTIMATED — distance-based heuristic fallback.
  4. unknown  — city not in the coordinate table.

No API key required to run: without Amadeus creds it transparently serves
searched/estimated data through the same endpoint, so the plumbing is real and
flips to live the moment credentials are provided.

Run:  python server.py            (defaults to PORT 4175)
Live: set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET, then run.
"""

import datetime
import json
import math
import os
import re
import socket
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

USER_AGENT = "Reunly/0.5 (reunion planner prototype)"

PORT = int(os.environ.get("PORT", "4175"))

# Amadeus has two hosts: the sandbox (test.api) returns FICTIONAL inventory,
# production (api) returns real prices. Default to the sandbox because that's
# what free self-service keys work against — but track which one we used, so
# the UI can label sandbox numbers as test data instead of passing them off as
# real live fares.
AMADEUS_HOST = os.environ.get("AMADEUS_HOST", "https://test.api.amadeus.com")
AMADEUS_IS_SANDBOX = "test.api." in AMADEUS_HOST
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
FARES_AS_OF = "2026-06-27"

# --- City coordinates (mirror of data.js, server-side estimate fallback) ------
CITY_COORDS = {
    "New York, NY": (40.7128, -74.006),
    "San Francisco, CA": (37.7749, -122.4194),
    "Los Angeles, CA": (34.0522, -118.2437),
    "Chicago, IL": (41.8781, -87.6298),
    "Washington, DC": (38.9072, -77.0369),
    "Boston, MA": (42.3601, -71.0589),
    "Seattle, WA": (47.6062, -122.3321),
    "Atlanta, GA": (33.749, -84.388),
    "Dallas, TX": (32.7767, -96.797),
    "London, UK": (51.5072, -0.1276),
    "Manchester, UK": (53.4808, -2.2426),
    "Paris, France": (48.8566, 2.3522),
    "Dubai, UAE": (25.2048, 55.2708),
    "Abu Dhabi, UAE": (24.4539, 54.3773),
    "Delhi, India": (28.6139, 77.209),
    "Mumbai, India": (19.076, 72.8777),
    "Bangalore, India": (12.9716, 77.5946),
    "Chennai, India": (13.0827, 80.2707),
    "Hyderabad, India": (17.385, 78.4867),
    "Kolkata, India": (22.5726, 88.3639),
    "Pune, India": (18.5204, 73.8567),
    "Goa, India": (15.4909, 73.8278),
    "Singapore": (1.3521, 103.8198),
    "Bangkok, Thailand": (13.7563, 100.5018),
    "Bali, Indonesia": (-8.6705, 115.2126),
    "Kuala Lumpur, Malaysia": (3.139, 101.6869),
    "Hong Kong": (22.3193, 114.1694),
    "Sydney, Australia": (-33.8688, 151.2093),
}

# --- Curated real round-trip USD fares (mirror of data.js) --------------------
SEARCHED_FARES = {
    "Singapore|Bangkok, Thailand": (150, 310),
    "Dubai, UAE|Bali, Indonesia": (520, 980),
    "Mumbai, India|Goa, India": (65, 150),
    "London, UK|Dubai, UAE": (380, 685),
    "Delhi, India|Bangkok, Thailand": (230, 320),
    "New York, NY|London, UK": (430, 650),
}

# --- City -> IATA (needed for the live Amadeus path) --------------------------
CITY_IATA = {
    "New York, NY": "JFK", "San Francisco, CA": "SFO", "Los Angeles, CA": "LAX",
    "Chicago, IL": "ORD", "Washington, DC": "IAD", "Boston, MA": "BOS",
    "Seattle, WA": "SEA", "Atlanta, GA": "ATL", "Dallas, TX": "DFW",
    "London, UK": "LHR", "Manchester, UK": "MAN", "Paris, France": "CDG",
    "Dubai, UAE": "DXB", "Abu Dhabi, UAE": "AUH", "Delhi, India": "DEL",
    "Mumbai, India": "BOM", "Bangalore, India": "BLR", "Chennai, India": "MAA",
    "Hyderabad, India": "HYD", "Kolkata, India": "CCU", "Pune, India": "PNQ",
    "Goa, India": "GOI", "Singapore": "SIN", "Bangkok, Thailand": "BKK",
    "Bali, Indonesia": "DPS", "Kuala Lumpur, Malaysia": "KUL",
    "Hong Kong": "HKG", "Sydney, Australia": "SYD",
}

_LOWER = {k.lower(): k for k in CITY_COORDS}


def resolve_city(name):
    return _LOWER.get((name or "").strip().lower())


# --- Geocoding for ANY city (OpenStreetMap Nominatim, keyless) ----------------
# Serialized via a lock so concurrent fare requests for the same new city only
# hit Nominatim once (respects their fair-use policy).
# Every cache below is keyed by a raw query string from an unauthenticated
# client, so on the public deployment they would otherwise grow without bound
# while amplifying requests to Nominatim/Wikipedia from the server's IP.
CACHE_LIMIT = 5000
# Largest request body we're willing to read and throw away; beyond this the
# connection is closed rather than left half-drained.
MAX_DRAIN = 1 << 20

# The only files the static server may hand out. Everything else in the
# working directory (.git, server source, docs, tests, hero-animation/) is 404.
STATIC_FILES = {
    "index.html", "styles.css", "data.js", "engine.js", "fares.js",
    "globe-land.js", "app.js", "service-worker.js", "manifest.json", "icon.svg",
    # v0.9 prototype (pub crawl / work social live tracker)
    "prototypes/pub-crawl/index.html", "prototypes/pub-crawl/crawl.css",
    "prototypes/pub-crawl/crawl.js", "prototypes/pub-crawl/crawl-engine.js",
    "prototypes/pub-crawl/vendor/leaflet.js", "prototypes/pub-crawl/vendor/leaflet.css",
}
# Longest query parameter any /api/ endpoint legitimately takes.
MAX_PARAM = 160

# Per-IP token bucket for /api/. Sized for the real client: opening a plan
# fires ~90 fare/photo lookups at once, so the burst is generous; sustained
# abuse drains it and gets 429s.
RATE_BURST = 240
RATE_PER_SEC = 4.0
_rate_buckets = {}
_rate_lock = threading.Lock()


def _rate_ok(ip):
    now = time.monotonic()
    with _rate_lock:
        tokens, last = _rate_buckets.get(ip, (RATE_BURST, now))
        tokens = min(RATE_BURST, tokens + (now - last) * RATE_PER_SEC)
        if len(_rate_buckets) > CACHE_LIMIT:
            _rate_buckets.clear()  # bounded: forgetting buckets only forgives
        if tokens < 1:
            _rate_buckets[ip] = (tokens, now)
            return False
        _rate_buckets[ip] = (tokens - 1, now)
        return True


# Nominatim's usage policy is at most 1 request/second per application. One
# shared pacer for every call this server makes to it, whoever asked.
_nominatim_lock = threading.Lock()
_nominatim_next = [0.0]


NOMINATIM_MAX_WAIT = 5.0


def _nominatim_wait():
    """Take the next 1-per-second slot, or raise if the queue is too long.

    Unbounded, a scripted flood made every real user's lookup wait minutes.
    Callers run this inside their try block, so a refusal is just a failed
    lookup — and failed lookups are never cached.
    """
    with _nominatim_lock:
        now = time.monotonic()
        wait = _nominatim_next[0] - now
        if wait > NOMINATIM_MAX_WAIT:
            raise RuntimeError("nominatim queue full")
        _nominatim_next[0] = max(now, _nominatim_next[0]) + 1.0
    if wait > 0:
        time.sleep(wait)


def _cache_put(cache, key, value):
    """Store, discarding the oldest entries once the cache is full."""
    if len(cache) >= CACHE_LIMIT:
        for old in list(cache)[: CACHE_LIMIT // 4]:
            cache.pop(old, None)
    cache[key] = value
    return value


_geo_cache = {}
_geo_lock = threading.Lock()


def geocode(name):
    key = (name or "").strip().lower()
    if not key:
        return None
    # Check the cache under the lock, then RELEASE it before the network call.
    # Holding a global lock across an 8-second request serialised every other
    # user's lookups behind one slow response.
    with _geo_lock:
        if key in _geo_cache:
            return _geo_cache[key]
    coord = None
    try:
        q = urllib.parse.urlencode({"q": name, "format": "json", "limit": 1})
        _nominatim_wait()

        req = urllib.request.Request(
            "https://nominatim.openstreetmap.org/search?" + q,
            headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=8) as r:
            arr = json.loads(r.read())
        if arr:
            coord = (float(arr[0]["lat"]), float(arr[0]["lon"]))
    except Exception:
        # A timeout or 5xx says nothing about the place. Caching it pinned
        # that city as unresolvable (no fare, no globe) until a restart.
        return None
    with _geo_lock:
        _cache_put(_geo_cache, key, coord)
    return coord


# --- Type-ahead place suggestions (Nominatim search) --------------------------
_suggest_cache = {}
_suggest_lock = threading.Lock()


def _short_label(item):
    """Build a concise 'City, Country' label from a Nominatim result."""
    addr = item.get("address", {})
    place = (
        addr.get("city") or addr.get("town") or addr.get("village")
        or addr.get("municipality") or addr.get("state") or item.get("name")
        or item.get("display_name", "").split(",")[0]
    )
    country = addr.get("country")
    label = ", ".join([x for x in (place, country) if x])
    return label or item.get("display_name", "")


def suggest_places(q):
    key = q.strip().lower()
    if len(key) < 2:
        return []
    # Same reasoning as geocode(): type-ahead fires per keystroke, so holding a
    # global lock across the request made N typists queue up 8 seconds apart.
    with _suggest_lock:
        if key in _suggest_cache:
            return _suggest_cache[key]
    results = []
    try:
        params = urllib.parse.urlencode({
            "q": q, "format": "json", "limit": 6, "addressdetails": 1,
            "featuretype": "city", "accept-language": "en",
        })
        _nominatim_wait()

        req = urllib.request.Request(
            "https://nominatim.openstreetmap.org/search?" + params,
            headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=8) as r:
            arr = json.loads(r.read())
        seen = set()
        for item in arr:
            label = _short_label(item)
            if not label or label.lower() in seen:
                continue
            seen.add(label.lower())
            results.append({
                "label": label,
                "lat": float(item["lat"]),
                "lon": float(item["lon"]),
                "cc": (item.get("address", {}).get("country_code") or "").lower(),
            })
    except Exception:
        return []  # a failure isn't "no such place" — don't cache it
    with _suggest_lock:
        _cache_put(_suggest_cache, key, results)
    return results


AREA_TAGS = ("city", "town", "village", "suburb", "borough", "neighbourhood", "quarter", "hamlet")


def suggest_cities(q, areas=False):
    """Type-ahead for a HOME city, the way a maps app does it.

    Nominatim matches whole words, so "Lond" or "Springf" found nothing, and
    its labels dropped the region, so five US Springfields collapsed into one
    "Springfield, United States" entry. Photon (keyless, OpenStreetMap-based)
    is built for prefix search and returns state + country for each match.
    Restricted to cities and towns: a home is never a state or a borough.
    Falls back to the Nominatim path if Photon is unreachable.

    areas=True widens it to suburbs, neighbourhoods and villages, labelled
    with their city ("Islington, London, United Kingdom") — for "coming
    from", where the general search only offered "Greater London".
    """
    key = q.strip().lower()
    if len(key) < 2:
        return []
    ckey = ("area:" if areas else "city:") + key
    with _suggest_lock:
        if ckey in _suggest_cache:
            return _suggest_cache[ckey]
    results = []
    try:
        tags = AREA_TAGS if areas else ("city", "town")
        params = urllib.parse.urlencode(
            [("q", q), ("limit", 8), ("lang", "en")] + [("osm_tag", "place:" + t) for t in tags])
        req = urllib.request.Request(
            "https://photon.komoot.io/api/?" + params,
            headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=8) as r:
            feats = json.loads(r.read()).get("features", [])
        seen = set()
        for f in feats:
            p = f.get("properties", {})
            name, country = p.get("name"), p.get("country")
            if not name or not country:
                continue
            state = p.get("state")
            # A suburb is better placed by its city than its state.
            region = (p.get("city") if areas and p.get("city") not in (None, name) else None) or state
            parts = [name] + ([region] if region and region not in (name, country) else []) + [country]
            label = ", ".join(parts)
            if label.lower() in seen:
                continue
            seen.add(label.lower())
            lon, lat = f["geometry"]["coordinates"]
            results.append({
                "label": label, "lat": float(lat), "lon": float(lon),
                "cc": (p.get("countrycode") or "").lower(),
            })
            if len(results) == 6:
                break
    except Exception:
        return suggest_places(q)
    with _suggest_lock:
        _cache_put(_suggest_cache, ckey, results)
    return results


def reverse_geocode(lat, lng):
    try:
        params = urllib.parse.urlencode({
            "lat": lat, "lon": lng, "format": "json", "zoom": 10,
            "addressdetails": 1, "accept-language": "en",
        })
        _nominatim_wait()

        req = urllib.request.Request(
            "https://nominatim.openstreetmap.org/reverse?" + params,
            headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=8) as r:
            item = json.loads(r.read())
        return {
            "label": _short_label(item),
            "cc": (item.get("address", {}).get("country_code") or "").lower(),
        }
    except Exception:
        return {"label": "", "cc": ""}


def coords_for(name):
    """Return (lat, lng) for a city: known table first, else geocoded."""
    key = resolve_city(name)
    if key:
        return CITY_COORDS[key]
    return geocode(name)


def haversine_miles(a, b):
    r = 3958.8
    lat1, lng1 = a
    lat2, lng2 = b
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    h = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(d_lng / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))


# Must mirror estimateFare in engine.js. The client prefers this proxy answer
# over its own estimate, so any rule that lives only in engine.js is silently
# bypassed the moment the server is reachable -- which is normal operation, not
# an edge case. This function had no drive branch and returned no mode, so a
# 190-mile family drive was costed as three airline tickets ($307.50 instead of
# $70) while the card beside it drew a car.
DRIVE_MILES = 300


def estimate_fare(miles):
    if miles is None:
        return None
    if miles == 0:
        return (0, 0, "local")
    driving = miles <= DRIVE_MILES
    # Always the price of a SEAT. The client's engine prices the car itself
    # (per vehicle, real road distance, regional speeds) and picks whichever is
    # cheaper for the party; handing it fuel money as a "fare" made a short
    # flight look like a $100 tank of petrol whenever driving was ruled out.
    base = 60
    per_mile = 0.20
    near = min(miles, 600) * per_mile
    far = max(0, miles - 600) * 0.11
    mid = base + near + far
    # Always "flight": this is a seat price. Whether the party drives instead
    # is decided by the client's engine, which knows the road and the party.
    return (
        round(mid * 0.82 / 5) * 5,
        round(mid * 1.28 / 5) * 5,
        "flight",
    )


# NOTE: lodging estimates live in engine.js only. Scoring needs them
# synchronously and offline, so the client is the single source of truth —
# a second copy here silently drifted out of step (the two tables used
# different lookups and already disagreed for some cities).


# --- Amadeus live path (optional) --------------------------------------------
_token_cache = {"token": None, "exp": 0}


def _amadeus_token():
    cid = os.environ.get("AMADEUS_CLIENT_ID")
    secret = os.environ.get("AMADEUS_CLIENT_SECRET")
    if not cid or not secret:
        return None
    if _token_cache["token"] and _token_cache["exp"] > time.time() + 30:
        return _token_cache["token"]
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": cid,
        "client_secret": secret,
    }).encode()
    req = urllib.request.Request(
        AMADEUS_HOST + "/v1/security/oauth2/token", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=8) as r:
        body = json.loads(r.read())
    _token_cache["token"] = body["access_token"]
    _token_cache["exp"] = time.time() + body.get("expires_in", 1800)
    return _token_cache["token"]


def amadeus_fare(frm, to, date, nights=5):
    """Return (min, max) round-trip USD from live offers, or None on any issue."""
    o_iata = CITY_IATA.get(frm)
    d_iata = CITY_IATA.get(to)
    if not o_iata or not d_iata:
        return None
    try:
        token = _amadeus_token()
        if not token:
            return None
        # No date means we cannot price anything honestly. The old fallback
        # pinned every lookup to one hard-coded August departure regardless of
        # when the group was actually travelling -- and that date has since
        # passed, so the live path silently returned nothing forever while the
        # app went on badging estimates as though the lookup still worked.
        if not date:
            return None
        try:
            datetime.date.fromisoformat(date)
        except ValueError:
            return None
        # Don't quote a departure in the past; airlines have no such inventory.
        if datetime.date.fromisoformat(date) < datetime.date.today():
            return None
        dep = date
        ret = _plus_days(dep, max(1, min(int(nights or 5), 60)))
        params = urllib.parse.urlencode({
            "originLocationCode": o_iata,
            "destinationLocationCode": d_iata,
            "departureDate": dep,
            "returnDate": ret,
            "adults": 1,
            "currencyCode": "USD",
            "max": 8,
        })
        req = urllib.request.Request(
            AMADEUS_HOST + "/v2/shopping/flight-offers?" + params,
            headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read())
        prices = [float(o["price"]["grandTotal"]) for o in body.get("data", [])]
        if not prices:
            return None
        return (round(min(prices)), round(max(prices)))
    except Exception:
        return None


def _plus_days(iso, days):
    import datetime
    y, m, d = (int(x) for x in iso.split("-"))
    dt = datetime.date(y, m, d) + datetime.timedelta(days=days)
    return dt.isoformat()


def resolve_fare(frm_raw, to_raw, date, nights=5):
    o = coords_for(frm_raw)
    d = coords_for(to_raw)
    if not o or not d:
        return {"source": "unknown", "currency": "USD"}

    miles = round(haversine_miles(o, d))
    frm = resolve_city(frm_raw)
    to = resolve_city(to_raw)

    # Every fare here is a SEAT price, so `mode` is "flight" (or "local" for the
    # same city). Drive-vs-fly is decided by the client engine (chooseTravel),
    # which knows the party size and the regional road profile; labelling a
    # short hop "drive" here contradicted it (Pune→Goa is a 10-hour road trip).
    mode = "local" if miles == 0 else "flight"

    # Live (only for canonical cities with known IATA codes).
    if os.environ.get("AMADEUS_CLIENT_ID") and frm in CITY_IATA and to in CITY_IATA:
        live = amadeus_fare(frm, to, date, nights)
        if live:
            # Sandbox inventory is fictional — never badge it as a real fare.
            # A live airline quote is a flight whatever the distance says.
            return {"min": live[0], "max": live[1], "currency": "USD",
                    "source": "sandbox" if AMADEUS_IS_SANDBOX else "live",
                    "asOf": time.strftime("%Y-%m-%d"), "miles": miles, "mode": "flight"}

    # Curated searched fares (canonical pairs only).
    if frm and to:
        key = f"{frm}|{to}"
        if key in SEARCHED_FARES:
            lo, hi = SEARCHED_FARES[key]
            return {"min": lo, "max": hi, "currency": "USD", "source": "searched",
                    "asOf": FARES_AS_OF, "miles": miles, "mode": "flight"}

    if miles == 0:
        return {"min": 0, "max": 0, "currency": "USD", "source": "estimated",
                "miles": 0, "mode": "local"}
    est = estimate_fare(miles)
    return {"min": est[0], "max": est[1], "currency": "USD", "source": "estimated",
            "miles": miles, "mode": est[2]}


# --- LAN address (so phones on the same Wi-Fi can open the app) ---------------
def lan_ip():
    """Best-effort LAN IP of this machine (no packets actually sent)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# --- Weather at destination (Open-Meteo, keyless) ------------------------------
# Within 15 days we use the real forecast; further out we fetch the same dates
# last year and label it "typical". Cached per (place, start, end).
_weather_cache = {}
_weather_lock = threading.Lock()


def _avg(values):
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals)) if vals else None


def weather_for(place, start, end):
    key = f"{place}|{start}|{end}".lower()
    # Check the cache under the lock, then RELEASE it for the network calls.
    # geocode() was fixed for this and these two handlers reintroduced it:
    # holding a global lock across two 8-second upstream requests serialised
    # every other user behind one slow response. Measured as a clean staircase
    # (0.23 / 0.38 / 0.83 / 0.98s) for four concurrent lookups of four cities.
    with _weather_lock:
        if key in _weather_cache:
            return _weather_cache[key]
    result = {"ok": False}
    try:
        coords = coords_for(place)
        if coords and start:
            today = datetime.date.today()
            s = datetime.date.fromisoformat(start)
            e = datetime.date.fromisoformat(end) if end else s
            if e < s:
                e = s
            days_until = (s - today).days
            if 0 <= days_until <= 15:
                mode = "forecast"
                qs, qe = s, min(e, s + datetime.timedelta(days=15 - days_until))
                url = (
                    "https://api.open-meteo.com/v1/forecast?"
                    + urllib.parse.urlencode({
                        "latitude": coords[0], "longitude": coords[1],
                        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                        "start_date": qs.isoformat(), "end_date": qe.isoformat(),
                        "timezone": "auto",
                    })
                )
            else:
                mode = "typical"
                # Same dates one year earlier (historical archive).
                shift = datetime.timedelta(days=365)
                qs, qe = s - shift, e - shift
                # Ask for rainfall too. Without it, a trip more than 15 days
                # out (i.e. most trips) showed temperature only — so the
                # monsoon-season case this exists to warn about went
                # completely unflagged.
                url = (
                    "https://archive-api.open-meteo.com/v1/archive?"
                    + urllib.parse.urlencode({
                        "latitude": coords[0], "longitude": coords[1],
                        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
                        "start_date": qs.isoformat(), "end_date": qe.isoformat(),
                        "timezone": "auto",
                    })
                )
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=8) as r:
                body = json.loads(r.read())
            daily = body.get("daily", {})
            tmax = _avg(daily.get("temperature_2m_max", []))
            tmin = _avg(daily.get("temperature_2m_min", []))
            rain = _avg(daily.get("precipitation_probability_max", []))
            if tmax is not None and tmin is not None:
                result = {"ok": True, "mode": mode, "tMin": tmin, "tMax": tmax}
                if rain is not None:
                    result["rainPct"] = rain
                # Historical branch: express rain as how many days that week
                # actually saw meaningful rainfall (>1mm) a year earlier.
                sums = [v for v in daily.get("precipitation_sum", []) if v is not None]
                if sums:
                    wet = sum(1 for v in sums if v >= 1.0)
                    result["wetDays"] = wet
                    result["totalDays"] = len(sums)
    except Exception:
        result = {"ok": False}
    with _weather_lock:
        return _cache_put(_weather_cache, key, result)


# --- Destination photos (Wikipedia REST summary, keyless) ---------------------
_photo_cache = {}
_photo_lock = threading.Lock()


def wiki_photo(place):
    """Real photo URL for a place via Wikipedia page summary, or None."""
    key = (place or "").strip().lower()
    if not key:
        return None
    # Cache lookup under the lock, network call outside it — the same reason
    # geocode() does: one slow Wikipedia response must not stall every other
    # user's photo lookup behind it.
    with _photo_lock:
        if key in _photo_cache:
            return _photo_cache[key]
    url = None
    try:
        # Use the part before the first comma ("Goa, India" -> "Goa").
        title = place.split(",")[0].strip().replace(" ", "_")
        req = urllib.request.Request(
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
            + urllib.parse.quote(title),
            headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=8) as r:
            body = json.loads(r.read())
        img = body.get("originalimage") or body.get("thumbnail") or {}
        url = img.get("source")
    except Exception:
        url = None
    with _photo_lock:
        return _cache_put(_photo_cache, key, url)


# --- Cross-device "someone responded" notifications --------------------------
# In-memory only, keyed by invite code (uppercased). This is a lightweight
# prototype mechanism, NOT durable storage: it resets whenever the server
# process restarts (e.g. Render's free tier spins the service down after
# ~15 min idle, or on redeploy). Fine for a live testing session; a real
# product would put this in a database.
_notify_lock = threading.Lock()
# Entries are capped per code, but nothing capped the number of CODES or aged
# them out, so unauthenticated traffic could grow this without bound on the
# public deployment.
_NOTIFY_MAX_CODES = 2000
_NOTIFY_TTL_SECONDS = 24 * 3600
_notify_store = {}  # code -> [ {name, destination, dateLabel, dateOk, destOk, ts}, ... ]
_NOTIFY_MAX_PER_CODE = 200


def add_notification(code, entry):
    key = (code or "").strip().upper()
    if not key:
        return
    entry = dict(entry)
    entry["ts"] = time.time()
    with _notify_lock:
        # Age out stale codes, then bound the number of them. Without this the
        # dict grew forever: only the entries WITHIN a code were capped.
        if len(_notify_store) >= _NOTIFY_MAX_CODES:
            cutoff = time.time() - _NOTIFY_TTL_SECONDS
            for k in [
                k for k, v in _notify_store.items()
                if not v or v[-1].get("ts", 0) < cutoff
            ]:
                _notify_store.pop(k, None)
            # Still full of live codes: drop the oldest quarter by last write.
            if len(_notify_store) >= _NOTIFY_MAX_CODES:
                oldest = sorted(
                    _notify_store, key=lambda k: _notify_store[k][-1].get("ts", 0)
                )[: _NOTIFY_MAX_CODES // 4]
                for k in oldest:
                    _notify_store.pop(k, None)
        bucket = _notify_store.setdefault(key, [])
        bucket.append(entry)
        if len(bucket) > _NOTIFY_MAX_PER_CODE:
            del bucket[: len(bucket) - _NOTIFY_MAX_PER_CODE]


def get_notifications(code, since):
    key = (code or "").strip().upper()
    with _notify_lock:
        bucket = _notify_store.get(key, [])
        return [e for e in bucket if e["ts"] > since]


# --- v0.9 prototype: live events (pub crawl / work social tracker) ----------
# The first shared, server-held state in the app: where the group is NOW.
# In memory only, by design: the organiser's phone keeps the full record and
# re-uploads it (with its host key) whenever the server has forgotten it, so a
# Render restart costs guests a few seconds of "waiting for the organiser"
# rather than the evening. No database, still stdlib-only.
_live = {}  # id -> {"key": str, "rec": dict, "people": {pid: person}, "touched": ts}
_live_lock = threading.Lock()
LIVE_MAX = 500
LIVE_TTL = 2 * 24 * 3600
LIVE_MAX_STOPS = 12
LIVE_MAX_PEOPLE = 80
_LIVE_ID = re.compile(r"^[A-Za-z0-9_-]{8,24}$")
_HHMM = re.compile(r"^([01]?\d|2[0-4]):[0-5]\d$")


def _s(v, n):
    return str(v if v is not None else "")[:n]


def _time_or_blank(v):
    v = _s(v, 5)
    return v if _HHMM.match(v) else ""


def _num(v, lo, hi):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) and lo <= x <= hi else None


_PHONE = re.compile(r"^\+?[0-9 ()-]{5,20}$")
BOOKING_STATUSES = ("none", "called", "booked", "walkin")


def _phone(v):
    v = _s(v, 24).strip()
    return v if _PHONE.match(v) else ""


def _place(v):
    """{label, lat, lon} for where someone is coming from, or None."""
    if not isinstance(v, dict):
        return None
    lat, lon = _num(v.get("lat"), -90, 90), _num(v.get("lon"), -180, 180)
    label = _s(v.get("label"), 80).strip()
    if lat is None or lon is None or not label:
        return None
    return {"label": label, "lat": lat, "lon": lon}


def _web(v):
    v = _s(v, 200).strip()
    return v if re.match(r"^https?://[^\s<>\"']+$", v) else ""


def sanitize_live(data):
    """Keep only the fields the tracker uses, each bounded. Raises on junk."""
    if not isinstance(data, dict):
        raise ValueError("record must be an object")
    stops = []
    for s in (data.get("stops") or [])[:LIVE_MAX_STOPS]:
        if not isinstance(s, dict):
            continue
        lat, lon = _num(s.get("lat"), -90, 90), _num(s.get("lon"), -180, 180)
        if lat is None or lon is None or not _s(s.get("name"), 80).strip():
            continue
        bk = s.get("booking") if isinstance(s.get("booking"), dict) else {}
        stops.append({
            "id": _s(s.get("id"), 24), "name": _s(s.get("name"), 80),
            "lat": lat, "lon": lon, "hours": _s(s.get("hours"), 160),
            "kind": _s(s.get("kind"), 20), "address": _s(s.get("address"), 120),
            "phone": _phone(s.get("phone")), "website": _web(s.get("website")),
            "booking": {
                "status": bk.get("status") if bk.get("status") in BOOKING_STATUSES else "none",
                "ref": _s(bk.get("ref"), 40),
            },
        })
    st = data.get("status") if isinstance(data.get("status"), dict) else {}
    phase = st.get("phase") if st.get("phase") in ("planning", "live", "done") else "planning"
    stop_n = _num(st.get("stop"), -1, len(stops) - 1) if stops else None
    state = st.get("state") if st.get("state") in ("at", "moving") else "at"
    log = []
    for e in (data.get("log") or [])[:LIVE_MAX_STOPS * 2]:
        if isinstance(e, dict) and _num(e.get("stop"), 0, LIVE_MAX_STOPS) is not None:
            log.append({"stop": int(e["stop"]), "arrived": _num(e.get("arrived"), 0, 1e13),
                        "left": _num(e.get("left"), 0, 1e13)})
    date = _s(data.get("date"), 10)
    return {
        "name": _s(data.get("name"), 80) or "Evening out",
        "organizer": _s(data.get("organizer"), 40),
        "date": date if re.match(r"^\d{4}-\d{2}-\d{2}$", date) else "",
        "plannedStart": _time_or_blank(data.get("plannedStart")),
        "finalStart": _time_or_blank(data.get("finalStart")),
        "dwell": int(_num(data.get("dwell"), 15, 180) or 50),
        "stops": stops,
        # Optional, organiser-supplied: shown to guests as a call button.
        "organizerPhone": _phone(data.get("organizerPhone")),
        # The organiser's own way home (they're a traveller too).
        "organizerHome": _place(data.get("organizerHome")),
        "organizerTransport": data.get("organizerTransport") if data.get("organizerTransport") in LIVE_TRANSPORT else "",
        "organizerLastTrain": _time_or_blank(data.get("organizerLastTrain")),
        # The area's last train / tube, for the "ends after the last train" check.
        "lastTrain": _time_or_blank(data.get("lastTrain")),
        "status": {"phase": phase, "stop": int(stop_n) if stop_n is not None else -1,
                   "state": state, "since": _num(st.get("since"), 0, 1e13),
                   # "Where to find us" at the current stop (e.g. "back room").
                   "spot": _s(st.get("spot"), 80)},
        "log": log,
    }


def _live_prune():
    now = time.time()
    for k in [k for k, v in _live.items() if now - v["touched"] > LIVE_TTL]:
        _live.pop(k, None)
    if len(_live) > LIVE_MAX:  # forget the stalest first; the host can re-upload
        for k, _ in sorted(_live.items(), key=lambda kv: kv[1]["touched"])[: len(_live) - LIVE_MAX]:
            _live.pop(k, None)


def _live_secret():
    """Secret the host keys are derived from. Must survive restarts, or no
    organiser could re-upload their event: LIVE_SECRET on Render (generated
    once by the Blueprint), a git-ignored local file otherwise."""
    env = os.environ.get("LIVE_SECRET", "")
    if len(env) >= 16:
        return env.encode()
    path = os.path.join(DIRECTORY, ".live-secret")
    try:
        with open(path, "rb") as f:
            saved = f.read().strip()
        if len(saved) >= 32:
            return saved
    except OSError:
        pass
    import secrets
    fresh = secrets.token_hex(32).encode()
    try:
        with open(path, "wb") as f:
            f.write(fresh)
    except OSError:
        pass  # read-only disk: keys still work until the next restart
    return fresh


_LIVE_SECRET = _live_secret()


def host_key_for(eid):
    """The one host key for an event. Bound to the id, so re-creating a
    forgotten event (self-heal) works only for the real organiser — before,
    anyone holding the public guest link could re-create it first with a key
    of their own and lock the organiser out."""
    import hashlib
    import hmac
    return hmac.new(_LIVE_SECRET, eid.encode(), hashlib.sha256).hexdigest()[:32]


class LiveConflict(Exception):
    """The host's copy is behind the server's (another co-host moved first)."""

    def __init__(self, current):
        super().__init__("stale")
        self.current = current


class LiveRateLimited(Exception):
    pass


# Events created per IP per hour. A script could otherwise fill LIVE_MAX and
# push real (quietly idle) events out of memory.
LIVE_CREATES_PER_HOUR = 10
_live_creates = {}
# Requests from this machine itself (local development and testing) aren't
# limited: a morning of test runs otherwise locks the developer out. On Render
# every request arrives through the proxy, so nothing there is loopback.
LOOPBACK = {"127.0.0.1", "::1"}


def live_public(entry):
    """What anyone with the link may see — never the host key or guest tokens."""
    out = dict(entry["rec"])
    out["people"] = list(entry["people"].values())
    out["rev"] = entry["rev"]
    out["serverTime"] = time.time() * 1000
    return out


def live_get(eid):
    with _live_lock:
        entry = _live.get(eid)
        if entry:
            entry["touched"] = time.time()  # evict by least recently polled
        return live_public(entry) if entry else None


def live_create(data, ip=""):
    import secrets
    rec = sanitize_live(data)
    now = time.time()
    with _live_lock:
        recent = [t for t in _live_creates.get(ip, []) if now - t < 3600]
        if len(recent) >= LIVE_CREATES_PER_HOUR and ip not in LOOPBACK:
            raise LiveRateLimited()
        recent.append(now)
        _live_creates[ip] = recent
        if len(_live_creates) > CACHE_LIMIT:
            _live_creates.clear()
        _live_prune()
        eid = secrets.token_urlsafe(9)
        _live[eid] = {"rec": rec, "people": {}, "tokens": {}, "rev": 1, "touched": now}
        return eid, host_key_for(eid), live_public(_live[eid])


def live_update(eid, key, data, people=None, base_rev=None):
    """Host update. Re-creates a forgotten event from the host's own copy."""
    import hmac
    if not _LIVE_ID.match(eid or "") or not hmac.compare_digest(host_key_for(eid), _s(key, 64)):
        raise PermissionError("wrong host key")
    rec = sanitize_live(data)
    with _live_lock:
        entry = _live.get(eid)
        if entry is None:
            _live_prune()
            entry = _live[eid] = {"rec": rec, "people": {}, "tokens": {},
                                  "rev": int(base_rev or 0), "touched": time.time()}
            # Self-heal the guest list too, from the host's last copy.
            for p in (people or [])[:LIVE_MAX_PEOPLE]:
                clean = _live_person(p)
                if clean:
                    entry["people"][clean["id"]] = clean
        elif base_rev is not None and int(base_rev) != entry["rev"]:
            # Two co-hosts tapping "Moving on" at once used to skip a stop:
            # each sent a whole record built on the same old state.
            raise LiveConflict(live_public(entry))
        entry["rec"] = rec
        entry["rev"] += 1
        entry["touched"] = time.time()
        return live_public(entry)


# late = running late (with eta minutes); home = heading home; safe = home safe.
LIVE_PERSON_STATUSES = ("coming", "onway", "here", "out", "late", "home", "safe")
LIVE_TRANSPORT = ("walk", "train", "bus", "taxi", "lift", "drive", "unsure")


def _live_person(p):
    if not isinstance(p, dict):
        return None
    pid = _s(p.get("id"), 24)
    name = "".join(ch for ch in _s(p.get("name"), 40) if ch.isprintable()).strip()
    if not _LIVE_ID.match(pid) or not name:
        return None
    status = p.get("status") if p.get("status") in LIVE_PERSON_STATUSES else "coming"
    transport = p.get("transport") if p.get("transport") in LIVE_TRANSPORT else ""
    eta = _num(p.get("eta"), 0, 180)
    return {"id": pid, "name": name, "from": _time_or_blank(p.get("from")),
            "until": _time_or_blank(p.get("until")), "status": status,
            "transport": transport, "lastTrain": _time_or_blank(p.get("lastTrain")),
            "home": _place(p.get("home")),
            "eta": int(eta) if eta is not None else 0,
            "ts": time.time() * 1000}


def live_person(eid, person):
    """Guest upsert. Each guest's first save registers a private token; later
    saves must carry it, so nobody can rename someone else or mark them out
    (ids are visible to everyone in the public record)."""
    import hashlib
    import hmac
    clean = _live_person(person)
    token = _s((person or {}).get("token"), 64)
    if not clean or len(token) < 16:
        raise ValueError("bad person")
    digest = hashlib.sha256(token.encode()).hexdigest()
    with _live_lock:
        entry = _live.get(eid)
        if entry is None:
            return None
        known = entry["tokens"].get(clean["id"])
        if known is not None and not hmac.compare_digest(known, digest):
            raise PermissionError("not your entry")
        if clean["id"] not in entry["people"] and len(entry["people"]) >= LIVE_MAX_PEOPLE:
            raise ValueError("event is full")
        entry["people"][clean["id"]] = clean
        entry["tokens"][clean["id"]] = digest
        entry["touched"] = time.time()
        return live_public(entry)


# Pubs and bars near a point, from OpenStreetMap via Nominatim: a bounded
# search for "pub" returns both pubs and bars, with opening hours in
# extratags — which is what lets the route builder warn that a City pub is
# shut on a Saturday. (Overpass was tried first: the public instances timed
# out or refused queries during testing, so it isn't a dependency.) Shares the
# 1 req/s Nominatim pacer; failures are never cached.
_pubs_cache = {}
_pubs_lock = threading.Lock()
PUB_TYPES = {"pub", "bar", "biergarten"}
PUB_TAGS = {"food", "wheelchair", "outdoor_seating", "real_ale", "live_sport",
            "cuisine", "diet:vegetarian", "diet:vegan"}
# /api/pubs per IP per minute: every new area is a Nominatim call on the
# shared 1 req/s pacer, so one client must not starve city search for all.
PUBS_PER_MINUTE = 20
_pubs_calls = {}


def pubs_rate_ok(ip):
    if ip in LOOPBACK:
        return True
    now = time.time()
    with _pubs_lock:
        recent = [t for t in _pubs_calls.get(ip, []) if now - t < 60]
        if len(recent) >= PUBS_PER_MINUTE:
            _pubs_calls[ip] = recent
            return False
        recent.append(now)
        _pubs_calls[ip] = recent
        if len(_pubs_calls) > CACHE_LIMIT:
            _pubs_calls.clear()
        return True


def pubs_near(lat, lon, radius_m=700):
    key = f"{lat:.3f},{lon:.3f},{radius_m}"
    with _pubs_lock:
        if key in _pubs_cache:
            return _pubs_cache[key]
    dlat = radius_m / 111_000
    dlon = dlat / max(0.2, math.cos(math.radians(lat)))
    try:
        params = urllib.parse.urlencode({
            "q": "pub", "format": "json", "limit": 40, "bounded": 1,
            "extratags": 1, "addressdetails": 1, "accept-language": "en",
            "viewbox": f"{lon - dlon},{lat + dlat},{lon + dlon},{lat - dlat}",
        })
        _nominatim_wait()
        req = urllib.request.Request(
            "https://nominatim.openstreetmap.org/search?" + params,
            headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as r:
            arr = json.loads(r.read())
    except Exception:
        return None  # not cached: a timeout says nothing about the area
    out = []
    for item in arr:
        if item.get("type") not in PUB_TYPES or not item.get("name"):
            continue
        plat, plon = float(item["lat"]), float(item["lon"])
        addr = item.get("address", {})
        street = " ".join(x for x in (addr.get("house_number"), addr.get("road")) if x)
        out.append({
            "name": item["name"][:80], "lat": plat, "lon": plon,
            "kind": "bar" if item.get("type") == "bar" else "pub",
            "hours": ((item.get("extratags") or {}).get("opening_hours") or "")[:160],
            "address": street[:120],
            "dist": round(haversine_miles((lat, lon), (plat, plon)) * 1609),
            # What smart suggest scores on (only these, each bounded).
            "tags": {k: _s(v, 40) for k, v in (item.get("extratags") or {}).items()
                     if k in PUB_TAGS},
            # For booking: call or check the venue. Validated, never raw.
            "phone": _phone((item.get("extratags") or {}).get("phone")
                            or (item.get("extratags") or {}).get("contact:phone")),
            "website": _web((item.get("extratags") or {}).get("website")
                            or (item.get("extratags") or {}).get("contact:website")),
        })
    out.sort(key=lambda p: p["dist"])
    with _pubs_lock:
        _cache_put(_pubs_cache, key, out)
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, *args):
        pass  # quiet

    # Keep-alive: the client fires ~90 fare/photo requests in parallel, and the
    # stdlib default (HTTP/1.0) tears down the connection after every one.
    # Every response path must set Content-Length and fully drain the request
    # body, or a keep-alive connection desyncs and the browser hangs.
    protocol_version = "HTTP/1.1"
    # Don't let idle keep-alive sockets pin a thread each indefinitely.
    timeout = 30

    def end_headers(self):
        # Prototype: never let the browser HTTP-cache app files, so edits always
        # load fresh (the service worker handles real offline caching). Media
        # is the exception: re-downloading a 0.6 MB video on every visit was
        # pure waste, so _send_media sets its own policy.
        # Popped, not read: keep-alive reuses this handler for the next request
        # on the connection, and a lingering media policy made app.js and API
        # JSON cacheable for a day after any video request.
        self.send_header("Cache-Control", self.__dict__.pop("_cache_control", None)
                         or "no-store, must-revalidate")
        # Clickjacking + MIME sniffing. frame-ancestors can't be set from a
        # <meta> CSP, so these have to be real headers.
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def _client_ip(self):
        # Render's proxy appends the address it saw, so the LAST hop is the one
        # we can trust; the first is whatever the client chose to send.
        fwd = self.headers.get("X-Forwarded-For", "")
        return (fwd.split(",")[-1].strip() if fwd else "") or self.client_address[0]

    def _send_static(self, path, head=False):
        """Serve only the app's own files.

        SimpleHTTPRequestHandler serves the whole working directory, which
        exposed .git (history, the owner's email), server source, internal
        docs and directory listings. Anything not on the allowlist is a 404.
        """
        name = "index.html" if path in ("", "/") else path.lstrip("/")
        if name.endswith("/"):
            name += "index.html"
        if name not in STATIC_FILES:
            return self.send_error(404)
        self.path = "/" + name
        return super().do_HEAD() if head else super().do_GET()

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_media(self, path):
        """Serve /media/* with byte-range support.

        iOS Safari won't play a <video> unless the server answers Range
        requests with 206, and SimpleHTTPRequestHandler ignores Range. Only
        plain filenames inside media/ are served — no traversal.
        """
        name = os.path.basename(path)
        full = os.path.join(DIRECTORY, "media", name)
        if not name or name.startswith(".") or not os.path.isfile(full):
            return self.send_error(404)
        size = os.path.getsize(full)
        ctype = {".mp4": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg",
                 ".png": "image/png"}.get(os.path.splitext(name)[1].lower())
        if not ctype:
            return self.send_error(404)
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", "").strip())
        partial = bool(m) and (m.group(1) or m.group(2))
        if partial:
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:  # suffix range: the last N bytes
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        length = end - start + 1
        self._cache_control = "public, max-age=86400"
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_HEAD(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/media/"):
            return self._send_media(path)
        return self._send_static(path, head=True)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/media/"):
            return self._send_media(parsed.path)
        if parsed.path.startswith("/api/"):
            # Every /api/ call can fan out to a free upstream (Nominatim,
            # Photon, Wikipedia, Open-Meteo). Unthrottled, one script could get
            # this host's IP banned and break lookups for every user.
            if not _rate_ok(self._client_ip()):
                return self._send_json({"error": "slow down"}, code=429)
            if any(len(v) > MAX_PARAM for vs in urllib.parse.parse_qs(parsed.query).values() for v in vs):
                return self._send_json({"error": "parameter too long"}, code=400)
        if parsed.path == "/api/health":
            return self._send_json({
                "ok": True,
                "live": bool(os.environ.get("AMADEUS_CLIENT_ID")),
                "asOf": FARES_AS_OF,
            })
        if parsed.path == "/api/fare":
            q = urllib.parse.parse_qs(parsed.query)
            frm = q.get("from", [""])[0]
            to = q.get("to", [""])[0]
            date = q.get("date", [""])[0]
            try:
                nights = int(q.get("nights", ["5"])[0])
            except ValueError:
                nights = 5
            return self._send_json(resolve_fare(frm, to, date, nights))
        if parsed.path == "/api/geocode":
            # Coordinates for the plan's journey globe. Same cached geocoder the
            # fare path uses, so it adds no new upstream traffic pattern.
            q = urllib.parse.parse_qs(parsed.query)
            place = q.get("q", [""])[0][:120]
            coord = coords_for(place) if place.strip() else None
            if not coord:
                return self._send_json({"lat": None, "lng": None})
            return self._send_json({"lat": coord[0], "lng": coord[1]})
        if parsed.path == "/api/photo":
            q = urllib.parse.parse_qs(parsed.query)
            place = q.get("place", [""])[0]
            return self._send_json({"place": place, "image": wiki_photo(place)})
        if parsed.path == "/api/host":
            # On a real hosting platform (Render, etc.) there's a public HTTPS URL
            # in the environment — prefer that over the local LAN IP so the
            # "test on your phone" QR code points somewhere reachable from
            # anywhere, not just this machine's Wi-Fi.
            public_url = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("PUBLIC_URL")
            return self._send_json({
                "lan": lan_ip(),
                "port": PORT,
                "publicUrl": public_url,
            })
        if parsed.path == "/api/geosuggest":
            q = urllib.parse.parse_qs(parsed.query)
            kind = q.get("kind", [""])[0]
            text = q.get("q", [""])[0]
            if kind in ("city", "area"):
                return self._send_json({"results": suggest_cities(text, areas=kind == "area")})
            return self._send_json({"results": suggest_places(text)})
        if parsed.path == "/api/reverse":
            q = urllib.parse.parse_qs(parsed.query)
            return self._send_json(
                reverse_geocode(q.get("lat", [""])[0], q.get("lng", [""])[0])
            )
        if parsed.path == "/api/weather":
            q = urllib.parse.parse_qs(parsed.query)
            return self._send_json(
                weather_for(
                    q.get("place", [""])[0],
                    q.get("start", [""])[0],
                    q.get("end", [""])[0],
                )
            )
        if parsed.path == "/api/live":
            eid = urllib.parse.parse_qs(parsed.query).get("id", [""])[0]
            rec = live_get(eid) if _LIVE_ID.match(eid) else None
            if rec is None:
                return self._send_json({"missing": True}, code=404)
            return self._send_json(rec)
        if parsed.path == "/api/pubs":
            if not pubs_rate_ok(self._client_ip()):
                return self._send_json({"results": [], "error": "busy"}, code=429)
            q = urllib.parse.parse_qs(parsed.query)
            lat = _num(q.get("lat", [""])[0], -90, 90)
            lon = _num(q.get("lon", [""])[0], -180, 180)
            if lat is None or lon is None:
                return self._send_json({"error": "lat and lon required"}, code=400)
            pubs = pubs_near(lat, lon)
            if pubs is None:
                return self._send_json({"results": [], "error": "unavailable"})
            return self._send_json({"results": pubs})
        if parsed.path == "/api/notify":
            q = urllib.parse.parse_qs(parsed.query)
            code = q.get("code", [""])[0]
            # Same floor on reads: the feed carries participants' names and the
            # chosen destination, so it must not be enumerable.
            if len(code) < 16:
                return self._send_json({"results": []})
            try:
                since = float(q.get("since", ["0"])[0])
            except ValueError:
                since = 0.0
            return self._send_json({"results": get_notifications(code, since)})
        if parsed.path.startswith("/api/"):
            return self._send_json({"error": "not found"}, code=404)
        return self._send_static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not _rate_ok(self._client_ip()):
            try:
                self._drain_body(int(self.headers.get("Content-Length", "0") or "0"))
            except ValueError:
                pass
            return self._send_json({"error": "slow down"}, code=429)
        if parsed.path.startswith("/api/live/"):
            try:
                data = self._read_json(32768)
            except ValueError:
                return self._send_json({"error": "bad request"}, code=400)
            try:
                if parsed.path == "/api/live/create":
                    eid, key, rec = live_create(data.get("record"), self._client_ip())
                    return self._send_json({"id": eid, "key": key, "record": rec})
                if parsed.path == "/api/live/update":
                    base = _num(data.get("rev"), 0, 1e9)
                    rec = live_update(_s(data.get("id"), 24), _s(data.get("key"), 64),
                                      data.get("record"), data.get("people"),
                                      None if base is None else int(base))
                    return self._send_json(rec)
                if parsed.path == "/api/live/person":
                    rec = live_person(_s(data.get("id"), 24), data.get("person"))
                    if rec is None:
                        return self._send_json({"missing": True}, code=404)
                    return self._send_json(rec)
            except LiveConflict as c:
                return self._send_json({"error": "stale", "current": c.current}, code=409)
            except LiveRateLimited:
                return self._send_json({"error": "too many events"}, code=429)
            except PermissionError:
                return self._send_json({"error": "not allowed"}, code=403)
            except ValueError as e:
                return self._send_json({"error": str(e)[:60]}, code=400)
            return self._send_json({"error": "not found"}, code=404)
        if parsed.path == "/api/notify":
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
                # Reject absurdly large bodies rather than reading unbounded
                # input -- but DRAIN them first. Raising before the read left
                # the body sitting in the socket, where the next request on the
                # same keep-alive connection parsed it as a request line: the
                # client got "501 Unsupported method" and every subsequent call
                # on that connection was lost. The app fires ~90 fare and photo
                # requests over these connections, so one oversized POST took
                # out the rest of the pipeline.
                if length < 0 or length > 8192:
                    self._drain_body(length)
                    raise ValueError("bad content length")
                if length == 0:
                    raise ValueError("empty body")
                raw = self.rfile.read(length)
                data = json.loads(raw)
                # The client sends a 128-bit token, not the short join code.
                # Reject anything too weak to be one, so a guessed/short code
                # can't be used to plant notifications in someone's feed.
                code = str(data.get("code", ""))[:64]
                if len(code) < 16:
                    raise ValueError("weak notification key")
                kind = str(data.get("kind", "reply"))[:16]
                entry = {
                    # "reply" = someone answered the confirm step;
                    # "locked" = the plan was decided.
                    "kind": kind if kind in ("reply", "locked", "declined") else "reply",
                    "name": str(data.get("name", "Someone"))[:80],
                    "destination": str(data.get("destination", ""))[:120],
                    "dateLabel": str(data.get("dateLabel", ""))[:60],
                    "dateOk": bool(data.get("dateOk")),
                    "destOk": bool(data.get("destOk")),
                }
                add_notification(code, entry)
                return self._send_json({"ok": True})
            except Exception:
                return self._send_json({"ok": False}, code=400)
        # Drain any body before replying: on a keep-alive connection unread
        # bytes would be mis-read as the start of the next request.
        try:
            self._drain_body(int(self.headers.get("Content-Length", "0") or "0"))
        except ValueError:
            pass
        return self._send_json({"error": "not found"}, code=404)

    def _read_json(self, limit):
        """Read a bounded JSON object body, always leaving the socket in sync."""
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            raise ValueError("bad length")
        if length <= 0 or length > limit:
            self._drain_body(length)
            raise ValueError("bad length")
        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            raise ValueError("bad json")
        if not isinstance(data, dict):
            raise ValueError("bad json")
        return data

    def _drain_body(self, length):
        """Read and discard a request body so the connection stays in sync."""
        length = max(0, length)
        # Anything past the cap can't be drained, so the leftover bytes would be
        # parsed as the next request on a keep-alive connection -- the exact
        # desync draining exists to prevent. Close instead of pretending.
        if length > MAX_DRAIN:
            self.close_connection = True
            return
        remaining = length
        try:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            self.close_connection = True


if __name__ == "__main__":
    # Bind to all interfaces so phones on the same Wi-Fi can open the app.
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Reunly server on http://127.0.0.1:{PORT}")
        print(f"  On your phone (same Wi-Fi): http://{lan_ip()}:{PORT}")
        print(f"  Live fares: {'ON' if os.environ.get('AMADEUS_CLIENT_ID') else 'OFF'}")
        httpd.serve_forever()
