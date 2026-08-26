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
_geo_cache = {}
_geo_lock = threading.Lock()


def geocode(name):
    key = (name or "").strip().lower()
    if not key:
        return None
    with _geo_lock:
        if key in _geo_cache:
            return _geo_cache[key]
        coord = None
        try:
            q = urllib.parse.urlencode({"q": name, "format": "json", "limit": 1})
            req = urllib.request.Request(
                "https://nominatim.openstreetmap.org/search?" + q,
                headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=8) as r:
                arr = json.loads(r.read())
            if arr:
                coord = (float(arr[0]["lat"]), float(arr[0]["lon"]))
        except Exception:
            coord = None
        _geo_cache[key] = coord
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
    with _suggest_lock:
        if key in _suggest_cache:
            return _suggest_cache[key]
        results = []
        try:
            params = urllib.parse.urlencode({
                "q": q, "format": "json", "limit": 6, "addressdetails": 1,
                "featuretype": "city", "accept-language": "en",
            })
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
            results = []
        _suggest_cache[key] = results
        return results


def reverse_geocode(lat, lng):
    try:
        params = urllib.parse.urlencode({
            "lat": lat, "lon": lng, "format": "json", "zoom": 10,
            "addressdetails": 1, "accept-language": "en",
        })
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


def estimate_fare(miles):
    if miles is None:
        return None
    if miles == 0:
        return (0, 0)
    base = 60
    near = min(miles, 600) * 0.20
    far = max(0, miles - 600) * 0.11
    mid = base + near + far
    return (round(mid * 0.82 / 5) * 5, round(mid * 1.28 / 5) * 5)


# Rough nightly lodging bands (USD, per person sharing a twin room) for the
# cities we know. These are deliberately coarse: the UI must label them as
# estimates, never quote them as prices. Anything unlisted falls back to
# DEFAULT_NIGHTLY.
DEFAULT_NIGHTLY = (70, 130)
NIGHTLY_RATES = {
    # Pricier hubs
    "London, UK": (110, 210), "Paris, France": (105, 200),
    "New York, NY": (130, 250), "San Francisco, CA": (130, 240),
    "Singapore": (95, 180), "Dubai, UAE": (90, 190),
    "Hong Kong": (95, 180), "Sydney, Australia": (100, 190),
    "Tokyo, Japan": (85, 165), "Zurich, Switzerland": (140, 260),
    # Mid
    "Rome, Italy": (80, 150), "Barcelona, Spain": (80, 150),
    "Lisbon, Portugal": (70, 135), "Berlin, Germany": (75, 140),
    "Toronto, ON": (95, 175), "Chicago, IL": (100, 185),
    # Value
    "Bangkok, Thailand": (35, 80), "Bali, Indonesia": (30, 75),
    "Goa, India": (30, 70), "Delhi, India": (30, 70),
    "Mumbai, India": (40, 90), "Kuala Lumpur, Malaysia": (35, 80),
    "Istanbul, Turkey": (45, 95), "Mexico City, Mexico": (45, 95),
}


def estimate_lodging(destination, nights):
    """Estimated per-person lodging for a stay. Returns (min, max) or None."""
    if not destination or not nights or nights <= 0:
        return None
    key = resolve_city(destination) or destination
    low, high = NIGHTLY_RATES.get(key, DEFAULT_NIGHTLY)
    return (int(low * nights), int(high * nights))


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


def amadeus_fare(frm, to, date):
    """Return (min, max) round-trip USD from live offers, or None on any issue."""
    o_iata = CITY_IATA.get(frm)
    d_iata = CITY_IATA.get(to)
    if not o_iata or not d_iata:
        return None
    try:
        token = _amadeus_token()
        if not token:
            return None
        dep = date or "2026-08-14"
        # Round trip: return ~5 days after departure.
        ret = _plus_days(dep, 5)
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


