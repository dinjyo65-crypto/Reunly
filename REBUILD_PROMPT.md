# Reunly — From-Scratch Build Prompt

Paste the prompt below into a capable coding agent to recreate this app from nothing.
It captures the product, stack, every feature built across all iterations, the
design language, the deployment setup, and the hard-won gotchas — in the order
they were actually built, so a rebuild can follow the same path.

---

## THE PROMPT

> Build a mobile-first group-planning web app called **Reunly**, positioned as
> **"the easiest way for groups to decide when, where, and how to meet"** — not
> just reunions, but family gatherings, university alumni events, office
> get-togethers, weddings, holidays, and regular friend meetups. Brand promise:
> "Making reunions effortless." Tagline: **"Reconnect. We'll handle the rest."**
>
> ### Stack & constraints
> - Vanilla **HTML/CSS/JS only** (no framework, no build step), split into clean
>   modules loaded via plain `<script>` tags: `data.js` (static data + helpers),
>   `engine.js` (pure, UI-free scoring/ranking logic), `fares.js` (client fare/
>   photo fetching + caching), `app.js` (the UI controller — state, rendering,
>   wiring), plus `styles.css`, `index.html`.
> - A **Python stdlib-only server** (`server.py`, zero third-party dependencies)
>   that serves the static files AND a same-origin JSON API. Reads `PORT` from
>   the environment (default 4175) and binds `0.0.0.0` so it works unmodified
>   both locally and on a cloud host. Run via `.claude/launch.json` locally.
> - PWA: `manifest.json`, `icon.svg`, and a **network-first** `service-worker.js`
>   (falls back to cache offline; never caches `/api/*`).
> - No paid APIs required anywhere. Be honest in the UI: never claim a price or
>   forecast is "live/guaranteed" unless it actually came from a live source —
>   label every fare/weather value with its provenance. Open the app directly
>   into the experience (no marketing landing page).
> - **Deployable to a free host (e.g. Render.com)** as a single Blueprint: add a
>   `render.yaml` (Python web service, free plan, `startCommand: python
>   server.py`, health check on `/`). The server must be **deployment-aware**:
>   `/api/host` returns `RENDER_EXTERNAL_URL`/`PUBLIC_URL` when set, falling back
>   to a best-effort LAN IP (via a UDP-connect trick, wrapped in try/except)
>   for local Wi-Fi testing — the client must prefer the public URL when present
>   so a QR/share modal always shows a link that actually works for whoever
>   scans it, wherever they are.
>
> ### Core flow (screens)
> 1. **Registration** — full name, email, home city (with **live type-ahead**
>    city suggestions — see Live geo-suggest below), plus a **"Use my location"**
>    button (browser geolocation → server-side reverse-geocode → fills the city
>    and captures the country for currency). Then choose **Set up a get-together**
>    or **Join with an invite code**.
> 2. **Dashboard** — organized into **lifecycle tabs**: **Decide** (the
>    recommendation + voting + confirm-step + trip toolkit + insights),
>    **People** (the roster, each editable inline), **Costs** (per-person travel
>    cost breakdown + expense splitter), **Memories** (post-event photo/note
>    wall). A pinned header above the tabs holds event name/type, invite code,
>    "N in · M invited" count, and an Invite button. Landing on **Decide** (not
>    People) applies to BOTH the organiser and every invitee — the empty Decide
>    state must be an actionable call-to-action, not a passive hint (see
>    Recommendation engine → empty state below).
>
> ### Identity & roles (build this before anything collaborative — it's the
> foundation everything else depends on)
> - `state.me` = the current user's participant id; `state.role` =
>   `"organizer"` (came via "Set up") or `"participant"` (came via "Join").
> - `isMe(p)` / `canEdit(p)` (`role === "organizer" || isMe(p)`) gate every
>   Edit/Remove control — invitees can only edit their own card; nobody
>   (including the organiser) can remove themselves.
> - The current user's own card is visually marked ("You" badge) and sorted
>   first in the roster.
> - **True empty state**: a brand-new organiser with zero other participants
>   sees "It's just you so far" with two choices — **Invite people**, or
>   **explore with an opt-in sample/demo group** (clearly banner-labeled
>   "🧪 Demo mode", with a one-click "Clear sample data"). Never silently
>   populate a new event with fake people.
> - A **"Respond as…"** dropdown appears only in demo mode: switches `state.me`
>   to any seed participant so one person can experience the app (and cast
>   votes) as each member, for single-device testing/demoing. Must never
>   appear outside demo mode — it must not fake real multi-user presence.
>
> ### Participants — flexible ranked preferences (not fixed slots)
> - Each participant: name, email, home city, an **open-ended list** of ranked
>   date ranges (`{start, end}`, index 0 = best) and an open-ended list of
>   ranked destinations (index 0 = best) — **one row to start**, a
>   **"+ Add another date / place"** button to add more, each row individually
>   removable once there's more than one. Do not hard-code 3 fixed slots.
> - Also collect: max budget (number), dietary preference (dropdown), needs
>   accommodation (checkbox), kids attending (number), free-text accessibility
>   needs, and a multi-select of activity interests (chips).
> - An **RSVP** control ("✓ I'm in" / "Can't make it", tri-state incl.
>   "no response") on every card, editable only by its owner/organiser. The
>   dashboard header count must reflect real RSVPs ("N in · M invited"), not
>   just roster size.
>
> ### Recommendation engine (pure functions in `engine.js`)
> - Tally destinations and date ranges weighted by rank: points **decay
>   3 → 2 → 1 → 1 → 1…** (a floor of 1, never 0) so a long list of options never
>   produces an ignored (zero-weight) preference. Date matching uses **range
>   overlap**, not exact equality.
> - Rank every (date range × destination) combination with a **cost-conscious**
>   weighting: `total = 0.30*dateScore + 0.30*destScore + 0.40*costScore`
>   (named constants, sub-scores normalized 0..1; cost normalized across
>   candidate destinations, cheapest = 1). This can intentionally rank a
>   cheaper-but-less-popular place above the most-voted one — that's correct,
>   not a bug, given the weighting; show a one-line "why this won" reason
>   (e.g. "wins on cost" / "wins on date fit") so it never reads as an error.
> - **De-escalate to ONE hero, not a medal-covered leaderboard**: show the #1
>   option as a single winner card (destination photo banner, date, the
>   "why it won" line, a 4-cell score breakdown, and **Lock this plan** as the
>   single primary action). List #2/#3 as compact, quiet rows below — no
>   photos, no medals, minimal visual weight — each with its own small Lock
>   button (locking is allowed on *any* shortlisted option, with a confirm
>   dialog, not only the algorithmic #1).
> - **Empty state** (nobody has entered dates/destinations yet): an actionable
>   card — "🗓️ Add your dates & places" with two buttons, **"➕ Add your
>   availability"** (jumps to the People tab and opens the user's own card for
>   editing) and **"📨 Invite people"**. Never a passive "nothing yet" message
>   with no next action.
> - Show a visible progress hint everywhere tallies matter: "N of M responded".
>
> ### The Decide-tab confirmation step (build this — it's the answer to "what
> does a brand-new invitee actually see")
> When someone lands on Decide with **no data of their own yet** but the group
> **already has** a computed top pick (join-link invitees, freshly-added
> participants, or someone switched to via the demo "Respond as" simulator),
> do **not** show the blank "add your own" empty state — instead show a
> **confirmation card**: the group's current top destination + date, with two
> **independent** Yes/No questions —
> - "Does this date work for you?" Yes / No
> - "Does this place work for you?" Yes / No
>
> Both must be answered before Continue enables (someone might accept the date
> but reject the place, or vice versa — never conflate the two into one
> question). Answering **No** to either opens the existing flexible
> add-date/add-place row editor **inline**, right there, and Continue stays
> disabled until at least one valid alternative is entered for every "No".
> Answering **Yes** writes the group's top pick straight into that person's own
> `dates[0]`/`destinations[0]`. On Continue: persist the two answers
> (`dateConfirmed`/`destConfirmed`, tri-state — `null` = not asked,
> `true`/`false` = answered) so **this is a one-time step per person** — it must
> never re-interrupt someone who has already answered, and must never trigger
> for someone who is directly typing their own first date/place from the empty
> state (guard on "has no data of their own AND hasn't answered yet AND a group
> pick exists"). After Continue, take the user straight to **People** to fill in
> the remaining preference fields (budget, food, kids, etc.).
>
> ### Voting ("Decide together" when the algorithm alone isn't enough)
> - Organiser-only **"Open a vote"** promotes the top N ranked combos into a
>   ballot (`{open, openedBy, options[], votesByParticipant: {id: {optionId}}}`).
> - Each identity casts exactly one vote (tap an option row); live tally bars,
>   "✓ you" marker on your own vote, "N of M voted" progress.
> - Organiser can **Close voting** (locks in a winner badge on the leading
>   option, tie-broken by the engine score) and **Lock** it, or **Reopen**/
>   **Clear**. A demo-only **"Seed demo votes"** button fills plausible votes
>   for the sample group so the tally feels alive while testing solo.
>
> ### Travel costs
> - Per person: fare to the agreed/locked destination (or the current top
>   pick), shown in **their own regional currency** derived from their home
>   city's country — AND, underneath, the same amount converted into the
>   *viewer's* home currency ("≈ £170–£270 for you (GBP)"), so the person
>   reading the tab always has a familiar number too. A header toggle forces
>   everything to USD. If someone's preferred destination is the same as the
>   group's best, show a "🎯 Same as group best" note instead of a duplicate
>   card.
> - Distance/time (flight + drive, drive hidden beyond ~800mi so overseas
>   routes don't show a nonsensical multi-day "drive"), and deep links to
>   Google Flights, Rome2Rio, and Google Maps built with `encodeURIComponent`.
> - Fare resolution, in order: **live** (a real flight-offers API, only if
>   credentials are configured) → **searched** (a small curated table of real
>   captured round-trip ranges) → **estimated** (a diminishing-per-mile
>   distance heuristic so long-haul stays realistic) → **unknown**. Label the
>   provenance on every fare shown (badge: live / searched·date / estimated).
>   Never render a "live" badge from a code path that can't actually produce
>   live data.
> - **Geocode any city** the user types that isn't in a built-in table (proxy
>   → OpenStreetMap Nominatim, keyless, cached + lock-serialized) so fares
>   generate for literally anywhere, with an "Estimating…" skeleton state
>   while the geocoded fare is in flight.
> - **Expense splitter**: log who paid what (USD), split equally across
>   everyone RSVP'd "in" (falling back to everyone if fewer than 2 are marked
>   in), compute balances (paid − share) and a **greedy minimal-transfer
>   settle-up** ("Aisha → Dinesh $184"). Delete your own entries (or any, if
>   organiser).
>
> ### Live location & currency intelligence
> - `GET /api/geosuggest?q=` — type-ahead place suggestions (OpenStreetMap
>   Nominatim `search`, cached, debounced client-side ~200ms) wired to
>   **every** city/destination input in the app (registration, home city,
>   ranked destination rows) — replacing any static fixed city list.
> - `GET /api/reverse?lat=&lng=` — reverse-geocode for "Use my location".
> - Currency is derived from the resolved country (a country-name map AND an
>   ISO country-code map, since the two geocoding paths return different
>   shapes) — cover at least USD/GBP/EUR/INR/AED/SGD/HKD/THB/IDR/MYR/AUD/JPY/
>   CNY/CAD/CHF with a symbol + an approximate static FX rate, clearly labeled
>   approximate.
>
> ### Trip toolkit (shown once a plan is locked)
> - `GET /api/weather?place=&start=&end=` proxies a keyless weather API: real
>   forecast if the date is within ~15 days, otherwise the same calendar dates
>   one year prior from a historical/archive endpoint, explicitly labeled
>   "Typically" vs "Forecast".
> - One-tap deep links: Hotels (Google Hotels), Airbnb, Explore-map,
>   Restaurants.
> - **Add to calendar** — generate a real, valid all-day `.ics` file
>   client-side (remember `DTEND` is exclusive — use end-date + 1 day) and
>   trigger a download via a Blob URL.
> - **Smart itinerary**: deterministic (seeded PRNG) day-by-day plan built from
>   the group's aggregated activity interests. Each idea entry carries which
>   time-of-day slots it's valid for (e.g. "sunset walk" only fits evening) —
>   **slot-aware**, don't let a nightlife idea land in the morning. Every idea
>   deep-links to a Maps search for it. A **Shuffle** button rerolls the seed.
>
> ### Memory wall (post-event, gated)
> - Hidden until a plan is locked; before the event start date shows a teaser
>   ("unlocks on the day") with an organiser-only **preview** toggle so it's
>   demoable early.
> - After unlock: a composer (text note + photo file input) and an
>   author-tagged, newest-first feed. Photos are **downscaled client-side on a
>   canvas** (~1024px, JPEG ~0.7 quality) before being stored, with a hard cap
>   on count, because this is on-device storage (localStorage) with no server —
>   say so explicitly in the UI ("stored only in this browser"). Handle a
>   storage-quota failure gracefully (roll back, toast, don't crash). Delete
>   only your own entries (or any, if organiser).
>
> ### Monetisation — "Reunly Pro"
> - A visible upsell card + modal (feature list, a price line, and a **demo
>   unlock** button since there's no real payment backend) that actually gates
>   two real things: a downloadable **Trip Pack** (a self-contained, printable
>   HTML one-pager — who's going, their fares, the itinerary — built from the
>   app's own data with all user text HTML-escaped) and a higher memory-wall
>   photo cap. Show a small "Pro" badge in the header once unlocked. Also
>   sketch (in the UI copy, not code) 2–3 other monetisation angles: affiliate
>   revenue from the hotel/flight links already present, a subscription tier,
>   a B2B tier for schools/clubs/wedding planners.
>
> ### Cross-device organiser notifications (only after identity + roles exist)
> Real friends test this on separate physical devices with no shared backend —
> a same-browser-only notification is nearly useless for that. Add a **minimal
> server-side** piece: `POST /api/notify` `{code, name, destination, dateLabel,
> dateOk, destOk}` appends to an in-memory list keyed by invite code (case-
> insensitive match, cap list length, cap field lengths, reject malformed
> bodies with a 400 rather than crashing); `GET /api/notify?code=&since=`
> returns entries newer than a timestamp. Fire a POST (fire-and-forget, ignore
> failures) when someone completes the Decide confirm step. The organiser's
> client polls on an interval and shows a **🔔 bell** with an unread badge in
> the header; clicking shows a short list. Be explicit with the user that this
> store is **in-memory only** — it resets on a server restart/redeploy (fine
> for a live test session, not durable storage) — and that this is the one
> place in the whole app with real server-side state.
>
> ### Design language (modern, premium — not a plain form)
> - Dark base (`#080b16`-ish); a signature **indigo→violet→pink gradient** on
>   the logo, primary buttons, score bars, gradient headline text. Light theme
>   too, toggle in the header, persisted.
> - **Glassmorphism** cards (translucent + backdrop blur, large radii,
>   `box-shadow`). An animated, subtle aurora background gradient behind the
>   whole app.
> - **Registration is a hero, not a form**: a gradient headline, a rotating
>   word in the tagline, and an **ambient flight animation** — a plane
>   following an SVG arc between two cities that **change randomly every
>   loop**. Draw a real **top-down airliner silhouette** (pointed nose, swept
>   delta wings, tail cone + rear stabilisers, a small cockpit-window accent) —
>   a generic arrow/chevron shape does not read as a plane; check this
>   visually before shipping it. The card containing the actual form pops in
>   with a spring-ish entrance.
> - Motion budget: screen fade-ups, staggered list-item entrances, score bars
>   animating from 0 to their value (double-`requestAnimationFrame` so the
>   0-state paints first), button hover/press lift — all wrapped in a
>   `prefers-reduced-motion` guard.
> - Destination emojis everywhere meaning needs a visual anchor (participant
>   avatar tiles, chips, recommendation cards) with a sensible pin fallback for
>   unmapped places. Confetti (lightweight, no library) once, when a genuinely
>   decisive winner first emerges (not on every render).
> - First-run **onboarding carousel** (a few slides, dots, Skip/Next), shown
>   once via a persisted flag.
>
> ### Security, correctness, and accessibility — non-negotiable
> - Render **all** user-supplied text via `textContent`/`createElement` —
>   never `innerHTML` with string interpolation. This is a real XSS boundary,
>   not a style preference.
> - A CSP `<meta>` tag restricting `img-src`/`connect-src`/`script-src` etc. to
>   `'self'` plus the exact external image hosts actually used (a QR-code
>   image API, a photo-source API) — update it deliberately whenever a new
>   external asset host is added, never leave it default-open.
> - The invite-link payload must **never include email addresses** or other
>   people's private fields — only what a new joiner needs to see the event
>   and roster names.
> - Every modal is a real dialog: `role="dialog"`, `aria-modal`, closes on
>   Escape, returns focus to the element that opened it. Toasts use
>   `aria-live="polite"`. Progress/score bars expose `role="progressbar"` with
>   `aria-valuenow`.
> - `[hidden] { display: none !important; }` **must** be a very early global
>   rule. A component class that later sets `display: flex/grid/block` on the
>   same element silently defeats the native `hidden` attribute, leaving an
>   invisible full-screen element that still intercepts clicks — this is a
>   real bug class, not theoretical; write the guard rule before it happens,
>   not after debugging a "my buttons don't work" report.
> - **Service worker: network-first**, not cache-first, for the app shell
>   (try the network, fall back to cache only when offline); never cache
>   `/api/*`; bump the cache-version string on every shell-file change; on
>   `activate`, delete old-version caches. Cache-first during active
>   development silently serves stale JS and wastes hours chasing phantom
>   bugs — get this right from the very first commit, not as a later fix.
>
> ### Deliverables
> Working files (`index.html`, `styles.css`, `data.js`, `engine.js`, `fares.js`,
> `app.js`, `server.py`, `service-worker.js`, `manifest.json`, `icon.svg`,
> `render.yaml`, `.claude/launch.json`), clean readable code with comments only
> where the *why* isn't obvious from the code, and a short note on how to
> deploy (push to GitHub → Render Blueprint → done) and how to test with a
> real group (send the deployed URL; each person registers and either sets up
> or joins with the invite code).

---

## Notes for whoever runs this prompt

- This produced roughly ten iterative rounds in the original build (see the git
  log for the exact order: engine → data → identity/roles/tabs → voting →
  memory wall → RSVP/privacy → phone/LAN testing → weather/toolkit/itinerary/
  expenses → live geosuggest/flexible options/currency/Pro → flight-plane
  polish → Decide-landing UX fix → deployment-aware host/Render → the
  confirm-step + cross-device notifications). A single mega-prompt like the
  one above will very likely need the same kind of iteration in practice —
  treat it as a target to steer toward, not a one-shot spec.
- The two gotchas called out explicitly above (`[hidden]` vs `display`, and
  service-worker cache strategy) were **real bugs that shipped and had to be
  found and fixed** in the original build. Building them in correctly from the
  start avoids repeating that debugging time.
- If the rebuilding agent has live browser tooling, it should click through
  every flow described above (register → set up vs. join → confirm step with
  a Yes+No / No+Yes / No+No matrix → voting → lock → costs in two currencies →
  toolkit → memory wall gating → Pro unlock → notification bell) rather than
  trusting code review alone — several bugs in the original build were only
  caught by literally testing branchy Yes/No UI combinations and rapid-typing
  into inputs mid-render.
