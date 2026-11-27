// SpikeSight C9 - dashboard controller.
//
// This module holds DOM code and view state only. Every number on screen is computed by
// scout-engine.js (the same module the Worker and the tests import); this file formats and
// draws. Nodes are built with createElement / createElementNS and filled through textContent,
// so team names, player labels, GRID replay strings, GRID API output and coach answers can
// never be parsed as markup.

import { MAP_IDS, MAPS } from "./tactical-maps.js";
import { SAMPLE_GRID_SERIES, TEAMS, TEAM_IDS, getTeamRounds } from "./pro-data.js";
import {
  BUY_POLICY_LABELS, ECONOMY_LABELS, ECONOMY_STATES, ROUND_PHASES, SAVE_SCENARIOS, UTILITY_LABELS, UTILITY_TYPES,
  buildDeterministicCoachAnswer, buildScoutSummary, clusterUtility, computeUtilityMetrics, evaluateForceBuy,
  evaluateSaveVsRetake, filterUtility, generateDossier, hydrateGridSeries, sightlineCone, simulateMap,
} from "./scout-engine.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const SIZE = 1000;
const TRIALS = 1000;
const DEFAULT_TEAM_ID = "FNC";
const DEFAULT_OUR_TEAM_ID = "C9";
const SAMPLE_DATA_SOURCE = "grid-sample";
const GRID_OUTPUT_LIMIT = 6000;
const MAX_IMPORT_CHARS = 2000000;
const MAX_SCORE_BARS = 12;
/** Highest score a live map can show: 18-18 after the 12 overtime rounds, then sudden death. */
const MAX_LIVE_SCORE = 18;

/** Every element the controller touches. Boot fails with a clear message when one is missing. */
const IDS = {
  teamSelect: "#team-select",
  ourTeamSelect: "#our-team-select",
  dataPill: "#data-pill",
  loadGridBtn: "#load-grid-btn",
  dossierBtn: "#dossier-btn",
  runSimBtn: "#run-sim-btn",
  askCoachBtn: "#ask-coach-btn",
  map: "#tactical-map",
  gridStatus: "#grid-status",
  eventsShown: "#events-shown",
  toggleHeat: "#toggle-heat",
  toggleOperator: "#toggle-operator",
  toggleCounters: "#toggle-counters",
  kpiEfficiency: "#kpi-efficiency",
  kpiEfficiencyNote: "#kpi-efficiency-note",
  kpiFlashAssist: "#kpi-flash-assist",
  kpiFlashNote: "#kpi-flash-note",
  kpiSiteBias: "#kpi-site-bias",
  timingChart: "#timing-chart",
  timingNote: "#timing-note",
  kpiSample: "#kpi-sample",
  operatorSummary: "#operator-summary",
  operatorFrequency: "#operator-frequency",
  operatorSpots: "#operator-spots",
  antiopList: "#antiop-list",
  economyStates: "#economy-states",
  economyPistol: "#economy-pistol",
  ecoOurScore: "#eco-our-score",
  ecoTheirScore: "#eco-their-score",
  ecoOurCredits: "#eco-our-credits",
  ecoTheirCredits: "#eco-their-credits",
  ecoSide: "#eco-side",
  ecoSeed: "#eco-seed",
  ecoOurStreak: "#eco-our-streak",
  ecoTheirStreak: "#eco-their-streak",
  ecoAlive: "#eco-alive",
  ecoEnemies: "#eco-enemies",
  ecoTime: "#eco-time",
  ecoPlanted: "#eco-planted",
  simResults: "#sim-results",
  simChart: "#sim-chart",
  coachInput: "#coach-input",
  coachOutput: "#coach-output",
  coachSource: "#coach-source",
  dossierMarkdown: "#dossier-markdown",
  dossierKpis: "#dossier-kpis",
  copyDossierBtn: "#copy-dossier-btn",
  dossierStatus: "#dossier-status",
  gridEndpoint: "#grid-endpoint",
  gridApiKey: "#grid-api-key",
  gridQuery: "#grid-query",
  gridQueryBtn: "#grid-query-btn",
  gridOutput: "#grid-output",
  gridJsonInput: "#grid-json-input",
  gridImportBtn: "#grid-import-btn",
  gridFillSampleBtn: "#grid-fill-sample-btn",
  gridUnloadBtn: "#grid-unload-btn",
};

const TYPE_TOGGLES = { smoke: "#toggle-smoke", flash: "#toggle-flash", recon: "#toggle-recon", molly: "#toggle-molly" };
const PANELS = { operator: "#panel-operator", economy: "#panel-economy", coach: "#panel-coach", dossier: "#panel-dossier", grid: "#panel-grid" };
const GROUPS = { mapTabs: "button.map-tab", sideButtons: "button.side-btn", phaseButtons: "button.phase-btn", panelTabs: "button.panel-tab", coachChips: "button.coach-chip" };
const SIDE_IDS = ["both", "attack", "defense"];
const PHASE_IDS = ["all", ...ROUND_PHASES.map((p) => p.id)];
const ZONE_ORDER = ["lane", "choke", "mid", "spawn", "site", "plant"];
const COUNTER_MARKS = { smoke: "S", flash: "F", trade: "T", "jump-peek": "J", avoid: "!" };

