# JetBrains Workflow: SpikeSight C9

This file describes how to work on SpikeSight C9 with a JetBrains IDE, Qodana and a JetBrains AI tool, for the JetBrains AI workflow bonus of the Cloud9 x JetBrains "Sky's The Limit" Hackathon 2026. It is a procedure you can repeat. The last section states which steps were executed while building and which were not.

## 1. Open the project

1. Open the repository folder in WebStorm or IntelliJ IDEA Ultimate (the JavaScript and Node.js support is needed).
2. Set a Node.js interpreter of version 22 or newer under Settings, Languages and Frameworks, Node.js. There is nothing to install: the project has no dependencies.
3. The shared run configuration in `.idea/runConfigurations/` is picked up when the project opens.

## 2. Run the tests from the IDE

`.idea/runConfigurations/SpikeSight_Tests.xml` defines one npm run configuration named **SpikeSight Tests (node --test tests/*.test.mjs)**. It runs the `test` script of `package.json`, which is:

```bash
node --test tests/*.test.mjs
```

Select the configuration in the run widget and press Run. The suite needs no network and no browser.

| File | What it guards |
| --- | --- |
| `tests/spikesight.test.mjs` | Map coordinate normalisation, utility clustering and metrics, Operator sightline math, economy classification, Monte Carlo determinism and probability bounds, the map, overtime and credit rules, the side-aware save-versus-retake call, the GRID hydrator, the proxy host and path allowlist, key redaction, body limits, and the `/health` and `/api/scout-coach` responses with the coach's same-origin and rate limit guards. |
| `tests/dashboard.test.mjs` | The page has the ids the controller looks up, no inline script, style or handler, no HTML-parsing sink in the browser modules, and `app.js` boots and handles its buttons on a fake DOM, including hostile replay strings, replay navigation, flash cone geometry, zone label spacing and keyboard focus. |

## 3. Change code with JetBrains AI Assistant or Junie

The code is split so that an AI tool can change one module and the tests show at once whether the change is safe.

- `public/js/scout-engine.js`, `tactical-maps.js` and `pro-data.js` are pure: no DOM, no clock, no `Math.random`. Each metric has its formula in a comment above the function.
- `public/js/app.js` holds DOM code and view state only.
- `worker/index.js` holds the routes and imports the same pure modules.

A working loop:

1. Give the assistant one module and the formula comment of the function to change. Example prompt: "In `scout-engine.js`, add a `65-70s` bucket to `EXECUTE_BUCKETS` and keep the formula comment in step with the code."
2. Run the **SpikeSight Tests** configuration.
3. Use these tests as the guard for a change of that kind:
   - `simulateMap is deterministic for a seed and changes with the seed`, `every probability returned by simulateMap is in [0, 1] and the distribution is complete`, `map rules: first to 13 by two, sides swap at the half and in overtime, sudden death never ends level` and `credit rules: loss bonus steps, win and plant credits, the cap, carried gear and each buy policy`, for any change to the economy model.
   - `resolveGridTarget refuses hostile and malformed targets` and `POST /api/grid/query refuses a target off the allowlist without any outbound fetch`, for any change to the Worker.
   - `browser modules use no HTML-parsing sink, no eval and no storage` and `hostile team and player names from a replay only ever reach the page as text`, for any change to `app.js`.
4. Review the diff in the IDE before accepting it. A change that edits a test expectation and the code in the same step deserves a second look.

## 4. Qodana

`qodana.yaml`:

```yaml
version: "1.0"
linter: jetbrains/qodana-js:2025.2
profile:
  name: qodana.recommended
exclude:
  - name: All
    paths:
      - .wrangler
      - node_modules
```

Run it locally with the Qodana CLI from the project root:

```bash
qodana scan
```

or with the container:

```bash
docker run --rm -v "$(pwd)":/data/project/ -e QODANA_TOKEN jetbrains/qodana-js:2025.2
```

The linter needs a `QODANA_TOKEN`. Supply it through the environment or a CI secret and never commit it. In CI, run the same container as a pipeline step with the token stored as a secret.

Inspections that matter for this code:

- **Unused exports and unused local symbols.** The pure modules export many functions; an export that neither `app.js`, the Worker nor a test imports is dead code.
- **Unsafe DOM sinks.** `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` must not appear in `public/js`. A test enforces this as well.
- **Unhandled promise rejections.** Every `fetch` in `app.js` and in the Worker is inside `try` and `catch`; a promise without a handler is a defect here.
- **Unresolved imports.** The Worker imports from `../public/js/`, so a renamed export breaks both sides.

## 5. What was executed, and what was not

Executed on the headless build host (Linux, Node v24.22.3, Wrangler 4.168.0) on 2026-11-27:

- `node --test tests/*.test.mjs`: 91 tests, 91 passed, 0 failed (69 in `tests/spikesight.test.mjs`, 22 in `tests/dashboard.test.mjs`).
- `npx --no-install wrangler deploy`: bundled the Worker (Total Upload 116.57 KiB, gzip 31.13 KiB) and deployed it to [spikesight-c9.bedir-ai.workers.dev](https://spikesight-c9.bedir-ai.workers.dev).
- `.idea/runConfigurations/SpikeSight_Tests.xml` was checked to be well-formed XML.

Not executed, because the build host has no JetBrains IDE and no Qodana licence token:

- The run configuration was not started from an IDE.
- No Qodana scan was run. There is no Qodana report, score or baseline for this project yet.
- Sections 1 to 4 are a procedure for a JetBrains IDE. This file contains no IDE output, no screenshots and no AI session transcripts.

## Disclaimer

SpikeSight C9 is an independent open-source analytics tool. It is not affiliated with or endorsed by Riot Games, and VALORANT is a trademark of Riot Games, Inc. It is also not an official product of Cloud9, GRID or JetBrains. Its roster datasets are modelled scenario data shaped like GRID Series State, not official match statistics.
