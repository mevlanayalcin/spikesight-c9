# Devpost Submission: SpikeSight C9

- **Project name:** SpikeSight C9
- **Tagline:** A VALORANT coaching war room: an SVG tactical map with utility, Operator and economy layers, a seeded 1,000-trial win-probability simulator, one-click GRID replay hydration and an anti-strat dossier.
- **Hackathon:** Cloud9 x JetBrains "Sky's The Limit" Hackathon 2026
- **Category:** Category 1, plus the JetBrains AI workflow bonus
- **Live web application:** [spikesight-c9.bedir-ai.workers.dev](https://spikesight-c9.bedir-ai.workers.dev)
- **Sample series endpoint:** [spikesight-c9.bedir-ai.workers.dev/api/grid/sample-series](https://spikesight-c9.bedir-ai.workers.dev/api/grid/sample-series)
- **GitHub repository:** added at publish time by the coordinator
- **Demo video:** added at publish time by the coordinator

## Inspiration

Anti-strat preparation is mostly manual. An analyst watches VODs, notes where the opposing Operator player sets up, when the executes arrive and what the team does on a broken economy, then writes it up for the coach. We wanted one screen that answers those three questions from round telemetry and hands the coach a report to paste into a team channel.

## What it does

SpikeSight C9 implements both Category 1 blueprints in one dashboard.

**1. Interactive 2D SVG tactical map engine.** Ascent, Haven, Bind and Lotus are drawn top-down with site zones, spike plant zones, spawns, chokes and Mid where the map has one. Six rosters are available: Cloud9, Cloud9 White / GC, Sentinels, G2 Esports, Fnatic and PRX. Three layers sit on the map:

- **Layer 1, Utility Placement and Ability Analysis.** Toggles for Smokes, Flashes, Recon/Info and Mollies/Post-Plant, an Attack versus Defense filter and a round phase filter (0 to 30 s Default, 30 to 65 s Execute, Post-Plant). Utility is drawn as glowing circles, flash cones and recon rings with density clusters. The panel reports the Utility Efficiency Score, Flash Assist Rate, Execute Timing Distribution and Site Bias %.
- **Layer 2, Operator Tendency and Sniper Profiler.** Hold positions with sightline cones, first-blood pick rate, re-peek rate, Operator frequency on buy rounds against eco rounds, and anti-Operator counter recommendations placed on the map: where to smoke, where to flash, when to trade the re-peek and when to jump-peek.
- **Layer 3, Economy and Round Win-Probability Markov Engine.** Win rate by economy state (Pistol, Eco, Half-Buy / Bonus, Full Buy) and a seeded 1,000-trial Monte Carlo simulator for the rest of the map. It reports map and half win probability, comeback probability, force-buy EV and a save-versus-retake call that reads the clock by side (retake on defense, post-plant hold or execute on attack). The same inputs and seed reproduce the same numbers.

**2. Live GRID GraphQL and replay integration.** The Worker serves a GRID-shaped sample series (Cloud9 13 to 10 Fnatic on Ascent, 23 rounds) that the dashboard hydrates in one click. A bring-your-own-key proxy forwards GraphQL queries to GRID Central Data and Series State; it only calls `api-op.grid.gg` and `api.grid.gg` on the two GraphQL paths and takes the key from the `x-api-key` header. A Series State JSON document can also be pasted and imported.

**One-click outputs.** "Generate Anti-Strat Dossier" writes a Markdown report with Operator tendencies, execute timings, pistol tendencies and site win rates and copies it to the clipboard. "Ask Tactical AI Coach" answers a question through Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) grounded on telemetry computed by the Worker. When the model is unavailable a deterministic coach answers from the same numbers, so the endpoint always returns HTTP 200.

## How we built it

- A Cloudflare Worker in plain JavaScript ES modules with static assets, no bundler configuration and no npm dependencies.
- The analysis lives in pure modules (`tactical-maps.js`, `pro-data.js`, `scout-engine.js`) that the browser, the Worker and the tests all import, so the page and the coach compute the same numbers.
- `app.js` holds DOM code only. It builds every node with `createElement`, `createElementNS` and `textContent`, and the page runs under a `script-src 'self'; style-src 'self'` Content-Security-Policy with no inline script or style.
- The Monte Carlo uses a Mulberry32 generator with an explicit seed.
- The coach is the only route that spends a metered resource, so the model is called only for same-origin requests under a per-address rate limit (6 per minute); every other request still gets HTTP 200 from the deterministic coach, and the provider's error text is never relayed.
- 91 `node --test` tests: 69 for the engine and the Worker (coordinate normalisation, clustering, sightline math, economy classification, Monte Carlo determinism and bounds, the overtime, sudden-death and credit rules, the side-aware save-versus-retake call, the GRID hydrator, the proxy allowlist, key redaction and body limits, the coach fallback and its limits) and 22 for the dashboard (static page checks and tests of `app.js` on a hand-written fake DOM, including hostile replay strings, flash cone geometry, zone label spacing and keyboard focus).

## JetBrains tooling

- `.idea/runConfigurations/SpikeSight_Tests.xml`: a shared npm run configuration that runs `node --test tests/*.test.mjs`.
- `qodana.yaml`: `jetbrains/qodana-js:2025.2` with the `qodana.recommended` profile.
- [`JETBRAINS_WORKFLOW.md`](JETBRAINS_WORKFLOW.md): the IDE, Qodana and AI workflow as a reproducible procedure, with a plain statement of which steps were executed on the build host.

## Challenges

- Keeping the map honest without game artwork: zones are schematic polygons placed around public callout coordinates, and a test checks that every site callout lies inside its own site polygon.
- Making the coach trustworthy: the Worker computes the telemetry itself instead of trusting the client, treats the question as untrusted text and falls back to a deterministic answer.
- Keeping the coach and the screen in agreement after a replay is loaded: the dashboard tells the Worker to ground on the same hydrated replay, and a replay imported in the browser is answered in the browser.
- A proxy that cannot be turned into an open relay: the target URL is rebuilt from an allowlisted host and path, redirects are not followed and the key is redacted from upstream responses.

## What's next

- Run the GRID proxy with a real key and map live Series State fields onto the round shape.
- Fit the round win matrix to measured round outcomes instead of assumptions.
- More maps, and lineup-level utility detail.

## Limits to know about

- No GRID API key was available while building, so the live GRID path was tested against a fake upstream only.
- The roster datasets and the sample series are modelled, and the economy model rests on stated assumptions.
- At verification time the live coach answered from the deterministic coach, because the account's daily Workers AI allocation was used up.

## Disclaimer

SpikeSight C9 is an independent open-source analytics tool. It is not affiliated with or endorsed by Riot Games, and VALORANT is a trademark of Riot Games, Inc. It is also not an official product of Cloud9, GRID or JetBrains. The roster datasets and the sample series are modelled scenario data shaped like GRID Series State, not official match statistics.
