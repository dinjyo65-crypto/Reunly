# PROGRESS — Reunly

_Last updated: 2026-10-26 — **v8 friends test starting** (live https://reunly.onrender.com, re-verified today). Kit in `testing/`. v0.9 pub-crawl prototype on `v0.9-dev` (local)._

## Goal
Mobile-first group-planning PWA ("decide when, where and how to meet"): vanilla HTML/CSS/JS + a stdlib-only Python server, deployable as a Render Blueprint. Full target spec is in `REBUILD_PROMPT.md`. Done = a real group can plan, vote, lock, cost, settle up and remember a trip end to end on separate devices, with every estimate honestly labelled. v8 goal: a working app that a security expert, travel expert, travel planner, app developer and app user all broadly agree on, with Reunly Pro (monetisation) in mind.

## Done
- v0.6–v0.9.1 feature build (Jun–Jul) and Aug 26–28 review-fix rounds — see git log / `REBUILD_PROMPT.md`
- 2026-10-21 (v0.7-dev, pushed + merged to master `c5c514c`): vote-panel crash fix, thumb.wikimedia CSP, maps-style home-city lookup (Photon, pick required, currency from country)
- **v8** (branch `v8`):
  - `59c65ad` Globe hero: Remotion project `hero-animation/` (Globe.tsx, palette "Brand-Glow" + pace 1.0 agreed by a motion designer and a brand/UX designer). 4 MP4 loops in `media/` (~0.6 MB each; WebM dropped — VP9 render failed to decode in Chrome) + finale poster. Locked plan shows the group's real trips on a dot-matrix globe (`globe-land.js`, `/api/geocode`). `/media/*` served with byte ranges (iOS).
  - `9886b25` Review round 1 fixes (security, travel, planner, developer, user) — full list in the commit message: static allowlist + rate limits + headers; hero only for sign-up visitors; regional road model + per-destination seasons + season-aware booking lead times + entry permits + dated booking links; cost tolerance (no trivial-saving override); decline notifications; re-confirm after lock; kitty view; organiser "in"; guest send-back window, invite banner, guest-hidden organiser controls; honest organiser-only Pro copy
- Tests: `npm test` 106/106; `.qa/walk2.js` 54/54; `.qa/city.js` 9/9; `.qa/hero.js` 8/8; `.qa/v8fixes.js` 6/6 (all git-ignored except engine tests)

## In progress
- **v8 friends test (from 2026-10-26)**: plan + paste-ready messages in `testing/FRIENDS-TEST-PLAN.md` and `testing/message-to-friends.txt` (5–8 friends, mixed iPhone/Android/abroad, one week: invite → replies → vote → lock → costs). Live site re-verified 2026-10-26: v8 footer, hero video plays, city search, fares, `.git` 404; cold start ~23 s (suggest an uptime pinger for the week). iPhone testers asked to stay in Safari (home-screen storage risk). Render deploys from `v0.7-dev` — keep it level with `master`.
- **v0.9** (`PLAN-v0.9.md`, branch `v0.9-dev`, local only): decisions made (organiser + co-hosts check in; pubs + any place; taps only, no GPS; standalone prototype). **Prototype built and passing**: `prototypes/pub-crawl/` + `/api/live*` + `/api/pubs` (Nominatim; Overpass proved unreliable). Tests: `npm test` 113 (incl. 7 crawl), `.qa/crawl.js` 18/18; main app suites unchanged (54/9/8/9). Open at http://localhost:4175/prototypes/pub-crawl/ . Rounds 4–5 done (PLAN-v0.9.md): coming-from + ways home, auto last train, guest actions by state, 3-agent simulation × 3 cycles with fixes. Tests: `npm test` 126, `.qa/crawl.js` 46/46. Round 6 done: call/text/nudge, organiser in home-safe list, drop-out alerts, change my reply, real last trains (Transitous). Tests: `npm test` 127, `.qa/crawl.js` 52/52. Next: small real friends test of the prototype (needs it online), then integrate as an "evening" mode.

- Round 2 (all 5 re-verified): travel SHIP, security SHIP, developer/planner/user SHIP after one fix each — fixed: keep-alive leaking the media Cache-Control onto app.js/API; notify token not saved until a later edit (every guest reply lost after the organiser reloaded); guest never prompted to send after Done (send bar now above the tabs + send window opens on Done); bell refreshes when opened; XFF last hop + 5 s cap on the Nominatim queue; passport/visa before a 150-day peak booking; Malaysia off the slow-roads list; Dubai Christmas ×1.6; server fare mode always "flight". Tests: engine 106, walk2 54, city 9, hero 8, v8fixes 9.

## Next up
1. Run the friends test (`testing/FRIENDS-TEST-PLAN.md`); at the end of the week paste the feedback into a session → triage into fixes here
2. v0.9: try the pub-crawl prototype on phones, 5-expert review, then integrate as an "evening" mode (`PLAN-v0.9.md`)
3. v9 backlog from the reviews: deposit tracker with due dates + nudges and live shared sync (the two things organisers said they'd pay Pro for); reply-by dates; re-broadcast prompt after merges; join-by-code without a link; multiple events; shorter post-confirm form; hide vote/confirm after lock; passport country + visa hints; long-haul fare levels, nonstop table, home-country holidays; real Pro entitlements (server-signed, Stripe, persistent storage); invite-link auth; split app.js; Python tests for server.py

## Testing steps (as an app)
1. Render dashboard → service `reunly` → Events: confirm the deploy finished for the pushed commit. Open the `https://…onrender.com` URL (first load after idle ~30–60 s).
2. Install on each phone from that HTTPS URL: Android Chrome → ⋮ → *Install app*; iPhone Safari → Share → *Add to Home Screen*.
3. Organiser: register (pick city from the list) → *Set up a get-together* → add own dates + places → *📨 Invite people* → send the link.
4. Each friend: open the link (banner says who invited them) → register → answer "Does this work for you?" (mix Yes/No, try "I can't make it") → **📤 Send my answers** back to the organiser.
5. Organiser: open each return link → check roster/ranking → vote → lock → Costs (own currency), Before you go, Trip Pack, plan globe, Memories.
6. Note phone model, step, expected vs seen (+ screenshot).
- Local alternative: `python server.py` → http://localhost:4175 (📱 button shows a QR for phones on the same Wi-Fi).
- Known limits: 🔔 resets on redeploy/spin-down; data lives in each phone's browser.

## Decisions
- 2026-10-21: keep the 15 mapped currencies for now (other countries show USD)
- 2026-10-21: free public Photon is fine for now (fair-use limits accepted)
- 2026-10-21: globe (not flat) hero; looping video on sign-up, live JS globe once a plan is locked
- 2026-10-21: palette "Brand-Glow", pace 1.0, 4 travellers per sample trip (motion + brand experts)

## Open questions / blockers
- Notifications store is in-memory only (resets on Render redeploy) — still acceptable?
- Hero video tooling: `cd hero-animation && npx remotion studio` (port 3001 here; port 3000 is another local site, so `remotion still/render` need `--port=3055`)
