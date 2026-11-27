// SpikeSight C9 - rosters, modelled scenario datasets and the bundled GRID-shaped replay.
//
// IMPORTANT: every number produced by this module is MODELLED scenario data. The round
// objects are shaped like GRID Series State telemetry (roundNumber, side, economyState,
// utilityEvents[], killEvents[], plantSite, operatorHoldSpots[]) but they are generated
// by a seeded model, they are not official match statistics. Player identifiers are
// slot labels built from the team short name and an agent ("C9 Jett"), not player handles.
//
// Pure module: no DOM, no I/O, no Math.random, no Date. Positions come from the real
// callout coordinates in tactical-maps.js plus a small seeded jitter.

import { MAPS, MAP_IDS, getMap, getCallout, normalizedToGame } from "./tactical-maps.js";

// ---------------------------------------------------------------------------
// Shared primitives (re-exported by scout-engine.js)
// ---------------------------------------------------------------------------

/** Mulberry32: small deterministic PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** VALORANT rule constants used by the classifier, the dataset model and the simulator. */
export const VALORANT_RULES = Object.freeze({
  pistolRounds: Object.freeze([1, 13]),
  roundsPerHalf: 12,
  roundsToWin: 13,
  // Team loadout value thresholds (the convention used on vlr.gg).
  ecoBelow: 5000,
  fullBuyFrom: 20000,
  // Per-player credit rules.
  pistolCredits: 800,
  winReward: 3000,
  lossRewards: Object.freeze([1900, 2400, 2900]),
  plantReward: 300,
  killReward: 200,
  creditCap: 9000,
  operatorCost: 4700,
});

/**
 * Economy state of one team in one round.
 *   PISTOL   roundNumber is 1 or 13
 *   ECO      team loadout value below 5,000
 *   HALF_BUY 5,000 up to but not including 20,000
 *   FULL_BUY 20,000 and above
 * A non-finite loadout value is treated as 0 (ECO).
 */
export function classifyEconomy({ roundNumber, loadoutValue } = {}) {
  if (VALORANT_RULES.pistolRounds.includes(Number(roundNumber))) return "PISTOL";
  const value = Number.isFinite(Number(loadoutValue)) ? Number(loadoutValue) : 0;
  if (value < VALORANT_RULES.ecoBelow) return "ECO";
  if (value < VALORANT_RULES.fullBuyFrom) return "HALF_BUY";
  return "FULL_BUY";
}

function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const round1 = (n) => Math.round(n * 10) / 10;
const round4 = (n) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// Agents and abilities (ability names per utility type)
// ---------------------------------------------------------------------------
const ABILITIES = {
  Omen: { smoke: "Dark Cover" },
  Astra: { smoke: "Nebula" },
  Brimstone: { smoke: "Sky Smoke", molly: "Incendiary" },
  Viper: { smoke: "Poison Cloud", molly: "Snake Bite" },
  Sova: { recon: "Recon Bolt" },
  Fade: { recon: "Haunt" },
  Skye: { flash: "Guiding Light", recon: "Trailblazer" },
  "KAY/O": { flash: "FLASH/drive" },
  Breach: { flash: "Flashpoint" },
  Gekko: { flash: "Dizzy" },
  Yoru: { flash: "Blindside" },
  Killjoy: { molly: "Nanoswarm" },
  Cypher: { recon: "Spycam" },
};

/** Drawn footprint per utility type, in normalised minimap units. */
export const UTILITY_RADIUS = Object.freeze({ smoke: 0.03, flash: 0.06, recon: 0.075, molly: 0.022 });

// ---------------------------------------------------------------------------
// Map playbooks: which callouts an execute, a hold or an Operator setup uses.
// ---------------------------------------------------------------------------
const PLAYBOOK = {
  ascent: {
    midControl: ["Mid Top", "Mid Catwalk", "Mid Courtyard"],
    sites: {
      A: { lobby: "A Lobby", chokes: ["A Main"], anchors: ["A Rafters", "A Window", "A Tree"] },
      B: { lobby: "B Lobby", chokes: ["B Main"], anchors: ["Mid Market", "B Boat House"] },
    },
    opSpots: {
      "A Rafters": { watch: "A Main", side: "defense", site: "A" },
      "Mid Bottom": { watch: "Mid Top", side: "defense", site: null },
      "B Boat House": { watch: "B Main", side: "defense", site: "B" },
      "Mid Top": { watch: "Mid Bottom", side: "attack", site: null },
      "A Lobby": { watch: "A Main", side: "attack", site: "A" },
    },
  },
  haven: {
    midControl: ["Mid Window", "Mid Courtyard", "Mid Doors"],
    sites: {
      A: { lobby: "A Lobby", chokes: ["A Long", "A Sewer"], anchors: ["A Tower", "A Link"] },
      B: { lobby: "Mid Window", chokes: ["Mid Courtyard"], anchors: ["B Back"] },
      C: { lobby: "C Lobby", chokes: ["C Long", "C Garage"], anchors: ["C Link", "C Window"] },
    },
    opSpots: {
      "A Tower": { watch: "A Long", side: "defense", site: "A" },
      "C Site": { watch: "C Long", side: "defense", site: "C" },
      "B Back": { watch: "Mid Courtyard", side: "defense", site: "B" },
      "A Lobby": { watch: "A Long", side: "attack", site: "A" },
      "Mid Window": { watch: "B Site", side: "attack", site: "B" },
    },
  },
  bind: {
    midControl: ["Attacker Side Cave", "A Link", "B Link"],
    sites: {
      A: { lobby: "A Lobby", chokes: ["A Short", "A Bath"], anchors: ["A Tower", "A Lamps"] },
      B: { lobby: "B Fountain", chokes: ["B Long", "B Window"], anchors: ["B Hall", "B Elbow", "B Garden"] },
    },
    opSpots: {
      "A Tower": { watch: "A Bath", side: "defense", site: "A" },
      "A Lamps": { watch: "A Short", side: "defense", site: "A" },
      "B Elbow": { watch: "B Long", side: "defense", site: "B" },
      "B Hall": { watch: "B Window", side: "defense", site: "B" },
      "B Fountain": { watch: "B Long", side: "attack", site: "B" },
      "A Lobby": { watch: "A Bath", side: "attack", site: "A" },
    },
  },
  lotus: {
    midControl: ["A Root", "B Pillars", "C Mound"],
    sites: {
      A: { lobby: "A Lobby", chokes: ["A Main", "A Tree"], anchors: ["A Stairs", "A Top"] },
      B: { lobby: "B Pillars", chokes: ["B Main"], anchors: ["B Upper", "A Link"] },
      C: { lobby: "C Lobby", chokes: ["C Main", "C Mound"], anchors: ["C Hall", "C Bend", "C Waterfall"] },
    },
    opSpots: {
      "A Stairs": { watch: "A Tree", side: "defense", site: "A" },
      "B Upper": { watch: "B Main", side: "defense", site: "B" },
      "C Hall": { watch: "C Main", side: "defense", site: "C" },
      "A Lobby": { watch: "A Root", side: "attack", site: "A" },
      "C Lobby": { watch: "C Mound", side: "attack", site: "C" },
    },
  },
};

