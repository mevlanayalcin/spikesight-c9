// SpikeSight C9 - dashboard tests: static checks on public/ and a boot smoke test of
// public/js/app.js against the hand-written DOM in tests/helpers/fake-dom.mjs.
// Run with: node --test tests/*.test.mjs   (no packages, no network, no browser)

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { MAP_IDS, MAPS } from "../public/js/tactical-maps.js";
import { SAMPLE_GRID_SERIES, TEAMS, getTeamRounds } from "../public/js/pro-data.js";
import {
  buildDeterministicCoachAnswer, buildScoutSummary, evaluateForceBuy, evaluateSaveVsRetake, filterUtility, generateDossier, hydrateGridSeries,
  simulateMap,
} from "../public/js/scout-engine.js";
import { installFakeDom, parseHtml } from "./helpers/fake-dom.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const HTML = read("../public/index.html");
const APP = read("../public/js/app.js");
const CSS = read("../public/styles.css");
const HOSTILE = "<img src=x onerror=alert(1)>";

// ---------------------------------------------------------------------------
// Boot the dashboard once for this file. Network access is refused unless a test
// installs its own fetch.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const refuseNetwork = async () => {
  throw new Error("network access is not allowed in tests");
};
globalThis.fetch = refuseNetwork;
const dom = installFakeDom(HTML);
let bootError = null;
try {
  await import("../public/js/app.js");
} catch (err) {
  bootError = err;
}
test.after(() => {
  globalThis.fetch = realFetch;
  dom.restore();
});

const $ = (selector) => dom.document.querySelector(selector);
const $$ = (selector) => dom.document.querySelectorAll(selector);
const click = (selector) => $(selector).dispatch("click");
const mapNodes = (className) => $("#tactical-map").descendants().filter((node) => node.classList.contains(className));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const near = (actual, expected, tolerance, label = "") => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} +/- ${tolerance}, got ${actual}`);
};
const pct1 = (value) => `${(value * 100).toFixed(1)}%`;

/** Replace fetch for one test. Returns the recorded calls. */
function fakeFetch(t, respond) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  t.after(() => {
    globalThis.fetch = refuseNetwork;
  });
  return calls;
}

async function setChecked(selector, checked) {
  $(selector).checked = checked;
  await $(selector).dispatch("change");
}

/** Back to the default view: Fnatic scouted for Cloud9 on Ascent, modelled dataset, every filter open. */
async function resetView() {
  $("#team-select").value = "FNC";
  await $("#team-select").dispatch("change");
  $("#our-team-select").value = "C9";
  await $("#our-team-select").dispatch("change");
  await click('button.map-tab[data-map="ascent"]');
  await click('button.side-btn[data-side="both"]');
  await click('button.phase-btn[data-phase="all"]');
  for (const id of ["#toggle-smoke", "#toggle-flash", "#toggle-recon", "#toggle-molly", "#toggle-heat", "#toggle-operator", "#toggle-counters"]) {
    await setChecked(id, true);
  }
  $("#coach-input").value = "";
}

const AUTOMATION_IDS = [
  "team-select", "our-team-select", "tactical-map", "toggle-smoke", "toggle-flash", "toggle-recon", "toggle-molly",
  "toggle-heat", "toggle-operator", "toggle-counters", "kpi-efficiency", "kpi-flash-assist", "kpi-site-bias", "timing-chart",
  "panel-operator", "panel-economy", "panel-coach", "panel-dossier", "panel-grid", "operator-spots", "antiop-list",
  "eco-our-score", "eco-their-score", "eco-our-credits", "eco-their-credits", "eco-side", "eco-seed", "sim-results", "sim-chart",
  "coach-input", "coach-output", "coach-source", "dossier-markdown", "copy-dossier-btn", "dossier-status", "grid-status",
  "grid-endpoint", "grid-api-key", "grid-query", "grid-query-btn", "grid-output", "grid-json-input", "grid-import-btn",
  "load-grid-btn", "dossier-btn", "run-sim-btn", "ask-coach-btn",
];

// ===========================================================================
// (a) Static checks
// ===========================================================================

test("every element and selector app.js looks up exists in index.html", () => {
  const page = parseHtml(HTML);
  const lookedUp = [...APP.matchAll(/"#([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  assert.ok(lookedUp.length >= 60, `expected the controller to look up at least 60 ids, found ${lookedUp.length}`);
  for (const id of lookedUp) assert.ok(page.getElementById(id), `index.html has no element with id "${id}"`);

  const groups = [...APP.matchAll(/"(button\.[a-z][a-z-]*)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(groups, ["button.coach-chip", "button.map-tab", "button.panel-tab", "button.phase-btn", "button.side-btn"]);
  for (const selector of groups) assert.ok(page.querySelectorAll(selector).length > 0, `no element matches ${selector}`);

  // The data-* values the controller switches on are the ones the page carries.
  const dataValues = (selector, key) => page.querySelectorAll(selector).map((node) => node.dataset[key]);
  assert.deepEqual(dataValues("button.map-tab", "map"), MAP_IDS);
  assert.deepEqual(dataValues("button.side-btn", "side"), JSON.parse(/const SIDE_IDS = (\[[^\]]*\]);/.exec(APP)[1]));
  assert.deepEqual(dataValues("button.side-btn", "side"), ["both", "attack", "defense"]);
  assert.deepEqual(dataValues("button.phase-btn", "phase"), ["all", "default", "execute", "postplant"]);
  const panelKeys = [...(/const PANELS = \{([^}]*)\}/.exec(APP)[1]).matchAll(/([a-z]+): "#panel-([a-z]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(panelKeys.map(([key]) => key), ["operator", "economy", "coach", "dossier", "grid"]);
  for (const [key, id] of panelKeys) assert.equal(key, id);
  assert.deepEqual(dataValues("button.panel-tab", "panel"), panelKeys.map(([key]) => key));
  for (const chip of page.querySelectorAll("button.coach-chip")) assert.ok(chip.dataset.question.length > 10);

  // The ids promised to the visual QA script are in the page and wired in the controller.
  for (const id of AUTOMATION_IDS) {
    assert.ok(page.getElementById(id), `automation id #${id} is missing from index.html`);
    assert.ok(lookedUp.includes(id), `automation id #${id} is not used by app.js`);
  }
});