/** Example queries only: no GRID key was available to verify them against the live API. */
const GRID_SAMPLE_QUERIES = {
  "central-data": "query RecentSeries {\n  allSeries(first: 5, orderBy: StartTimeScheduled) {\n    totalCount\n    edges { node { id startTimeScheduled title { nameShortened } tournament { nameShortened } teams { baseInfo { name } } } }\n  }\n}",
  "series-state": "query SeriesState {\n  seriesState(id: \"REPLACE_WITH_SERIES_ID\") {\n    id started finished\n    teams { name score won }\n    games { sequenceNumber map { name } teams { name score won } }\n  }\n}",
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function el(tag, text = "", className = "") {
  const node = document.createElement(tag);
  if (text !== "" && text !== null && text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function must(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`SpikeSight C9: the page is missing the element ${selector}`);
  return node;
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const finite = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const pct = (share, digits = 0) => `${(finite(share) * 100).toFixed(digits)}%`;
const points = (list) => list.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ");
const credits = (value) => finite(value).toLocaleString("en-US");
const text = (value, fallback) => (typeof value === "string" && value !== "" ? value : fallback);
const errorText = (err) => (err && typeof err.message === "string" ? err.message : String(err)).split("\n")[0].slice(0, 160);

function withTitle(node, title) {
  node.append(svgEl("title", {}, title));
  return node;
}

function readInt(node, fallback, lo, hi) {
  const parsed = Number.parseInt(node.value, 10);
  return Number.isFinite(parsed) ? clamp(parsed, lo, hi) : fallback;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
class SpikeSightApp {
  constructor() {
    this.n = Object.fromEntries(Object.entries(IDS).map(([key, selector]) => [key, must(selector)]));
    this.typeToggles = Object.fromEntries(Object.entries(TYPE_TOGGLES).map(([type, selector]) => [type, must(selector)]));
    this.panels = Object.fromEntries(Object.entries(PANELS).map(([id, selector]) => [id, must(selector)]));
    this.groups = Object.fromEntries(Object.entries(GROUPS).map(([key, selector]) => [key, [...document.querySelectorAll(selector)]]));
    this.state = {
      teamId: DEFAULT_TEAM_ID,
      ourTeamId: DEFAULT_OUR_TEAM_ID,
      mapId: MAP_IDS[0],
      types: new Set(UTILITY_TYPES),
      side: "both",
      phase: "all",
      showHeat: true,
      showOperator: true,
      showCounters: true,
      replay: null, // { hydrated, origin: "sample" | "bundled" | "import" }
      selectedSpot: null,
      activePanel: "operator",
      dossierShown: false,
    };
    this.summaryCache = new Map();
    this.statusNote = null;
    // The hold-spot nodes of the last render, by callout, so focus can follow a redraw.
    this.spotGroups = new Map();
    this.spotRows = new Map();
    this.initControls();
    this.syncTeamOptions();
    this.renderAll();
  }

  // ----- data access ------------------------------------------------------
  /** True when a replay is loaded and this team has rounds in it. */
  inReplay(teamId) {
    const replay = this.state.replay;
    return replay !== null && hasOwn(replay.hydrated.roundsByTeam, teamId) && replay.hydrated.roundsByTeam[teamId].length > 0;
  }

  teamName(teamId) {
    if (hasOwn(TEAMS, teamId)) return TEAMS[teamId].name;
    const found = this.state.replay?.hydrated.teams.find((t) => t.teamId === teamId);
    return found ? text(found.name, teamId) : String(teamId);
  }

  rounds() {
    const { teamId, mapId, replay } = this.state;
    if (replay !== null) return this.inReplay(teamId) ? replay.hydrated.roundsByTeam[teamId] : [];
    return getTeamRounds(teamId, mapId);
  }

  summary() {
    const { teamId, mapId, replay } = this.state;
    const key = `${replay === null ? "modelled" : "replay"}|${teamId}|${mapId}`;
    if (!this.summaryCache.has(key)) {
      const built = replay === null
        ? buildScoutSummary({ teamId, mapId })
        : buildScoutSummary({ teamId, mapId, rounds: this.rounds(), teamName: this.teamName(teamId), source: { kind: "grid-replay", seriesId: replay.hydrated.seriesId } });
      this.summaryCache.set(key, built);
    }
    return this.summaryCache.get(key);
  }

  // ----- controls ---------------------------------------------------------
  initControls() {
    const { n } = this;
    n.teamSelect.addEventListener("change", () => this.onTeamChange(n.teamSelect.value));
    n.ourTeamSelect.addEventListener("change", () => this.onOurTeamChange(n.ourTeamSelect.value));

    for (const btn of this.groups.mapTabs) btn.addEventListener("click", () => this.onMapChange(btn.dataset.map));
    for (const btn of this.groups.sideButtons) {
      btn.addEventListener("click", () => {
        if (!SIDE_IDS.includes(btn.dataset.side)) return;
        this.state.side = btn.dataset.side;
        this.renderFilters();
      });
    }
    for (const btn of this.groups.phaseButtons) {
      btn.addEventListener("click", () => {
        if (!PHASE_IDS.includes(btn.dataset.phase)) return;
        this.state.phase = btn.dataset.phase;
        this.renderFilters();
      });
    }
    for (const [type, node] of Object.entries(this.typeToggles)) {
      node.addEventListener("change", () => {
        if (node.checked) this.state.types.add(type);
        else this.state.types.delete(type);
        this.renderFilters();
      });
    }
    n.toggleHeat.addEventListener("change", () => { this.state.showHeat = n.toggleHeat.checked; this.renderMap(); });
    n.toggleOperator.addEventListener("change", () => { this.state.showOperator = n.toggleOperator.checked; this.renderMap(); });
    n.toggleCounters.addEventListener("change", () => { this.state.showCounters = n.toggleCounters.checked; this.renderMap(); });

    for (const btn of this.groups.panelTabs) btn.addEventListener("click", () => this.openPanel(btn.dataset.panel));
    for (const btn of this.groups.coachChips) {
      btn.addEventListener("click", () => {
        n.coachInput.value = btn.dataset.question ?? "";
        return this.askCoach();
      });
    }

    n.loadGridBtn.addEventListener("click", () => this.loadGridReplay());
    n.dossierBtn.addEventListener("click", () => this.showDossier(true));
    n.copyDossierBtn.addEventListener("click", () => (this.state.dossierShown ? this.copyDossier() : this.showDossier(true)));
    n.runSimBtn.addEventListener("click", () => this.runSim());
    n.askCoachBtn.addEventListener("click", () => this.askCoach());
    n.gridQueryBtn.addEventListener("click", () => this.runGridQuery());
    n.gridImportBtn.addEventListener("click", () => this.importGridJson());
    n.gridFillSampleBtn.addEventListener("click", () => { n.gridJsonInput.value = JSON.stringify(SAMPLE_GRID_SERIES); });
    n.gridUnloadBtn.addEventListener("click", () => { if (this.state.replay !== null) this.leaveReplay(); });
    n.gridEndpoint.addEventListener("change", () => this.syncGridQuery(false));
    for (const node of [n.ecoOurScore, n.ecoTheirScore, n.ecoOurCredits, n.ecoTheirCredits, n.ecoSide, n.ecoSeed, n.ecoOurStreak, n.ecoTheirStreak, n.ecoAlive, n.ecoEnemies, n.ecoTime, n.ecoPlanted]) {
      node.addEventListener("change", () => this.clearSim("Inputs changed. Press Run 1,000-Trial Economy Sim to update the results."));
    }
    this.syncGridQuery(true);
  }

  /** Put the example query for the chosen endpoint in the box, unless the user typed their own. */
  syncGridQuery(force) {
    const box = this.n.gridQuery;
    const samples = Object.values(GRID_SAMPLE_QUERIES);
    if (force || box.value.trim() === "" || samples.includes(box.value)) {
      box.value = GRID_SAMPLE_QUERIES[this.n.gridEndpoint.value] ?? GRID_SAMPLE_QUERIES["central-data"];
    }
  }

  /** Rebuild both team selects: the six rosters plus any replay team with rounds that is not one of them. */
  syncTeamOptions() {
    const options = TEAM_IDS.map((id) => ({ id, label: `${TEAMS[id].name} (${TEAMS[id].shortName})` }));
    for (const team of this.state.replay?.hydrated.teams ?? []) {
      if (!hasOwn(TEAMS, team.teamId) && this.inReplay(team.teamId)) options.push({ id: team.teamId, label: `${text(team.name, team.teamId)} (replay team)` });
    }
    for (const [select, value] of [[this.n.teamSelect, this.state.teamId], [this.n.ourTeamSelect, this.state.ourTeamId]]) {
      select.replaceChildren(...options.map(({ id, label }) => {
        const option = el("option", label);
        option.value = id;
        if (id === value) option.selected = true;
        return option;
      }));
      select.value = value;
    }
  }

  onTeamChange(teamId) {
    const known = hasOwn(TEAMS, teamId);
    if (!known && !this.inReplay(teamId)) return;
    this.state.teamId = teamId;
    this.state.selectedSpot = null;
    // A team that played in the loaded replay is scouted from the replay, whichever side of it
    // was picked. Any other roster has no rounds there, so the dashboard returns to that
    // roster's modelled dataset.
    if (this.state.replay !== null && !this.inReplay(teamId)) this.leaveReplay();
    else this.renderAll();
  }

  onOurTeamChange(teamId) {
    if (!hasOwn(TEAMS, teamId) && !this.inReplay(teamId)) return;
    this.state.ourTeamId = teamId;
    this.clearSim();
    this.renderHeader();
    if (this.state.dossierShown) this.fillDossier();
  }

  /** Map tabs browse the modelled datasets, so any tab (the active one too) leaves a loaded replay. */
  onMapChange(mapId) {
    if (!MAP_IDS.includes(mapId)) return;
    if (mapId === this.state.mapId && this.state.replay === null) return;
    this.state.mapId = mapId;
    this.state.selectedSpot = null;
    if (this.state.replay !== null) this.leaveReplay();
    else this.renderAll();
  }

  leaveReplay() {
    this.state.replay = null;
    this.statusNote = null;
    this.summaryCache.clear();
    if (!hasOwn(TEAMS, this.state.teamId)) this.state.teamId = DEFAULT_TEAM_ID;
    if (!hasOwn(TEAMS, this.state.ourTeamId)) this.state.ourTeamId = DEFAULT_OUR_TEAM_ID;
    this.syncTeamOptions();
    this.renderAll();
  }

  openPanel(id) {
    if (!hasOwn(this.panels, id)) return;
    this.state.activePanel = id;
    for (const btn of this.groups.panelTabs) {
      const active = btn.dataset.panel === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const [key, panel] of Object.entries(this.panels)) panel.hidden = key !== id;
  }

  /**
   * Toggle the highlighted hold spot. Both the map layer and the table are rebuilt, which removes
   * the node that was activated, so a keyboard activation names where focus has to return:
   * "map" (the hold spot marker) or "table" (the row).
   */
  selectSpot(callout, focusTarget = null) {
    this.state.selectedSpot = this.state.selectedSpot === callout ? null : callout;
    if (this.state.selectedSpot !== null && !this.state.showOperator) {
      this.state.showOperator = true;
      this.n.toggleOperator.checked = true;
    }
    this.renderMap();
    this.renderOperator();
    const node = focusTarget === "map" ? this.spotGroups.get(callout) : focusTarget === "table" ? this.spotRows.get(callout) : null;
    if (node && typeof node.focus === "function") node.focus();
  }

  /** Enter or Space on a focused hold spot. Space must not also scroll the panel. */
  onSpotKey(event, callout, focusTarget) {
    if (!event || (event.key !== "Enter" && event.key !== " ")) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    this.selectSpot(callout, focusTarget);
  }

  // ----- rendering --------------------------------------------------------
  renderAll() {
    this.renderHeader();
    this.renderMap();
    this.renderKpis();
    this.renderOperator();
    this.renderEconomy();
    this.clearSim();
    if (this.state.dossierShown) this.fillDossier();
  }

  renderFilters() {
    for (const btn of this.groups.sideButtons) {
      const active = btn.dataset.side === this.state.side;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    for (const btn of this.groups.phaseButtons) {
      const active = btn.dataset.phase === this.state.phase;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    this.renderMap();
    this.renderKpis();
  }

  renderHeader() {
    const { n, state } = this;
    const summary = this.summary();
    for (const btn of this.groups.mapTabs) {
      const active = btn.dataset.map === state.mapId;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    n.teamSelect.value = state.teamId;
    n.ourTeamSelect.value = state.ourTeamId;
    n.dataPill.textContent = state.replay === null ? "MODELLED DATASET" : "GRID REPLAY";
    n.dataPill.classList.toggle("live", state.replay !== null);
    n.gridUnloadBtn.disabled = state.replay === null;
    if (state.replay === null) {
      this.setStatus(`Modelled scenario dataset · ${summary.teamName} on ${summary.mapName} · ${summary.roundCount} rounds · shaped like GRID Series State, not official match statistics`, "");
    } else {
      this.setStatus(this.replayStatus(), state.replay.hydrated.warningCount > 0 || this.statusNote ? "warn" : "ok");
    }
  }

  replayStatus() {
    const { hydrated } = this.state.replay;
    const [a, b] = hydrated.teams;
    const score = a && b ? `${text(a.name, a.teamId)} ${a.score}–${b.score} ${text(b.name, b.teamId)}` : "score unavailable";
    let line = `GRID replay ${hydrated.seriesId} · ${score} · ${hydrated.roundCount} rounds · ${hydrated.mapName}`;
    if (this.inReplay(this.state.teamId)) line += ` · scouting ${this.teamName(this.state.teamId)}`;
    if (hydrated.warningCount > 0) line += ` · ${hydrated.warningCount} warning(s): ${hydrated.warnings.slice(0, 2).join(" ")}`;
    if (this.statusNote) line += ` · ${this.statusNote}`;
    return line;
  }

  setStatus(message, tone) {
    const node = this.n.gridStatus;
    node.textContent = message;
    node.classList.toggle("ok", tone === "ok");
    node.classList.toggle("warn", tone === "warn");
  }

  // ----- map --------------------------------------------------------------
  renderMap() {
    const { state } = this;
    const map = MAPS[state.mapId];
    const summary = this.summary();
    const rounds = this.rounds();
    const nodes = [this.buildDefs(), svgEl("rect", { class: "map-bg", x: 0, y: 0, width: SIZE, height: SIZE, rx: 16 })];

    const grid = svgEl("g", { class: "grid-layer" });
    for (let i = 1; i < 10; i += 1) {
      grid.append(svgEl("line", { class: "map-gridline", x1: i * 100, y1: 0, x2: i * 100, y2: SIZE }));
      grid.append(svgEl("line", { class: "map-gridline", x1: 0, y1: i * 100, x2: SIZE, y2: i * 100 }));
    }
    nodes.push(grid);

    const connectors = svgEl("g", { class: "connector-layer" });
    for (const c of map.connectors) {
      const [[x1, y1], [x2, y2]] = c.points;
      connectors.append(svgEl("line", { class: c.teleporter ? "connector-tp" : "connector", x1: x1 * SIZE, y1: y1 * SIZE, x2: x2 * SIZE, y2: y2 * SIZE }));
    }
    nodes.push(connectors);

    const zones = svgEl("g", { class: "zone-layer" });
    const labels = svgEl("g", { class: "zone-label-layer" });
    const ordered = [...map.zones].sort((a, b) => ZONE_ORDER.indexOf(a.kind) - ZONE_ORDER.indexOf(b.kind));
    for (const zone of ordered) {
      zones.append(this.drawZone(zone));
      labels.append(this.drawZoneLabel(zone));
    }
    nodes.push(zones);

    const types = [...state.types];
    const events = types.length === 0 ? [] : filterUtility(rounds, { types, side: state.side, phase: state.phase });
    const utilLayer = svgEl("g", { class: state.showHeat ? "util-layer dimmed" : "util-layer", filter: "url(#ss-glow)" });
    for (const event of events) {
      const drawn = this.drawUtility(event);
      if (drawn) utilLayer.append(drawn);
    }
    nodes.push(utilLayer);

    if (state.showHeat) {
      const clusters = clusterUtility(events, { radius: 0.05 }).filter((c) => c.count >= 2);
      const most = clusters.reduce((max, c) => Math.max(max, c.count), 1);
      const heat = svgEl("g", { class: "heat-layer", filter: "url(#ss-heat-blur)" });
      const heatLabels = svgEl("g", { class: "heat-label-layer" });
      for (const c of clusters) {
        const blob = svgEl("circle", {
          class: `heat heat-${c.type}`, cx: c.x * SIZE, cy: c.y * SIZE,
          r: Math.round(16 + 7 * Math.sqrt(c.count)), opacity: (0.2 + 0.45 * (c.count / most)).toFixed(2),
        });
        heat.append(blob);
        heatLabels.append(withTitle(
          svgEl("text", { class: "heat-label", x: c.x * SIZE, y: c.y * SIZE + 5 }, c.count),
          `${c.count} ${UTILITY_LABELS[c.type] ?? c.type} in this cluster (${pct(c.share)} of the utility shown)`,
        ));
      }
      nodes.push(heat, heatLabels);
    }

    nodes.push(labels);

    const sideMatches = (spotSide) => state.side === "both" || spotSide === undefined || spotSide === null || spotSide === state.side;
    const spots = summary.operator.spots.filter((s) => sideMatches(s.side));
    const visibleSpots = new Set(spots.map((s) => s.callout));
    this.spotGroups = new Map();
    if (state.showOperator) {
      const opLayer = svgEl("g", { class: "operator-layer" });
      for (const spot of spots) opLayer.append(this.drawOperatorSpot(spot));
      nodes.push(opLayer);
    }
    if (state.showCounters) {
      const counterLayer = svgEl("g", { class: "counter-layer" });
      const stacked = new Map();
      for (const rec of summary.antiOp) {
        if (!visibleSpots.has(rec.spot)) continue;
        const key = `${Math.round(rec.x * 200)}:${Math.round(rec.y * 200)}`;
        const index = stacked.get(key) ?? 0;
        stacked.set(key, index + 1);
        counterLayer.append(this.drawCounter(rec, index));
      }
      nodes.push(counterLayer);
    }

    if (rounds.length === 0) {
      nodes.push(svgEl("text", { class: "map-empty", x: SIZE / 2, y: SIZE / 2 }, "No rounds for this team in the current data source"));
    }
    this.n.map.replaceChildren(...nodes);

    const phase = ROUND_PHASES.find((p) => p.id === state.phase);
    const scope = [
      state.side === "both" ? "both sides" : `${state.side} rounds`,
      phase ? phase.label : "all phases",
    ].join(", ");
    this.n.eventsShown.textContent = `${events.length} utility events on the map (${scope}).`;
  }

  buildDefs() {
    const defs = svgEl("defs");
    const region = { filterUnits: "userSpaceOnUse", x: 0, y: 0, width: SIZE, height: SIZE };
    const glow = svgEl("filter", { id: "ss-glow", ...region });
    glow.append(svgEl("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 5, result: "blur" }));
    const merge = svgEl("feMerge");
    merge.append(svgEl("feMergeNode", { in: "blur" }), svgEl("feMergeNode", { in: "SourceGraphic" }));
    glow.append(merge);
    const heat = svgEl("filter", { id: "ss-heat-blur", ...region });
    heat.append(svgEl("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 9 }));
    defs.append(glow, heat);
    return defs;
  }

  zoneClass(zone) {
    if (zone.kind === "spawn") return zone.id === "spawn-attack" ? "spawn-attack" : "spawn-defense";
    if (zone.kind === "lane" && zone.teleporter) return "teleporter";
    return zone.kind;
  }

  drawZone(zone) {
    const polygon = svgEl("polygon", {
      class: `zone zone-${this.zoneClass(zone)}`,
      points: points(zone.points.map(([x, y]) => [x * SIZE, y * SIZE])),
      "data-zone": zone.id,
    });
    const kind = zone.kind === "plant" ? "spike plant zone" : zone.teleporter ? "teleporter" : zone.kind;
    return withTitle(polygon, `${zone.label} (${kind})`);
  }

  drawZoneLabel(zone) {
    const ys = zone.points.map(([, y]) => y * SIZE);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const x = zone.center.x * SIZE;
    let y = (zone.center.y + finite(zone.labelDy)) * SIZE + 5;
    let cls = `zone-label zone-label-${zone.kind}`;
    if (zone.kind === "site") y = top > 40 ? top - 10 : bottom + 28;
    else if (zone.kind === "plant") y = bottom + 15;
    else if (zone.kind === "spawn" && zone.id !== "spawn-attack") cls += " zone-label-spawn-defense";
    return svgEl("text", { class: cls, x, y }, zone.kind === "site" ? zone.label.toUpperCase() : zone.label);
  }

  drawUtility(event) {
    if (!event.position || !Number.isFinite(event.position.x) || !Number.isFinite(event.position.y)) return null;
    const x = event.position.x * SIZE;
    const y = event.position.y * SIZE;
    const r = clamp(finite(event.radius, 0.03) * SIZE, 8, 130);
    const dir = event.direction && Number.isFinite(event.direction.dx) && Number.isFinite(event.direction.dy)
      && (event.direction.dx !== 0 || event.direction.dy !== 0) ? event.direction : null;
    const phase = ROUND_PHASES.find((p) => p.id === event.phase);
    const title = [
      `${text(event.ability, "Ability")} (${UTILITY_LABELS[event.type] ?? event.type})`,
      `${text(event.agent, "Agent")} · ${text(event.player, "player")}`,
      `round ${event.roundNumber}, ${event.side}`,
      `${finite(event.time)}s${phase ? `, ${phase.label}` : ""}`,
      event.assistedKill ? "assisted a kill" : `${finite(event.enemiesAffected)} enemies affected`,
    ].join(" · ");

    if (event.type === "smoke") return withTitle(svgEl("circle", { class: "util util-smoke", cx: x, cy: y, r }), title);
    if (event.type === "molly") {
      return withTitle(svgEl("polygon", { class: "util util-molly", points: points([[x, y - r], [x + r, y], [x, y + r], [x - r, y]]) }), title);
    }
    if (event.type === "flash") {
      if (!dir) return withTitle(svgEl("circle", { class: "util util-flash", cx: x, cy: y, r: 13 }), title);
      const angle = Math.atan2(dir.dy, dir.dx);
      const reach = clamp(r * 1.5, 40, 150);
      const cone = [[x, y]];
      for (const step of [-0.5, -0.25, 0, 0.25, 0.5]) {
        cone.push([x + Math.cos(angle + step) * reach, y + Math.sin(angle + step) * reach]);
      }
      return withTitle(svgEl("polygon", { class: "util util-flash", points: points(cone) }), title);
    }
    if (event.type === "recon") {
      const group = svgEl("g", { class: "util-recon-group" });
      group.append(
        svgEl("circle", { class: "util util-recon", cx: x, cy: y, r }),
        svgEl("circle", { class: "util util-recon", cx: x, cy: y, r: r * 0.55 }),
        svgEl("circle", { class: "util-recon-inner", cx: x, cy: y, r: 4.5 }),
      );
      if (dir) {
        const length = Math.hypot(dir.dx, dir.dy);
        group.append(svgEl("line", { class: "util-recon-tick", x1: x, y1: y, x2: x + (dir.dx / length) * r * 0.55, y2: y + (dir.dy / length) * r * 0.55 }));
      }
      return withTitle(group, title);
    }
    return null;
  }

  drawOperatorSpot(spot) {
    const { selectedSpot } = this.state;
    const x = finite(spot.x) * SIZE;
    const y = finite(spot.y) * SIZE;
    const callout = text(spot.callout, "Hold spot");
    let cls = "op-group";
    if (selectedSpot !== null) cls += selectedSpot === spot.callout ? " selected" : " dim";
    const group = svgEl("g", { class: cls, "data-spot": callout, tabindex: 0, role: "button" });
    const cone = sightlineCone(spot, { size: SIZE });
    if (cone.length >= 3) group.append(svgEl("polygon", { class: "op-cone", points: points(cone) }));
    group.append(
      svgEl("circle", { class: "op-ring", cx: x, cy: y, r: 12 }),
      svgEl("line", { class: "op-cross", x1: x - 18, y1: y, x2: x + 18, y2: y }),
      svgEl("line", { class: "op-cross", x1: x, y1: y - 18, x2: x, y2: y + 18 }),
      svgEl("circle", { class: "op-dot", cx: x, cy: y, r: 3.5 }),
    );
    const right = x < 760;
    group.append(svgEl("text", { class: "op-label", x: right ? x + 20 : x - 20, y: y - 16, "text-anchor": right ? "start" : "end" }, `${callout} · FB ${pct(spot.firstBloodPickRate)}`));
    withTitle(group, `${text(spot.player, "Operator")} holds ${callout}${spot.watch ? ` watching ${spot.watch}` : ""}: ${spot.holds} hold(s), first-blood pick rate ${pct(spot.firstBloodPickRate)}, re-peek rate ${pct(spot.rePeekRate)}, ${spot.kills} kill(s)`);
    group.addEventListener("click", () => this.selectSpot(spot.callout));
    group.addEventListener("keydown", (event) => this.onSpotKey(event, spot.callout, "map"));
    this.spotGroups.set(spot.callout, group);
    return group;
  }

  drawCounter(rec, stackIndex) {
    const { selectedSpot } = this.state;
    const x = finite(rec.x) * SIZE + stackIndex * 30;
    const y = finite(rec.y) * SIZE;
    const known = hasOwn(COUNTER_MARKS, rec.type);
    const cls = selectedSpot !== null && selectedSpot !== rec.spot ? "counter-group dim" : "counter-group";
    const group = svgEl("g", { class: cls, "data-spot": text(rec.spot, "") });
    group.append(
      svgEl("circle", { class: `counter counter-${known ? rec.type : "trade"}`, cx: x, cy: y, r: rec.type === "smoke" ? 26 : 13 }),
      svgEl("text", { class: "counter-label", x, y: y + 4.5 }, known ? COUNTER_MARKS[rec.type] : "?"),
    );
    return withTitle(group, `${String(rec.type).toUpperCase()} counter for ${text(rec.spot, "the hold spot")}: ${text(rec.text, "")}`);
  }

  // ----- Layer 1 KPIs -----------------------------------------------------
  renderKpis() {
    const { n, state } = this;
    const map = MAPS[state.mapId];
    const all = this.rounds();
    const rounds = state.side === "both" ? all : all.filter((r) => r.side === state.side);
    const m = computeUtilityMetrics(rounds, { mapId: state.mapId });
    const size = m.sampleSize;

    n.kpiEfficiency.textContent = finite(m.utilityEfficiencyScore).toFixed(1);
    n.kpiEfficiencyNote.textContent = `${size.effectiveEvents} of ${size.utilityEvents} events hit an enemy or assisted a kill (out of 100)`;
    n.kpiFlashAssist.textContent = pct(m.flashAssistRate, 1);
    n.kpiFlashNote.textContent = `${size.assistedFlashes} of ${size.flashes} flashes assisted a kill`;

    const biasNodes = [];
    for (const side of state.side === "both" ? ["attack", "defense"] : [state.side]) {
      const shares = m.siteBias[side] ?? {};
      biasNodes.push(el("div", side === "attack" ? "Attack: sites hit" : "Defense: sites stacked", "bias-head"));
      for (const site of map.sites) biasNodes.push(this.barRow(`${site} Site`, finite(shares[site]), side === "defense" ? "defense" : ""));
    }
    n.kpiSiteBias.replaceChildren(...biasNodes);

    this.renderTimingChart(m.executeTiming);
    const scope = state.side === "both" ? "both sides" : `${state.side} rounds only`;
    n.kpiSample.textContent = `Sample: ${size.rounds} rounds (${size.attackRounds} attack, ${size.defenseRounds} defense), ${size.utilityEvents} utility events. KPIs cover ${scope}; type and phase filters change the map only.`;
  }

  barRow(name, share, fillClass, wide = false) {
    const row = el("div", "", wide ? "bias-row wide" : "bias-row");
    const track = el("div", "", "bias-track");
    const fill = el("div", "", fillClass ? `bias-fill ${fillClass}` : "bias-fill");
    fill.style.width = `${clamp(Math.round(share * 1000) / 10, 0, 100)}%`;
    track.append(fill);
    row.append(el("span", name, "bias-name"), track, el("span", pct(share), "bias-pct"));
    return row;
  }

  renderTimingChart(timing) {
    const { n } = this;
    const width = 320;
    const baseY = 86;
    const top = 24;
    const left = 10;
    const buckets = timing.buckets;
    const slot = (width - left * 2) / Math.max(1, buckets.length);
    const nodes = [svgEl("line", { class: "chart-axis", x1: left, y1: baseY, x2: width - left, y2: baseY })];
    if (timing.rounds === 0) {
      nodes.push(svgEl("text", { class: "chart-note", x: width / 2, y: 52 }, "No attack round with execute-phase utility"));
      n.timingChart.replaceChildren(...nodes);
      n.timingNote.textContent = "Execute timing is measured on attack rounds: pick Attack or Both in the side filter.";
      return;
    }
    const most = buckets.reduce((max, b) => Math.max(max, b.share), 0) || 1;
    buckets.forEach((bucket, i) => {
      const height = (bucket.share / most) * (baseY - top - 12);
      const x = left + i * slot + 4;
      const peak = timing.peak !== null && timing.peak.label === bucket.label;
      const bar = svgEl("rect", { class: peak ? "bar bar-peak" : "bar", x, y: baseY - height, width: slot - 8, height: Math.max(height, 0), rx: 3 });
      nodes.push(withTitle(bar, `${bucket.label}: ${bucket.count} of ${timing.rounds} attack rounds (${pct(bucket.share)})`));
      if (bucket.count > 0) nodes.push(svgEl("text", { class: "chart-value", x: x + (slot - 8) / 2, y: baseY - height - 4 }, bucket.count));
      nodes.push(svgEl("text", { class: "chart-label", x: x + (slot - 8) / 2, y: baseY + 13 }, bucket.label));
    });
    if (Number.isFinite(timing.medianSeconds)) {
      const first = buckets[0].from;
      const span = buckets.length * 5;
      const mx = left + clamp((timing.medianSeconds - first) / span, 0, 1) * (width - left * 2);
      nodes.push(svgEl("line", { class: "median-line", x1: mx, y1: 12, x2: mx, y2: baseY }));
      nodes.push(svgEl("text", { class: "median-label", x: mx < width - 96 ? mx + 5 : mx - 5, y: 11, "text-anchor": mx < width - 96 ? "start" : "end" }, `median ${timing.medianSeconds}s`));
    }
    n.timingChart.replaceChildren(...nodes);
    n.timingNote.textContent = timing.peak
      ? `First execute utility per attack round: peak ${timing.peak.label} (${pct(timing.peak.share)} of ${timing.rounds}), median ${timing.medianSeconds}s.`
      : `First execute utility per attack round over ${timing.rounds} attack rounds.`;
  }

  // ----- Layer 2 panel ----------------------------------------------------
  statCard(label, value, note, tone = "") {
    const card = el("div", "", tone ? `state-card ${tone}` : "state-card");
    card.append(el("span", label, "kpi-label"), el("strong", value, "state-value"));
    if (note) card.append(el("span", note, "kpi-note"));
    return card;
  }

  renderOperator() {
    const { n, state } = this;
    const summary = this.summary();
    const op = summary.operator;
    n.operatorSummary.replaceChildren(
      this.statCard("Operator rounds", `${op.operatorRounds} / ${op.rounds}`, `${pct(op.operatorRoundRate, 1)} of rounds`),
      this.statCard("First-blood pick rate", pct(op.firstBloodPickRate, 1), `over ${op.holds} Operator holds`),
      this.statCard("Re-peek rate", pct(op.rePeekRate, 1), "holds with a second peek"),
      this.statCard("Operator kills", String(op.kills), op.primarySpot ? `primary spot ${op.primarySpot.callout}` : "no hold recorded"),
    );
    n.operatorFrequency.replaceChildren(
      this.barRow(`Full-buy rounds (${op.buyRounds})`, finite(op.buyRoundOpFrequency), "", true),
      this.barRow(`Eco + half-buy rounds (${op.ecoRounds})`, finite(op.ecoRoundOpFrequency), "eco", true),
    );

    this.spotRows = new Map();
    if (op.spots.length === 0) {
      const row = el("tr");
      const cell = el("td", `No Operator hold recorded for ${summary.teamName} in ${summary.roundCount} rounds.`);
      cell.setAttribute("colspan", "7");
      row.append(cell);
      n.operatorSpots.replaceChildren(row);
    } else {
      n.operatorSpots.replaceChildren(...op.spots.map((spot) => {
        const row = el("tr", "", state.selectedSpot === spot.callout ? "selected" : "");
        row.setAttribute("tabindex", "0");
        row.dataset.spot = text(spot.callout, "");
        const name = el("td");
        name.append(el("span", text(spot.callout, "Hold spot"), "spot-name"), el("span", text(spot.player, "Operator"), "spot-player"));
        const side = el("td");
        if (spot.side === "attack" || spot.side === "defense") side.append(el("span", spot.side, `side-tag ${spot.side}`));
        row.append(
          name, side, el("td", text(spot.watch, "")), el("td", String(spot.holds)),
          el("td", `${pct(spot.firstBloodPickRate)} (${spot.firstBloods}/${spot.holds})`),
          el("td", `${pct(spot.rePeekRate)} (${spot.rePeeks}/${spot.holds})`), el("td", String(spot.kills)),
        );
        row.addEventListener("click", () => this.selectSpot(spot.callout));
        row.addEventListener("keydown", (event) => this.onSpotKey(event, spot.callout, "table"));
        this.spotRows.set(spot.callout, row);
        return row;
      }));
    }

    if (summary.antiOp.length === 0) {
      n.antiopList.replaceChildren(el("li", "No Operator hold in the sample, so there is no counter to recommend. Play standard anti-rifle spacing.", "rec-item"));
    } else {
      n.antiopList.replaceChildren(...summary.antiOp.map((rec) => {
        const item = el("li", "", state.selectedSpot !== null && state.selectedSpot !== rec.spot ? "rec-item dim" : "rec-item");
        item.dataset.spot = text(rec.spot, "");
        const known = hasOwn(COUNTER_MARKS, rec.type);
        item.append(el("span", String(rec.type), known ? `rec-type ${rec.type}` : "rec-type"), el("span", text(rec.text, "")));
        return item;
      }));
    }
  }

  // ----- Layer 3 panel ----------------------------------------------------
  renderEconomy() {
    const { n } = this;
    const eco = this.summary().economy;
    n.economyStates.replaceChildren(...ECONOMY_STATES.map((id) => {
      const s = eco.states[id];
      return this.statCard(
        ECONOMY_LABELS[id] ?? s.label,
        s.count > 0 ? pct(s.winRate, 1) : "n/a",
        `${s.wins} of ${s.count} rounds won · avg loadout ${credits(s.averageLoadout)}`,
      );
    }));
    const a = eco.pistol.attack;
    const d = eco.pistol.defense;
    n.economyPistol.textContent = `Win rate by economy state of the scouted team. Pistol rounds: attack ${a.wins} of ${a.rounds} won, defense ${d.wins} of ${d.rounds} won. Overall ${eco.wins} of ${eco.rounds} rounds won (${pct(eco.winRate, 1)}).`;
  }

  clearSim(message = "Press Run 1,000-Trial Economy Sim to play out the rest of the map from this score and economy.") {
    this.n.simResults.replaceChildren(el("p", message, "sim-note"));
    this.n.simChart.replaceChildren();
  }

  strengthEdge() {
    const edge = (teamId) => (hasOwn(TEAMS, teamId) ? finite(TEAMS[teamId].style?.strengthEdge) : 0);
    return Math.round((edge(this.state.ourTeamId) - edge(this.state.teamId)) * 10000) / 10000;
  }

  runSim() {
    const { n, state } = this;
    this.openPanel("economy");
    try {
      const params = {
        ourScore: readInt(n.ecoOurScore, 0, 0, MAX_LIVE_SCORE),
        theirScore: readInt(n.ecoTheirScore, 0, 0, MAX_LIVE_SCORE),
        ourCredits: readInt(n.ecoOurCredits, 22000, 0, 45000),
        theirCredits: readInt(n.ecoTheirCredits, 22000, 0, 45000),
        // 0 and 0 means "not stated": the engine then derives who lost the last round.
        ourLossStreak: readInt(n.ecoOurStreak, 0, 0, 5),
        theirLossStreak: readInt(n.ecoTheirStreak, 0, 0, 5),
        ourSide: n.ecoSide.value === "attack" ? "attack" : "defense",
        mapId: state.mapId,
        strengthEdge: this.strengthEdge(),
        trials: TRIALS,
        seed: readInt(n.ecoSeed, 1337, 0, 4294967295),
      };
      const situation = {
        alive: readInt(n.ecoAlive, 3, 0, 5),
        enemiesAlive: readInt(n.ecoEnemies, 4, 0, 5),
        timeRemaining: readInt(n.ecoTime, 22, 0, 100),
        spikePlanted: n.ecoPlanted.checked,
      };
      const sim = simulateMap(params);
      const force = evaluateForceBuy(params);
      const retake = evaluateSaveVsRetake({ ...situation, ...params });

      // Show the values that were actually used, so the same inputs reproduce the same numbers.
      n.ecoOurScore.value = String(params.ourScore);
      n.ecoTheirScore.value = String(params.theirScore);
      n.ecoOurCredits.value = String(params.ourCredits);
      n.ecoTheirCredits.value = String(params.theirCredits);
      n.ecoSeed.value = String(sim.seed);
      n.ecoOurStreak.value = String(params.ourLossStreak);
      n.ecoTheirStreak.value = String(params.theirLossStreak);
      n.ecoAlive.value = String(situation.alive);
      n.ecoEnemies.value = String(situation.enemiesAlive);
      n.ecoTime.value = String(situation.timeRemaining);
      this.renderSim({ params, situation, sim, force, retake });
    } catch (err) {
      this.clearSim(`The simulation could not run: ${errorText(err)}`);
    }
  }

  renderSim({ params, situation, sim, force, retake }) {
    const { n, state } = this;
    const ours = this.teamName(state.ourTeamId);
    const theirs = this.teamName(state.teamId);
    const pts = (value) => `${(finite(value) * 100).toFixed(1)} pts`;
    const signed = (value) => `${value > 0 ? "+" : ""}${(finite(value) * 100).toFixed(1)} pts`;

    let comeback = "Level score";
    let comebackNote = `The score is level at ${params.ourScore}-${params.theirScore}, so nobody is trailing.`;
    if (sim.comebackProb !== null && sim.trailing !== null) {
      comeback = pct(sim.comebackProb, 1);
      comebackNote = sim.trailing === "us"
        ? `${ours} trail ${params.ourScore}-${params.theirScore} and still win the map`
        : `${theirs} trail ${params.theirScore}-${params.ourScore} and still win the map`;
    }
    const forceTone = force.recommendation === "FORCE" ? "call-good" : force.recommendation === "SAVE" ? "call-warn" : "";
    const start = sim.start;
    // The headline number plays the model's own buy for this round. Name that buy, because the
    // force-buy card compares two other first-round buys and all three numbers differ.
    const baseline = start.ourBuyPolicy !== null && hasOwn(BUY_POLICY_LABELS, start.ourBuyPolicy) ? `baseline buy: ${BUY_POLICY_LABELS[start.ourBuyPolicy]} · ` : "";
    const scenario = hasOwn(SAVE_SCENARIOS, retake.scenario) ? SAVE_SCENARIOS[retake.scenario].label : "Play on";
    const cards = el("div", "", "state-grid");
    cards.append(
      this.statCard("Map win probability", pct(sim.mapWinProb, 1), `${baseline}standard error ${pts(sim.standardError)} · 95% interval ${pct(sim.ci95[0], 1)} to ${pct(sim.ci95[1], 1)}`),
      this.statCard("Half win probability", pct(sim.halfWinProb, 1), `${ours} lead when this half ends · level ${pct(sim.halfTieProb, 1)}`),
      this.statCard("Comeback probability", comeback, comebackNote),
      this.statCard("Expected final score", `${finite(sim.expectedFinalScore.our).toFixed(1)} - ${finite(sim.expectedFinalScore.their).toFixed(1)}`, `${ours} - ${theirs}, mean over ${sim.trials.toLocaleString("en-US")} trials`),
      this.statCard("Force-buy EV", `${force.recommendation} ${signed(force.forceBuyEV)}`, `force (whole bank) ${pct(force.forceWinProb, 1)} vs save (at most 2,000) ${pct(force.saveWinProb, 1)} vs baseline ${pct(sim.mapWinProb, 1)} map win probability · standard error ${pts(force.standardError)}`, forceTone),
      this.statCard("Save vs retake", retake.call, `${scenario} ${situation.alive}v${situation.enemiesAlive}: play-on EV ${pct(retake.playEV, 1)} vs save EV ${pct(retake.saveEV, 1)} · round won ${pct(retake.playWinProb, 1)}`, retake.call === "SAVE" ? "call-warn" : "call-good"),
    );

    const streakNotes = {
      derived: " (not stated, so derived: the team behind on score, or with the smaller bank at a level score, is taken to have lost the last round)",
      unknown: " (not stated, and score and banks are level, so neither team is treated as the last round's winner)",
      pistol: " (a pistol round resets both)",
    };
    let streakNote = hasOwn(streakNotes, start.streakSource) ? streakNotes[start.streakSource] : "";
    if (start.streakSource === "input" && start.ourLossStreak > 0 && start.theirLossStreak > 0) {
      streakNote = " (both teams cannot be on a loss streak, so neither is treated as the last round's winner)";
    }
    const streaks = `Loss streaks going in: ${ours} ${start.ourLossStreak}, ${theirs} ${start.theirLossStreak}${streakNote}.`;
    const economy = (id) => (id && hasOwn(ECONOMY_LABELS, id) ? ECONOMY_LABELS[id] : "no buy");
    const model = start.ourEconomy === null
      ? `The map is already decided at ${params.ourScore}-${params.theirScore}, so nothing was simulated.`
      : `Round ${start.roundNumber}, ${ours} on ${start.ourSide}: ${economy(start.ourEconomy)} (${credits(start.ourLoadout)}) against ${economy(start.theirEconomy)} (${credits(start.theirLoadout)}), modelled round win probability ${pct(start.roundWinProb, 1)}. ${streaks} Strength edge ${signed(params.strengthEdge)} per round.`;
    n.simResults.replaceChildren(
      cards,
      el("p", retake.reasoning, "sim-note"),
      el("p", `${model} ${sim.trials.toLocaleString("en-US")} trials, seed ${sim.seed}: the same inputs and seed reproduce these numbers. The round win matrix and credit rules are model assumptions, not measured statistics.`, "sim-note"),
    );
    this.renderScoreChart(sim);
  }

  renderScoreChart(sim) {
    const width = 560;
    const baseY = 134;
    const left = 14;
    const ranked = sim.scoreDistribution.map((entry, index) => ({ entry, index }));
    const kept = [...ranked].sort((a, b) => b.entry.count - a.entry.count).slice(0, MAX_SCORE_BARS).sort((a, b) => a.index - b.index);
    const slot = (width - left * 2) / Math.max(1, kept.length);
    const most = kept.reduce((max, k) => Math.max(max, k.entry.share), 0) || 1;
    const nodes = [svgEl("line", { class: "chart-axis", x1: left, y1: baseY, x2: width - left, y2: baseY })];
    kept.forEach(({ entry }, i) => {
      const height = (entry.share / most) * (baseY - 30);
      const x = left + i * slot + 4;
      const barWidth = Math.min(slot - 8, 60);
      const bar = svgEl("rect", { class: entry.won ? "bar bar-won" : "bar bar-lost", x, y: baseY - height, width: barWidth, height: Math.max(height, 0), rx: 3 });
      nodes.push(withTitle(bar, `${entry.score}: ${entry.count} of ${sim.trials} trials (${pct(entry.share, 1)}), ${entry.won ? "map won" : "map lost"}`));
      nodes.push(svgEl("text", { class: "chart-value", x: x + barWidth / 2, y: baseY - height - 4 }, pct(entry.share)));
      nodes.push(svgEl("text", { class: "chart-label", x: x + barWidth / 2, y: baseY + 13 }, entry.score));
    });
    const hidden = sim.scoreDistribution.length - kept.length;
    nodes.push(svgEl("text", { class: "chart-note", x: width / 2, y: baseY + 32 }, `Final score distribution (our score first, cyan = map won)${hidden > 0 ? `, ${kept.length} most frequent of ${sim.scoreDistribution.length} outcomes` : ""}`));
    this.n.simChart.replaceChildren(...nodes);
  }

  // ----- AI coach ---------------------------------------------------------
  setCoach(answer, source, tone = "") {
    this.n.coachOutput.textContent = answer;
    this.n.coachSource.textContent = source;
    this.n.coachSource.classList.toggle("warn", tone === "warn");
  }

  coachContext() {
    const { state } = this;
    return {
      ourTeam: this.teamName(state.ourTeamId),
      sideFilter: state.side,
      phaseFilter: state.phase,
      utilityTypes: [...state.types],
      dataSource: state.replay === null ? "modelled dataset" : `GRID replay ${state.replay.hydrated.seriesId}`,
    };
  }

  async askCoach() {
    const { n, state } = this;
    this.openPanel("coach");
    const summary = this.summary();
    let question = n.coachInput.value.trim().slice(0, 600);
    if (question === "") {
      question = `What is the anti-strat game plan against ${summary.teamName} on ${summary.mapName}?`;
      n.coachInput.value = question;
    }
    const localAnswer = () => {
      try {
        return buildDeterministicCoachAnswer(summary, question);
      } catch (err) {
        return `- The deterministic coach could not read this dataset (${errorText(err)}).`;
      }
    };

    // An imported replay only exists in this browser, so the server cannot ground on it.
    if (state.replay !== null && state.replay.origin === "import") {
      this.setCoach(localAnswer(), "Deterministic coach (imported replay, in browser)");
      return;
    }

    n.askCoachBtn.disabled = true;
    this.setCoach("Asking the coach...", "Waiting for /api/scout-coach");
    try {
      const payload = { question, teamId: state.teamId, mapId: state.mapId, context: this.coachContext() };
      if (state.replay !== null) payload.dataSource = SAMPLE_DATA_SOURCE;
      const res = await fetch("/api/scout-coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data || typeof data.answer !== "string" || data.answer.trim() === "") {
        throw new Error(`the coach endpoint answered HTTP ${res.status} without an answer`);
      }
      const viaModel = data.source === "workers-ai";
      const parts = [viaModel ? "Workers AI" : "Deterministic coach"];
      if (typeof data.model === "string") parts.push(data.model);
      if (data.grounding && typeof data.grounding.dataset === "string") parts.push(`grounded on ${data.grounding.dataset}`);
      if (typeof data.warning === "string" && data.warning !== "") parts.push(data.warning);
      this.setCoach(data.answer, parts.join(" · "), viaModel ? "" : "warn");
    } catch (err) {
      this.setCoach(localAnswer(), `Deterministic coach (in browser): the coach request failed (${errorText(err)}), so the answer was computed here from the on-screen telemetry.`, "warn");
    } finally {
      n.askCoachBtn.disabled = false;
    }
  }

  // ----- dossier ----------------------------------------------------------
  fillDossier() {
    const { n, state } = this;
    const { markdown, kpis } = generateDossier(this.summary(), { ourTeamId: state.ourTeamId });
    n.dossierMarkdown.textContent = markdown;
    n.dossierKpis.replaceChildren(...kpis.map((k) => this.statCard(k.label, k.value, "")));
    state.dossierShown = true;
    return markdown;
  }

  async showDossier(copy) {
    this.openPanel("dossier");
    try {
      this.fillDossier();
    } catch (err) {
      this.n.dossierStatus.textContent = `The dossier could not be generated: ${errorText(err)}`;
      return;
    }
    if (copy) await this.copyDossier();
  }

  async copyDossier() {
    const { n } = this;
    const markdown = n.dossierMarkdown.textContent;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("no clipboard");
      await navigator.clipboard.writeText(markdown);
      n.dossierStatus.textContent = "Copied to clipboard";
    } catch {
      n.dossierStatus.textContent = "Clipboard unavailable, select the text below";
    }
  }

  // ----- GRID replay and live query --------------------------------------
  async loadGridReplay() {
    const { n } = this;
    n.loadGridBtn.disabled = true;
    try {
      let payload = null;
      let failure = null;
      try {
        const res = await fetch("/api/grid/sample-series", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        payload = await res.json();
      } catch (err) {
        failure = errorText(err);
      }
      if (payload !== null && this.applyReplay(payload, "sample", null)) return;
      const note = failure !== null
        ? `the live sample request failed (${failure}), so the bundled copy was used`
        : "the live sample could not be hydrated, so the bundled copy was used";
      this.applyReplay(SAMPLE_GRID_SERIES, "bundled", note);
    } finally {
      n.loadGridBtn.disabled = false;
    }
  }

  /** Hydrate a GRID payload and switch the dashboard to it. Returns false when it is rejected. */
  applyReplay(payload, origin, note) {
    const hydrated = hydrateGridSeries(payload);
    if (!hydrated.ok) {
      if (origin !== "sample") this.setStatus(`GRID replay rejected: ${hydrated.reason}`, "warn");
      return false;
    }
    // roundsByTeam always carries both team ids, so the test is for a team that has rounds.
    const ids = hydrated.teams.map((t) => t.teamId).filter((id) => hasOwn(hydrated.roundsByTeam, id) && hydrated.roundsByTeam[id].length > 0);
    if (ids.length === 0) {
      if (origin !== "sample") this.setStatus("GRID replay rejected: it has no team with rounds.", "warn");
      return false;
    }
    const ours = ids.includes(DEFAULT_OUR_TEAM_ID) ? DEFAULT_OUR_TEAM_ID : ids[0];
    const state = this.state;
    state.replay = { hydrated, origin };
    state.mapId = hydrated.mapId;
    state.ourTeamId = ours;
    state.teamId = ids.find((id) => id !== ours) ?? ours;
    state.selectedSpot = null;
    this.statusNote = note;
    this.summaryCache.clear();
    this.syncTeamOptions();
    this.renderAll();
    return true;
  }

  importGridJson() {
    const raw = this.n.gridJsonInput.value.trim();
    if (raw === "") {
      this.setStatus("Import failed: paste a GRID Series State JSON document first.", "warn");
      return;
    }
    if (raw.length > MAX_IMPORT_CHARS) {
      this.setStatus(`Import failed: the document is larger than ${MAX_IMPORT_CHARS.toLocaleString("en-US")} characters.`, "warn");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      this.setStatus(`Import failed: the text is not valid JSON (${errorText(err)}).`, "warn");
      return;
    }
    this.applyReplay(payload, "import", "imported in this browser; the coach answers locally");
  }

  async runGridQuery() {
    const { n } = this;
    const key = n.gridApiKey.value.trim();
    const headers = { "Content-Type": "application/json" };
    if (key !== "") headers["x-api-key"] = key;
    n.gridQueryBtn.disabled = true;
    n.gridOutput.textContent = "Running the query through /api/grid/query ...";
    try {
      const res = await fetch("/api/grid/query", {
        method: "POST",
        headers,
        body: JSON.stringify({ endpoint: n.gridEndpoint.value, query: n.gridQuery.value }),
      });
      const raw = await res.text();
      let shown = raw;
      try {
        shown = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // Not JSON: show the text as it came.
      }
      if (shown.length > GRID_OUTPUT_LIMIT) {
        shown = `${shown.slice(0, GRID_OUTPUT_LIMIT)}\n... (${shown.length.toLocaleString("en-US")} characters in total, shortened for display)`;
      }
      n.gridOutput.textContent = `HTTP ${res.status}\n${shown}`;
    } catch (err) {
      n.gridOutput.textContent = `The GRID query request failed: ${errorText(err)}`;
    } finally {
      n.gridQueryBtn.disabled = false;
    }
  }
}

window.__spikesight = new SpikeSightApp();