// ---------------------------------------------------------------------------
// Team definitions (modelled tendencies; see the header note)
// ---------------------------------------------------------------------------
const TEAM_DEFS = [
  {
    id: "C9", name: "Cloud9", shortName: "C9", region: "Americas", gameChangers: false,
    agents: [["Jett", "Duelist"], ["Omen", "Controller"], ["Sova", "Initiator"], ["KAY/O", "Initiator"], ["Killjoy", "Sentinel"]],
    kit: { smoke: "Omen", flash: "KAY/O", recon: "Sova", molly: "Killjoy", operator: "Jett" },
    style: { strengthEdge: 0.02, executeMean: 42, utilityHitRate: 0.56, flashAssistRate: 0.38, forceRate: 0.45, opBuyRate: 0.55, opEcoRate: 0.1, opFirstBloodRate: 0.4, opRePeekRate: 0.35 },
    utilityMix: { smoke: 0.32, flash: 0.28, recon: 0.22, molly: 0.18 },
    maps: {
      ascent: { attack: { A: 0.58, B: 0.42 }, defense: { A: 0.45, B: 0.55 }, op: [["A Rafters", 0.55], ["Mid Bottom", 0.3], ["B Boat House", 0.15]], pistol: ["B", "A"] },
      haven: { attack: { A: 0.3, B: 0.2, C: 0.5 }, defense: { A: 0.35, B: 0.25, C: 0.4 }, op: [["C Site", 0.5], ["A Tower", 0.35], ["B Back", 0.15]], pistol: ["C", "C"] },
      bind: { attack: { A: 0.45, B: 0.55 }, defense: { A: 0.5, B: 0.5 }, op: [["B Elbow", 0.45], ["A Tower", 0.35], ["A Lamps", 0.2]], pistol: ["B", "A"] },
      lotus: { attack: { A: 0.45, B: 0.15, C: 0.4 }, defense: { A: 0.4, B: 0.2, C: 0.4 }, op: [["A Stairs", 0.5], ["C Hall", 0.3], ["B Upper", 0.2]], pistol: ["A", "C"] },
    },
  },
  {
    id: "C9W", name: "Cloud9 White / GC", shortName: "C9W", region: "Americas (Game Changers)", gameChangers: true,
    agents: [["Jett", "Duelist"], ["Astra", "Controller"], ["Fade", "Initiator"], ["Skye", "Initiator"], ["Viper", "Controller"]],
    kit: { smoke: "Astra", flash: "Skye", recon: "Fade", molly: "Viper", operator: "Jett" },
    style: { strengthEdge: 0, executeMean: 46, utilityHitRate: 0.52, flashAssistRate: 0.34, forceRate: 0.4, opBuyRate: 0.5, opEcoRate: 0.08, opFirstBloodRate: 0.36, opRePeekRate: 0.42 },
    utilityMix: { smoke: 0.36, flash: 0.24, recon: 0.22, molly: 0.18 },
    maps: {
      ascent: { attack: { A: 0.44, B: 0.56 }, defense: { A: 0.55, B: 0.45 }, op: [["Mid Bottom", 0.5], ["A Rafters", 0.3], ["B Boat House", 0.2]], pistol: ["A", "B"] },
      haven: { attack: { A: 0.45, B: 0.25, C: 0.3 }, defense: { A: 0.4, B: 0.3, C: 0.3 }, op: [["A Tower", 0.55], ["C Site", 0.3], ["B Back", 0.15]], pistol: ["A", "A"] },
      bind: { attack: { A: 0.6, B: 0.4 }, defense: { A: 0.45, B: 0.55 }, op: [["A Lamps", 0.45], ["B Hall", 0.35], ["B Elbow", 0.2]], pistol: ["A", "B"] },
      lotus: { attack: { A: 0.3, B: 0.25, C: 0.45 }, defense: { A: 0.35, B: 0.25, C: 0.4 }, op: [["C Hall", 0.5], ["B Upper", 0.3], ["A Stairs", 0.2]], pistol: ["C", "A"] },
    },
  },
  {
    id: "SEN", name: "Sentinels", shortName: "SEN", region: "Americas", gameChangers: false,
    agents: [["Jett", "Duelist"], ["Omen", "Controller"], ["Sova", "Initiator"], ["Breach", "Initiator"], ["Killjoy", "Sentinel"]],
    kit: { smoke: "Omen", flash: "Breach", recon: "Sova", molly: "Killjoy", operator: "Jett" },
    style: { strengthEdge: 0.03, executeMean: 44, utilityHitRate: 0.55, flashAssistRate: 0.4, forceRate: 0.55, opBuyRate: 0.5, opEcoRate: 0.12, opFirstBloodRate: 0.42, opRePeekRate: 0.56 },
    utilityMix: { smoke: 0.3, flash: 0.3, recon: 0.22, molly: 0.18 },
    maps: {
      ascent: { attack: { A: 0.65, B: 0.35 }, defense: { A: 0.5, B: 0.5 }, op: [["A Rafters", 0.45], ["B Boat House", 0.35], ["Mid Bottom", 0.2]], pistol: ["A", "B"] },
      haven: { attack: { A: 0.4, B: 0.15, C: 0.45 }, defense: { A: 0.3, B: 0.3, C: 0.4 }, op: [["C Site", 0.6], ["A Tower", 0.25], ["B Back", 0.15]], pistol: ["C", "A"] },
      bind: { attack: { A: 0.38, B: 0.62 }, defense: { A: 0.55, B: 0.45 }, op: [["A Tower", 0.5], ["B Elbow", 0.3], ["B Hall", 0.2]], pistol: ["B", "B"] },
      lotus: { attack: { A: 0.5, B: 0.2, C: 0.3 }, defense: { A: 0.45, B: 0.2, C: 0.35 }, op: [["A Stairs", 0.6], ["B Upper", 0.25], ["C Hall", 0.15]], pistol: ["A", "A"] },
    },
  },
  {
    id: "G2", name: "G2 Esports", shortName: "G2", region: "Americas", gameChangers: false,
    agents: [["Jett", "Duelist"], ["Brimstone", "Controller"], ["Fade", "Initiator"], ["Gekko", "Initiator"], ["Cypher", "Sentinel"]],
    kit: { smoke: "Brimstone", flash: "Gekko", recon: "Fade", molly: "Brimstone", operator: "Jett" },
    style: { strengthEdge: 0.04, executeMean: 48, utilityHitRate: 0.6, flashAssistRate: 0.36, forceRate: 0.35, opBuyRate: 0.45, opEcoRate: 0.06, opFirstBloodRate: 0.38, opRePeekRate: 0.3 },
    utilityMix: { smoke: 0.34, flash: 0.22, recon: 0.22, molly: 0.22 },
    maps: {
      ascent: { attack: { A: 0.48, B: 0.52 }, defense: { A: 0.4, B: 0.6 }, op: [["B Boat House", 0.5], ["Mid Bottom", 0.3], ["A Rafters", 0.2]], pistol: ["B", "B"] },
      haven: { attack: { A: 0.34, B: 0.33, C: 0.33 }, defense: { A: 0.33, B: 0.34, C: 0.33 }, op: [["B Back", 0.4], ["A Tower", 0.3], ["C Site", 0.3]], pistol: ["B", "B"] },
      bind: { attack: { A: 0.52, B: 0.48 }, defense: { A: 0.5, B: 0.5 }, op: [["B Hall", 0.4], ["A Lamps", 0.35], ["A Tower", 0.25]], pistol: ["A", "A"] },
      lotus: { attack: { A: 0.35, B: 0.3, C: 0.35 }, defense: { A: 0.35, B: 0.3, C: 0.35 }, op: [["B Upper", 0.5], ["A Stairs", 0.25], ["C Hall", 0.25]], pistol: ["B", "B"] },
    },
  },
  {
    id: "FNC", name: "Fnatic", shortName: "FNC", region: "EMEA", gameChangers: false,
    agents: [["Chamber", "Sentinel"], ["Omen", "Controller"], ["Sova", "Initiator"], ["Breach", "Initiator"], ["Viper", "Controller"]],
    kit: { smoke: "Omen", flash: "Breach", recon: "Sova", molly: "Viper", operator: "Chamber" },
    style: { strengthEdge: 0.03, executeMean: 52, utilityHitRate: 0.62, flashAssistRate: 0.42, forceRate: 0.3, opBuyRate: 0.75, opEcoRate: 0.2, opFirstBloodRate: 0.46, opRePeekRate: 0.62 },
    utilityMix: { smoke: 0.3, flash: 0.26, recon: 0.2, molly: 0.24 },
    maps: {
      ascent: { attack: { A: 0.62, B: 0.38 }, defense: { A: 0.6, B: 0.4 }, op: [["A Rafters", 0.6], ["Mid Bottom", 0.3], ["B Boat House", 0.1]], pistol: ["A", "A"] },
      haven: { attack: { A: 0.5, B: 0.15, C: 0.35 }, defense: { A: 0.45, B: 0.2, C: 0.35 }, op: [["A Tower", 0.6], ["C Site", 0.3], ["B Back", 0.1]], pistol: ["A", "C"] },
      bind: { attack: { A: 0.42, B: 0.58 }, defense: { A: 0.4, B: 0.6 }, op: [["B Elbow", 0.55], ["B Hall", 0.25], ["A Tower", 0.2]], pistol: ["B", "B"] },
      lotus: { attack: { A: 0.25, B: 0.2, C: 0.55 }, defense: { A: 0.3, B: 0.25, C: 0.45 }, op: [["C Hall", 0.55], ["A Stairs", 0.3], ["B Upper", 0.15]], pistol: ["C", "C"] },
    },
  },
  {
    id: "PRX", name: "PRX", shortName: "PRX", region: "Pacific", gameChangers: false,
    agents: [["Jett", "Duelist"], ["Yoru", "Duelist"], ["Omen", "Controller"], ["Skye", "Initiator"], ["Killjoy", "Sentinel"]],
    kit: { smoke: "Omen", flash: "Yoru", recon: "Skye", molly: "Killjoy", operator: "Jett" },
    style: { strengthEdge: 0.02, executeMean: 34, utilityHitRate: 0.48, flashAssistRate: 0.44, forceRate: 0.7, opBuyRate: 0.35, opEcoRate: 0.15, opFirstBloodRate: 0.34, opRePeekRate: 0.7 },
    utilityMix: { smoke: 0.26, flash: 0.38, recon: 0.16, molly: 0.2 },
    maps: {
      ascent: { attack: { A: 0.4, B: 0.6 }, defense: { A: 0.5, B: 0.5 }, op: [["Mid Bottom", 0.6], ["A Rafters", 0.25], ["B Boat House", 0.15]], pistol: ["B", "A"] },
      haven: { attack: { A: 0.25, B: 0.4, C: 0.35 }, defense: { A: 0.3, B: 0.4, C: 0.3 }, op: [["B Back", 0.5], ["C Site", 0.3], ["A Tower", 0.2]], pistol: ["B", "B"] },
      bind: { attack: { A: 0.55, B: 0.45 }, defense: { A: 0.5, B: 0.5 }, op: [["A Lamps", 0.5], ["B Elbow", 0.3], ["B Hall", 0.2]], pistol: ["A", "B"] },
      lotus: { attack: { A: 0.4, B: 0.35, C: 0.25 }, defense: { A: 0.35, B: 0.35, C: 0.3 }, op: [["B Upper", 0.55], ["A Stairs", 0.25], ["C Hall", 0.2]], pistol: ["B", "A"] },
    },
  },
];