test("index.html carries the exact action buttons, toggles, filters and map tabs", () => {
  const page = parseHtml(HTML);
  const label = (selector) => page.querySelector(selector).textContent.trim();
  assert.equal(label("#load-grid-btn"), "Load GRID Replay (C9 vs FNC)");
  assert.equal(label("#dossier-btn"), "Generate Anti-Strat Dossier");
  assert.equal(label("#run-sim-btn"), "Run 1,000-Trial Economy Sim");
  assert.equal(label("#ask-coach-btn"), "Ask Tactical AI Coach");
  for (const id of ["load-grid-btn", "dossier-btn", "run-sim-btn", "ask-coach-btn"]) {
    assert.equal(page.getElementById(id).localName, "button");
    assert.equal(page.getElementById(id).getAttribute("type"), "button");
  }

  assert.equal(label('label[for="toggle-smoke"]'), "Smokes");
  assert.equal(label('label[for="toggle-flash"]'), "Flashes");
  assert.equal(label('label[for="toggle-recon"]'), "Recon/Info");
  assert.equal(label('label[for="toggle-molly"]'), "Mollies/Post-Plant");
  for (const id of ["toggle-smoke", "toggle-flash", "toggle-recon", "toggle-molly", "toggle-heat", "toggle-operator", "toggle-counters"]) {
    assert.equal(page.getElementById(id).getAttribute("type"), "checkbox");
    assert.equal(page.getElementById(id).checked, true, `#${id} starts checked`);
  }
  const labels = (selector) => page.querySelectorAll(selector).map((node) => node.textContent.trim());
  assert.deepEqual(labels("button.side-btn"), ["Both", "Attack", "Defense"]);
  assert.deepEqual(labels("button.phase-btn"), ["All", "0–30s Default", "30–65s Execute", "Post-Plant"]);
  assert.deepEqual(labels("button.map-tab"), ["Ascent", "Haven", "Bind", "Lotus"]);
  assert.deepEqual(labels("button.panel-tab"), ["Operator Profiler", "Economy & Win Probability", "AI Coach", "Anti-Strat Dossier", "GRID Live"]);

  const svg = page.getElementById("tactical-map");
  assert.equal(svg.localName, "svg");
  assert.equal(svg.getAttribute("viewBox"), "0 0 1000 1000");
  assert.equal(page.getElementById("dossier-markdown").localName, "pre");
  const key = page.getElementById("grid-api-key");
  assert.equal(key.getAttribute("type"), "password");
  assert.equal(key.getAttribute("autocomplete"), "off");
  assert.equal(key.getAttribute("value"), null);

  assert.equal(label("h1"), "SpikeSight C9");
  assert.ok(page.querySelector("header").textContent.includes("CLOUD9 x JETBRAINS · SKY'S THE LIMIT 2026"));
  assert.match(page.querySelector("h2").textContent, /Layer 1 · Utility Placement & Ability Analysis/);
  const footer = page.querySelector("footer").textContent;
  assert.match(footer, /not affiliated with or endorsed by Riot Games/);
  assert.match(footer, /modelled scenario data shaped like GRID Series State, not official match statistics/);
});

test("index.html has no inline script, inline style or inline event handler", () => {
  const page = parseHtml(HTML);
  const scripts = page.querySelectorAll("script");
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].getAttribute("type"), "module");
  assert.equal(scripts[0].getAttribute("src"), "./js/app.js");
  assert.equal(scripts[0].textContent.trim(), "");
  assert.equal(page.querySelectorAll("style").length, 0);
  const sheets = page.querySelectorAll("link").filter((node) => node.getAttribute("rel") === "stylesheet");
  assert.deepEqual(sheets.map((node) => node.getAttribute("href")), ["./styles.css"]);

  for (const node of page.root.descendants()) {
    for (const [name, value] of node.attributes) {
      assert.notEqual(name.toLowerCase(), "style", `<${node.localName}> has a style attribute`);
      assert.doesNotMatch(name, /^on/i, `<${node.localName}> has the handler attribute ${name}`);
      if (name === "src" || name === "href") assert.match(value, /^\.\/[\w./-]+$/, `${name}="${value}" must be a relative same-origin path`);
      assert.doesNotMatch(value, /javascript:/i);
    }
  }
  assert.doesNotMatch(HTML, /\sstyle\s*=/i);
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
});

