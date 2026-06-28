# Reunly — From-Scratch Build Prompt

Paste the prompt below into a capable coding agent to recreate this app from nothing.
It captures the product, stack, features, design language, and the hard-won gotchas.

---

## THE PROMPT

> Build a mobile-first reunion-planning web app called **Reunly** as a client-side
> prototype with a tiny Python backend proxy. It helps a group pick the best
> **date + destination** for a reunion and shows each person's **travel cost**.
>
> ### Stack & constraints
> - Vanilla **HTML/CSS/JS only** (no framework, no build step), split into clean
>   modules loaded via plain `<script>` tags: `data.js` (static data + helpers),
>   `engine.js` (pure, UI-free logic), `fares.js` (client fare/photo fetching),
>   `app.js` (UI controller), plus `styles.css`, `index.html`.
> - A small **Python stdlib server** (`server.py`, no third-party deps) that serves
>   the static files AND a same-origin JSON API. Run on **port 4175** via
>   `.claude/launch.json`.
> - PWA: `manifest.json`, `icon.svg`, and a **network-first** `service-worker.js`.
> - No paid APIs required. Be honest: never claim prices are "live/guaranteed"
>   unless actually fetched. Open the app directly into the experience (no
>   marketing landing page).
>
> ### Core flow (screens)
> 1. **Registration** — full name, email, home city (with type-ahead city
>    suggestions from a shared `<datalist>`). Then choose **Set up a reunion** or
>    **Join** (with an invitation-code field).
> 2. **Dashboard** — reunion name + type (Family/School/College/Friends), invite
>    code, participant count, plus the sections below.
>
> ### Participants
> - Seed several demo participants spread across regions (US, UK, UAE, Singapore,
>   India). Let the user **add** participants. **Every** participant is
>   **inline-editable inside its card**; the active card is visually highlighted.
> - Editable fields: name, email, home city, **three ranked date ranges**
>   (1st/2nd/3rd, native date pickers) and **three ranked destinations**
>   (datalist suggestions + a Google Maps helper link).
>
> ### Recommendation engine (pure functions in engine.js)
> - Tally destinations and date ranges weighted by preference rank (1st=3, 2nd=2,
>   3rd=1). Date matching uses **range overlap**, not exact equality.
> - Rank every (date range × destination) combination with a **cost-conscious**
>   weighting: `total = 0.30*dateScore + 0.30*destScore + 0.40*costScore`
>   (weights as named constants; sub-scores normalized 0..1). Cost is normalized
>   across candidate destinations (cheapest avg fare = 1).
> - Show the **top 3** with an explainable breakdown (date %, place %, cost %, avg
>   fare). **Recompute live** on every edit (debounced). Make the engine accept an
>   injected `fareProvider` so the UI can feed in live fares.
> - City matching must be **case-insensitive** (resolve to canonical names).
>
> ### Travel costs
> - For each participant show two cards: cost to the **group-best** destination and
>   to **their 1st preference** (if the same, show a "🎯 Same as group best" note
>   instead of a duplicate). Each card: fare range, distance (mi), approx flight
>   time, drive time (only when ≤ 800 mi so overseas routes don't show silly
>   drives), and deep links to **Google Flights / Rome2Rio / Google Maps**
>   (build with `encodeURIComponent`).
> - **Fares** resolve via the proxy `GET /api/fare?from=&to=&date=` in this order:
>   **live** (Amadeus Flight Offers, only if `AMADEUS_CLIENT_ID/_SECRET` env vars
>   set) → **searched** (a curated map of real round-trip USD ranges) →
>   **estimated** (distance heuristic with a *diminishing* per-mile rate so
>   long-haul stays realistic) → **unknown**. Always return `miles`. Label each
>   fare's provenance with a badge (live / searched·date / estimated).
> - **Geocode any city the user types** that isn't in the built-in table: proxy
>   calls OpenStreetMap **Nominatim** (keyless, serialized behind a lock + cached)
>   so fares generate for anywhere. Client shows an **"Estimating…" skeleton**
>   while a geocoded fare is in flight, then upgrades in place.
>
> ### The four "pro" features
> - **(a) Live-fare proxy** as above; client (`fares.js`) caches fares in memory +
>   localStorage (6h TTL), caches "unknown" too so the UI can distinguish pending
>   from no-estimate, and re-renders when data arrives (render-now-with-fallback).
> - **(b) Persistence** — full app state in `localStorage`; boot precedence:
>   **shared invite link > saved session > fresh registration**. Restart button
>   does a **full reset** (unregister SW + clear caches + clear state).
> - **(c) Multi-currency** — fares stored in USD, displayed in the traveller's
>   **regional currency** (₹/£/S$/AED/฿/Rp… mapped from the city's country) with a
>   USD reference line and a header **USD ↔ local toggle**. Static approx rates,
>   labelled approximate.
> - **(d) Shareable invite links** — encode reunion + participants into the URL
>   **hash** (base64 JSON, UTF-8 safe), no backend; opening the link reconstructs
>   the reunion and routes the joiner straight in after registering. Share button
>   uses `navigator.share` → clipboard fallback with a toast.
>
> ### Design language (modern, premium)
> - Dark base `#080b16`; signature **indigo→violet→pink gradient**
>   `linear-gradient(135deg,#6366f1,#a855f7,#ec4899)` on logo, primary buttons,
>   score bars, gradient text. **Glassmorphism** cards (translucent + backdrop
>   blur, large 18px radii). Animated **aurora** background.
> - **Registration is a hero**: gradient headline ("Where will the *crew
>   reunite?*"), a **rotating destination word**, floating travel emojis hugging
>   the screen edges (decorative, `pointer-events:none`), a glass card that pops
>   in, glowing CTA, "no account needed" line.
> - **Motion**: screen fade-ups, staggered list entrances, score bars animate
>   0→target (double-rAF), button hover/press. Wrap everything in a
>   `prefers-reduced-motion` guard.
> - **Destination emojis** everywhere (landmark/flag per city, 📍 fallback): as
>   participant **avatars**, on chips, recommendations, cost-card badges.
> - **Top-3 recommendations** show 🥇🥈🥉 medals; the #1 gets a gold accent **and a
>   real destination photo banner** fetched via proxy `GET /api/photo?place=` →
>   **Wikipedia REST page summary** image (keyless), gradient overlay + title on
>   top, gracefully falls back to a gradient if none.
> - **Confetti** burst (lightweight, no library) once when a clear winner is newly
>   decided. **Light/dark theme toggle** (persisted) and a **first-run onboarding
>   carousel** (3 slides, dots, Skip/Next, shown once via a localStorage flag).
>
> ### Security / correctness
> - Render all user-supplied text via `textContent`/`createElement` — **never**
>   `innerHTML` with interpolation (no XSS). Add a CSP meta tag (allow only
>   `'self'`, `data:`, and `upload.wikimedia.org` for images; `connect-src 'self'`
>   since photos/fares go through the proxy). External links get
>   `rel="noopener noreferrer"`.
>
> ### CRITICAL GOTCHAS — get these right from the start
> 1. **`hidden` attribute vs `display`**: a class like `.onboard{display:grid}` or
>    `.btn{display:inline-flex}` **overrides** the HTML `hidden` attribute, leaving
>    the element laid out. An "invisible" full-screen overlay (`position:fixed;
>    inset:0; opacity:0; pointer-events:auto`) will then **eat every click** and
>    make the whole app feel broken. Add a global `[hidden]{display:none
>    !important;}` rule. Diagnose pointer problems with
>    `document.elementFromPoint(x,y)` — **NOT** `element.click()`, which fires
>    through overlays and hides the bug.
> 2. **Service-worker stale cache**: use a **network-first** SW (fall back to cache
>    offline), exclude `/api/` from caching, send `Cache-Control: no-store` for
>    static files from the dev server, bump a `CACHE_VERSION`, call
>    `skipWaiting()`+`clients.claim()`, auto-reload on `controllerchange` (only
>    when a prior controller existed), and add a self-heal handler that clears
>    SW+caches and reloads once per session on an uncaught error. Otherwise edits
>    silently test old code.
> 3. **Keep `server.py` data (coords, searched fares, estimate formula) in sync**
>    with `data.js`/`engine.js` — it duplicates them server-side.
>
> ### Deliverables
> Working files (`index.html`, `styles.css`, `data.js`, `engine.js`, `fares.js`,
> `app.js`, `server.py`, `service-worker.js`, `manifest.json`, `icon.svg`,
> `.claude/launch.json`), clean readable code with comments, and a short note on
> how to enable live fares (set the two Amadeus env vars and restart).