function calloutPoint(mapId, name) {
  const c = getCallout(mapId, name);
  if (!c) throw new Error(`pro-data: unknown callout "${name}" on ${mapId}`);
  return { x: c.x, y: c.y };
}

function unitVector(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { dx: 0, dy: 0 };
  return { dx: round4(dx / len), dy: round4(dy / len) };
}

function holdSpotProfile(mapId, calloutName, weight) {
  const spec = PLAYBOOK[mapId].opSpots[calloutName];
  if (!spec) throw new Error(`pro-data: "${calloutName}" is not an Operator spot on ${mapId}`);
  const at = calloutPoint(mapId, calloutName);
  const watch = calloutPoint(mapId, spec.watch);
  const dir = unitVector(at, watch);
  return { callout: calloutName, watch: spec.watch, side: spec.side, site: spec.site, weight, x: round4(at.x), y: round4(at.y), dx: dir.dx, dy: dir.dy };
}

function buildTeam(def) {
  const roster = def.agents.map(([agent, role]) => ({
    slot: `${def.shortName} ${agent}`,
    agent,
    role,
    operator: agent === def.kit.operator,
  }));
  const maps = {};
  for (const mapId of MAP_IDS) {
    const m = def.maps[mapId];
    const book = PLAYBOOK[mapId];
    const attackSpots = Object.entries(book.opSpots).filter(([, s]) => s.side === "attack");
    const [attackSite, defenseSite] = m.pistol;
    const smoke = ABILITIES[def.kit.smoke].smoke;
    const molly = ABILITIES[def.kit.molly].molly;
    maps[mapId] = {
      siteBias: { attack: { ...m.attack }, defense: { ...m.defense } },
      executeWindow: { from: def.style.executeMean - 6, to: def.style.executeMean + 6 },
      utilityMix: { ...def.utilityMix },
      operator: {
        buyRoundRate: def.style.opBuyRate,
        ecoRoundRate: def.style.opEcoRate,
        holdSpots: [
          ...m.op.map(([name, weight]) => holdSpotProfile(mapId, name, weight)),
          ...attackSpots.map(([name]) => holdSpotProfile(mapId, name, round4(1 / attackSpots.length))),
        ],
      },
      pistol: {
        attackSite,
        defenseSite,
        attackPlan: `Hit ${attackSite} through ${book.sites[attackSite].chokes[0]} behind ${def.kit.smoke} ${smoke}`,
        defensePlan: `Stack ${defenseSite} and delay ${book.sites[defenseSite].chokes[0]} with ${def.kit.molly} ${molly}`,
      },
    };
  }
  return {
    id: def.id,
    name: def.name,
    shortName: def.shortName,
    region: def.region,
    gameChangers: def.gameChangers,
    roster,
    kit: { ...def.kit },
    style: { ...def.style },
    maps,
  };
}

