# PROGRESS — Reunly

_Last updated: 2026-10-21 — code frozen for real-device testing; `ff2be8d` pushed to v0.7-dev and master. No more changes until test feedback is in._

## Goal
Mobile-first group-planning PWA ("decide when, where and how to meet"): vanilla HTML/CSS/JS + a stdlib-only Python server, deployable as a Render Blueprint. Full target spec is in `REBUILD_PROMPT.md`. Done = a real group can plan, vote, lock, cost, settle up and remember a trip end to end on separate devices, with every estimate honestly labelled.

## Done
- v0.6–v0.9.1 feature build (Jun–Jul): registration hero, lifecycle tabs, identity + roles, ranked prefs, engine scoring, voting, RSVP, memory wall, trip toolkit, live geosuggest, currency-by-location, Reunly Pro, Decide confirm step, notify bell, Render deploy
- Review-fix rounds (Aug 26–28, ~45 commits): sync/merge hardening, settle-up in `engine.js` with tests, overlap windows, lodging/season/hemisphere pricing, treasurer ledger, ballot sync, Before-you-go checklist, convergence map
- 2026-10-21: pushed 38 commits; added browser click-through `.qa/walk2.js` (git-ignored; organiser + 4-way guest confirm matrix + bell)
- 2026-10-21: fixed `renderVote` crash ("Assignment to constant variable") — with any ballot open, `renderAll` threw before People/Costs/Expenses/Memories rendered and before `saveState()`. Regression from `18f8268`
- 2026-10-21: CSP now allows `thumb.wikimedia.org` (Wikipedia moved photo URLs there, so destination banners were blank); SW cache → v31
- 2026-10-21: `REBUILD_PROMPT.md` brought up to date with the August rounds
- 2026-10-21: home city now works like a maps app — prefix suggestions via Photon (`/api/geosuggest?kind=city`), "City, State, Country" labels, pick required at registration, currency from the picked country; roster city fields hint when no country. Tests: `.qa/city.js` (9/9)

## In progress
- **Real-device testing phase (user-led).** Testing steps below.
- **New registration hero animation** (Remotion project in `hero-animation/`, not yet committed or embedded). Two variants, 4 sample trips each, 1200×570, 9 s loops: flat convergence (`Convergence.tsx`) and rotating 3D globe (`Globe.tsx`, d3-geo + world-atlas, real coordinates, great-circle arcs, push-in finale). Preview: `cd hero-animation && npx remotion studio` (port 3001 here; port 3000 is taken by another local site, so `remotion still` needs `--port=3055`).
  - Agreed plan: home screen = **looping videos** rendered from the chosen variant; once a destination is locked, the plan's journey map should show the group's actual trips (rebuild that one in the app's own JS, same look).
  - Waiting on: user picks flat vs globe (or both), then render → embed.

## Testing steps (as an app)
1. Render dashboard → service `reunly` → Events: confirm a deploy of `ff2be8d` finished (check which branch the service tracks; both branches are now identical). Open the `https://…onrender.com` URL. First load after idle can take ~30–60 s (free tier spins down).
2. On each phone, open that HTTPS URL and install it: Android Chrome → ⋮ → *Install app* / *Add to Home screen*; iPhone Safari → Share → *Add to Home Screen*. (Installing needs HTTPS, so use the Render URL, not the LAN one.)
3. Organiser phone: register (pick the city from the list) → *Set up a get-together* → People → add own dates + places → *📨 Invite people* → send the link (WhatsApp/SMS).
4. Each friend: open the link → register → answer the confirm step (try a mix of Yes/No) → fill in their card → **send their link back** (the prompt on Decide). Their answers only reach the organiser when the organiser opens that return link.
5. Organiser: open each return link → check the roster/ranking update → open a vote → friends vote and send links back → close & lock → check Costs (each person's own currency), Before-you-go, Trip Pack, Memories.
6. Note anything odd with: phone model, which step, what you expected vs saw (a screenshot helps).
- Local alternative (same Wi-Fi only, no install): `python server.py` in the Reunly folder → open http://localhost:4175 → header 📱 button shows a QR for phones.
- Known limits during the test: the 🔔 bell resets on every Render redeploy/spin-down; data lives in each phone's browser (clearing site data wipes it).

## Next up (after testing feedback)
1. Triage test feedback into fixes; run `node .qa/walk2.js` + `node .qa/city.js` + `npm test` before each commit
2. Add an `npm run qa` script for the click-through (needs Chrome + `.qa/node_modules`)
3. Destination photos: server prefers Wikipedia `originalimage` (~3840px) — switch to a smaller variant for mobile data

## Decisions
- 2026-10-21: keep the 15 mapped currencies for now (other countries show USD)
- 2026-10-21: free public Photon is fine for now (fair-use limits accepted)

## Open questions / blockers
- Notifications store is in-memory only (resets on Render redeploy) — still acceptable?