def resolve_fare(frm_raw, to_raw, date):
    o = coords_for(frm_raw)
    d = coords_for(to_raw)
    if not o or not d:
        return {"source": "unknown", "currency": "USD"}

    miles = round(haversine_miles(o, d))
    frm = resolve_city(frm_raw)
    to = resolve_city(to_raw)

    # Live (only for canonical cities with known IATA codes).
    if os.environ.get("AMADEUS_CLIENT_ID") and frm in CITY_IATA and to in CITY_IATA:
        live = amadeus_fare(frm, to, date)
        if live:
            # Sandbox inventory is fictional — never badge it as a real fare.
            return {"min": live[0], "max": live[1], "currency": "USD",
                    "source": "sandbox" if AMADEUS_IS_SANDBOX else "live",
                    "asOf": time.strftime("%Y-%m-%d"), "miles": miles}

    # Curated searched fares (canonical pairs only).
    if frm and to:
        key = f"{frm}|{to}"
        if key in SEARCHED_FARES:
            lo, hi = SEARCHED_FARES[key]
            return {"min": lo, "max": hi, "currency": "USD",
                    "source": "searched", "asOf": FARES_AS_OF, "miles": miles}

    if miles == 0:
        return {"min": 0, "max": 0, "currency": "USD", "source": "estimated", "miles": 0}
    est = estimate_fare(miles)
    return {"min": est[0], "max": est[1], "currency": "USD", "source": "estimated", "miles": miles}


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
        _weather_cache[key] = result
        return result


# --- Destination photos (Wikipedia REST summary, keyless) ---------------------
_photo_cache = {}
_photo_lock = threading.Lock()


def wiki_photo(place):
    """Real photo URL for a place via Wikipedia page summary, or None."""
    key = (place or "").strip().lower()
    if not key:
        return None
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
        _photo_cache[key] = url
        return url


# --- Cross-device "someone responded" notifications --------------------------
# In-memory only, keyed by invite code (uppercased). This is a lightweight
# prototype mechanism, NOT durable storage: it resets whenever the server
# process restarts (e.g. Render's free tier spins the service down after
# ~15 min idle, or on redeploy). Fine for a live testing session; a real
# product would put this in a database.
_notify_lock = threading.Lock()
_notify_store = {}  # code -> [ {name, destination, dateLabel, dateOk, destOk, ts}, ... ]
_NOTIFY_MAX_PER_CODE = 200


def add_notification(code, entry):
    key = (code or "").strip().upper()
    if not key:
        return
    entry = dict(entry)
    entry["ts"] = time.time()
    with _notify_lock:
        bucket = _notify_store.setdefault(key, [])
        bucket.append(entry)
        if len(bucket) > _NOTIFY_MAX_PER_CODE:
            del bucket[: len(bucket) - _NOTIFY_MAX_PER_CODE]


def get_notifications(code, since):
    key = (code or "").strip().upper()
    with _notify_lock:
        bucket = _notify_store.get(key, [])
        return [e for e in bucket if e["ts"] > since]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, *args):
        pass  # quiet

    def end_headers(self):
        # Prototype: never let the browser HTTP-cache files, so edits always
        # load fresh (the service worker handles real offline caching).
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
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
            return self._send_json(resolve_fare(frm, to, date))
        if parsed.path == "/api/photo":
            q = urllib.parse.parse_qs(parsed.query)
            place = q.get("place", [""])[0]
            return self._send_json({"place": place, "image": wiki_photo(place)})
        if parsed.path == "/api/lodging":
            q = urllib.parse.parse_qs(parsed.query)
            place = q.get("place", [""])[0]
            try:
                nights = int(q.get("nights", ["0"])[0])
            except ValueError:
                nights = 0
            est = estimate_lodging(place, nights)
            if not est:
                return self._send_json({"ok": False})
            return self._send_json({
                "ok": True, "place": place, "nights": nights,
                "min": est[0], "max": est[1],
                "currency": "USD", "source": "estimated",
            })
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
            return self._send_json({"results": suggest_places(q.get("q", [""])[0])})
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
        if parsed.path == "/api/notify":
            q = urllib.parse.parse_qs(parsed.query)
            code = q.get("code", [""])[0]
            try:
                since = float(q.get("since", ["0"])[0])
            except ValueError:
                since = 0.0
            return self._send_json({"results": get_notifications(code, since)})
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/notify":
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
                # Reject absurdly large bodies rather than reading unbounded input.
                if length <= 0 or length > 8192:
                    raise ValueError("bad content length")
                raw = self.rfile.read(length)
                data = json.loads(raw)
                code = str(data.get("code", ""))[:32]
                entry = {
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
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    # Bind to all interfaces so phones on the same Wi-Fi can open the app.
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Reunly server on http://127.0.0.1:{PORT}")
        print(f"  On your phone (same Wi-Fi): http://{lan_ip()}:{PORT}")
        print(f"  Live fares: {'ON' if os.environ.get('AMADEUS_CLIENT_ID') else 'OFF'}")
        httpd.serve_forever()