/** Six curated rosters keyed by id: C9, C9W, SEN, G2, FNC, PRX. */
export const TEAMS = deepFreeze(Object.fromEntries(TEAM_DEFS.map((def) => [def.id, buildTeam(def)])));

export const TEAM_IDS = Object.freeze(TEAM_DEFS.map((def) => def.id));

/** Resolve a team id, name or short name (case-insensitive) to a TEAMS id, or null. */
export function findTeamId(text) {
  if (typeof text !== "string") return null;
  const wanted = text.trim().toLowerCase();
  if (!wanted) return null;
  for (const id of TEAM_IDS) {
    const t = TEAMS[id];
    if (id.toLowerCase() === wanted || t.name.toLowerCase() === wanted || t.shortName.toLowerCase() === wanted) return id;
  }
  if (wanted === "cloud9 white" || wanted === "cloud9 white gc" || wanted === "c9 white") return "C9W";
  if (wanted === "paper rex") return "PRX";
  if (wanted === "g2") return "G2";
  return null;
}

// ---------------------------------------------------------------------------
// Round model
// ---------------------------------------------------------------------------
const WEAPONS = {
  PISTOL: ["Classic", "Ghost", "Sheriff", "Frenzy"],
  ECO: ["Sheriff", "Classic", "Ghost", "Marshal"],
  HALF_BUY: ["Spectre", "Bulldog", "Sheriff", "Marshal"],
  FULL_BUY: ["Vandal", "Phantom", "Vandal", "Phantom"],
};
// How much of the playbook a team can afford per economy state (probability scale).
const UTILITY_BUDGET = { PISTOL: 0.5, ECO: 0.45, HALF_BUY: 0.8, FULL_BUY: 1 };
// Modelled round win edge by own economy against an average opponent buy.
const ECONOMY_EDGE = { PISTOL: 0, ECO: -0.26, HALF_BUY: -0.08, FULL_BUY: 0.05 };

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function pickWeighted(rng, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

function jitter(rng, point, amount = 0.012) {
  const x = point.x + (rng() * 2 - 1) * amount;
  const y = point.y + (rng() * 2 - 1) * amount;
  return { x: round4(Math.min(0.99, Math.max(0.01, x))), y: round4(Math.min(0.99, Math.max(0.01, y))) };
}

function newEconomy() {
  return { bank: 5 * VALORANT_RULES.pistolCredits, lossStreak: 0, lastLoadout: 0, lastWon: false };
}

/** Choose this round's team loadout value from the team bank. Returns { credits, loadoutValue }. */
function buyRound(rng, eco, roundNumber, forceRate) {
  const credits = eco.bank;
  let loadout;
  let carried = 0;
  if (VALORANT_RULES.pistolRounds.includes(roundNumber)) {
    loadout = 2900 + Math.floor(rng() * 1000);
  } else {
    // Weapons that survived the previous round keep part of their value.
    carried = Math.round(eco.lastLoadout * (eco.lastWon ? 0.55 : 0.12));
    const budget = eco.bank + carried;
    if (budget >= 22000) {
      loadout = Math.min(budget, 21000 + Math.floor(rng() * 5500));
    } else if (budget >= 9500 && (eco.lastWon || rng() < forceRate)) {
      loadout = Math.max(5200, Math.min(19400, Math.round(budget * (0.72 + rng() * 0.2))));
    } else {
      loadout = Math.min(4800, 1200 + Math.floor(rng() * 3000));
    }
  }
  loadout = Math.round(loadout / 50) * 50;
  eco.bank = Math.max(0, eco.bank - Math.max(0, loadout - carried));
  eco.lastLoadout = loadout;
  return { credits, loadoutValue: loadout };
}

function settleRound(eco, { won, kills, plantBonus }) {
  const r = VALORANT_RULES;
  if (won) {
    eco.bank += 5 * r.winReward;
    eco.lossStreak = 0;
  } else {
    eco.bank += 5 * r.lossRewards[Math.min(eco.lossStreak, r.lossRewards.length - 1)];
    eco.lossStreak += 1;
  }
  eco.bank += kills * r.killReward + (plantBonus ? 5 * r.plantReward : 0);
  eco.bank = Math.min(eco.bank, 5 * r.creditCap);
  eco.lastWon = won;
}

/** Round facts shared by both teams: where the attackers went and whether the spike went down. */
function rollRoundFacts(rng, { mapId, attackBias, pistolSite, executeMean, attackersWon, pistol, lowBuy }) {
  const sites = MAPS[mapId].sites;
  let targetSite;
  if (attackBias) {
    targetSite = pistol && pistolSite && rng() < 0.7 ? pistolSite : pickWeighted(rng, Object.entries(attackBias));
  } else {
    targetSite = pick(rng, sites);
  }
  let executeTime = executeMean + (rng() * 2 - 1) * 8 - (pistol ? 6 : 0) - (lowBuy ? 4 : 0);
  executeTime = round1(Math.min(63, Math.max(31, executeTime)));
  const planted = rng() < (attackersWon ? 0.78 : 0.42);
  const plantTime = planted ? round1(executeTime + 9 + rng() * 10) : null;
  let winCondition;
  if (attackersWon) winCondition = planted && rng() < 0.6 ? "spike-detonated" : "elimination";
  else if (planted) winCondition = rng() < 0.7 ? "spike-defused" : "elimination";
  else winCondition = rng() < 0.7 ? "elimination" : "time-expired";
  return { targetSite, executeTime, planted, plantSite: planted ? targetSite : null, plantTime, winCondition };
}

/**
 * Build one team's view of a round. `ctx` carries the team, the map, the round facts
 * and the team's own state for this round.
 */
function buildTeamRound(rng, ctx) {
  const { team, mapId, roundNumber, side, won, economyState, loadoutValue, credits, facts, stackSite, victims, firstBloodOurs } = ctx;
  const book = PLAYBOOK[mapId];
  const profile = team.maps[mapId];
  const style = team.style;
  const mix = profile.utilityMix;
  const budget = UTILITY_BUDGET[economyState];
  const P = (name) => calloutPoint(mapId, name);
  const target = book.sites[facts.targetSite];
  const siteCallout = (site) => `${site} Site`;
  const utilityEvents = [];

  const addUtility = (type, { at, toward = null, time, postPlant = false, site = null }) => {
    const agent = team.kit[type];
    const position = jitter(rng, P(at));
    const hit = rng() < style.utilityHitRate;
    const assistedKill = hit && rng() < (type === "flash" ? style.flashAssistRate / style.utilityHitRate : 0.18);
    utilityEvents.push({
      type,
      ability: ABILITIES[agent][type],
      agent,
      player: `${team.shortName} ${agent}`,
      time: round1(time),
      position,
      direction: toward ? unitVector(position, P(toward)) : null,
      radius: UTILITY_RADIUS[type],
      enemiesAffected: hit ? 1 + Math.floor(rng() * (type === "flash" ? 3 : 2)) : 0,
      assistedKill,
      postPlant,
      site,
    });
  };
  const chance = (p) => rng() < p;
  const between = (lo, hi) => lo + rng() * (hi - lo);

  if (side === "attack") {
    const site = facts.targetSite;
    const t = facts.executeTime;
    const choke = target.chokes[Math.floor(rng() * target.chokes.length)];
    // Default phase (0 to 30 s): map control.
    if (chance(budget)) addUtility("recon", { at: book.midControl[0], toward: book.midControl[1], time: between(6, 20) });
    if (chance(budget * 0.7)) addUtility("smoke", { at: book.midControl[1], time: between(10, 26) });
    if (chance(budget * mix.flash * 1.5)) addUtility("flash", { at: target.lobby, toward: choke, time: between(14, 28), site });
    // Execute phase (30 to 65 s).
    if (chance(Math.max(budget, 0.7))) addUtility("smoke", { at: target.anchors[0], time: t, site });
    if (target.anchors[1] && chance(budget)) addUtility("smoke", { at: target.anchors[1], time: t + 1, site });
    if (chance(budget * 0.9)) addUtility("recon", { at: choke, toward: siteCallout(site), time: Math.max(30, t - 2), site });
    if (chance(budget)) addUtility("flash", { at: choke, toward: siteCallout(site), time: t + 2, site });
    if (chance(budget * mix.flash * 2)) addUtility("flash", { at: choke, toward: target.anchors[0], time: t + 4, site });
    if (chance(budget * mix.molly * 3)) addUtility("molly", { at: target.anchors[target.anchors.length - 1], time: t + 5, site });
    // Post-plant.
    if (facts.planted) {
      const pt = facts.plantTime;
      if (chance(budget * 0.5)) addUtility("smoke", { at: target.anchors[0], time: pt + between(3, 10), postPlant: true, site });
      if (chance(budget * 0.4)) addUtility("recon", { at: siteCallout(site), toward: target.anchors[0], time: pt + between(5, 15), postPlant: true, site });
      if (chance(budget * 0.9)) addUtility("molly", { at: siteCallout(site), time: pt + between(12, 30), postPlant: true, site });
    }
  } else {
    const stack = book.sites[stackSite];
    const hitSite = facts.targetSite;
    const t = facts.executeTime;
    // Default phase: setup on the stacked site.
    if (chance(budget * 0.9)) addUtility("recon", { at: stack.chokes[0], toward: stack.lobby, time: between(3, 15), site: stackSite });
    if (chance(budget)) addUtility("smoke", { at: stack.chokes[0], time: between(4, 20), site: stackSite });
    if (chance(budget * mix.flash * 2)) addUtility("flash", { at: siteCallout(stackSite), toward: stack.chokes[0], time: between(8, 26), site: stackSite });
    if (chance(budget * mix.molly * 3)) addUtility("molly", { at: stack.chokes[0], time: between(12, 28), site: stackSite });
    if (chance(budget * 0.5)) addUtility("recon", { at: book.midControl[2], toward: book.midControl[1], time: between(5, 18) });
    // Execute phase: reaction to the hit.
    if (chance(budget * 0.8)) addUtility("smoke", { at: target.chokes[0], time: t + between(1, 4), site: hitSite });
    if (chance(budget * mix.flash * 2.5)) addUtility("flash", { at: target.anchors[0], toward: target.chokes[0], time: t + between(2, 6), site: hitSite });
    if (chance(budget * mix.molly * 2.5)) addUtility("molly", { at: target.chokes[0], time: t + between(1, 5), site: hitSite });
    // Post-plant: retake.
    if (facts.planted) {
      const pt = facts.plantTime;
      if (chance(budget * 0.6)) addUtility("recon", { at: target.anchors[0], toward: siteCallout(hitSite), time: pt + between(4, 10), postPlant: true, site: hitSite });
      if (chance(budget * 0.8)) addUtility("smoke", { at: siteCallout(hitSite), time: pt + between(6, 16), postPlant: true, site: hitSite });
      if (chance(budget * 0.8)) addUtility("flash", { at: target.anchors[0], toward: siteCallout(hitSite), time: pt + between(8, 18), postPlant: true, site: hitSite });
    }
  }
  utilityEvents.sort((a, b) => a.time - b.time);

  // Operator hold.
  const operatorHoldSpots = [];
  const opRate = economyState === "PISTOL" ? 0 : economyState === "FULL_BUY" ? style.opBuyRate : style.opEcoRate * (economyState === "HALF_BUY" ? 1.3 : 0.7);
  if (rng() < opRate) {
    const options = profile.operator.holdSpots.filter((s) => s.side === side);
    const spot = pickWeighted(rng, options.map((s) => [s, s.weight]));
    const position = jitter(rng, { x: spot.x, y: spot.y }, 0.008);
    const watch = P(spot.watch);
    const firstBlood = firstBloodOurs !== false && rng() < style.opFirstBloodRate;
    const rePeeked = rng() < style.opRePeekRate;
    operatorHoldSpots.push({
      player: `${team.shortName} ${team.kit.operator}`,
      position,
      sightline: unitVector(position, watch),
      fovDeg: round1(14 + rng() * 8),
      range: round4(Math.hypot(watch.x - position.x, watch.y - position.y) * 1.25),
      firstBlood,
      rePeeked,
      kills: (firstBlood ? 1 : 0) + (rng() < 0.35 ? 1 : 0),
      callout: spot.callout,
      watch: spot.watch,
      site: spot.site,
    });
  }

  // Kills made by this team.
  const hold = operatorHoldSpots[0] ?? null;
  const eliminated = facts.winCondition === "elimination" && won;
  let killCount = eliminated ? 5 : won ? 3 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 4);
  if (hold) killCount = Math.max(killCount, hold.kills);
  killCount = Math.min(killCount, victims.length);
  const oursFirst = hold?.firstBlood ? true : firstBloodOurs ?? rng() < 0.45 + style.strengthEdge;
  const killerSpots = side === "attack" ? [...target.chokes, siteCallout(facts.targetSite)] : [...target.anchors, siteCallout(facts.targetSite)];
  const victimSpots = side === "attack" ? [...target.anchors, siteCallout(facts.targetSite)] : [...target.chokes, target.lobby];
  const others = team.roster.filter((p) => !p.operator);
  const killEvents = [];
  let clock = oursFirst ? between(14, 34) : between(38, 50);
  for (let i = 0; i < killCount; i += 1) {
    const byOperator = hold !== null && i < hold.kills;
    killEvents.push({
      time: round1(clock),
      killer: byOperator ? hold.player : pick(rng, others).slot,
      victim: victims[i],
      weapon: byOperator ? "Operator" : pick(rng, WEAPONS[economyState]),
      killerPosition: byOperator ? { ...hold.position } : jitter(rng, P(pick(rng, killerSpots))),
      victimPosition: byOperator ? jitter(rng, P(hold.watch)) : jitter(rng, P(pick(rng, victimSpots))),
      firstBlood: i === 0 && oursFirst,
    });
    clock += between(2, 11);
  }

  return {
    roundNumber,
    side,
    economyState,
    loadoutValue,
    credits,
    won,
    winCondition: facts.winCondition,
    plantSite: facts.plantSite,
    plantTime: facts.plantTime,
    utilityEvents,
    killEvents,
    operatorHoldSpots,
  };
}

