# PROGRESS — Reunly

_Last updated: 2026-10-21 — home-city lookup works like a maps app (pick required, currency from country); 54/54 click-through, 9/9 city checks, 103/103 engine tests_

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
- Nothing mid-flight

## Next up
1. Confirm the Render service redeployed from GitHub (dashboard → reunly → Events) and smoke-test the public URL on two phones
2. Add an `npm run qa` script for the click-through so UI regressions like the vote crash are caught before commit (needs Chrome + `.qa/node_modules`)
3. Destination photos: server prefers Wikipedia `originalimage` (~3840px) — switch to the thumbnail or a sized variant for mobile data

## Open questions / blockers
- Any new review findings / feature list for the next round?
- Notifications store is in-memory only (resets on Render redeploy) — still acceptable?
- Only 15 currencies are mapped; a picked city in any other country (e.g. Nigeria, Brazil) still shows USD. Add more currencies + rates?
- Photon is a free public service with fair-use limits — fine for testing; a busy launch would want a self-hosted instance or a paid geocoder