test("browser modules use no HTML-parsing sink, no eval and no storage", () => {
  const banned = [
    /\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write(ln)?\b/, /\beval\s*\(/, /\bnew\s+Function\b/,
    /setAttribute\(\s*["'`]style["'`]/, /\bcssText\b/, /\bsrcdoc\b/, /\bDOMParser\b/, /createContextualFragment/,
  ];
  for (const file of ["app.js", "tactical-maps.js", "pro-data.js", "scout-engine.js"]) {
    const source = read(`../public/js/${file}`);
    for (const pattern of banned) assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`);
  }
  // The GRID key and everything else stay in memory: nothing is persisted or logged.
  for (const pattern of [/\blocalStorage\b/, /\bsessionStorage\b/, /\bdocument\.cookie\b/, /\bindexedDB\b/, /\bconsole\./, /\blocation\.(href|search|hash)\b/]) {
    assert.doesNotMatch(APP, pattern, `app.js matches ${pattern}`);
  }
  // The key is read once, into the x-api-key request header, and never into the JSON body.
  assert.equal([...APP.matchAll(/gridApiKey\.value/g)].length, 1);
  assert.match(APP, /headers\["x-api-key"\] = key;/);
});

test("no file under public/ loads anything from another origin", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else files.push(`${dir}${entry.name}`);
    }
  };
  walk("../public/");
  assert.deepEqual(files.map((f) => f.replace("../public/", "")).sort(), [
    "favicon.svg", "index.html", "js/app.js", "js/pro-data.js", "js/scout-engine.js", "js/tactical-maps.js", "styles.css",
  ]);
  const xmlNamespace = "http://www.w3.org/2000/svg"; // an identifier, never fetched
  for (const file of files) {
    const lines = read(file).split("\n");
    lines.forEach((line, index) => {
      for (const [url] of line.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
        const inComment = /^\s*(\/\/|\/\*|\*)/.test(line);
        assert.ok(url === xmlNamespace || inComment, `${file}:${index + 1} references ${url}`);
      }
      assert.doesNotMatch(line, /(src|href)\s*=\s*["']\/\//i, `${file}:${index + 1} has a protocol-relative URL`);
    });
  }
  const css = read("../public/styles.css");
  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /url\s*\(/i);
});

// ===========================================================================
// (b) Boot smoke test and the four action buttons
// ===========================================================================

test("the dashboard boots against the fake DOM and draws the default view", () => {
  assert.equal(bootError, null, bootError ? bootError.stack : "");
  assert.ok(dom.window.__spikesight, "the app instance is attached to window.__spikesight");
  const summary = buildScoutSummary({ teamId: "FNC", mapId: "ascent" });

  assert.equal($("#team-select").value, "FNC");
  assert.equal($("#our-team-select").value, "C9");
  assert.deepEqual($$("option").filter((o) => o.parentNode === $("#team-select")).map((o) => o.value), ["C9", "C9W", "SEN", "G2", "FNC", "PRX"]);
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");
  assert.match($("#grid-status").textContent, /^Modelled scenario dataset · Fnatic on Ascent · 24 rounds/);

  // Zones: one polygon per zone of the map, with the labels the task names.
  assert.equal(mapNodes("zone").length, MAPS.ascent.zones.length);
  assert.equal(mapNodes("zone-site").length, 2);
  assert.equal(mapNodes("zone-plant").length, 2);
  assert.equal(mapNodes("zone-mid").length, 1);
  assert.equal(mapNodes("zone-spawn-attack").length, 1);
  assert.equal(mapNodes("zone-spawn-defense").length, 1);
  assert.ok(mapNodes("zone-choke").length >= 3);
  const zoneLabels = mapNodes("zone-label").map((node) => node.textContent);
  for (const wanted of ["A SITE", "B SITE", "Mid", "Attacker Spawn", "Defender Spawn", "A Spike Plant", "B Spike Plant", "A Main"]) {
    assert.ok(zoneLabels.includes(wanted), `zone label ${wanted}`);
  }

  // Utility layer: every event of the dataset is drawn, each type with its own class.
  const events = filterUtility(getTeamRounds("FNC", "ascent"), { side: "both", phase: "all" });
  assert.equal(events.length, summary.utility.sampleSize.utilityEvents);
  assert.equal(mapNodes("util-smoke").length, summary.utility.typeCounts.smoke);
  assert.equal(mapNodes("util-flash").length, summary.utility.typeCounts.flash);
  assert.equal(mapNodes("util-molly").length, summary.utility.typeCounts.molly);
  assert.equal(mapNodes("util-recon-group").length, summary.utility.typeCounts.recon);
  assert.match($("#events-shown").textContent, new RegExp(`^${events.length} utility events on the map`));
  assert.ok(mapNodes("heat").length > 0, "density clusters are drawn");
  assert.equal(mapNodes("op-group").length, summary.operator.spots.length);
  assert.equal(mapNodes("op-cone").length, summary.operator.spots.length);
  assert.equal(mapNodes("counter-group").length, summary.antiOp.length);
  assert.ok($("#tactical-map").descendants().some((node) => node.localName === "filter" && node.id === "ss-glow"));

  // KPIs come straight from the engine.
  assert.equal($("#kpi-efficiency").textContent, summary.utility.utilityEfficiencyScore.toFixed(1));
  assert.equal($("#kpi-flash-assist").textContent, `${(summary.utility.flashAssistRate * 100).toFixed(1)}%`);
  assert.equal($("#kpi-site-bias").textContent, "Attack: sites hitA Site50%B Site50%Defense: sites stackedA Site58%B Site42%");
  assert.equal($("#timing-chart").descendants().filter((node) => node.classList.contains("bar")).length, 8);
  assert.match($("#timing-chart").textContent, /median 51\.2s/);

  const rows = $("#operator-spots").children;
  assert.equal(rows.length, summary.operator.spots.length);
  assert.ok(rows[0].textContent.startsWith(`${summary.operator.primarySpot.callout}${summary.operator.primarySpot.player}`));
  assert.equal($("#antiop-list").children.length, summary.antiOp.length);
  assert.ok($("#antiop-list").textContent.includes(summary.antiOp[0].text));
  assert.equal($("#economy-states").children.length, 4);
  assert.match($("#economy-states").textContent, /Pistol.*Eco.*Half-Buy \/ Bonus.*Full Buy/);

  assert.equal($("#panel-operator").hidden, false);
  for (const id of ["economy", "coach", "dossier", "grid"]) assert.equal($(`#panel-${id}`).hidden, true);
});

test("Run 1,000-Trial Economy Sim shows the engine's numbers and is reproducible from the seed", async () => {
  await resetView();
  const strengthEdge = Math.round((TEAMS.C9.style.strengthEdge - TEAMS.FNC.style.strengthEdge) * 10000) / 10000;
  const params = { ourScore: 6, theirScore: 8, ourCredits: 9000, theirCredits: 26000, ourSide: "defense", mapId: "ascent", strengthEdge, trials: 1000, seed: 1337 };
  const expected = simulateMap(params);
  const force = evaluateForceBuy(params);

  assert.match($("#sim-results").textContent, /^Press Run 1,000-Trial Economy Sim/);
  await click("#run-sim-btn");
  const first = $("#sim-results").textContent;
  assert.equal($("#panel-economy").hidden, false);
  assert.equal($("#panel-operator").hidden, true);
  assert.ok(first.includes(`Map win probability${(expected.mapWinProb * 100).toFixed(1)}%`), first);
  assert.ok(first.includes(`standard error ${(expected.standardError * 100).toFixed(1)} pts`));
  assert.ok(first.includes(`95% interval ${(expected.ci95[0] * 100).toFixed(1)}% to ${(expected.ci95[1] * 100).toFixed(1)}%`));
  assert.ok(first.includes(`Half win probability${(expected.halfWinProb * 100).toFixed(1)}%`));
  assert.ok(first.includes(`Comeback probability${(expected.comebackProb * 100).toFixed(1)}%`));
  assert.ok(first.includes(`Force-buy EV${force.recommendation} `));
  assert.match(first, /Save vs retake(RETAKE|SAVE)/);
  assert.match(first, /1,000 trials, seed 1337/);
  assert.equal($("#eco-seed").value, "1337");
  const bars = $("#sim-chart").descendants().filter((node) => node.classList.contains("bar"));
  assert.equal(bars.length, Math.min(12, expected.scoreDistribution.length));

  // Another seed gives another sample path, and the seed field shows the seed that was used.
  $("#eco-seed").value = "7";
  await $("#eco-seed").dispatch("change");
  assert.match($("#sim-results").textContent, /^Inputs changed/);
  await click("#run-sim-btn");
  const second = $("#sim-results").textContent;
  assert.notEqual(second, first);
  assert.ok(second.includes(`Map win probability${(simulateMap({ ...params, seed: 7 }).mapWinProb * 100).toFixed(1)}%`));
  assert.equal($("#eco-seed").value, "7");

  // Back to the first seed: identical text.
  $("#eco-seed").value = "1337";
  await click("#run-sim-btn");
  assert.equal($("#sim-results").textContent, first);

  // Out-of-range input is clamped and written back, and a decided map is reported, not simulated.
  $("#eco-our-score").value = "13";
  $("#eco-their-score").value = "-4";
  await click("#run-sim-btn");
  assert.equal($("#eco-their-score").value, "0");
  assert.match($("#sim-results").textContent, /Map win probability100\.0%/);
  assert.match($("#sim-results").textContent, /already decided at 13-0/);
  $("#eco-our-score").value = "6";
  $("#eco-their-score").value = "8";
});

test("Generate Anti-Strat Dossier fills the Markdown preview and copies it", async () => {
  await resetView();
  const expected = generateDossier(buildScoutSummary({ teamId: "FNC", mapId: "ascent" }), { ourTeamId: "C9" });
  dom.clipboard.writes.length = 0;
  await click("#dossier-btn");
  assert.equal($("#panel-dossier").hidden, false);
  const markdown = $("#dossier-markdown").textContent;
  assert.equal(markdown, expected.markdown);
  for (const heading of ["## Operator Tendencies", "## Execute Timings", "## Pistol Round Tendencies", "## Site Win Rates", "## Anti-Strat Game Plan"]) {
    assert.ok(markdown.includes(heading), heading);
  }
  assert.equal($("#dossier-kpis").children.length, expected.kpis.length);
  assert.deepEqual(dom.clipboard.writes, [expected.markdown]);
  assert.equal($("#dossier-status").textContent, "Copied to clipboard");

  // The dossier follows the view once it is open.
  await click('button.map-tab[data-map="haven"]');
  const haven = generateDossier(buildScoutSummary({ teamId: "FNC", mapId: "haven" }), { ourTeamId: "C9" }).markdown;
  assert.equal($("#dossier-markdown").textContent, haven);
  await click("#copy-dossier-btn");
  assert.deepEqual(dom.clipboard.writes, [expected.markdown, haven]);

  // Without a clipboard the text stays selectable and the status says so.
  const clipboard = dom.navigator.clipboard;
  dom.navigator.clipboard = undefined;
  try {
    await click("#dossier-btn");
    assert.equal($("#dossier-status").textContent, "Clipboard unavailable, select the text below");
    dom.navigator.clipboard = { writeText: async () => { throw new Error("denied"); } };
    await click("#copy-dossier-btn");
    assert.equal($("#dossier-status").textContent, "Clipboard unavailable, select the text below");
  } finally {
    dom.navigator.clipboard = clipboard;
  }
  assert.equal($("#dossier-markdown").textContent, haven);
});

test("Load GRID Replay (C9 vs FNC) hydrates the sample and switches the dashboard to it", async (t) => {
  await resetView();
  await click('button.map-tab[data-map="lotus"]');
  const calls = fakeFetch(t, () => json(SAMPLE_GRID_SERIES));
  await click("#load-grid-btn");
  assert.deepEqual(calls.map((c) => c.url), ["/api/grid/sample-series"]);

  const hydrated = hydrateGridSeries(SAMPLE_GRID_SERIES);
  const replay = buildScoutSummary({ teamId: "FNC", mapId: "ascent", rounds: hydrated.roundsByTeam.FNC, source: { kind: "grid-replay", seriesId: hydrated.seriesId } });
  const status = $("#grid-status").textContent;
  assert.equal(status, "GRID replay spikesight-sample-c9-fnc-ascent · Cloud9 13–10 Fnatic · 23 rounds · Ascent · scouting Fnatic");
  assert.match(status, /13/);
  assert.match(status, /10/);
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  assert.equal($("#team-select").value, "FNC");
  assert.equal($("#our-team-select").value, "C9");
  assert.equal($('button.map-tab[data-map="ascent"]').classList.contains("active"), true);
  assert.equal($('button.map-tab[data-map="lotus"]').classList.contains("active"), false);

  // The numbers on screen are the replay's, not the modelled dataset's.
  assert.equal($("#kpi-efficiency").textContent, replay.utility.utilityEfficiencyScore.toFixed(1));
  assert.match($("#kpi-sample").textContent, /^Sample: 23 rounds/);
  assert.equal($("#operator-spots").children.length, replay.operator.spots.length);
  assert.equal(mapNodes("util-smoke").length, replay.utility.typeCounts.smoke);

  // A failed request falls back to the bundled copy and says so.
  await resetView();
  globalThis.fetch = async () => { throw new Error("offline"); };
  await click("#load-grid-btn");
  assert.match($("#grid-status").textContent, /Cloud9 13–10 Fnatic · 23 rounds/);
  assert.match($("#grid-status").textContent, /the live sample request failed \(offline\), so the bundled copy was used/);
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  // So does a 500 and a body that is not a series.
  await resetView();
  globalThis.fetch = async () => new Response("oops", { status: 500 });
  await click("#load-grid-btn");
  assert.match($("#grid-status").textContent, /live sample request failed \(HTTP 500\), so the bundled copy was used/);
  await resetView();
  globalThis.fetch = async () => json({ data: { seriesState: null } });
  await click("#load-grid-btn");
  assert.match($("#grid-status").textContent, /could not be hydrated, so the bundled copy was used/);

  // Changing the map, or picking a team that did not play in the replay, returns to the modelled dataset.
  await click('button.map-tab[data-map="haven"]');
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");
  assert.match($("#grid-status").textContent, /^Modelled scenario dataset · Fnatic on Haven · 24 rounds/);
  globalThis.fetch = async () => json(SAMPLE_GRID_SERIES);
  await click("#load-grid-btn");
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  $("#team-select").value = "SEN";
  await $("#team-select").dispatch("change");
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");
  assert.match($("#grid-status").textContent, /^Modelled scenario dataset · Sentinels on Ascent · 24 rounds/);
});

test("Ask Tactical AI Coach posts the on-screen context and shows the answer and its source", async (t) => {
  await resetView();
  const replies = [];
  const calls = fakeFetch(t, (url) => {
    if (url === "/api/grid/sample-series") return json(SAMPLE_GRID_SERIES);
    return replies.shift()();
  });
  const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  // Workers AI answer on the modelled dataset; an empty question gets a default.
  replies.push(() => json({ ok: true, source: "workers-ai", model, answer: "- Smoke A Main.\n- Trade the re-peek.", grounding: { dataset: "modelled scenario dataset" } }));
  await click("#ask-coach-btn");
  assert.equal($("#panel-coach").hidden, false);
  assert.equal($("#coach-output").textContent, "- Smoke A Main.\n- Trade the re-peek.");
  assert.match($("#coach-source").textContent, /^Workers AI · @cf\/meta\/llama-3\.3-70b-instruct-fp8-fast · grounded on modelled scenario dataset$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/scout-coach");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent).sort(), ["context", "mapId", "question", "teamId"]);
  assert.equal(sent.question, "What is the anti-strat game plan against Fnatic on Ascent?");
  assert.equal($("#coach-input").value, sent.question);
  assert.deepEqual([sent.teamId, sent.mapId, sent.context.ourTeam, sent.context.dataSource], ["FNC", "ascent", "Cloud9", "modelled dataset"]);
  assert.equal($("#ask-coach-btn").disabled, false);

  // Deterministic answer from the server, with its warning.
  replies.push(() => json({ ok: true, source: "deterministic-coach", model: "deterministic-rules", answer: "- Operator: A Rafters.", grounding: { dataset: "modelled scenario dataset" }, warning: "Workers AI unavailable (quota); the deterministic coach answered." }));
  $("#coach-input").value = "  How do we beat the Fnatic Operator on Ascent defense?  ";
  await click("#ask-coach-btn");
  assert.equal($("#coach-output").textContent, "- Operator: A Rafters.");
  assert.match($("#coach-source").textContent, /^Deterministic coach · deterministic-rules · grounded on modelled scenario dataset · Workers AI unavailable \(quota\)/);
  assert.equal(JSON.parse(calls[1].init.body).question, "How do we beat the Fnatic Operator on Ascent defense?");

  // A coach chip fills the question and asks.
  replies.push(() => json({ ok: true, source: "workers-ai", model, answer: "- Chip answer." }));
  const chip = $$("button.coach-chip")[2];
  await chip.dispatch("click");
  assert.equal(JSON.parse(calls[2].init.body).question, chip.dataset.question);
  assert.equal($("#coach-output").textContent, "- Chip answer.");

  // A rejected request, an HTTP error and an empty answer all fall back to the browser coach.
  const question = "When do they execute?";
  const local = buildDeterministicCoachAnswer(buildScoutSummary({ teamId: "FNC", mapId: "ascent" }), question);
  for (const failing of [
    () => { throw new Error("offline"); },
    () => new Response("upstream exploded", { status: 502 }),
    () => json({ ok: true, source: "workers-ai", answer: "   " }),
    () => json({ error: "boom" }, 500),
  ]) {
    replies.push(failing);
    $("#coach-input").value = question;
    $("#coach-output").textContent = "stale";
    await click("#ask-coach-btn");
    assert.equal($("#coach-output").textContent, local);
    assert.match($("#coach-source").textContent, /^Deterministic coach \(in browser\): the coach request failed/);
    assert.equal($("#ask-coach-btn").disabled, false);
  }

  // After the replay button the request names the server-side sample, so the grounding matches the screen.
  await click("#load-grid-btn");
  replies.push(() => json({ ok: true, source: "deterministic-coach", model: "deterministic-rules", answer: "- Replay answer.", grounding: { dataset: "hydrated GRID replay spikesight-sample-c9-fnc-ascent" } }));
  $("#coach-input").value = question;
  await click("#ask-coach-btn");
  const replaySent = JSON.parse(calls[calls.length - 1].init.body);
  assert.equal(replaySent.dataSource, "grid-sample");
  assert.deepEqual([replaySent.teamId, replaySent.mapId], ["FNC", "ascent"]);
  assert.equal(replaySent.context.dataSource, "GRID replay spikesight-sample-c9-fnc-ascent");
  assert.match($("#coach-source").textContent, /grounded on hydrated GRID replay spikesight-sample-c9-fnc-ascent/);

  // Back on the modelled dataset the field is gone again.
  await click('button.map-tab[data-map="bind"]');
  replies.push(() => json({ ok: true, source: "workers-ai", model, answer: "- Bind." }));
  await click("#ask-coach-btn");
  const bindSent = JSON.parse(calls[calls.length - 1].init.body);
  assert.equal(Object.hasOwn(bindSent, "dataSource"), false);
  assert.equal(bindSent.mapId, "bind");
});

test("an imported replay is scouted and coached in the browser without calling the server", async (t) => {
  await resetView();
  const calls = fakeFetch(t, () => { throw new Error("the server must not be called for an imported replay"); });

  // Bad input is reported and changes nothing.
  $("#grid-json-input").value = "";
  await click("#grid-import-btn");
  assert.match($("#grid-status").textContent, /^Import failed: paste a GRID Series State JSON document first/);
  $("#grid-json-input").value = "{ not json";
  await click("#grid-import-btn");
  assert.match($("#grid-status").textContent, /^Import failed: the text is not valid JSON/);
  $("#grid-json-input").value = JSON.stringify({ data: { seriesState: { id: "x", games: [] } } });
  await click("#grid-import-btn");
  assert.match($("#grid-status").textContent, /^GRID replay rejected: /);
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");

  // The fill button supplies the bundled document; change its id and drop the last three rounds.
  await click("#grid-fill-sample-btn");
  const custom = JSON.parse($("#grid-json-input").value);
  assert.deepEqual(custom, JSON.parse(JSON.stringify(SAMPLE_GRID_SERIES)));
  custom.data.seriesState.id = "custom-scrim-42";
  custom.data.seriesState.games[0].segments.length = 20;
  $("#grid-json-input").value = JSON.stringify(custom);
  await click("#grid-import-btn");
  const hydrated = hydrateGridSeries(custom);
  assert.equal(hydrated.roundCount, 20);
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  assert.match($("#grid-status").textContent, /^GRID replay custom-scrim-42 · Cloud9 \d+–\d+ Fnatic · 20 rounds · Ascent/);
  assert.match($("#grid-status").textContent, /imported in this browser; the coach answers locally/);
  assert.match($("#kpi-sample").textContent, /^Sample: 20 rounds/);

  const summary = buildScoutSummary({ teamId: "FNC", mapId: "ascent", rounds: hydrated.roundsByTeam.FNC, teamName: "Fnatic", source: { kind: "grid-replay", seriesId: "custom-scrim-42" } });
  const question = "How do we beat their Operator?";
  $("#coach-input").value = question;
  await click("#ask-coach-btn");
  assert.equal(calls.length, 0);
  assert.equal($("#coach-source").textContent, "Deterministic coach (imported replay, in browser)");
  assert.equal($("#coach-output").textContent, buildDeterministicCoachAnswer(summary, question));

  await click("#dossier-btn");
  assert.match($("#dossier-markdown").textContent, /Data source: hydrated GRID replay custom-scrim-42/);
});

test("map tabs, utility toggles, side and phase filters and layer switches redraw the map", async () => {
  await resetView();
  for (const mapId of MAP_IDS) {
    await click(`button.map-tab[data-map="${mapId}"]`);
    const map = MAPS[mapId];
    const summary = buildScoutSummary({ teamId: "FNC", mapId });
    assert.equal(mapNodes("zone").length, map.zones.length, mapId);
    assert.equal(mapNodes("zone-site").length, map.sites.length, mapId);
    assert.equal(mapNodes("zone-plant").length, map.sites.length, mapId);
    assert.equal(mapNodes("zone-mid").length, mapId === "bind" ? 0 : 1, mapId);
    assert.equal(mapNodes("zone-teleporter").length, mapId === "bind" ? 2 : 0, mapId);
    const labels = mapNodes("zone-label").map((node) => node.textContent);
    assert.equal(labels.includes("C SITE"), map.sites.includes("C"), mapId);
    assert.equal($("#kpi-efficiency").textContent, summary.utility.utilityEfficiencyScore.toFixed(1), mapId);
    assert.equal($$("button.map-tab").filter((b) => b.classList.contains("active")).map((b) => b.dataset.map).join(), mapId);
    assert.equal($("#kpi-site-bias").textContent.includes("C Site"), map.sites.includes("C"), mapId);
  }

  await click('button.map-tab[data-map="ascent"]');
  const rounds = getTeamRounds("FNC", "ascent");
  const shown = () => Number.parseInt($("#events-shown").textContent, 10);

  // Utility type toggles.
  for (const type of ["smoke", "flash", "recon", "molly"]) {
    await setChecked(`#toggle-${type}`, false);
    const cls = type === "recon" ? "util-recon-group" : `util-${type}`;
    assert.equal(mapNodes(cls).length, 0, `${type} hidden`);
    const others = ["smoke", "flash", "recon", "molly"].filter((x) => x !== type);
    assert.equal(shown(), filterUtility(rounds, { types: others }).length);
    await setChecked(`#toggle-${type}`, true);
    assert.equal(mapNodes(cls).length, filterUtility(rounds, { types: [type] }).length, `${type} shown`);
  }
  for (const type of ["smoke", "flash", "recon", "molly"]) await setChecked(`#toggle-${type}`, false);
  assert.equal(shown(), 0);
  assert.equal(mapNodes("util").length, 0);
  assert.equal(mapNodes("heat").length, 0);
  for (const type of ["smoke", "flash", "recon", "molly"]) await setChecked(`#toggle-${type}`, true);

  // Side and phase filters, alone and combined.
  for (const side of ["attack", "defense", "both"]) {
    for (const phase of ["default", "execute", "postplant", "all"]) {
      await click(`button.side-btn[data-side="${side}"]`);
      await click(`button.phase-btn[data-phase="${phase}"]`);
      assert.equal(shown(), filterUtility(rounds, { side, phase }).length, `${side} ${phase}`);
      assert.equal($(`button.side-btn[data-side="${side}"]`).getAttribute("aria-pressed"), "true");
      assert.equal($$("button.phase-btn").filter((b) => b.classList.contains("active")).map((b) => b.dataset.phase).join(), phase);
    }
  }
  const summary = buildScoutSummary({ teamId: "FNC", mapId: "ascent" });
  await click('button.side-btn[data-side="defense"]');
  assert.equal(mapNodes("op-group").length, summary.operator.spots.filter((s) => s.side === "defense").length);
  assert.match($("#timing-note").textContent, /measured on attack rounds/);
  assert.match($("#kpi-sample").textContent, /^Sample: 12 rounds \(0 attack, 12 defense\)/);
  await click('button.side-btn[data-side="both"]');

  // Layer switches.
  await setChecked("#toggle-heat", false);
  assert.equal(mapNodes("heat").length, 0);
  await setChecked("#toggle-operator", false);
  assert.equal(mapNodes("op-group").length, 0);
  await setChecked("#toggle-counters", false);
  assert.equal(mapNodes("counter-group").length, 0);
  assert.ok(mapNodes("util").length > 0);

  // Selecting a hold spot row highlights it on the map and turns the Operator layer back on.
  const row = $("#operator-spots").children[1];
  await row.dispatch("click");
  assert.equal($("#toggle-operator").checked, true);
  const selected = mapNodes("op-group").filter((node) => node.classList.contains("selected"));
  assert.deepEqual(selected.map((node) => node.dataset.spot), [summary.operator.spots[1].callout]);
  assert.equal(mapNodes("op-group").filter((node) => node.classList.contains("dim")).length, summary.operator.spots.length - 1);
  assert.equal($("#operator-spots").children[1].classList.contains("selected"), true);
  await $("#operator-spots").children[1].dispatch("keydown", { key: "Enter" });
  assert.equal(mapNodes("op-group").filter((node) => node.classList.contains("selected")).length, 0);

  // Panel tabs.
  for (const id of ["economy", "coach", "dossier", "grid", "operator"]) {
    await click(`button.panel-tab[data-panel="${id}"]`);
    assert.deepEqual(["operator", "economy", "coach", "dossier", "grid"].filter((p) => !$(`#panel-${p}`).hidden), [id]);
    assert.equal($(`button.panel-tab[data-panel="${id}"]`).getAttribute("aria-selected"), "true");
  }
  await resetView();
});

test("the GRID Live form sends the key only in the x-api-key header and prints the reply as text", async (t) => {
  await resetView();
  const key = "browser-test-key-123";
  const calls = fakeFetch(t, () => json({ data: { allSeries: { totalCount: 1 } }, note: "<b>not markup</b>" }));
  $("#grid-api-key").value = `  ${key} `;
  $("#grid-endpoint").value = "series-state";
  await $("#grid-endpoint").dispatch("change");
  assert.match($("#grid-query").value, /seriesState\(id:/);
  await click("#grid-query-btn");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/grid/query");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], key);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["endpoint", "query"]);
  assert.equal(body.endpoint, "series-state");
  assert.equal(calls[0].init.body.includes(key), false);
  assert.equal(calls[0].url.includes(key), false);
  assert.match($("#grid-output").textContent, /^HTTP 200\n\{/);
  assert.ok($("#grid-output").textContent.includes("<b>not markup</b>"));
  assert.equal($("#grid-output").children.every((child) => child.isText), true);
  assert.equal($("#grid-output").textContent.includes(key), false);

  // No key: no header at all. A long reply is shortened and a failed request is reported.
  $("#grid-api-key").value = "";
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return json({ sample: "x".repeat(20000) }); };
  await click("#grid-query-btn");
  assert.equal(Object.hasOwn(calls[1].init.headers, "x-api-key"), false);
  assert.match($("#grid-output").textContent, /shortened for display\)$/);
  globalThis.fetch = async () => { throw new Error("offline"); };
  await click("#grid-query-btn");
  assert.equal($("#grid-output").textContent, "The GRID query request failed: offline");
  assert.equal($("#grid-query-btn").disabled, false);
});

// ===========================================================================
// (c) Hostile strings stay text
// ===========================================================================

test("hostile team and player names from a replay only ever reach the page as text", async () => {
  await resetView();
  const hostile = JSON.parse(
    JSON.stringify(SAMPLE_GRID_SERIES)
      .replaceAll("Cloud9", `Cloud9 ${HOSTILE}`)
      .replaceAll("Fnatic", `Fnatic ${HOSTILE}`)
      .replaceAll("FNC ", `${HOSTILE} `),
  );
  const before = dom.document.created.length;
  $("#grid-json-input").value = JSON.stringify(hostile);
  await click("#grid-import-btn");
  await click("#dossier-btn");
  $("#coach-input").value = "How do we beat their Operator?";
  await click("#ask-coach-btn");
  await click("#run-sim-btn");

  // The replay was accepted and the hostile names are on screen, as text.
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  assert.equal($("#team-select").value, "TEAM2");
  assert.equal($("#our-team-select").value, "TEAM1");
  for (const selector of ["#grid-status", "#team-select", "#our-team-select", "#operator-spots", "#antiop-list", "#tactical-map", "#dossier-markdown", "#coach-output", "#sim-results"]) {
    assert.ok($(selector).textContent.includes(HOSTILE), `${selector} shows the hostile string as text`);
  }

  // No element was ever made from it: nothing but the tags the controller builds itself.
  const made = dom.document.created.slice(before);
  assert.ok(made.length > 500);
  const tags = new Set(made.map((node) => node.localName));
  const allowed = new Set([
    "div", "span", "strong", "p", "li", "tr", "td", "option",
    "g", "defs", "filter", "feGaussianBlur", "feMerge", "feMergeNode", "rect", "line", "circle", "polygon", "text", "title",
  ]);
  for (const tag of tags) assert.ok(allowed.has(tag), `unexpected element <${tag}> was created`);
  assert.equal(tags.has("img"), false);
  assert.equal(tags.has("script"), false);
  for (const node of made) {
    for (const [name, value] of node.attributes) {
      assert.doesNotMatch(name, /^on/i);
      assert.notEqual(name, "style");
      assert.notEqual(name, "href");
      assert.notEqual(name, "src");
      if (name !== "data-spot") assert.equal(value.includes("onerror"), false, `${name} carries the hostile string`);
    }
  }
  assert.equal(dom.document.root.descendants().some((node) => node.localName === "img" && node.getAttribute("src") === "x"), false);
  await resetView();
});

test("a loaded replay is scouted for either of its teams and has three ways back to the modelled dataset", async (t) => {
  await resetView();
  const calls = fakeFetch(t, (url) => (url === "/api/grid/sample-series"
    ? json(SAMPLE_GRID_SERIES)
    : json({ ok: true, source: "deterministic-coach", model: "deterministic-rules", answer: "- Replay answer.", grounding: { dataset: "hydrated GRID replay spikesight-sample-c9-fnc-ascent" } })));
  const hydrated = hydrateGridSeries(SAMPLE_GRID_SERIES);
  const pick = async (teamId) => {
    $("#team-select").value = teamId;
    await $("#team-select").dispatch("change");
  };
  assert.equal($("#grid-unload-btn").disabled, true);
  await click("#load-grid-btn");
  assert.equal($("#grid-unload-btn").disabled, false);

  // Cloud9 played in the replay: picking it shows Cloud9's 23 replay rounds, not its modelled 24.
  await pick("C9");
  const replayC9 = buildScoutSummary({ teamId: "C9", mapId: "ascent", rounds: hydrated.roundsByTeam.C9, source: { kind: "grid-replay", seriesId: hydrated.seriesId } });
  const modelledC9 = buildScoutSummary({ teamId: "C9", mapId: "ascent" });
  assert.notEqual(replayC9.utility.sampleSize.utilityEvents, modelledC9.utility.sampleSize.utilityEvents);
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  assert.equal($("#grid-status").textContent, "GRID replay spikesight-sample-c9-fnc-ascent · Cloud9 13–10 Fnatic · 23 rounds · Ascent · scouting Cloud9");
  assert.match($("#kpi-sample").textContent, new RegExp(`^Sample: 23 rounds .*, ${replayC9.utility.sampleSize.utilityEvents} utility events`));
  assert.equal($("#kpi-efficiency").textContent, replayC9.utility.utilityEfficiencyScore.toFixed(1));
  assert.equal($("#operator-spots").children.length, Math.max(1, replayC9.operator.spots.length));
  assert.equal(mapNodes("util-smoke").length, replayC9.utility.typeCounts.smoke);
  // The coach is asked about the replay for that team too.
  $("#coach-input").value = "How do we beat their Operator?";
  await click("#ask-coach-btn");
  const sent = JSON.parse(calls.at(-1).init.body);
  assert.deepEqual([sent.teamId, sent.mapId, sent.dataSource], ["C9", "ascent", "grid-sample"]);
  // Back to Fnatic: still the replay.
  await pick("FNC");
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  assert.match($("#grid-status").textContent, /scouting Fnatic$/);

  // Way back 1: a roster that did not play in the replay.
  await pick("SEN");
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");
  assert.match($("#grid-status").textContent, /^Modelled scenario dataset · Sentinels on Ascent · 24 rounds/);
  assert.equal($("#grid-unload-btn").disabled, true);
  // Way back 2: any map tab, the active one included.
  await click("#load-grid-btn");
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  await click('button.map-tab[data-map="ascent"]');
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");
  assert.match($("#grid-status").textContent, /^Modelled scenario dataset · Fnatic on Ascent · 24 rounds/);
  // Way back 3: the button.
  await click("#load-grid-btn");
  await pick("C9");
  await click("#grid-unload-btn");
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");
  assert.match($("#grid-status").textContent, /^Modelled scenario dataset · Cloud9 on Ascent · 24 rounds/);
  assert.equal($("#grid-unload-btn").disabled, true);
  assert.match($("#kpi-sample").textContent, /^Sample: 24 rounds/);

  // Without a replay the active map tab and the button change nothing.
  const made = dom.document.created.length;
  await click('button.map-tab[data-map="ascent"]');
  await click("#grid-unload-btn");
  assert.equal(dom.document.created.length, made);
  await resetView();
});

test("a replay without team rounds is rejected and a team listed twice in a round is counted once", async () => {
  await resetView();
  const empty = JSON.parse(JSON.stringify(SAMPLE_GRID_SERIES));
  for (const segment of empty.data.seriesState.games[0].segments) segment.teams = [];
  assert.equal(hydrateGridSeries(empty).ok, true);                     // the hydrator accepts it, the dashboard must not
  $("#grid-json-input").value = JSON.stringify(empty);
  await click("#grid-import-btn");
  assert.equal($("#grid-status").textContent, "GRID replay rejected: it has no team with rounds.");
  assert.equal($("#data-pill").textContent, "MODELLED DATASET");
  assert.equal($("#team-select").value, "FNC");
  assert.match($("#kpi-sample").textContent, /^Sample: 24 rounds/);

  const twice = JSON.parse(JSON.stringify(SAMPLE_GRID_SERIES));
  const third = twice.data.seriesState.games[0].segments[2];
  third.teams.push(JSON.parse(JSON.stringify(third.teams[0])));
  $("#grid-json-input").value = JSON.stringify(twice);
  await click("#grid-import-btn");
  assert.equal($("#data-pill").textContent, "GRID REPLAY");
  assert.match($("#grid-status").textContent, /1 warning\(s\): Round 3: Cloud9 is listed twice; the later entry was skipped\./);
  $("#team-select").value = "C9";
  await $("#team-select").dispatch("change");
  assert.match($("#kpi-sample").textContent, /^Sample: 23 rounds/);
  await resetView();
});

test("the simulator names its baseline buy, reads the loss streaks and makes the attack-side call a hold", async () => {
  await resetView();
  const strengthEdge = Math.round((TEAMS.C9.style.strengthEdge - TEAMS.FNC.style.strengthEdge) * 10000) / 10000;
  const params = { ourScore: 6, theirScore: 8, ourCredits: 9000, theirCredits: 26000, ourSide: "defense", mapId: "ascent", strengthEdge, trials: 1000, seed: 1337 };
  const set = (selector, value) => { $(selector).value = String(value); };

  // 6-8 with a 9,000 bank and no streak stated: the trailing team lost the last round, so the
  // baseline is a save. The card says so, next to the force and save numbers it differs from.
  await click("#run-sim-btn");
  let shown = $("#sim-results").textContent;
  const baseline = simulateMap(params);
  const force = evaluateForceBuy(params);
  assert.ok(shown.includes(`Map win probability${pct1(baseline.mapWinProb)}baseline buy: save (light buy, at most 2,000) · standard error`), shown);
  assert.ok(shown.includes(`force (whole bank) ${pct1(force.forceWinProb)} vs save (at most 2,000) ${pct1(force.saveWinProb)} vs baseline ${pct1(baseline.mapWinProb)} map win probability`), shown);
  assert.ok(shown.includes("Loss streaks going in: Cloud9 1, Fnatic 0 (not stated, so derived:"), shown);
  assert.ok(shown.includes("Eco (2,000) against Full Buy"), shown);
  assert.ok(shown.includes("Retake 3v4: play-on EV"), shown);
  assert.deepEqual([$("#eco-our-streak").value, $("#eco-their-streak").value], ["0", "0"]);

  // Stating that Fnatic lost the last round makes Cloud9 its winner: a bonus buy and another number.
  set("#eco-their-streak", 1);
  await $("#eco-their-streak").dispatch("change");
  assert.match($("#sim-results").textContent, /^Inputs changed/);
  await click("#run-sim-btn");
  shown = $("#sim-results").textContent;
  const afterWin = simulateMap({ ...params, theirLossStreak: 1 });
  assert.notEqual(afterWin.mapWinProb, baseline.mapWinProb);
  assert.ok(shown.includes(`Map win probability${pct1(afterWin.mapWinProb)}baseline buy: bonus buy (70% of the bank after a won round) · standard error`), shown);
  assert.ok(shown.includes("Loss streaks going in: Cloud9 0, Fnatic 1. Strength edge"), shown);
  assert.ok(shown.includes("Half-Buy / Bonus (6,300) against Full Buy"), shown);
  set("#eco-our-streak", 2);
  await click("#run-sim-btn");
  assert.ok($("#sim-results").textContent.includes("Loss streaks going in: Cloud9 2, Fnatic 1 (both teams cannot be on a loss streak"));
  set("#eco-our-streak", 0);
  set("#eco-their-streak", 0);

  // Attack with the spike planted and 5 s left: nobody can defuse, so the call is HOLD with a
  // certain round, not "SAVE, the retake only wins 0%".
  set("#eco-side", "attack");
  set("#eco-alive", 3);
  set("#eco-enemies", 2);
  set("#eco-time", 5);
  $("#eco-planted").checked = true;
  await click("#run-sim-btn");
  shown = $("#sim-results").textContent;
  const hold = evaluateSaveVsRetake({ alive: 3, enemiesAlive: 2, timeRemaining: 5, spikePlanted: true, ...params, ourSide: "attack" });
  assert.equal(hold.call, "HOLD");
  assert.match(shown, /Save vs retakeHOLDPost-plant hold 3v2: play-on EV /);
  assert.ok(shown.includes(`play-on EV ${pct1(hold.playEV)} vs save EV ${pct1(hold.saveEV)} · round won 100.0%`), shown);
  assert.ok(shown.includes("Post-plant hold (3v2 on attack, spike planted, 5s left): the round is won 100% of the time"), shown);
  assert.ok(shown.includes("The clock is on our side: the opponents need 7 s to defuse."), shown);
  assert.doesNotMatch(shown, /only wins 0%/);
  // The same numbers on defense are a retake that cannot be finished.
  set("#eco-side", "defense");
  await click("#run-sim-btn");
  shown = $("#sim-results").textContent;
  assert.ok(shown.includes("Retake 3v2: play-on EV"), shown);
  assert.ok(shown.includes("round won 0.0%"), shown);
  assert.ok(shown.includes("We have to beat the clock: we need 7 s to defuse."), shown);
  // Spike not planted: on attack it is an execute.
  set("#eco-side", "attack");
  $("#eco-planted").checked = false;
  await click("#run-sim-btn");
  assert.ok($("#sim-results").textContent.includes("Execute 3v2: play-on EV"));
  set("#eco-side", "defense");
  $("#eco-planted").checked = true;

  // A live map cannot show more than 18: the form is clamped, and the sudden-death round from
  // 18-18 ends 19-18 or 18-19, never level.
  set("#eco-our-score", 30);
  set("#eco-their-score", 29);
  await click("#run-sim-btn");
  assert.deepEqual([$("#eco-our-score").value, $("#eco-their-score").value], ["18", "18"]);
  const finals = $("#sim-chart").descendants().filter((node) => node.classList.contains("chart-label")).map((node) => node.textContent);
  assert.deepEqual(finals, ["19-18", "18-19"]);
  assert.equal(dom.document.querySelector("#eco-our-score").getAttribute("max"), "18");
  assert.equal(dom.document.querySelector("#eco-their-score").getAttribute("max"), "18");

  set("#eco-our-score", 6);
  set("#eco-their-score", 8);
  set("#eco-alive", 3);
  set("#eco-enemies", 4);
  set("#eco-time", 22);
  await resetView();
});

test("flashes are drawn as cones from the throw position along their direction", async () => {
  await resetView();
  for (const type of ["smoke", "recon", "molly"]) await setChecked(`#toggle-${type}`, false);
  const flashes = filterUtility(getTeamRounds("FNC", "ascent"), { types: ["flash"], side: "both", phase: "all" });
  const nodes = mapNodes("util-flash");
  assert.equal(nodes.length, flashes.length);
  const turn = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  let cones = 0;
  flashes.forEach((event, i) => {
    const node = nodes[i];
    const dir = event.direction;
    if (!dir || (dir.dx === 0 && dir.dy === 0)) {
      assert.equal(node.localName, "circle");
      return;
    }
    cones += 1;
    assert.equal(node.localName, "polygon", "a flash with a direction is a cone, not a circle");
    const x = event.position.x * 1000;
    const y = event.position.y * 1000;
    const pts = node.getAttribute("points").split(" ").map((pair) => pair.split(",").map(Number));
    assert.equal(pts.length, 6, "the apex and five points on the arc");
    near(pts[0][0], x, 0.06, "apex x");
    near(pts[0][1], y, 0.06, "apex y");
    // The cone reaches 1.5 radii (between 40 and 150 units) and opens one radian around the direction.
    const radius = Math.min(130, Math.max(8, (Number.isFinite(event.radius) ? event.radius : 0.03) * 1000));
    const reach = Math.min(150, Math.max(40, radius * 1.5));
    const angles = pts.slice(1).map(([px, py]) => {
      near(Math.hypot(px - x, py - y), reach, 0.3, "arc distance");
      return Math.atan2(py - y, px - x);
    });
    near(turn(angles[2], Math.atan2(dir.dy, dir.dx)), 0, 0.02, "the cone points along the flash direction");
    near(turn(angles[4], angles[0]), 1, 0.02, "the cone opens one radian");
    for (let k = 1; k < angles.length; k += 1) near(turn(angles[k], angles[k - 1]), 0.25, 0.02, "even arc steps");
  });
  assert.ok(cones >= 10, `only ${cones} flash cones were drawn`);
  await resetView();
});

test("zone labels stay inside the map and do not run into each other on any map", async () => {
  await resetView();
  const fontSize = (cls) => {
    const found = new RegExp(`\\.${cls} \\{[^}]*?font-size: ([\\d.]+)px`).exec(CSS);
    return found ? Number(found[1]) : null;
  };
  assert.deepEqual([fontSize("zone-label"), fontSize("zone-label-site"), fontSize("zone-label-lane")], [13, 24, 11.5]);
  // Estimated ink box of a bold sans-serif label: 0.62 em per character (0.7 em for the spaced
  // upper-case site headings), from 0.8 em above the baseline to 0.25 em below it.
  const box = (node) => {
    const classes = node.getAttribute("class").split(" ");
    const size = classes.map(fontSize).filter((value) => value !== null).at(-1);
    const width = node.textContent.length * size * (classes.includes("zone-label-site") ? 0.7 : 0.62);
    const x = Number(node.getAttribute("x"));
    const y = Number(node.getAttribute("y"));
    return { text: node.textContent, x0: x - width / 2, x1: x + width / 2, y0: y - size * 0.8, y1: y + size * 0.25 };
  };
  for (const mapId of MAP_IDS) {
    await click(`button.map-tab[data-map="${mapId}"]`);
    const boxes = mapNodes("zone-label").map(box);
    assert.equal(boxes.length, MAPS[mapId].zones.length, mapId);
    for (const b of boxes) {
      assert.ok(b.x0 >= 0 && b.x1 <= 1000 && b.y0 >= 0 && b.y1 <= 1000, `${mapId}: "${b.text}" leaves the map`);
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
        assert.equal(overlap, false, `${mapId}: "${a.text}" and "${b.text}" overlap`);
      }
    }
    if (mapId === "lotus") {
      const site = boxes.find((b) => b.text === "C SITE");
      const hall = boxes.find((b) => b.text === "C Hall");
      assert.ok(site.y0 - hall.y1 >= 3, `C Hall ends ${site.y0 - hall.y1} units above C SITE`);
    }
  }
  await resetView();
});

test("keyboard activation of a hold spot keeps focus on it and does not scroll the panel", async () => {
  await resetView();
  const callout = buildScoutSummary({ teamId: "FNC", mapId: "ascent" }).operator.spots[1].callout;
  let prevented = 0;
  const key = (name) => ({ key: name, preventDefault() { prevented += 1; } });
  const marker = () => mapNodes("op-group").find((node) => node.dataset.spot === callout);

  // Space on a table row: the table is rebuilt, focus lands on the new row, the page does not scroll.
  const oldRow = $("#operator-spots").children[1];
  assert.equal(oldRow.dataset.spot, callout);
  await oldRow.dispatch("keydown", key(" "));
  const newRow = $("#operator-spots").children[1];
  assert.notEqual(newRow, oldRow);
  assert.equal(prevented, 1);
  assert.equal(dom.document.activeElement, newRow);
  assert.deepEqual([newRow.dataset.spot, newRow.classList.contains("selected"), newRow.getAttribute("tabindex")], [callout, true, "0"]);

  // Enter on the marker on the map: it is redrawn deselected and keeps focus.
  const oldMarker = marker();
  await oldMarker.dispatch("keydown", key("Enter"));
  const newMarker = marker();
  assert.notEqual(newMarker, oldMarker);
  assert.equal(prevented, 2);
  assert.equal(dom.document.activeElement, newMarker);
  assert.deepEqual([newMarker.classList.contains("selected"), newMarker.getAttribute("tabindex"), newMarker.getAttribute("role")], [false, "0", "button"]);

  // Other keys are left to the browser and redraw nothing.
  await newMarker.dispatch("keydown", key("a"));
  await newMarker.dispatch("keydown", key("Tab"));
  assert.equal(prevented, 2);
  assert.equal(marker(), newMarker);
  // A mouse click selects without moving focus.
  dom.document.activeElement = null;
  await $("#operator-spots").children[0].dispatch("click");
  assert.equal(dom.document.activeElement, null);
  await $("#operator-spots").children[0].dispatch("click");
  await resetView();
});

test("the top bar selects are width-capped so a long replay team name cannot squeeze the brand", () => {
  const rule = /\.selectors select \{([^}]*)\}/.exec(CSS)[1];
  assert.match(rule, /max-width: 240px/);
  assert.match(rule, /text-overflow: ellipsis/);
  // The one-row top bar at 1800 px and above keeps the selectors from shrinking, which is why the cap matters.
  assert.match(CSS, /\.pill-col, \.selectors, \.actions \{ flex: none; \}/);
  // 60 characters is the longest team name the hydrator keeps.
  const long = JSON.parse(JSON.stringify(SAMPLE_GRID_SERIES).replaceAll("Fnatic", "F".repeat(200)));
  assert.equal(hydrateGridSeries(long).teams[1].name.length, 60);
});

// ===========================================================================
// (d) Project wiring
// ===========================================================================

test("package.json, the JetBrains run configuration and qodana.yaml run the documented commands", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);

  const xml = read("../.idea/runConfigurations/SpikeSight_Tests.xml");
  const tree = parseHtml(xml); // throws on unbalanced or malformed tags
  assert.equal(tree.root.children.length, 1);
  const component = tree.root.children[0];
  assert.equal(component.localName, "component");
  assert.equal(component.getAttribute("name"), "ProjectRunConfigurationManager");
  const configs = component.querySelectorAll("configuration");
  assert.equal(configs.length, 1);
  assert.equal(configs[0].getAttribute("name"), "SpikeSight Tests (node --test tests/*.test.mjs)");
  assert.equal(configs[0].getAttribute("type"), "js.build_tools.npm");
  assert.equal(configs[0].querySelector("package-json").getAttribute("value"), "$PROJECT_DIR$/package.json");
  assert.equal(configs[0].querySelector("command").getAttribute("value"), "run");
  assert.deepEqual(configs[0].querySelectorAll("script").map((node) => node.getAttribute("value")), ["test"]);

  const qodana = read("../qodana.yaml");
  assert.match(qodana, /^version: "1\.0"$/m);
  assert.match(qodana, /^linter: jetbrains\/qodana-js:2025\.2$/m);
  assert.match(qodana, /^profile:\n {2}name: qodana\.recommended$/m);

  const wrangler = read("../wrangler.jsonc");
  assert.match(wrangler, /"name": "spikesight-c9"/);
  assert.doesNotMatch(wrangler, /account_id/);
});