function shuffled(rng, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const OPPONENT_SLOTS = ["Opponent 1", "Opponent 2", "Opponent 3", "Opponent 4", "Opponent 5"];
const roundsCache = new Map();

/**
 * Deterministic 24-round modelled dataset for one team on one map: 12 attack and 12
 * defense rounds, pistol rounds at 1 and 13. The result is cached and frozen.
 */
export function getTeamRounds(teamId, mapId) {
  if (!Object.prototype.hasOwnProperty.call(TEAMS, teamId)) {
    throw new RangeError(`Unknown team id "${String(teamId)}". Valid ids: ${TEAM_IDS.join(", ")}.`);
  }
  const map = getMap(mapId);
  const key = `${teamId}:${map.id}`;
  const cached = roundsCache.get(key);
  if (cached) return cached;

  const team = TEAMS[teamId];
  const profile = team.maps[map.id];
  const seed = hashString(`spikesight:${key}`);
  const rng = mulberry32(seed);
  const attackFirst = (seed & 1) === 0;
  const rounds = [];
  let eco = newEconomy();
  for (let roundNumber = 1; roundNumber <= 24; roundNumber += 1) {
    if (roundNumber === 13) eco = newEconomy();
    const side = roundNumber <= 12 === attackFirst ? "attack" : "defense";
    const pistol = VALORANT_RULES.pistolRounds.includes(roundNumber);
    const { credits, loadoutValue } = buyRound(rng, eco, roundNumber, team.style.forceRate);
    const economyState = classifyEconomy({ roundNumber, loadoutValue });
    const sideEdge = side === "attack" ? -0.01 : 0.01;
    const won = rng() < 0.5 + team.style.strengthEdge + ECONOMY_EDGE[economyState] + sideEdge;
    const facts = rollRoundFacts(rng, {
      mapId: map.id,
      attackBias: side === "attack" ? profile.siteBias.attack : null,
      pistolSite: profile.pistol.attackSite,
      executeMean: side === "attack" ? team.style.executeMean : 44,
      attackersWon: side === "attack" ? won : !won,
      pistol,
      lowBuy: side === "attack" && economyState === "ECO",
    });
    const stackSite = side === "defense"
      ? pistol && rng() < 0.7 ? profile.pistol.defenseSite : pickWeighted(rng, Object.entries(profile.siteBias.defense))
      : null;
    const round = buildTeamRound(rng, {
      team, mapId: map.id, roundNumber, side, won, economyState, loadoutValue, credits, facts, stackSite,
      victims: shuffled(rng, OPPONENT_SLOTS),
    });
    settleRound(eco, { won, kills: round.killEvents.length, plantBonus: side === "attack" && facts.planted });
    rounds.push(round);
  }
  const frozen = deepFreeze(rounds);
  roundsCache.set(key, frozen);
  return frozen;
}

// ---------------------------------------------------------------------------
// Bundled GRID-shaped replay: Cloud9 vs Fnatic, Ascent, 13-10 (modelled sample)
// ---------------------------------------------------------------------------
const SAMPLE_SEED = 0x00c9f13c;
// C = Cloud9 wins the round, F = Fnatic wins. 12 rounds, then 11: 7-5 at the half, 13-10 final.
const SAMPLE_WINNERS = "CCFCCFFCCFCF" + "FCCFCFCFFCC";

function toGamePoint(mapId, point) {
  const g = normalizedToGame(mapId, point.x, point.y);
  return { x: round1(g.x), y: round1(g.y) };
}

function toGameDirection(mapId, dir) {
  if (!dir) return null;
  const t = MAPS[mapId].transform;
  // Minimap dx comes from game y and minimap dy from game x (see tactical-maps.js).
  const gx = dir.dy / t.yMultiplier;
  const gy = dir.dx / t.xMultiplier;
  const len = Math.hypot(gx, gy);
  return len === 0 ? { dx: 0, dy: 0 } : { dx: round4(gx / len), dy: round4(gy / len) };
}

function toGameTeamEntry(mapId, teamRef, round) {
  const scale = Math.abs(MAPS[mapId].transform.xMultiplier);
  return {
    id: teamRef.id,
    name: teamRef.name,
    side: round.side,
    won: round.won,
    economyState: round.economyState,
    loadoutValue: round.loadoutValue,
    credits: round.credits,
    utilityEvents: round.utilityEvents.map((e) => ({
      ...e,
      position: toGamePoint(mapId, e.position),
      direction: toGameDirection(mapId, e.direction),
      radius: Math.round(e.radius / scale),
    })),
    killEvents: round.killEvents.map((k) => ({
      ...k,
      killerPosition: toGamePoint(mapId, k.killerPosition),
      victimPosition: toGamePoint(mapId, k.victimPosition),
    })),
    operatorHoldSpots: round.operatorHoldSpots.map((h) => ({
      ...h,
      position: toGamePoint(mapId, h.position),
      sightline: toGameDirection(mapId, h.sightline),
      range: Math.round(h.range / scale),
    })),
  };
}

function buildSampleSeries() {
  const mapId = "ascent";
  const rng = mulberry32(SAMPLE_SEED);
  const refs = { C: { id: "sample-c9", name: "Cloud9", team: TEAMS.C9 }, F: { id: "sample-fnc", name: "Fnatic", team: TEAMS.FNC } };
  const eco = { C: newEconomy(), F: newEconomy() };
  const score = { C: 0, F: 0 };
  const segments = [];
  for (let i = 0; i < SAMPLE_WINNERS.length; i += 1) {
    const roundNumber = i + 1;
    if (roundNumber === 13) {
      eco.C = newEconomy();
      eco.F = newEconomy();
    }
    const winner = SAMPLE_WINNERS[i];
    const attacker = roundNumber <= 12 ? "C" : "F";
    const defender = attacker === "C" ? "F" : "C";
    const pistol = VALORANT_RULES.pistolRounds.includes(roundNumber);
    const buys = {};
    for (const k of ["C", "F"]) {
      const buy = buyRound(rng, eco[k], roundNumber, refs[k].team.style.forceRate);
      buys[k] = { ...buy, economyState: classifyEconomy({ roundNumber, loadoutValue: buy.loadoutValue }) };
    }
    const atkProfile = refs[attacker].team.maps[mapId];
    const defProfile = refs[defender].team.maps[mapId];
    const facts = rollRoundFacts(rng, {
      mapId,
      attackBias: atkProfile.siteBias.attack,
      pistolSite: atkProfile.pistol.attackSite,
      executeMean: refs[attacker].team.style.executeMean,
      attackersWon: winner === attacker,
      pistol,
      lowBuy: buys[attacker].economyState === "ECO",
    });
    const stackSite = pistol && rng() < 0.7 ? defProfile.pistol.defenseSite : pickWeighted(rng, Object.entries(defProfile.siteBias.defense));
    const firstBloodTeam = rng() < 0.5 ? "C" : "F";
    const entries = [];
    for (const k of ["C", "F"]) {
      const other = k === "C" ? "F" : "C";
      const round = buildTeamRound(rng, {
        team: refs[k].team, mapId, roundNumber,
        side: k === attacker ? "attack" : "defense",
        won: winner === k,
        economyState: buys[k].economyState, loadoutValue: buys[k].loadoutValue, credits: buys[k].credits,
        facts, stackSite,
        victims: shuffled(rng, refs[other].team.roster.map((p) => p.slot)),
        firstBloodOurs: firstBloodTeam === k,
      });
      settleRound(eco[k], { won: winner === k, kills: round.killEvents.length, plantBonus: k === attacker && facts.planted });
      entries.push(toGameTeamEntry(mapId, refs[k], round));
    }
    score[winner] += 1;
    segments.push({
      id: `sample-ascent-r${roundNumber}`,
      type: "round",
      sequenceNumber: roundNumber,
      roundNumber,
      finished: true,
      winner: refs[winner].name,
      winCondition: facts.winCondition,
      plantSite: facts.plantSite,
      plantTime: facts.plantTime,
      teams: entries,
    });
  }
  return {
    data: {
      seriesState: {
        id: "spikesight-sample-c9-fnc-ascent",
        dataset: "Modelled sample shaped like GRID Series State. Not official match statistics.",
        positionUnits: "game",
        title: { nameShortened: "val" },
        format: "best-of-1",
        started: true,
        finished: true,
        teams: [
          { id: refs.C.id, name: "Cloud9", score: 1, won: true },
          { id: refs.F.id, name: "Fnatic", score: 0, won: false },
        ],
        games: [
          {
            id: "spikesight-sample-c9-fnc-ascent-g1",
            sequenceNumber: 1,
            started: true,
            finished: true,
            map: { name: mapId },
            teams: [
              { id: refs.C.id, name: "Cloud9", score: score.C, won: score.C > score.F },
              { id: refs.F.id, name: "Fnatic", score: score.F, won: score.F > score.C },
            ],
            segments,
          },
        ],
      },
    },
  };
}

/** Frozen GRID-shaped payload (positions in GAME units) for one-click hydration. */
export const SAMPLE_GRID_SERIES = deepFreeze(buildSampleSeries());
