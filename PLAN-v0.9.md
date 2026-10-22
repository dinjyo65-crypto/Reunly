# Reunly v0.9 — Work meetups & pub crawls (plan)

_Status: planning (2026-10-22). Prototype first, then integrate into the app._

## The idea in one line
Same flow as a trip — people say when they're free, the organiser fixes a start time — but for **one evening in one area**, and with a **live progress tracker** so people who can't make the first stop can find the group and join later.

## Who it's for
- **After-work socials / leaving drinks / team nights** — "Office / work" is already an event type.
- **Pub crawls / bar hops** — birthdays, stag & hen, alumni nights, a city weekend.

## How it works (user journeys)

### 1. Organiser sets it up (2 min)
1. *Set up a get-together* → type **Work social** or **Pub crawl** (new "evening" mode).
2. Picks the **date** and a rough window, e.g. "Thu 6 Nov, from 17:30".
3. Builds the **route**: a starting area, then stops in order. Each stop: name, address, planned arrival time. Times are suggested automatically (e.g. 45–60 min per stop + walking time) and editable.
4. Sends the invite link, exactly like today.

### 2. Invitees say when they can make it (30 s)
Not "which dates" but **"from when, until when?"** on that evening — e.g. "from 18:30", "until 21:00", or "whole night". Plus the existing quick *Yes / Can't make it*.

### 3. Organiser finalises the start time
The app shows a **head-count timeline** ("4 people at 17:30, 7 by 18:30, 9 by 19:00, 6 still there at 22:00") and suggests the start time that gets the most people to the first stop. It also shows **which stop each person will probably join at**, given their arrival time and the route: *"Priya (from 19:15) → joins at Stop 2, The Swan."* Organiser taps **Finalise**.

### 4. On the night — the live tracker
Everyone opens the same link and sees:

```
 ● The Crown      17:30   ✓ was here 17:34–18:40
 ● The Swan       18:45   ◉ HERE NOW since 18:47  (6 people)
 ○ The Old Bell   20:00   next · ~6 min walk
 ○ Ye Olde Mitre  21:15
 [ Directions to The Swan ]   [ I'm on my way ]   [ I'm here ]
```

- The organiser (or a co-host) taps **"We've arrived"** at each stop → everyone's tracker updates within ~15 s.
- **"Moving on"** marks the group as walking to the next stop, with an ETA, so a late joiner heads to the right place.
- Late joiners tap **"I'm on my way"** (optional) so the group knows to expect them; **"I'm here"** adds them to the head count.
- If the plan changes ("this one's full, going to The Lamb instead"), the organiser edits the next stop and everyone sees it.

### 5. After
Summary: stops, times, who came; optional **kitty / rounds** using the existing expense ledger ("Sam put £60 in the kitty"); photos on the memory wall.

## What we can reuse from v8
| Need | Already in the app |
|---|---|
| Invite link, guest send-back, RSVP, "can't make it" | ✓ (v8) |
| Organiser vs guest roles, organiser-only controls | ✓ |
| Place search & coordinates | Photon (cities) + `/api/geocode` |
| Walking distance between stops | engine distance maths (×1.3 road factor, ~3 mph walking) |
| Map/globe drawing, directions links | ✓ (Google Maps deep links) |
| Kitty & settle-up | ✓ (v8 kitty view) |
| Notifications to the organiser | `/api/notify` (in-memory) |

## What's genuinely new

### A. Live shared state (the big one)
Today everything syncs by sending links back — fine for a 6-week trip plan, useless for "where are they **now**". The tracker needs a small **server-side record per event** that phones poll.

- `POST /api/live` → create, returns an event id + a secret **host key** (only the organiser/co-hosts' phones hold it).
- `GET /api/live/:id` → current stop, arrival times, head count, plan edits. Phones poll every ~15 s while the tracker is open (simple; works on Render free; no websockets).
- `POST /api/live/:id/checkin` (host key) → "arrived at stop N" / "moving on".
- `POST /api/live/:id/join` → "on my way" / "I'm here" (anyone with the link; rate-limited).

**Storage without a database (recommended):** the organiser's phone holds the full record (as now, in localStorage) and the server is a cache. If Render restarts and the server forgets, the next poll from the organiser's phone re-uploads it automatically ("self-healing"). Guests briefly see "waiting for the organiser…". Keeps the stdlib-only, free-tier setup. A real database (Render Postgres / Upstash) becomes necessary only for Pro features that must outlive the organiser's phone.

### B. Pub search & opening hours
OpenStreetMap **Overpass** (free, no key) returns pubs/bars near a point **with opening hours** — tested: 600 m around Bank, London returns named pubs, e.g. *The Saint — "Mo-Fr 12:00-23:00; Sa,Su off"*. The route builder can **warn when a stop is closed at its planned time** (City of London pubs often shut at weekends). Needs a server proxy + caching + the existing rate limiting.

### C. Time-of-day availability
New availability shape: `{ from: "18:30", until: "21:00" }` on the event day, alongside the existing date ranges. Engine function: best start time + "joins at stop N" per person.

### D. Who checks in
Organiser + named **co-hosts** (handing over when the organiser leaves early). The host key travels only in a separate "co-host link".

## Privacy & safety (non-negotiable)
- **No GPS tracking by default.** Check-ins are taps, not location pings. (Optional "auto check-in when I arrive" could come later, on the host's phone only.)
- Only stop names/times and first names are shared; no emails (as today).
- Host actions need the host key; join actions are rate-limited.
- Gentle **responsible-drinking** touch: a "home safe?" check at the end; last-train time for the area (later).

## Monetisation (Pro)
- **Reunly for Teams** (work socials): recurring monthly socials, company expense export (receipt list → CSV/PDF for finance), co-host roles, larger groups, branded invite. Most natural B2B angle.
- **Pub crawl Pro**: route planner with opening-hours checks, live tracker beyond N people, printable route card/T-shirt QR, kitty tracking.
- **Venue partnerships**: "book an area / pre-order for 12 at The Swan" affiliate (later).
- Free tier keeps: up to ~3 stops & small groups, live tracker included (it's the hook).

## Plan: prototype first, then integrate
1. **Prototype (standalone)** — `prototypes/pub-crawl/` page + a minimal in-memory `/api/live` on the local server. Organiser builds a 4-stop route, checks in; two "guests" in other browsers/phones see the tracker update. Tested with Playwright (organiser + early guest + late joiner) and on real phones over Wi-Fi.
2. **Review** with the 5 experts (security, travel/hospitality, planner, developer, user) on the prototype.
3. **Integrate (v0.9)** — "evening" event mode in the main app: time availability, start-time finaliser, route builder with Overpass + opening hours, live tracker tab, co-host link, kitty.
4. Real-device test with a real after-work social.

## Open questions (need the user's call)
1. Who can check in — organiser only, organiser + co-hosts, or anyone at the pub?
2. Route stops — searched pubs only, or also free-typed places (an office, a restaurant)?
3. Optional live location later, or never?
4. Prototype as a standalone page in this repo (recommended) — OK?
