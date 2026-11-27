// SpikeSight C9 - behavioural tests for the pure modules and the Worker.
// Run with: node --test tests/*.test.mjs   (no packages, no network)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAP_IDS, MAPS, clamp01, gameToNormalized, getCallout, normalizedToGame, normalizedToSvg, pointInPolygon, siteAt, zoneAt,
} from "../public/js/tactical-maps.js";
import { SAMPLE_GRID_SERIES, TEAMS, getTeamRounds } from "../public/js/pro-data.js";
import {
  BUY_POLICY_LABELS, ECONOMY_LABELS, ECONOMY_STATES, ROUND_PHASES, SAVE_SCENARIOS, UTILITY_TYPES,
  buildDeterministicCoachAnswer, buildOperatorProfile, buildScoutSummary, chooseBuy, classifyEconomy, classifyPhase, clusterUtility,
  computeUtilityMetrics, evaluateForceBuy, evaluateSaveVsRetake, filterUtility, generateDossier, hydrateGridSeries,
  isInSightCone, lossBonusCredits, mapWinner, mulberry32, recommendAntiOp, roundWinProbability, settleSimRound, sideForNextRound,
  sightlineAngleDeg, sightlineCone, simulateMap, summarizeEconomy,
} from "../public/js/scout-engine.js";
import worker, {
  AI_MODEL, COACH_FALLBACKS, COACH_LIMIT_PER_MINUTE, GRID_ALLOWED_HOSTS, GRID_ALLOWED_PATHS, resolveGridTarget,
} from "../worker/index.js";

// ---------------------------------------------------------------------------
// Helpers and hand-built fixtures
// ---------------------------------------------------------------------------
const near = (actual, expected, tolerance, label = "") => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} +/- ${tolerance}, got ${actual}`);
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const in01 = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Utility event with neutral defaults. */
const ev = (type, time, x, y, extra = {}) => ({
  type, ability: "Test", agent: "Agent", player: "T Agent", time, position: { x, y }, direction: null, radius: 0.03,
  enemiesAffected: 0, assistedKill: false, postPlant: false, site: null, ...extra,
});
/** Round with neutral defaults. */
const rd = (roundNumber, side, extra = {}) => ({
  roundNumber, side, economyState: "FULL_BUY", loadoutValue: 21000, credits: 0, won: false, winCondition: "elimination",
  plantSite: null, plantTime: null, utilityEvents: [], killEvents: [], operatorHoldSpots: [], ...extra,
});
/** Operator hold spot with neutral defaults. */
const hold = (callout, x, y, dx, dy, extra = {}) => ({
  player: "T Jett", position: { x, y }, sightline: { dx, dy }, fovDeg: 20, range: 0.3, firstBlood: false, rePeeked: false, kills: 0, callout, ...extra,
});

// Two rounds, nine utility events, used by the filter tests.
const FILTER_ROUNDS = [
  rd(2, "attack", {
    plantSite: "A", plantTime: 50,
    utilityEvents: [
      ev("smoke", 10, 0.3, 0.3),
      ev("flash", 29.9, 0.4, 0.4),
      ev("flash", 30, 0.41, 0.4),
      ev("recon", 45, 0.5, 0.5),
      ev("molly", 55, 0.6, 0.6),            // at or after the plant at 50 s -> post-plant
    ],
  }),
  rd(3, "defense", {
    utilityEvents: [
      ev("smoke", 5, 0.32, 0.3),
      ev("flash", 40, 0.7, 0.7),
      ev("flash", 70, 0.7, 0.72),           // no plant in this round -> still execute
      ev("molly", 80, 0.2, 0.8, { postPlant: true }),
    ],
  }),
];

// Nine rounds with four Operator holds, used by the profiler tests.
const OPERATOR_ROUNDS = [
  rd(1, "defense", { economyState: "PISTOL", loadoutValue: 3400 }),
  rd(2, "defense", { operatorHoldSpots: [hold("Rafters", 0.2, 0.2, 1, 0, { firstBlood: true, rePeeked: true, kills: 2 })] }),
  rd(3, "defense", { operatorHoldSpots: [hold("Rafters", 0.22, 0.2, 1, 0, { rePeeked: true, kills: 1 })] }),
  rd(4, "defense"),
  rd(5, "defense", { operatorHoldSpots: [hold("Rafters", 0.21, 0.23, 1, 0, { firstBlood: true })] }),
  rd(6, "defense", { economyState: "ECO", loadoutValue: 2000 }),
  rd(7, "defense", { economyState: "HALF_BUY", loadoutValue: 12000, operatorHoldSpots: [hold("Market", 0.6, 0.6, 0, 1, { firstBlood: true, kills: 1 })] }),
  rd(8, "defense", { economyState: "ECO", loadoutValue: 1500 }),
  rd(9, "defense", { economyState: "ECO", loadoutValue: 3000 }),
];

function allPositions(round) {
  return [
    ...round.utilityEvents.map((e) => e.position),
    ...round.killEvents.flatMap((k) => [k.killerPosition, k.victimPosition]),
    ...round.operatorHoldSpots.map((h) => h.position),
  ];
}

// ===========================================================================
// (a) Map coordinate normalisation and zone geometry
// ===========================================================================

test("gameToNormalized applies the Riot minimap transform (hand-computed callouts)", () => {
  // Ascent A Site: nx = -6626 * 0.00007 + 0.813895 = 0.350075; ny = 6154 * -0.00007 + 0.573242 = 0.142462
  const aSite = gameToNormalized("ascent", 6154, -6626);
  near(aSite.x, 0.350, 0.002, "ascent A x");
  near(aSite.y, 0.142, 0.002, "ascent A y");
  near(aSite.x, 0.350075, 1e-9, "ascent A x exact");
  near(aSite.y, 0.142462, 1e-9, "ascent A y exact");
  // Haven C Site: nx = -9010.56 * 0.000075 + 1.09345 = 0.417658; ny = -2378.13 * -0.000075 + 0.642728 = 0.821088
  const cSite = gameToNormalized("haven", -2378.13, -9010.56);
  near(cSite.x, 0.418, 0.002, "haven C x");
  near(cSite.y, 0.821, 0.002, "haven C y");
  // Bind attacker spawn and Lotus B Site from the same formula.
  const bindSpawn = gameToNormalized("bind", 161.65, 77.51);
  near(bindSpawn.x, 0.5815, 0.0005, "bind spawn x");
  near(bindSpawn.y, 0.958, 0.0005, "bind spawn y");
  const lotusB = gameToNormalized("lotus", 6368.03, 668.18);
  near(lotusB.x, 0.5029, 0.0005, "lotus B x");
  near(lotusB.y, 0.4593, 0.0005, "lotus B y");
});

test("map transforms and callout counts match the published constants", () => {
  assert.deepEqual([...MAP_IDS], ["ascent", "haven", "bind", "lotus"]);
  assert.deepEqual(plain(MAPS.ascent.transform), { xMultiplier: 0.00007, yMultiplier: -0.00007, xScalarToAdd: 0.813895, yScalarToAdd: 0.573242 });
  assert.deepEqual(plain(MAPS.haven.transform), { xMultiplier: 0.000075, yMultiplier: -0.000075, xScalarToAdd: 1.09345, yScalarToAdd: 0.642728 });
  assert.deepEqual(plain(MAPS.bind.transform), { xMultiplier: 0.000059, yMultiplier: -0.000059, xScalarToAdd: 0.576941, yScalarToAdd: 0.967566 });
  assert.deepEqual(plain(MAPS.lotus.transform), { xMultiplier: 0.000072, yMultiplier: -0.000072, xScalarToAdd: 0.454789, yScalarToAdd: 0.917752 });
  assert.deepEqual(MAP_IDS.map((id) => MAPS[id].callouts.length), [22, 21, 24, 28]);
  for (const id of MAP_IDS) {
    for (const c of MAPS[id].callouts) assert.ok(in01(c.x) && in01(c.y), `${id} ${c.superRegion} ${c.region} is on the minimap`);
  }
});

test("normalizedToGame is the exact inverse of gameToNormalized", () => {
  const origin = normalizedToGame("ascent", 0.813895, 0.573242);
  near(origin.x, 0, 1e-6, "origin x");
  near(origin.y, 0, 1e-6, "origin y");
  const samples = [[6154, -6626], [-2344.06, -7548.51], [0, 0], [14641.92, -1017.67], [-4484.77, 5874.5]];
  for (const id of MAP_IDS) {
    for (const [gx, gy] of samples) {
      const n = gameToNormalized(id, gx, gy);
      const back = normalizedToGame(id, n.x, n.y);
      near(back.x, gx, 1, `${id} game x`);
      near(back.y, gy, 1, `${id} game y`);
    }
  }
});

test("normalizedToSvg scales to the viewBox and clamp01 bounds its input", () => {
  assert.deepEqual(normalizedToSvg({ x: 0.25, y: 0.5 }), { x: 250, y: 500 });
  assert.deepEqual(normalizedToSvg({ x: 0.25, y: 0.5 }, 400), { x: 100, y: 200 });
  assert.equal(clamp01(-0.4), 0);
  assert.equal(clamp01(1.7), 1);
  assert.equal(clamp01(0.3), 0.3);
  assert.equal(clamp01(Number.NaN), 0);
});

test("an unknown map id throws a RangeError that lists the valid ids", () => {
  for (const call of [
    () => gameToNormalized("split", 0, 0),
    () => normalizedToGame("icebox", 0.5, 0.5),
    () => zoneAt("pearl", 0.5, 0.5),
    () => getCallout(undefined, "A", "Site"),
  ]) {
    assert.throws(call, (err) => err instanceof RangeError && /ascent, haven, bind, lotus/.test(err.message));
  }
});

test("every map has its site list and the required tactical zones", () => {
  const expectedSites = { ascent: ["A", "B"], haven: ["A", "B", "C"], bind: ["A", "B"], lotus: ["A", "B", "C"] };
  for (const id of MAP_IDS) {
    const map = MAPS[id];
    assert.deepEqual([...map.sites], expectedSites[id]);
    const kinds = (kind) => map.zones.filter((z) => z.kind === kind);
    assert.deepEqual(kinds("site").map((z) => z.site).sort(), expectedSites[id], `${id} site zones`);
    assert.deepEqual(kinds("plant").map((z) => z.site).sort(), expectedSites[id], `${id} plant zones`);
    assert.deepEqual(kinds("spawn").map((z) => z.label).sort(), ["Attacker Spawn", "Defender Spawn"], `${id} spawns`);
    assert.ok(kinds("choke").length >= 3, `${id} has at least three chokes`);
    for (const z of map.zones) {
      assert.ok(z.points.length >= 3, `${id} ${z.id} is a polygon`);
      for (const [x, y] of z.points) assert.ok(in01(x) && in01(y), `${id} ${z.id} stays on the minimap`);
    }
  }
  for (const id of ["ascent", "haven", "lotus"]) assert.equal(MAPS[id].zones.filter((z) => z.kind === "mid").length, 1, `${id} has a mid zone`);
  // Bind has no mid: it has two one-way teleporter lanes instead.
  assert.equal(MAPS.bind.zones.filter((z) => z.kind === "mid").length, 0);
  const teleporters = MAPS.bind.zones.filter((z) => z.teleporter === true);
  assert.equal(teleporters.length, 2);
  assert.ok(teleporters.every((z) => z.kind === "lane"));
});

test("each site callout lies inside its own site polygon and sites do not overlap", () => {
  for (const id of MAP_IDS) {
    const map = MAPS[id];
    for (const site of map.sites) {
      const callout = getCallout(id, site, "Site");
      assert.ok(callout, `${id} has a ${site} Site callout`);
      const siteZone = map.zones.find((z) => z.kind === "site" && z.site === site);
      assert.equal(pointInPolygon({ x: callout.x, y: callout.y }, siteZone.points), true, `${id} ${site} callout inside polygon`);
      assert.equal(siteAt(id, callout.x, callout.y), site);
      assert.equal(zoneAt(id, callout.x, callout.y).site, site);
      // No vertex or centre of this site polygon falls inside another site's polygon.
      for (const other of map.zones.filter((z) => z.kind === "site" && z.site !== site)) {
        for (const [x, y] of [...siteZone.points, [callout.x, callout.y]]) {
          assert.equal(pointInPolygon({ x, y }, other.points), false, `${id} ${site} overlaps ${other.site}`);
        }
      }
    }
    const spawn = getCallout(id, "Attacker Side", "Spawn");
    assert.equal(siteAt(id, spawn.x, spawn.y), null, `${id} attacker spawn is not on a site`);
    assert.equal(zoneAt(id, spawn.x, spawn.y).kind, "spawn");
  }
  assert.equal(zoneAt("ascent", 0.99, 0.01), null);
});

test("pointInPolygon uses even-odd ray casting", () => {
  const square = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]];
  assert.equal(pointInPolygon({ x: 0.4, y: 0.4 }, square), true);
  assert.equal(pointInPolygon([0.25, 0.55], square), true);
  assert.equal(pointInPolygon({ x: 0.7, y: 0.4 }, square), false);
  assert.equal(pointInPolygon({ x: 0.4, y: 0.1 }, square), false);
  assert.equal(pointInPolygon({ x: 0.4, y: 0.4 }, [[0, 0], [1, 1]]), false);
  assert.equal(pointInPolygon({ x: Number.NaN, y: 0.4 }, square), false);
});

// ===========================================================================
// (b) Utility analysis
// ===========================================================================

test("classifyPhase splits default, execute and post-plant at the documented boundaries", () => {
  const noPlant = { plantTime: null };
  assert.deepEqual(ROUND_PHASES.map((p) => p.id), ["default", "execute", "postplant"]);
  assert.equal(classifyPhase({ time: 0 }, noPlant), "default");
  assert.equal(classifyPhase({ time: 29.9 }, noPlant), "default");
  assert.equal(classifyPhase({ time: 30 }, noPlant), "execute");
  assert.equal(classifyPhase({ time: 64.9 }, noPlant), "execute");
  assert.equal(classifyPhase({ time: 90 }, noPlant), "execute");
  assert.equal(classifyPhase({ time: 49.9 }, { plantTime: 50 }), "execute");
  assert.equal(classifyPhase({ time: 50 }, { plantTime: 50 }), "postplant");
  assert.equal(classifyPhase({ time: 12 }, { plantTime: 10 }), "postplant");
  assert.equal(classifyPhase({ time: 5, postPlant: true }, noPlant), "postplant");
});

test("filterUtility filters by type, side and phase, alone and combined", () => {
  assert.deepEqual([...UTILITY_TYPES], ["smoke", "flash", "recon", "molly"]);
  assert.equal(filterUtility(FILTER_ROUNDS).length, 9);
  assert.deepEqual(filterUtility(FILTER_ROUNDS, { types: ["smoke"] }).map((e) => e.time), [10, 5]);
  assert.equal(filterUtility(FILTER_ROUNDS, { types: ["flash", "recon"] }).length, 5);
  assert.equal(filterUtility(FILTER_ROUNDS, { types: [] }).length, 0);
  assert.equal(filterUtility(FILTER_ROUNDS, { side: "attack" }).length, 5);
  assert.equal(filterUtility(FILTER_ROUNDS, { side: "defense" }).length, 4);
  assert.equal(filterUtility(FILTER_ROUNDS, { side: "both" }).length, 9);
  assert.deepEqual(filterUtility(FILTER_ROUNDS, { phase: "default" }).map((e) => e.time), [10, 29.9, 5]);
  assert.deepEqual(filterUtility(FILTER_ROUNDS, { phase: "execute" }).map((e) => e.time), [30, 45, 40, 70]);
  assert.deepEqual(filterUtility(FILTER_ROUNDS, { phase: "postplant" }).map((e) => e.time), [55, 80]);
  const combined = filterUtility(FILTER_ROUNDS, { types: new Set(["flash"]), side: "attack", phase: "execute" });
  assert.equal(combined.length, 1);
  assert.equal(combined[0].time, 30);
  assert.equal(combined[0].roundNumber, 2);
  assert.equal(combined[0].side, "attack");
  assert.equal(combined[0].phase, "execute");
});

test("clusterUtility merges nearby events of one type and keeps far or different ones apart", () => {
  const events = [
    ev("smoke", 1, 0.3, 0.3),
    ev("smoke", 2, 0.32, 0.3),
    ev("flash", 3, 0.31, 0.31),             // same place, other type: its own cluster
    ev("smoke", 4, 0.31, 0.33),
    ev("smoke", 5, 0.8, 0.8),               // far away: its own cluster
  ];
  const clusters = clusterUtility(events, { radius: 0.05 });
  assert.equal(clusters.length, 3);
  const [big, second, third] = clusters;
  assert.equal(big.type, "smoke");
  assert.equal(big.count, 3);
  near(big.x, 0.31, 1e-9, "centroid x");    // (0.30 + 0.32 + 0.31) / 3
  near(big.y, 0.31, 1e-9, "centroid y");    // (0.30 + 0.30 + 0.33) / 3
  near(big.share, 0.6, 1e-12, "share");
  assert.deepEqual([second.type, second.count, third.type, third.count], ["flash", 1, "smoke", 1]);
  assert.deepEqual([third.x, third.y], [0.8, 0.8]);
  assert.equal(clusters.reduce((s, c) => s + c.count, 0), 5);
  // A tighter radius splits the group; identical input gives identical output.
  assert.equal(clusterUtility(events, { radius: 0.01 }).length, 5);
  assert.deepEqual(clusterUtility(events, { radius: 0.05 }), clusters);
  assert.deepEqual(clusterUtility([]), []);
});

test("utility efficiency, flash assist rate and execute timing follow their formulas", () => {
  const rounds = [
    rd(2, "attack", {
      plantSite: "A", plantTime: 60,
      utilityEvents: [
        ev("flash", 12, 0.4, 0.4, { assistedKill: true, enemiesAffected: 1 }),   // effective
        ev("flash", 33, 0.4, 0.4),
        ev("smoke", 38, 0.4, 0.4, { site: "A" }),
      ],
    }),
    rd(3, "attack", {
      utilityEvents: [
        ev("flash", 41, 0.6, 0.6, { assistedKill: true, site: "B" }),           // effective
        ev("flash", 47, 0.6, 0.6, { site: "B" }),
        ev("recon", 52, 0.6, 0.6, { enemiesAffected: 2, site: "B" }),           // effective
      ],
    }),
  ];
  const m = computeUtilityMetrics(rounds);
  assert.equal(m.utilityEfficiencyScore, 50);            // 3 effective of 6 events
  assert.equal(m.flashAssistRate, 0.5);                  // 2 assisted of 4 flashes
  assert.equal(m.executeTiming.rounds, 2);
  assert.equal(m.executeTiming.medianSeconds, 37);       // first execute utility at 33 s and 41 s
  const counts = Object.fromEntries(m.executeTiming.buckets.map((b) => [b.label, b.count]));
  assert.equal(counts["30-35s"], 1);
  assert.equal(counts["40-45s"], 1);
  assert.equal(m.executeTiming.buckets.reduce((s, b) => s + b.count, 0), 2);
  near(m.executeTiming.buckets.reduce((s, b) => s + b.share, 0), 1, 1e-12, "bucket shares");
  assert.deepEqual(m.siteBias.attack, { A: 0.5, B: 0.5 });   // plant on A, execute utility on B
  assert.equal(m.sampleSize.utilityEvents, 6);
  assert.equal(m.sampleSize.flashes, 4);
});

test("site bias shares sum to 1 per side and come from plants, executes and defensive stacks", () => {
  const rounds = [
    rd(2, "attack", { plantSite: "A", plantTime: 55 }),
    rd(3, "attack", { plantSite: "A", plantTime: 58 }),
    rd(4, "attack", { utilityEvents: [ev("smoke", 40, 0.5, 0.5, { site: "B" })] }),                    // no plant: execute utility on B
    rd(5, "attack"),                                                                                  // no site at all: not counted
    rd(14, "defense", { utilityEvents: [ev("smoke", 5, 0.5, 0.5, { site: "B" }), ev("molly", 9, 0.5, 0.5, { site: "B" }), ev("recon", 7, 0.5, 0.5, { site: "A" })] }),
    rd(15, "defense", { operatorHoldSpots: [hold("A Tower", 0.5, 0.2, 1, 0, { site: "A" })] }),
    rd(16, "defense", { utilityEvents: [ev("smoke", 45, 0.5, 0.5, { site: "C" })] }),                 // reaction only: no stack read
  ];
  const m = computeUtilityMetrics(rounds, { mapId: "haven" });
  near(m.siteBias.attack.A, 2 / 3, 1e-12, "attack A");
  near(m.siteBias.attack.B, 1 / 3, 1e-12, "attack B");
  assert.equal(m.siteBias.attack.C, 0);
  assert.deepEqual(m.siteBias.defense, { A: 0.5, B: 0.5, C: 0 });
  for (const side of ["attack", "defense"]) {
    near(Object.values(m.siteBias[side]).reduce((s, v) => s + v, 0), 1, 1e-12, `${side} shares`);
  }
  // The modelled datasets obey the same invariant.
  for (const mapId of MAP_IDS) {
    const real = computeUtilityMetrics(getTeamRounds("C9", mapId), { mapId });
    for (const side of ["attack", "defense"]) {
      assert.deepEqual(Object.keys(real.siteBias[side]), [...MAPS[mapId].sites]);
      near(Object.values(real.siteBias[side]).reduce((s, v) => s + v, 0), 1, 1e-9, `${mapId} ${side}`);
    }
  }
});

test("empty input gives zeros and empty lists, never NaN", () => {
  const m = computeUtilityMetrics([]);
  assert.equal(m.utilityEfficiencyScore, 0);
  assert.equal(m.flashAssistRate, 0);
  assert.equal(m.executeTiming.medianSeconds, 0);
  assert.equal(m.executeTiming.peak, null);
  assert.ok(m.executeTiming.buckets.every((b) => b.count === 0 && b.share === 0));
  assert.deepEqual(m.siteBias, { attack: {}, defense: {} });
  assert.deepEqual(filterUtility([]), []);
  assert.deepEqual(filterUtility(undefined), []);
  const profile = buildOperatorProfile([]);
  assert.deepEqual(profile.spots, []);
  assert.equal(profile.primarySpot, null);
  const eco = summarizeEconomy([]);
  const walk = (value, path) => {
    if (typeof value === "number") assert.ok(Number.isFinite(value), `${path} is finite`);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
  };
  walk(m, "metrics");
  walk(profile, "profile");
  walk(eco, "economy");
});

// ===========================================================================
// (c) Operator sniper angle and sightline maths
// ===========================================================================

test("sightlineAngleDeg returns the minimap bearing for the four axis directions", () => {
  assert.equal(sightlineAngleDeg(1, 0), 0);
  assert.equal(sightlineAngleDeg(0, 1), 90);      // y grows downward on the minimap
  assert.equal(sightlineAngleDeg(-1, 0), 180);
  assert.equal(sightlineAngleDeg(0, -1), 270);
  near(sightlineAngleDeg(1, 1), 45, 1e-9, "diagonal");
  assert.equal(sightlineAngleDeg(0, 0), null);
});

test("isInSightCone respects range, half-angle and a zero-length sightline", () => {
  const spot = hold("Test", 0.5, 0.5, 1, 0);      // looks right, fov 20 degrees, range 0.3
  assert.equal(isInSightCone(spot, { x: 0.7, y: 0.5 }), true);                                  // on axis, in range
  assert.equal(isInSightCone(spot, { x: 0.81, y: 0.5 }), false);                                // 0.31 away: beyond range
  assert.equal(isInSightCone(spot, { x: 0.7, y: 0.5 + 0.2 * Math.tan((9 * Math.PI) / 180) }), true);    // 9 degrees off axis
  assert.equal(isInSightCone(spot, { x: 0.7, y: 0.5 + 0.2 * Math.tan((12 * Math.PI) / 180) }), false);  // 12 degrees off axis
  assert.equal(isInSightCone(spot, { x: 0.3, y: 0.5 }), false);                                 // behind the scope
  assert.equal(isInSightCone(hold("Test", 0.5, 0.5, 5, 0), { x: 0.7, y: 0.5 }), true);          // direction need not be unit length
  assert.equal(isInSightCone(hold("Test", 0.5, 0.5, 0, 0), { x: 0.7, y: 0.5 }), false);         // zero vector
  assert.equal(isInSightCone(hold("Test", 0.5, 0.5, Number.NaN, 0), { x: 0.7, y: 0.5 }), false);
  assert.equal(isInSightCone(spot, { x: Number.NaN, y: 0.5 }), false);
  // The aggregated profile shape { x, y, dx, dy } is accepted too.
  assert.equal(isInSightCone({ x: 0.5, y: 0.5, dx: 0, dy: -1, fovDeg: 30, range: 0.2 }, { x: 0.5, y: 0.35 }), true);
});

test("sightlineCone returns the apex and the arc in SVG units", () => {
  const cone = sightlineCone(hold("Test", 0.5, 0.5, 1, 0), { size: 1000, steps: 2 });
  assert.equal(cone.length, 4);
  assert.deepEqual(cone[0], [500, 500]);
  // Arc at range 0.3 for -10, 0 and +10 degrees: 300 * cos(10 deg) = 295.44, 300 * sin(10 deg) = 52.09
  near(cone[1][0], 795.44, 0.01, "arc start x");
  near(cone[1][1], 447.91, 0.01, "arc start y");
  assert.deepEqual(cone[2], [800, 500]);
  near(cone[3][0], 795.44, 0.01, "arc end x");
  near(cone[3][1], 552.09, 0.01, "arc end y");
  assert.equal(sightlineCone(hold("Test", 0.5, 0.5, 1, 0)).length, 10);     // apex + 9 arc points by default
  assert.deepEqual(sightlineCone(hold("Test", 0.5, 0.5, 0, 0)), []);
});

test("buildOperatorProfile aggregates hold spots, pick rates and buy versus eco frequency", () => {
  const p = buildOperatorProfile(OPERATOR_ROUNDS);
  assert.equal(p.rounds, 9);
  assert.equal(p.holds, 4);
  near(p.operatorRoundRate, 4 / 9, 1e-4, "Operator round rate");
  assert.equal(p.buyRoundOpFrequency, 0.75);       // 3 of 4 FULL_BUY rounds
  assert.equal(p.ecoRoundOpFrequency, 0.25);       // 1 of 4 ECO and HALF_BUY rounds
  assert.equal(p.firstBloodPickRate, 0.75);        // 3 first bloods in 4 holds
  assert.equal(p.rePeekRate, 0.5);                 // 2 re-peeks in 4 holds
  assert.equal(p.spots.length, 2);
  const [rafters, market] = p.spots;
  assert.equal(p.primarySpot, rafters);
  assert.equal(rafters.callout, "Rafters");
  assert.equal(rafters.holds, 3);
  near(rafters.firstBloodPickRate, 2 / 3, 1e-4, "Rafters first-blood pick rate");
  near(rafters.rePeekRate, 2 / 3, 1e-4, "Rafters re-peek rate");
  assert.equal(rafters.kills, 3);
  near(rafters.x, 0.21, 1e-9, "mean x");           // (0.20 + 0.22 + 0.21) / 3
  near(rafters.y, 0.21, 1e-9, "mean y");           // (0.20 + 0.20 + 0.23) / 3
  assert.deepEqual([rafters.dx, rafters.dy, rafters.angleDeg], [1, 0, 0]);
  assert.deepEqual([market.callout, market.holds, market.firstBloodPickRate, market.rePeekRate, market.angleDeg], ["Market", 1, 1, 0, 90]);
});

test("recommendAntiOp places smoke and flash inside the cone and reacts to the re-peek rate", () => {
  const rafters = getCallout("ascent", "A", "Rafters");
  const main = getCallout("ascent", "A", "Main");
  const dist = Math.hypot(main.x - rafters.x, main.y - rafters.y);
  const dx = (main.x - rafters.x) / dist;
  const dy = (main.y - rafters.y) / dist;
  const spotAt = (extra) => hold("A Rafters", rafters.x, rafters.y, dx, dy, { range: dist * 1.25, ...extra });

  // Re-peeks on 2 of 3 holds (0.667 > 0.5): a re-peek punish is recommended.
  const hot = buildOperatorProfile([
    rd(2, "defense", { operatorHoldSpots: [spotAt({ rePeeked: true, firstBlood: true })] }),
    rd(3, "defense", { operatorHoldSpots: [spotAt({ rePeeked: true })] }),
    rd(4, "defense", { operatorHoldSpots: [spotAt({})] }),
  ]);
  const recs = recommendAntiOp("ascent", hot);
  assert.ok(recs.length >= 3);
  assert.ok(recs.every((r) => r.spot === "A Rafters" && r.target === "A Rafters" && r.from === "A Main"));
  assert.deepEqual(recs.map((r) => r.rank), recs.map((_, i) => i + 1));
  const smoke = recs.find((r) => r.type === "smoke");
  const flash = recs.find((r) => r.type === "flash");
  for (const [rec, fraction] of [[smoke, 0.35], [flash, 0.75]]) {
    assert.equal(isInSightCone(hot.primarySpot, rec), true, `${rec.type} is inside the cone`);
    near(rec.x, rafters.x + (main.x - rafters.x) * fraction, 1e-3, `${rec.type} x on the segment`);
    near(rec.y, rafters.y + (main.y - rafters.y) * fraction, 1e-3, `${rec.type} y on the segment`);
    assert.match(rec.text, /A Rafters/);
  }
  const punish = recs.filter((r) => r.rePeekPunish);
  assert.equal(punish.length, 1);
  assert.equal(punish[0].type, "trade");
  assert.match(punish[0].text, /67%/);

  // Re-peeks on exactly 1 of 2 holds (0.5, not above the threshold): no punish, a jump-peek instead.
  const calm = buildOperatorProfile([
    rd(2, "defense", { operatorHoldSpots: [spotAt({ rePeeked: true })] }),
    rd(3, "defense", { operatorHoldSpots: [spotAt({})] }),
  ]);
  const calmRecs = recommendAntiOp("ascent", calm);
  assert.equal(calmRecs.some((r) => r.rePeekPunish || r.type === "trade"), false);
  assert.equal(calmRecs.some((r) => r.type === "jump-peek"), true);
  assert.deepEqual(recommendAntiOp("ascent", buildOperatorProfile([])), []);
  assert.throws(() => recommendAntiOp("split", hot), RangeError);
});

test("every anti-Operator smoke and flash in the modelled datasets sits inside its sight cone", () => {
  let checked = 0;
  for (const teamId of Object.keys(TEAMS)) {
    for (const mapId of MAP_IDS) {
      const profile = buildOperatorProfile(getTeamRounds(teamId, mapId));
      for (const rec of recommendAntiOp(mapId, profile)) {
        const spot = profile.spots.find((s) => s.callout === rec.spot);
        assert.ok(spot, `${teamId} ${mapId} ${rec.spot} exists`);
        assert.ok(in01(rec.x) && in01(rec.y));
        if (rec.type === "smoke" || rec.type === "flash") {
          assert.equal(isInSightCone(spot, rec), true, `${teamId} ${mapId} ${rec.type} at ${rec.spot}`);
          checked += 1;
        }
        assert.equal(rec.rePeekPunish, rec.type === "trade");
        if (rec.type === "trade") assert.ok(spot.rePeekRate > 0.5);
        if (rec.type === "jump-peek") assert.ok(spot.rePeekRate <= 0.5);
      }
    }
  }
  assert.ok(checked >= 48, `checked ${checked} counters`);
});

// ===========================================================================
// (d) Economy state classification
// ===========================================================================

test("classifyEconomy uses the pistol rounds and the 5,000 / 20,000 loadout thresholds", () => {
  assert.deepEqual([...ECONOMY_STATES], ["PISTOL", "ECO", "HALF_BUY", "FULL_BUY"]);
  assert.deepEqual({ ...ECONOMY_LABELS }, { PISTOL: "Pistol", ECO: "Eco", HALF_BUY: "Half-Buy / Bonus", FULL_BUY: "Full Buy" });
  assert.equal(classifyEconomy({ roundNumber: 1, loadoutValue: 3400 }), "PISTOL");
  assert.equal(classifyEconomy({ roundNumber: 13, loadoutValue: 30000 }), "PISTOL");
  assert.equal(classifyEconomy({ roundNumber: 2, loadoutValue: 4999 }), "ECO");
  assert.equal(classifyEconomy({ roundNumber: 2, loadoutValue: 5000 }), "HALF_BUY");
  assert.equal(classifyEconomy({ roundNumber: 2, loadoutValue: 19999 }), "HALF_BUY");
  assert.equal(classifyEconomy({ roundNumber: 2, loadoutValue: 20000 }), "FULL_BUY");
  assert.equal(classifyEconomy({ roundNumber: 12, loadoutValue: 3000 }), "ECO");
  assert.equal(classifyEconomy({ roundNumber: 14, loadoutValue: 26000 }), "FULL_BUY");
  assert.equal(classifyEconomy({ roundNumber: 5, loadoutValue: Number.NaN }), "ECO");
});

test("summarizeEconomy counts rounds and win rates per state and per pistol side", () => {
  const rounds = [
    rd(1, "attack", { economyState: "PISTOL", won: true }),
    rd(13, "defense", { economyState: "PISTOL", won: false }),
    rd(2, "attack", { economyState: "ECO", won: false }),
    rd(3, "attack", { economyState: "ECO", won: true }),
    rd(4, "attack", { economyState: "ECO", won: false }),
    rd(5, "attack", { economyState: "ECO", won: false }),
    rd(6, "attack", { economyState: "HALF_BUY", won: true }),
    rd(7, "attack", { economyState: "FULL_BUY", won: true }),
    rd(8, "attack", { economyState: "FULL_BUY", won: true }),
    rd(9, "attack", { economyState: "FULL_BUY", won: false }),
  ];
  const e = summarizeEconomy(rounds);
  assert.deepEqual([e.rounds, e.wins, e.winRate], [10, 5, 0.5]);
  assert.deepEqual([e.states.PISTOL.count, e.states.PISTOL.winRate], [2, 0.5]);
  assert.deepEqual([e.states.ECO.count, e.states.ECO.wins, e.states.ECO.winRate], [4, 1, 0.25]);
  assert.deepEqual([e.states.HALF_BUY.count, e.states.HALF_BUY.winRate], [1, 1]);
  assert.deepEqual([e.states.FULL_BUY.count, e.states.FULL_BUY.wins], [3, 2]);
  near(e.states.FULL_BUY.winRate, 2 / 3, 1e-4, "full buy win rate");
  assert.equal(e.states.HALF_BUY.label, "Half-Buy / Bonus");
  assert.deepEqual(e.pistol.attack, { rounds: 1, wins: 1, winRate: 1 });
  assert.deepEqual(e.pistol.defense, { rounds: 1, wins: 0, winRate: 0 });
});

test("roundWinProbability follows the documented matrix, side edge and clamp", () => {
  near(roundWinProbability({ ourEconomy: "FULL_BUY", theirEconomy: "FULL_BUY" }), 0.5, 1e-12, "mirror");
  near(roundWinProbability({ ourEconomy: "FULL_BUY", theirEconomy: "FULL_BUY", ourSide: "defense", mapId: "ascent" }), 0.52, 1e-12, "ascent defense");
  near(roundWinProbability({ ourEconomy: "FULL_BUY", theirEconomy: "FULL_BUY", ourSide: "attack", mapId: "ascent" }), 0.48, 1e-12, "ascent attack");
  near(roundWinProbability({ ourEconomy: "ECO", theirEconomy: "FULL_BUY" }), 0.12, 1e-12, "eco into full buy");
  near(roundWinProbability({ ourEconomy: "FULL_BUY", theirEconomy: "FULL_BUY", strengthEdge: 0.05 }), 0.55, 1e-12, "strength edge");
  assert.equal(roundWinProbability({ ourEconomy: "ECO", theirEconomy: "FULL_BUY", strengthEdge: -0.3 }), 0.02);
  assert.equal(roundWinProbability({ ourEconomy: "FULL_BUY", theirEconomy: "ECO", strengthEdge: 0.3 }), 0.98);
  for (const a of ECONOMY_STATES) {
    for (const b of ECONOMY_STATES) {
      const ours = roundWinProbability({ ourEconomy: a, theirEconomy: b, ourSide: "attack", mapId: "haven" });
      const theirs = roundWinProbability({ ourEconomy: b, theirEconomy: a, ourSide: "defense", mapId: "haven" });
      near(ours + theirs, 1, 1e-12, `${a} v ${b}`);
      assert.ok(ours >= 0.02 && ours <= 0.98);
    }
  }
  // A better buy never lowers the round win probability.
  for (const their of ECONOMY_STATES) {
    const row = ["ECO", "HALF_BUY", "FULL_BUY"].map((our) => roundWinProbability({ ourEconomy: our, theirEconomy: their }));
    assert.ok(row[0] <= row[1] && row[1] <= row[2], `monotone against ${their}`);
  }
});

// ===========================================================================
// (e) Seeded Monte Carlo
// ===========================================================================

test("mulberry32 is a deterministic generator in [0, 1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = Array.from({ length: 200 }, () => a());
  const seqB = Array.from({ length: 200 }, () => b());
  const seqC = Array.from({ length: 200 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
  const mean = seqA.reduce((s, v) => s + v, 0) / seqA.length;
  assert.ok(mean > 0.4 && mean < 0.6, `mean ${mean}`);
});

test("simulateMap is deterministic for a seed and changes with the seed", () => {
  const state = { ourScore: 4, theirScore: 6, ourCredits: 12000, theirCredits: 26000, ourLossStreak: 1, ourSide: "attack", mapId: "ascent", trials: 1000 };
  const first = simulateMap({ ...state, seed: 42 });
  const second = simulateMap({ ...state, seed: 42 });
  const other = simulateMap({ ...state, seed: 43 });
  assert.deepEqual(first, second);
  assert.equal(first.trials, 1000);
  assert.equal(first.seed, 42);
  assert.notDeepEqual(first.scoreDistribution, other.scoreDistribution);
  assert.equal(simulateMap({ ...state, seed: 42, trials: 200 }).scoreDistribution.reduce((s, d) => s + d.count, 0), 200);
});

test("every probability returned by simulateMap is in [0, 1] and the distribution is complete", () => {
  const states = [
    {},
    { ourScore: 0, theirScore: 0, ourSide: "defense", mapId: "haven" },
    { ourScore: 5, theirScore: 7, ourCredits: 3000, theirCredits: 30000, ourLossStreak: 2, mapId: "bind" },
    { ourScore: 11, theirScore: 11, ourSide: "defense", mapId: "lotus" },
    { ourScore: 12, theirScore: 12, mapId: "ascent" },
    { ourScore: 14, theirScore: 14 },
    { ourScore: 12, theirScore: 0, strengthEdge: -0.3 },
    { ourScore: 0, theirScore: 12, strengthEdge: 0.3 },
    { ourScore: 13, theirScore: 7 },
    { ourScore: -5, theirScore: "x", ourCredits: Number.NaN, trials: 50, seed: "abc", mapId: "nowhere" },
  ];
  for (const state of states) {
    const r = simulateMap({ seed: 7, ...state });
    const label = JSON.stringify(state);
    for (const key of ["mapWinProb", "halfWinProb", "halfTieProb", "standardError"]) assert.ok(in01(r[key]), `${key} for ${label}: ${r[key]}`);
    assert.ok(r.comebackProb === null || in01(r.comebackProb), `comebackProb for ${label}`);
    assert.ok(in01(r.ci95[0]) && in01(r.ci95[1]) && r.ci95[0] <= r.mapWinProb && r.mapWinProb <= r.ci95[1], `ci95 for ${label}`);
    assert.ok(r.halfWinProb + r.halfTieProb <= 1 + 1e-12);
    assert.equal(r.scoreDistribution.reduce((s, d) => s + d.count, 0), r.trials);
    near(r.scoreDistribution.reduce((s, d) => s + d.share, 0), 1, 1e-9, `shares for ${label}`);
    const won = r.scoreDistribution.filter((d) => d.won).reduce((s, d) => s + d.count, 0);
    near(won / r.trials, r.mapWinProb, 1e-12, `wins for ${label}`);
    for (const d of r.scoreDistribution) {
      const hi = Math.max(d.our, d.their);
      const lo = Math.min(d.our, d.their);
      // First to 13 with a two-round lead, or the sudden-death round after 12 overtime rounds.
      assert.ok((hi >= 13 && hi - lo >= 2) || (hi === 19 && lo === 18), `final score ${d.score} for ${label}`);
    }
  }
});

test("standard error and the 95% interval match sqrt(p(1-p)/n)", () => {
  const r = simulateMap({ ourScore: 6, theirScore: 6, mapId: "ascent", seed: 2026, trials: 1000 });
  const p = r.mapWinProb;
  assert.ok(p > 0.3 && p < 0.7, `an even 6-6 start should be close to a coin flip, got ${p}`);
  near(r.standardError, Math.sqrt((p * (1 - p)) / 1000), 1e-12, "standard error");
  near(r.ci95[0], p - 1.96 * r.standardError, 1e-12, "ci low");
  near(r.ci95[1], p + 1.96 * r.standardError, 1e-12, "ci high");
  assert.ok(r.standardError < 0.0159, "at most about 1.6 points at 1,000 trials");
  assert.equal(r.comebackProb, null);
  assert.equal(r.start.ourEconomy, "PISTOL");      // 6-6 means round 13
  assert.equal(r.start.roundNumber, 13);
});

test("a 12-3 lead is nearly decisive and the trailing side's comeback is rare", () => {
  const lead = simulateMap({ ourScore: 12, theirScore: 3, mapId: "ascent", seed: 11 });
  assert.ok(lead.mapWinProb > 0.9, `lead ${lead.mapWinProb}`);
  assert.ok(lead.comebackProb < 0.1);
  assert.equal(lead.trailing, "them");
  near(lead.comebackProb, 1 - lead.mapWinProb, 1e-12, "comeback is the complement");
  const behind = simulateMap({ ourScore: 3, theirScore: 12, mapId: "ascent", seed: 11 });
  assert.ok(behind.mapWinProb < 0.1, `behind ${behind.mapWinProb}`);
  assert.equal(behind.trailing, "us");
  assert.equal(behind.comebackProb, behind.mapWinProb);
  // A finished map is not simulated.
  const done = simulateMap({ ourScore: 13, theirScore: 5, seed: 11 });
  assert.equal(done.mapWinProb, 1);
  assert.deepEqual(done.scoreDistribution.map((d) => [d.score, d.count]), [["13-5", 1000]]);
  assert.equal(simulateMap({ ourScore: 9, theirScore: 13 }).mapWinProb, 0);
});

test("a stronger economy or a strength edge does not lower the map win probability", () => {
  const base = { ourScore: 5, theirScore: 5, theirCredits: 30000, ourLossStreak: 1, mapId: "ascent", seed: 99 };
  const broke = simulateMap({ ...base, ourCredits: 2000 });
  const rich = simulateMap({ ...base, ourCredits: 30000 });
  assert.equal(broke.start.ourEconomy, "ECO");
  assert.equal(rich.start.ourEconomy, "FULL_BUY");
  assert.ok(rich.start.roundWinProb > broke.start.roundWinProb);
  assert.ok(rich.mapWinProb >= broke.mapWinProb, `${rich.mapWinProb} >= ${broke.mapWinProb}`);
  const weak = simulateMap({ ...base, ourCredits: 30000, strengthEdge: -0.1 });
  const strong = simulateMap({ ...base, ourCredits: 30000, strengthEdge: 0.1 });
  assert.ok(strong.mapWinProb > weak.mapWinProb, `${strong.mapWinProb} > ${weak.mapWinProb}`);
});

test("evaluateForceBuy compares forcing and saving under one seed", () => {
  const state = { ourScore: 3, theirScore: 5, ourCredits: 9000, theirCredits: 30000, ourLossStreak: 2, mapId: "ascent", seed: 9 };
  const r = evaluateForceBuy(state);
  assert.deepEqual(r, evaluateForceBuy(state));
  assert.ok(in01(r.forceWinProb) && in01(r.saveWinProb));
  near(r.forceBuyEV, r.forceWinProb - r.saveWinProb, 1e-12, "EV");
  assert.ok(r.forceBuyEV >= -1 && r.forceBuyEV <= 1);
  assert.equal(r.forceWinProb, simulateMap({ ...state, firstRoundDecision: "force" }).mapWinProb);
  assert.equal(r.saveWinProb, simulateMap({ ...state, firstRoundDecision: "save" }).mapWinProb);
  assert.equal(r.forceEconomy, "HALF_BUY");        // 9,000 credits spent in full
  assert.equal(r.saveEconomy, "ECO");              // 2,000 credits spent
  assert.ok(r.forceRoundWinProb > r.saveRoundWinProb);
  assert.ok(["FORCE", "SAVE", "EVEN"].includes(r.recommendation));
  const expected = Math.abs(r.forceBuyEV) < 2 * r.standardError ? "EVEN" : r.forceBuyEV > 0 ? "FORCE" : "SAVE";
  assert.equal(r.recommendation, expected);
});

test("evaluateSaveVsRetake computes the retake chance by hand and makes a consistent call", () => {
  const state = { ourScore: 6, theirScore: 7, ourSide: "defense", ourCredits: 8000, theirCredits: 20000, mapId: "ascent", seed: 9 };
  // 2v4, 25 s: duel 4 / (4 + 16) = 0.2, time (25 - 7) / 20 = 0.9, plant penalty 0.9 -> 0.162
  const thin = evaluateSaveVsRetake({ alive: 2, enemiesAlive: 4, timeRemaining: 25, spikePlanted: true, ...state });
  near(thin.retakeWinProb, 0.162, 1e-12, "2v4");
  // 4v2, 35 s: duel 16 / 20 = 0.8, time factor 1, plant penalty 0.9 -> 0.72
  const thick = evaluateSaveVsRetake({ alive: 4, enemiesAlive: 2, timeRemaining: 35, spikePlanted: true, ...state });
  near(thick.retakeWinProb, 0.72, 1e-12, "4v2");
  assert.equal(thick.call, "RETAKE");
  // Less than a defuse left: the retake cannot win, so save.
  const late = evaluateSaveVsRetake({ alive: 3, enemiesAlive: 1, timeRemaining: 5, spikePlanted: true, ...state });
  assert.equal(late.retakeWinProb, 0);
  assert.equal(late.call, "SAVE");
  assert.equal(evaluateSaveVsRetake({ alive: 5, enemiesAlive: 0, timeRemaining: 30, ...state }).retakeWinProb, 1);
  assert.equal(evaluateSaveVsRetake({ alive: 0, enemiesAlive: 3, timeRemaining: 30, ...state }).retakeWinProb, 0);
  for (const r of [thin, thick, late]) {
    assert.ok(in01(r.retakeWinProb) && in01(r.retakeEV) && in01(r.saveEV));
    assert.equal(r.scenario, "retake");
    assert.equal(r.call, r.retakeEV > r.saveEV ? "RETAKE" : "SAVE");
    near(r.retakeEV, r.retakeWinProb * r.mapWinProbIfRoundWon + (1 - r.retakeWinProb) * r.mapWinProbIfRoundLost, 1e-12, "retake EV");
    assert.equal(r.saveRoundWinProb, 0);                 // saving a retake concedes the round
    assert.equal(r.saveEV, r.mapWinProbIfSaved);
    assert.ok(r.mapWinProbIfRoundWon >= r.mapWinProbIfRoundLost);
    assert.ok(typeof r.reasoning === "string" && r.reasoning.length > 20);
    assert.match(r.reasoning, /We have to beat the clock: we need 7 s to defuse\./);
    checkSaveCall(r);
  }
  assert.deepEqual(thin, evaluateSaveVsRetake({ alive: 2, enemiesAlive: 4, timeRemaining: 25, spikePlanted: true, ...state }));
});

/** Identities every save-versus-play result has to satisfy, whatever the side. */
function checkSaveCall(r) {
  for (const key of ["playWinProb", "playEV", "saveRoundWinProb", "saveEV", "mapWinProbIfRoundWon", "mapWinProbIfRoundLost", "mapWinProbIfSaved"]) {
    assert.ok(in01(r[key]), `${key}: ${r[key]}`);
  }
  near(r.playEV, r.playWinProb * r.mapWinProbIfRoundWon + (1 - r.playWinProb) * r.mapWinProbIfRoundLost, 1e-12, "play EV");
  near(r.saveEV, r.saveRoundWinProb * r.mapWinProbIfRoundWon + (1 - r.saveRoundWinProb) * r.mapWinProbIfSaved, 1e-12, "save EV");
  assert.equal(r.retakeWinProb, r.playWinProb);
  assert.equal(r.retakeEV, r.playEV);
  assert.equal(r.playCall, SAVE_SCENARIOS[r.scenario].playCall);
  assert.equal(r.call, r.playEV > r.saveEV || r.playWinProb === 1 ? r.playCall : "SAVE");
  assert.ok(typeof r.reasoning === "string" && r.reasoning.length > 20);
}

test("evaluateSaveVsRetake reads the clock by side: post-plant hold, site hold and execute", () => {
  const state = { ourScore: 6, theirScore: 8, ourCredits: 12000, theirCredits: 20000, mapId: "ascent", seed: 9 };
  const attack = (extra) => evaluateSaveVsRetake({ alive: 3, enemiesAlive: 2, spikePlanted: true, ourSide: "attack", ...state, ...extra });
  const defense = (extra) => evaluateSaveVsRetake({ alive: 3, enemiesAlive: 2, spikePlanted: true, ourSide: "defense", ...state, ...extra });

  // Attack, spike planted, 3v2. The two defenders are the team on the clock:
  //   5 s: nobody can defuse (7 s)                           -> we win 1
  //  22 s: 4 / (4 + 9) * (22 - 7) / 20 * 0.9 = 0.207692...   -> we win 0.792307...
  //  40 s: 4 / 13 * 1 * 0.9 = 0.276923...                    -> we win 0.723076...
  const late = attack({ timeRemaining: 5 });
  assert.equal(late.playWinProb, 1);
  assert.equal(late.saveRoundWinProb, 1);                 // the spike goes off even if we walk away
  assert.equal(late.call, "HOLD");
  assert.equal(late.scenario, "post-plant-hold");
  assert.match(late.reasoning, /^Post-plant hold \(3v2 on attack, spike planted, 5s left\): the round is won 100% of the time/);
  assert.match(late.reasoning, /The clock is on our side: the opponents need 7 s to defuse\./);
  const mid = attack({ timeRemaining: 22 });
  near(mid.playWinProb, 1 - (4 / 13) * 0.75 * 0.9, 1e-12, "attack 22 s");
  near(mid.saveRoundWinProb, 0.25, 1e-12, "an abandoned spike is defused 75% of the time");
  const early = attack({ timeRemaining: 40 });
  near(early.playWinProb, 1 - (4 / 13) * 0.9, 1e-12, "attack 40 s");
  assert.equal(early.saveRoundWinProb, 0);
  // A shorter clock never hurts the team that planted, and never helps the team that has to defuse.
  let previousAttack = 0;
  let previousDefense = 1;
  for (const timeRemaining of [45, 30, 22, 15, 9, 7, 3, 0]) {
    const a = attack({ timeRemaining });
    const d = defense({ timeRemaining });
    assert.ok(a.playWinProb >= previousAttack, `attack at ${timeRemaining}s`);
    assert.ok(d.playWinProb <= previousDefense, `defense at ${timeRemaining}s`);
    previousAttack = a.playWinProb;
    previousDefense = d.playWinProb;
    assert.equal(a.scenario, "post-plant-hold");
    assert.equal(d.scenario, "retake");
    checkSaveCall(a);
    checkSaveCall(d);
  }
  // The same inputs on the two sides are two different rounds (the defect was that they were not).
  assert.equal(defense({ timeRemaining: 5 }).playWinProb, 0);
  assert.notEqual(attack({ timeRemaining: 22 }).playWinProb, defense({ timeRemaining: 22 }).playWinProb);

  // Attack, planted, nobody of ours alive: three defenders still need the time. 17 s -> they defuse 0.5.
  const dead = attack({ alive: 0, enemiesAlive: 3, timeRemaining: 17 });
  near(dead.playWinProb, 0.5, 1e-12, "0v3 post-plant");
  assert.equal(dead.saveRoundWinProb, dead.playWinProb);  // there is nobody left to save
  // No defender left: the round is won, the call is not SAVE.
  const won = attack({ enemiesAlive: 0, timeRemaining: 30 });
  assert.deepEqual([won.playWinProb, won.saveRoundWinProb, won.call], [1, 1, "HOLD"]);

  // Before the plant the attackers are on the clock (4 s to plant).
  // Defense 2v3 with 14 s: attackers 9 / 13 * (14 - 4) / 20 = 0.346153... -> we hold 0.653846...
  const hold = evaluateSaveVsRetake({ alive: 2, enemiesAlive: 3, timeRemaining: 14, spikePlanted: false, ourSide: "defense", ...state });
  near(hold.playWinProb, 1 - (9 / 13) * 0.5, 1e-12, "site hold");
  near(hold.saveRoundWinProb, 0.5, 1e-12, "site hold, saved");
  assert.deepEqual([hold.scenario, hold.playCall], ["site-hold", "HOLD"]);
  assert.match(hold.reasoning, /The clock is on our side: the opponents need 4 s to plant\./);
  // Attack 4v2 with 14 s: 16 / 20 * 0.5 = 0.4; with 3 s nobody can plant.
  const execute = evaluateSaveVsRetake({ alive: 4, enemiesAlive: 2, timeRemaining: 14, spikePlanted: false, ourSide: "attack", ...state });
  near(execute.playWinProb, 0.4, 1e-12, "execute");
  assert.deepEqual([execute.scenario, execute.playCall, execute.saveRoundWinProb], ["execute", "EXECUTE", 0]);
  assert.match(execute.reasoning, /We have to beat the clock: we need 4 s to plant\./);
  assert.equal(evaluateSaveVsRetake({ alive: 4, enemiesAlive: 2, timeRemaining: 3, spikePlanted: false, ourSide: "attack", ...state }).playWinProb, 0);
  // Every defender dead before the plant: the attackers have won, whatever the clock says.
  assert.equal(evaluateSaveVsRetake({ alive: 2, enemiesAlive: 0, timeRemaining: 1, spikePlanted: false, ourSide: "attack", ...state }).playWinProb, 1);
  assert.equal(evaluateSaveVsRetake({ alive: 0, enemiesAlive: 2, timeRemaining: 1, spikePlanted: false, ourSide: "defense", ...state }).playWinProb, 0);

  for (const r of [late, mid, early, dead, won, hold, execute, evaluateSaveVsRetake()]) checkSaveCall(r);
  assert.deepEqual(Object.keys(SAVE_SCENARIOS), ["retake", "post-plant-hold", "site-hold", "execute"]);
  assert.deepEqual(mid, attack({ timeRemaining: 22 }));
});

test("map rules: first to 13 by two, sides swap at the half and in overtime, sudden death never ends level", () => {
  assert.deepEqual([mapWinner(13, 11), mapWinner(13, 12), mapWinner(11, 13), mapWinner(12, 12), mapWinner(14, 12), mapWinner(15, 17)], [1, 0, -1, 0, 1, -1]);
  // 36 rounds played is the end of overtime: from then on any lead decides.
  assert.deepEqual([mapWinner(18, 17), mapWinner(18, 18), mapWinner(19, 18), mapWinner(18, 19), mapWinner(30, 29), mapWinner(30, 30)], [0, 0, 1, -1, 1, 0]);

  assert.equal(sideForNextRound(11, "attack"), "attack");
  assert.equal(sideForNextRound(12, "attack"), "defense");            // half time
  for (let round = 13; round <= 23; round += 1) assert.equal(sideForNextRound(round, "defense"), "defense", `round ${round}`);
  assert.equal(sideForNextRound(24, "defense"), "attack");            // into overtime
  assert.equal(sideForNextRound(25, "attack"), "defense");            // and before every overtime round
  assert.equal(sideForNextRound(36, "defense"), "attack");

  // Overtime from 12-12 on Ascent, replayed by hand. Both teams have 25,000 every round (a full
  // buy against a full buy, 0.5), Ascent takes 0.02 from the attackers, the sides alternate, and
  // each round draws twice (the result, then the plant).
  const reference = (seed, firstSide) => {
    const rng = mulberry32(seed);
    const finals = new Map();
    let wins = 0;
    for (let trial = 0; trial < 1000; trial += 1) {
      let our = 12;
      let their = 12;
      let side = firstSide;
      for (;;) {
        const weWin = rng() < (side === "attack" ? 0.48 : 0.52);
        rng();
        if (weWin) our += 1;
        else their += 1;
        if (Math.abs(our - their) >= 2 || (our + their > 36 && our !== their)) break;
        side = side === "attack" ? "defense" : "attack";
      }
      if (our > their) wins += 1;
      finals.set(`${our}-${their}`, (finals.get(`${our}-${their}`) ?? 0) + 1);
    }
    return { wins, finals };
  };
  for (const [seed, firstSide] of [[5, "attack"], [6, "defense"]]) {
    const sim = simulateMap({ ourScore: 12, theirScore: 12, ourSide: firstSide, mapId: "ascent", seed });
    const ref = reference(seed, firstSide);
    assert.equal(sim.mapWinProb, ref.wins / 1000, `seed ${seed}`);
    assert.deepEqual(new Map(sim.scoreDistribution.map((d) => [d.score, d.count])), ref.finals, `seed ${seed}`);
    assert.equal(sim.start.roundNumber, 25);
    assert.equal(sim.start.ourBuyPolicy, "full-buy");
    assert.equal(sim.halfWinProb, sim.mapWinProb);                    // no half is left in overtime
  }

  // Sudden death from 18-18 is one round, and it cannot end level.
  const sudden = simulateMap({ ourScore: 18, theirScore: 18, mapId: "ascent", seed: 3 });
  assert.deepEqual(sudden.scoreDistribution.map((d) => d.score), ["19-18", "18-19"]);
  assert.equal(sudden.scoreDistribution[0].count / 1000, sudden.mapWinProb);
  // Scores the model can never reach are still handled: a lead past overtime is a finished map,
  // and a level score is played until somebody leads.
  const ahead = simulateMap({ ourScore: 30, theirScore: 29, seed: 3 });
  assert.deepEqual([ahead.mapWinProb, ahead.scoreDistribution.map((d) => [d.score, d.count, d.won])], [1, [["30-29", 1000, true]]]);
  assert.equal(simulateMap({ ourScore: 29, theirScore: 30, seed: 3 }).mapWinProb, 0);
  const level = simulateMap({ ourScore: 30, theirScore: 30, seed: 3 });
  assert.deepEqual(level.scoreDistribution.map((d) => d.score), ["31-30", "30-31"]);
  for (const d of [...sudden.scoreDistribution, ...level.scoreDistribution]) assert.equal(d.won, d.our > d.their);
});

test("halfWinProb counts a lead at the end of the half; a level half is reported separately", () => {
  // 5-6 before round 12: the best we can do is 6-6, which is level, not a half won.
  const behind = simulateMap({ ourScore: 5, theirScore: 6, mapId: "ascent", seed: 21 });
  assert.equal(behind.start.roundNumber, 12);
  assert.equal(behind.halfWinProb, 0);
  assert.ok(behind.halfTieProb > 0.1 && behind.halfTieProb < 0.9, `tie ${behind.halfTieProb}`);
  // 6-5: we lead 7-5 or it is 6-6.
  const ahead = simulateMap({ ourScore: 6, theirScore: 5, mapId: "ascent", seed: 21 });
  near(ahead.halfWinProb + ahead.halfTieProb, 1, 1e-12, "6-5");
  assert.ok(ahead.halfWinProb > 0.1 && ahead.halfTieProb > 0.1);
  // 7-5 cannot be caught in one round, 5-7 cannot be recovered.
  assert.deepEqual([simulateMap({ ourScore: 7, theirScore: 4, seed: 21 }).halfWinProb, simulateMap({ ourScore: 4, theirScore: 7, seed: 21 }).halfWinProb], [1, 0]);
  // 12-11 before round 24: winning the round wins the map, losing it levels the half.
  const last = simulateMap({ ourScore: 12, theirScore: 11, mapId: "ascent", seed: 21 });
  near(last.halfWinProb + last.halfTieProb, 1, 1e-12, "12-11");
  assert.ok(last.mapWinProb > last.halfWinProb, "overtime wins come on top of the round-24 wins");
});

test("credit rules: loss bonus steps, win and plant credits, the cap, carried gear and each buy policy", () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(lossBonusCredits), [9500, 12000, 14500, 14500, 14500]);
  assert.equal(lossBonusCredits("x"), 9500);

  // A team that keeps losing: 9,500 then 12,000 then 14,500 (plus 400 kill money), capped at 45,000.
  const team = { credits: 10000, lossStreak: 0, carried: 0, lastWon: true };
  settleSimRound(team, { spend: 4000, loadout: 4000 }, false, false);
  assert.deepEqual(team, { credits: 15900, lossStreak: 1, carried: 400, lastWon: false });
  settleSimRound(team, { spend: 2000, loadout: 2400 }, false, false);
  assert.deepEqual(team, { credits: 26300, lossStreak: 2, carried: 240, lastWon: false });
  settleSimRound(team, { spend: 0, loadout: 240 }, false, false);
  assert.deepEqual(team, { credits: 41200, lossStreak: 3, carried: 24, lastWon: false });
  settleSimRound(team, { spend: 0, loadout: 24 }, false, false);
  assert.deepEqual(team, { credits: 45000, lossStreak: 4, carried: 2, lastWon: false });
  // A win pays 15,000 + 1,000, a plant 1,500, the streak resets and 60% of the loadout is kept.
  const winner = { credits: 20000, lossStreak: 3, carried: 0, lastWon: false };
  settleSimRound(winner, { spend: 20000, loadout: 21500 }, true, true);
  assert.deepEqual(winner, { credits: 17500, lossStreak: 0, carried: 12900, lastWon: true });
  // A plant on a lost round still pays the attackers.
  const planter = { credits: 0, lossStreak: 0, carried: 0, lastWon: false };
  settleSimRound(planter, { spend: 0, loadout: 0 }, false, true);
  assert.equal(planter.credits, 9500 + 400 + 1500);

  const buy = (team2, round, mustBuy, decision) => {
    const { spend, loadout, economy, policy } = chooseBuy({ carried: 0, lastWon: false, ...team2 }, round, mustBuy, decision);
    return [spend, loadout, economy, policy];
  };
  assert.deepEqual(buy({ credits: 4000 }, 1, false, null), [3400, 3400, "PISTOL", "pistol"]);
  assert.deepEqual(buy({ credits: 30000, carried: 5000 }, 5, false, null), [16500, 21500, "FULL_BUY", "full-buy"]);
  assert.deepEqual(buy({ credits: 9000, lastWon: true }, 5, false, null), [6300, 6300, "HALF_BUY", "bonus"]);
  assert.deepEqual(buy({ credits: 9000 }, 5, false, null), [2000, 2000, "ECO", "save"]);
  assert.deepEqual(buy({ credits: 9000 }, 12, true, null), [9000, 9000, "HALF_BUY", "must-buy"]);
  assert.deepEqual(buy({ credits: 9000 }, 5, false, "force"), [9000, 9000, "HALF_BUY", "force"]);
  assert.deepEqual(buy({ credits: 30000 }, 5, false, "save"), [2000, 2000, "ECO", "save"]);
  assert.deepEqual(Object.keys(BUY_POLICY_LABELS), ["pistol", "full-buy", "force", "must-buy", "bonus", "save"]);
});

test("the simulator starts from one last-round winner: stated loss streaks, or derived from score and bank", () => {
  const base = { ourScore: 6, theirScore: 8, ourCredits: 9000, theirCredits: 26000, ourSide: "defense", mapId: "ascent", seed: 1337 };
  // Nothing stated: the trailing team lost the last round, so with 9,000 it saves (it cannot both
  // have won 15,000 and hold a 9,000 bank).
  const derived = simulateMap(base);
  assert.deepEqual(
    [derived.start.streakSource, derived.start.ourLossStreak, derived.start.theirLossStreak, derived.start.ourBuyPolicy, derived.start.ourEconomy, derived.start.ourLoadout, derived.start.theirBuyPolicy],
    ["derived", 1, 0, "save", "ECO", 2000, "full-buy"],
  );
  // Stating the same streak gives the same chain.
  const stated = simulateMap({ ...base, ourLossStreak: 1 });
  assert.equal(stated.start.streakSource, "input");
  assert.equal(stated.mapWinProb, derived.mapWinProb);
  assert.deepEqual(stated.scoreDistribution, derived.scoreDistribution);
  // Stating that THEY lost makes us the winner of the last round: a 70% bonus buy.
  const bonus = simulateMap({ ...base, theirLossStreak: 1 });
  assert.deepEqual([bonus.start.ourBuyPolicy, bonus.start.ourEconomy, bonus.start.ourLoadout], ["bonus", "HALF_BUY", 6300]);
  assert.ok(bonus.start.roundWinProb > derived.start.roundWinProb);
  // Both on a streak is not a possible state: neither is treated as the winner.
  assert.equal(simulateMap({ ...base, ourLossStreak: 2, theirLossStreak: 1 }).start.ourBuyPolicy, "save");

  // Leading with the same small bank: they lost, we won.
  const leading = simulateMap({ ...base, ourScore: 8, theirScore: 6 });
  assert.deepEqual([leading.start.streakSource, leading.start.ourLossStreak, leading.start.theirLossStreak, leading.start.ourBuyPolicy], ["derived", 0, 1, "bonus"]);
  // Level score: the smaller bank lost.
  const poorer = simulateMap({ ourScore: 5, theirScore: 5, ourCredits: 8000, theirCredits: 30000, seed: 4 });
  assert.deepEqual([poorer.start.streakSource, poorer.start.ourLossStreak, poorer.start.ourBuyPolicy], ["derived", 1, "save"]);
  const richer = simulateMap({ ourScore: 5, theirScore: 5, ourCredits: 30000, theirCredits: 8000, seed: 4 });
  assert.deepEqual([richer.start.streakSource, richer.start.theirLossStreak, richer.start.theirBuyPolicy], ["derived", 1, "save"]);
  // Level score and level banks: unknown, nobody is the winner.
  const even = simulateMap({ ourScore: 5, theirScore: 5, ourCredits: 9000, theirCredits: 9000, seed: 4 });
  assert.deepEqual([even.start.streakSource, even.start.ourLossStreak, even.start.theirLossStreak, even.start.ourBuyPolicy, even.start.theirBuyPolicy], ["unknown", 0, 0, "save", "save"]);
  // Pistol rounds reset the streaks, so nothing is derived.
  assert.deepEqual([simulateMap({ ourScore: 4, theirScore: 8, seed: 4 }).start.streakSource, simulateMap({ seed: 4 }).start.streakSource], ["pistol", "pistol"]);
});

// ===========================================================================
// (f) Roster datasets
// ===========================================================================

test("TEAMS holds exactly the six curated rosters with slot-label players", () => {
  assert.deepEqual(Object.keys(TEAMS), ["C9", "C9W", "SEN", "G2", "FNC", "PRX"]);
  assert.deepEqual(Object.values(TEAMS).map((t) => t.name), ["Cloud9", "Cloud9 White / GC", "Sentinels", "G2 Esports", "Fnatic", "PRX"]);
  assert.deepEqual(Object.values(TEAMS).filter((t) => t.gameChangers).map((t) => t.id), ["C9W"]);
  for (const team of Object.values(TEAMS)) {
    assert.equal(team.roster.length, 5);
    assert.ok(team.roster.every((p) => p.slot === `${team.shortName} ${p.agent}`), `${team.id} uses slot labels`);
    assert.equal(team.roster.filter((p) => p.operator).length, 1);
    for (const mapId of MAP_IDS) {
      const profile = team.maps[mapId];
      for (const side of ["attack", "defense"]) {
        assert.deepEqual(Object.keys(profile.siteBias[side]), [...MAPS[mapId].sites]);
        near(Object.values(profile.siteBias[side]).reduce((s, v) => s + v, 0), 1, 1e-9, `${team.id} ${mapId} ${side} bias`);
      }
      assert.ok(profile.operator.holdSpots.length >= 3);
      assert.ok(profile.operator.buyRoundRate > profile.operator.ecoRoundRate);
    }
  }
  assert.ok(TEAMS.FNC.roster.some((p) => p.slot === "FNC Chamber"));
  assert.ok(TEAMS.C9.roster.some((p) => p.slot === "C9 Jett"));
});

test("getTeamRounds is deterministic: a fresh module instance regenerates identical rounds", async () => {
  const fresh = await import("../public/js/pro-data.js?fresh-instance=1");
  assert.notEqual(fresh.getTeamRounds, getTeamRounds);
  for (const [teamId, mapId] of [["C9", "ascent"], ["FNC", "haven"], ["PRX", "lotus"]]) {
    assert.deepEqual(plain(fresh.getTeamRounds(teamId, mapId)), plain(getTeamRounds(teamId, mapId)));
  }
  assert.equal(getTeamRounds("C9", "bind"), getTeamRounds("C9", "bind"));          // cached
  assert.notDeepEqual(plain(getTeamRounds("C9", "ascent")), plain(getTeamRounds("FNC", "ascent")));
  assert.notDeepEqual(plain(getTeamRounds("C9", "ascent")), plain(getTeamRounds("C9", "haven")));
  assert.throws(() => getTeamRounds("NOPE", "ascent"), RangeError);
  assert.throws(() => getTeamRounds("C9", "split"), RangeError);
});

test("every dataset has 24 GRID-shaped rounds with valid sides, pistols, sites and positions", () => {
  for (const teamId of Object.keys(TEAMS)) {
    for (const mapId of MAP_IDS) {
      const rounds = getTeamRounds(teamId, mapId);
      const label = `${teamId} ${mapId}`;
      assert.equal(rounds.length, 24, label);
      assert.deepEqual(rounds.map((r) => r.roundNumber), Array.from({ length: 24 }, (_, i) => i + 1), label);
      assert.equal(rounds.filter((r) => r.side === "attack").length, 12, label);
      assert.equal(rounds.filter((r) => r.side === "defense").length, 12, label);
      assert.equal(new Set(rounds.slice(0, 12).map((r) => r.side)).size, 1, `${label} keeps one side per half`);
      assert.notEqual(rounds[0].side, rounds[12].side, `${label} swaps sides after round 12`);
      assert.deepEqual(rounds.filter((r) => r.economyState === "PISTOL").map((r) => r.roundNumber), [1, 13], label);
      let utility = 0;
      for (const round of rounds) {
        for (const key of ["roundNumber", "side", "economyState", "utilityEvents", "killEvents", "plantSite", "operatorHoldSpots"]) {
          assert.ok(Object.prototype.hasOwnProperty.call(round, key), `${label} round has ${key}`);
        }
        assert.equal(round.economyState, classifyEconomy({ roundNumber: round.roundNumber, loadoutValue: round.loadoutValue }), `${label} r${round.roundNumber} economy`);
        assert.ok(round.plantSite === null || MAPS[mapId].sites.includes(round.plantSite), `${label} r${round.roundNumber} plant site`);
        assert.equal(round.plantSite === null, round.plantTime === null, `${label} r${round.roundNumber} plant time`);
        for (const p of allPositions(round)) assert.ok(in01(p.x) && in01(p.y), `${label} r${round.roundNumber} position`);
        for (const e of round.utilityEvents) {
          assert.ok(UTILITY_TYPES.includes(e.type));
          assert.ok(e.time >= 0 && e.radius > 0 && e.enemiesAffected >= 0);
          assert.ok(e.player.startsWith(`${TEAMS[teamId].shortName} `));
          if (e.type === "flash" || e.type === "recon") near(Math.hypot(e.direction.dx, e.direction.dy), 1, 1e-3, `${label} direction`);
        }
        for (const h of round.operatorHoldSpots) {
          near(Math.hypot(h.sightline.dx, h.sightline.dy), 1, 1e-3, `${label} sightline`);
          assert.ok(h.fovDeg > 0 && h.range > 0);
          assert.ok(getCallout(mapId, h.callout), `${label} hold spot ${h.callout} is a real callout`);
        }
        assert.ok(round.killEvents.filter((k) => k.firstBlood).length <= 1);
        utility += round.utilityEvents.length;
      }
      assert.ok(utility >= 100, `${label} has ${utility} utility events`);
    }
  }
});

// ===========================================================================
// (g) GRID Series State hydrator
// ===========================================================================

test("the bundled GRID sample is Cloud9 13-10 Fnatic on Ascent over 23 rounds", () => {
  const state = SAMPLE_GRID_SERIES.data.seriesState;
  assert.equal(state.title.nameShortened, "val");
  assert.deepEqual(state.teams.map((t) => [t.name, t.score, t.won]), [["Cloud9", 1, true], ["Fnatic", 0, false]]);
  const game = state.games[0];
  assert.equal(game.map.name, "ascent");
  assert.deepEqual(game.teams.map((t) => [t.name, t.score, t.won]), [["Cloud9", 13, true], ["Fnatic", 10, false]]);
  assert.equal(game.segments.length, 23);
  assert.equal(game.segments.filter((s) => s.winner === "Cloud9").length, 13);
  assert.equal(game.segments.filter((s) => s.winner === "Fnatic").length, 10);
  assert.equal(game.segments[22].winner, "Cloud9");
  // Nobody reaches 13 before the last round.
  let c9 = 0;
  let fnc = 0;
  for (const seg of game.segments.slice(0, 22)) {
    if (seg.winner === "Cloud9") c9 += 1;
    else fnc += 1;
    assert.ok(c9 < 13 && fnc < 13);
  }
  for (const seg of game.segments) {
    assert.equal(seg.teams.length, 2);
    const sides = Object.fromEntries(seg.teams.map((t) => [t.name, t.side]));
    assert.equal(sides.Cloud9, seg.roundNumber <= 12 ? "attack" : "defense");
    assert.equal(sides.Fnatic, seg.roundNumber <= 12 ? "defense" : "attack");
    for (const t of seg.teams) {
      for (const key of ["economyState", "loadoutValue", "utilityEvents", "killEvents", "operatorHoldSpots"]) assert.ok(key in t);
    }
  }
  // Positions are in game units, far outside 0..1.
  const firstEvent = game.segments[0].teams[0].utilityEvents[0];
  assert.ok(Math.abs(firstEvent.position.x) > 50 || Math.abs(firstEvent.position.y) > 50);
  assert.ok(Object.isFrozen(SAMPLE_GRID_SERIES) && Object.isFrozen(game.segments[0].teams[0].utilityEvents));
});

test("hydrateGridSeries turns the sample into normalised per-team rounds with a recomputed score", () => {
  const h = hydrateGridSeries(SAMPLE_GRID_SERIES);
  assert.equal(h.ok, true);
  assert.equal(h.seriesId, "spikesight-sample-c9-fnc-ascent");
  assert.equal(h.mapId, "ascent");
  assert.deepEqual(h.teams.map((t) => [t.name, t.teamId, t.score, t.won]), [["Cloud9", "C9", 13, true], ["Fnatic", "FNC", 10, false]]);
  assert.deepEqual(h.score, { C9: 13, FNC: 10 });
  assert.equal(h.roundCount, 23);
  assert.deepEqual(h.warnings, []);
  for (const teamId of ["C9", "FNC"]) {
    const rounds = h.roundsByTeam[teamId];
    assert.equal(rounds.length, 23);
    assert.deepEqual(rounds.map((r) => r.roundNumber), Array.from({ length: 23 }, (_, i) => i + 1));
    assert.equal(rounds.filter((r) => r.won).length, h.score[teamId]);
    for (const round of rounds) {
      assert.equal(round.economyState, classifyEconomy(round));
      for (const p of allPositions(round)) assert.ok(in01(p.x) && in01(p.y), `${teamId} r${round.roundNumber} normalised position`);
      for (const hs of round.operatorHoldSpots) near(Math.hypot(hs.sightline.dx, hs.sightline.dy), 1, 1e-3, "sightline is a unit vector");
    }
  }
  assert.equal(h.roundsByTeam.C9[0].side, "attack");
  assert.equal(h.roundsByTeam.C9[12].side, "defense");
  assert.equal(h.roundsByTeam.FNC[0].side, "defense");
  // A bare seriesState is accepted as well.
  const bare = hydrateGridSeries(SAMPLE_GRID_SERIES.data.seriesState);
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.score, { C9: 13, FNC: 10 });
  // The hydrated rounds feed the same analytics as the modelled dataset.
  const summary = buildScoutSummary({ teamId: "FNC", mapId: h.mapId, rounds: h.roundsByTeam.FNC, source: { kind: "grid-replay", seriesId: h.seriesId } });
  assert.equal(summary.roundCount, 23);
  assert.equal(summary.record.wins, 10);
  assert.ok(summary.utility.sampleSize.utilityEvents > 50);
});

test("hydrateGridSeries converts game coordinates, directions and lengths by the map transform", () => {
  const payload = {
    seriesState: {
      id: "hand-built-1",
      games: [{
        map: { name: "Ascent" },
        teams: [{ name: "Cloud9", score: 1 }, { name: "FNC", score: 0 }],
        segments: [{
          roundNumber: 2, winner: "Cloud9", plantSite: "A", plantTime: 61.5,
          teams: [
            {
              name: "Cloud9", side: "attack", loadoutValue: 21000,
              utilityEvents: [
                { type: "smoke", time: 41, position: { x: 6154, y: -6626 }, radius: 429, site: "A", enemiesAffected: 1 },
                { type: "flash", time: 43, position: { x: 5321.62, y: -4710.13 }, direction: { dx: 0, dy: -1 }, assistedKill: true },
                { type: "recon", time: 12, position: { x: 2753.93, y: -2129.62 }, direction: { dx: 3, dy: 0 } },
              ],
              killEvents: [{ time: 44, killer: "C9 Jett", victim: "FNC Omen", weapon: "Vandal", killerPosition: { x: 5321.62, y: -4710.13 }, victimPosition: { x: 6154, y: -6626 }, firstBlood: true }],
              operatorHoldSpots: [],
            },
            {
              name: "FNC", side: "defender", loadoutValue: 4200,
              utilityEvents: [],
              killEvents: [],
              operatorHoldSpots: [{ player: "FNC Chamber", position: { x: 6129.89, y: -8210 }, sightline: { dx: 0, dy: 1 }, fovDeg: 16, range: 3000, firstBlood: false, rePeeked: true, kills: 0, callout: "A Rafters", watch: "A Main", site: "A" }],
            },
          ],
        }],
      }],
    },
  };
  const h = hydrateGridSeries(payload);
  assert.equal(h.ok, true, h.reason);
  assert.equal(h.mapId, "ascent");
  assert.deepEqual(h.score, { C9: 1, FNC: 0 });
  assert.deepEqual(h.warnings, []);
  const c9 = h.roundsByTeam.C9[0];
  assert.deepEqual([c9.roundNumber, c9.side, c9.economyState, c9.won, c9.plantSite, c9.plantTime], [2, "attack", "FULL_BUY", true, "A", 61.5]);
  const [recon, smoke, flash] = c9.utilityEvents;          // sorted by time: 12, 41, 43
  assert.deepEqual([recon.type, smoke.type, flash.type], ["recon", "smoke", "flash"]);
  near(smoke.position.x, 0.3501, 1e-4, "smoke x");          // -6626 * 0.00007 + 0.813895
  near(smoke.position.y, 0.1425, 1e-4, "smoke y");          // 6154 * -0.00007 + 0.573242
  near(smoke.radius, 0.03, 1e-4, "smoke radius");           // 429 game units * 0.00007
  assert.equal(smoke.direction, null);
  assert.equal(siteAt("ascent", smoke.position.x, smoke.position.y), "A");
  assert.deepEqual(flash.direction, { dx: -1, dy: 0 });     // game -y is minimap left
  assert.deepEqual(recon.direction, { dx: 0, dy: -1 });     // game +x is minimap up
  assert.equal(flash.assistedKill, true);
  near(c9.killEvents[0].victimPosition.x, 0.3501, 1e-4, "victim x");
  const fnc = h.roundsByTeam.FNC[0];
  assert.deepEqual([fnc.side, fnc.economyState, fnc.won], ["defense", "ECO", false]);
  const spot = fnc.operatorHoldSpots[0];
  assert.deepEqual(spot.sightline, { dx: 1, dy: 0 });       // game +y is minimap right
  near(spot.range, 0.21, 1e-4, "range");                    // 3000 * 0.00007
  near(spot.position.x, 0.2392, 1e-4, "hold x");            // -8210 * 0.00007 + 0.813895
  assert.equal(spot.watch, "A Main");
});

test("hydrateGridSeries rejects unusable payloads without throwing", () => {
  const good = plain(SAMPLE_GRID_SERIES);
  const wrongMap = plain(good);
  wrongMap.data.seriesState.games[0].map.name = "split";
  const tooLong = plain(good);
  const segs = tooLong.data.seriesState.games[0].segments;
  tooLong.data.seriesState.games[0].segments = Array.from({ length: 61 }, (_, i) => segs[i % segs.length]);
  const oneTeam = plain(good);
  oneTeam.data.seriesState.games[0].teams.pop();
  oneTeam.data.seriesState.teams.pop();
  const bad = [null, undefined, 42, "seriesState", [], {}, { data: null }, { data: { seriesState: { games: [] } } },
    { data: { seriesState: { games: [{ map: { name: "ascent" } }] } } }, { data: { seriesState: { games: "x" } } }, wrongMap, tooLong, oneTeam];
  for (const payload of bad) {
    let result;
    assert.doesNotThrow(() => { result = hydrateGridSeries(payload); });
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === "string" && result.reason.length > 5);
  }
  assert.match(hydrateGridSeries(wrongMap).reason, /split/);
  assert.match(hydrateGridSeries(tooLong).reason, /61/);
});

test("hydrateGridSeries drops malformed events and reports a declared score that disagrees", () => {
  const payload = plain(SAMPLE_GRID_SERIES);
  const game = payload.data.seriesState.games[0];
  const entry = game.segments[0].teams[0];
  const validBefore = entry.utilityEvents.length;
  entry.utilityEvents.push({ type: "nuke", time: 3, position: { x: 100, y: 100 } });                      // unknown type
  entry.utilityEvents.push({ type: "smoke", time: 4, position: { x: "abc", y: null } });                  // non-finite coordinates
  entry.utilityEvents.push({ type: "smoke", time: 5, position: { x: 900000, y: 900000 } });               // far off the map
  entry.utilityEvents.push({ type: "molly", time: "soon", position: { x: 6154, y: -6626 } });             // bad time: coerced to 0
  entry.killEvents.push({ time: 9, killer: "x", victim: "y", weapon: "z", killerPosition: null, victimPosition: { x: 1, y: 1 } });
  entry.operatorHoldSpots.push({ player: "x", position: { x: Number.POSITIVE_INFINITY, y: 0 }, sightline: { dx: 1, dy: 0 } });
  game.segments[1].plantSite = "Z";
  game.teams[0].score = 12;                                                                             // really 13
  const killsBefore = entry.killEvents.length - 1;
  const holdsBefore = entry.operatorHoldSpots.length - 1;

  const h = hydrateGridSeries(payload);
  assert.equal(h.ok, true);
  const round = h.roundsByTeam.C9[0];
  assert.equal(round.utilityEvents.length, validBefore + 1);            // only the coerced molly was kept
  assert.equal(round.utilityEvents[0].time, 0);
  assert.equal(round.utilityEvents[0].type, "molly");
  assert.ok(round.utilityEvents.every((e) => UTILITY_TYPES.includes(e.type) && in01(e.position.x) && in01(e.position.y)));
  assert.equal(round.killEvents.length, killsBefore);
  assert.equal(round.operatorHoldSpots.length, holdsBefore);
  assert.equal(h.roundsByTeam.C9[1].plantSite, null);
  assert.deepEqual(h.score, { C9: 13, FNC: 10 });                       // recomputed, not the declared 12
  assert.equal(h.teams[0].declaredScore, 12);
  const text = h.warnings.join("\n");
  assert.match(text, /unknown type "nuke"/);
  assert.match(text, /without a usable position/);
  assert.match(text, /time is not a number/);
  assert.match(text, /kill event/);
  assert.match(text, /Operator hold spot/);
  assert.match(text, /plantSite/);
  assert.match(text, /Declared score 12 for Cloud9 disagrees with 13/);
  assert.ok(h.warningCount >= 7);
});

test("hydrateGridSeries counts a round once: a repeated segment and a team listed twice are skipped with a warning", () => {
  const base = hydrateGridSeries(SAMPLE_GRID_SERIES);
  assert.equal(base.warningCount, 0);

  const repeatedRound = plain(SAMPLE_GRID_SERIES);
  const segments = repeatedRound.data.seriesState.games[0].segments;
  segments.push(plain(segments[4]));                                   // round 5 again, as a 24th segment
  const a = hydrateGridSeries(repeatedRound);
  assert.equal(a.ok, true);
  assert.equal(a.roundCount, 23);
  assert.deepEqual(a.score, { C9: 13, FNC: 10 });
  assert.deepEqual(a.roundsByTeam, base.roundsByTeam);
  assert.deepEqual(a.warnings, ["Round 5 appears twice; the later segment was skipped."]);

  const repeatedTeam = plain(SAMPLE_GRID_SERIES);
  const third = repeatedTeam.data.seriesState.games[0].segments[2];
  assert.equal(third.teams[0].name, "Cloud9");
  third.teams.push(plain(third.teams[0]));                             // Cloud9 twice inside round 3
  const b = hydrateGridSeries(repeatedTeam);
  assert.equal(b.ok, true);
  assert.deepEqual([b.roundsByTeam.C9.length, b.roundsByTeam.FNC.length], [23, 23]);
  assert.deepEqual(b.roundsByTeam, base.roundsByTeam);
  assert.deepEqual(b.warnings, ["Round 3: Cloud9 is listed twice; the later entry was skipped."]);
  assert.deepEqual(buildScoutSummary({ teamId: "C9", mapId: "ascent", rounds: b.roundsByTeam.C9 }).record, buildScoutSummary({ teamId: "C9", mapId: "ascent", rounds: base.roundsByTeam.C9 }).record);

  // Segments without team entries hydrate to empty round lists (the dashboard refuses such a replay).
  const noEntries = plain(SAMPLE_GRID_SERIES);
  for (const seg of noEntries.data.seriesState.games[0].segments) seg.teams = [];
  const c = hydrateGridSeries(noEntries);
  assert.equal(c.ok, true);
  assert.deepEqual(c.roundsByTeam, { C9: [], FNC: [] });
  assert.deepEqual(c.score, { C9: 13, FNC: 10 });
});

// ===========================================================================
// (h) Scouting summary, dossier and deterministic coach
// ===========================================================================

test("buildScoutSummary combines the layers and agrees with the functions it wraps", () => {
  const rounds = getTeamRounds("FNC", "ascent");
  const s = buildScoutSummary({ teamId: "FNC", mapId: "ascent" });
  assert.deepEqual([s.teamId, s.teamName, s.mapId, s.mapName, s.roundCount], ["FNC", "Fnatic", "ascent", "Ascent", 24]);
  assert.equal(s.source.kind, "modelled");
  assert.deepEqual(s.utility, computeUtilityMetrics(rounds, { mapId: "ascent" }));
  assert.deepEqual(s.operator, buildOperatorProfile(rounds));
  assert.deepEqual(s.economy, summarizeEconomy(rounds));
  assert.equal(s.record.wins, rounds.filter((r) => r.won).length);
  assert.equal(s.record.attack.rounds + s.record.defense.rounds, 24);
  assert.equal(s.pistol.rounds, 2);
  assert.equal(s.pistol.attack.rounds + s.pistol.defense.rounds, 2);
  for (const side of ["attack", "defense"]) {
    assert.deepEqual(Object.keys(s.siteWinRates[side]), ["A", "B"]);
    for (const cell of Object.values(s.siteWinRates[side])) {
      assert.ok(cell.wins <= cell.rounds && in01(cell.winRate));
    }
    assert.ok(Object.values(s.siteWinRates[side]).reduce((sum, c) => sum + c.rounds, 0) <= 12);
  }
  // Attack rounds that planted are counted under their plant site.
  const plantsOnA = rounds.filter((r) => r.side === "attack" && r.plantSite === "A").length;
  assert.ok(s.siteWinRates.attack.A.rounds >= plantsOnA);
  assert.equal(s.keyNumbers.primaryOperatorSpot, s.operator.primarySpot.callout);
  assert.equal(s.keyNumbers.topCounter, s.antiOp[0].text);
  assert.throws(() => buildScoutSummary({ teamId: "FNC", mapId: "split" }), RangeError);
  assert.throws(() => buildScoutSummary({ teamId: "NOPE", mapId: "ascent" }), RangeError);
});

test("generateDossier writes the required Markdown sections in order with numbers from the summary", () => {
  const s = buildScoutSummary({ teamId: "FNC", mapId: "ascent" });
  const { markdown, kpis } = generateDossier(s, { ourTeamId: "C9" });
  const headings = ["# SpikeSight C9 Anti-Strat Dossier: Fnatic on Ascent", "## Operator Tendencies", "## Execute Timings", "## Pistol Round Tendencies", "## Site Win Rates", "## Utility Profile", "## Anti-Strat Game Plan", "Data source: modelled scenario dataset"];
  let cursor = -1;
  for (const heading of headings) {
    const at = markdown.indexOf(heading);
    assert.ok(at > cursor, `"${heading}" appears after the previous section`);
    cursor = at;
  }
  assert.ok(markdown.startsWith(headings[0]));
  assert.match(markdown, /Prepared for: Cloud9\./);
  assert.ok(markdown.includes(`Utility Efficiency Score: ${s.utility.utilityEfficiencyScore} / 100`));
  assert.ok(markdown.includes(`| ${s.operator.primarySpot.callout} | ${s.operator.primarySpot.player} |`));
  assert.ok(markdown.includes(`Median first execute utility: ${s.utility.executeTiming.medianSeconds}s`));
  assert.ok(markdown.includes(s.antiOp[0].text));
  assert.ok(markdown.trimEnd().split("\n").at(-1).startsWith("Data source: "));
  assert.ok(Array.isArray(kpis) && kpis.length >= 5);
  assert.ok(kpis.every((k) => typeof k.id === "string" && typeof k.label === "string" && typeof k.value === "string"));
  assert.equal(kpis.find((k) => k.id === "utility-efficiency").value, `${s.utility.utilityEfficiencyScore} / 100`);

  // A hydrated replay is named in the closing line instead.
  const h = hydrateGridSeries(SAMPLE_GRID_SERIES);
  const replay = buildScoutSummary({ teamId: "FNC", mapId: h.mapId, rounds: h.roundsByTeam.FNC, source: { kind: "grid-replay", seriesId: h.seriesId } });
  const replayDossier = generateDossier(replay).markdown;
  assert.match(replayDossier, /Data source: hydrated GRID replay spikesight-sample-c9-fnc-ascent\.$/);
  assert.doesNotMatch(replayDossier, /Prepared for/);
  // A team with no Operator data still produces every section.
  const quiet = generateDossier(buildScoutSummary({ teamId: "X1", teamName: "Scrim Team", mapId: "bind", rounds: [rd(2, "attack"), rd(3, "defense")] })).markdown;
  for (const heading of headings.slice(1, 7)) assert.ok(quiet.includes(heading));
  assert.match(quiet, /Scrim Team on Bind/);
  assert.match(quiet, /No Operator hold was recorded in 2 rounds/);
});

test("buildDeterministicCoachAnswer quotes the summary and leads with the question topic", () => {
  // Hand-built data: Rafters is the primary spot with 2 first bloods in 3 holds (67%).
  const s = buildScoutSummary({ teamId: "T1", teamName: "Test Five", mapId: "ascent", rounds: OPERATOR_ROUNDS });
  const answer = buildDeterministicCoachAnswer(s, "How do we play around their Operator?");
  const lines = answer.split("\n");
  assert.ok(lines.length >= 4 && lines.length <= 6, `got ${lines.length} bullets`);
  assert.ok(lines.every((line) => line.startsWith("- ")));
  assert.match(lines[0], /^- Operator: T Jett holds Rafters on 3 of 4 Operator holds, with a 67% first-blood pick rate and a 67% re-peek rate\./);
  assert.match(answer, /75% of full-buy rounds against 25% of eco and half-buy rounds/);
  assert.ok(answer.includes(s.antiOp[0].text));

  const fnc = buildScoutSummary({ teamId: "FNC", mapId: "ascent" });
  const leads = {
    "What do they do on pistol rounds?": /^- Pistol rounds:/,
    "Should we force buy or save on eco?": /^- Economy:/,
    "When do they execute?": /^- Execute timing:/,
    "Which site do they prefer?": /^- Site bias:/,
    "Can we retake against them?": /^- Retake:/,
    "How do we beat the Fnatic Operator on Ascent defense?": /^- Operator:/,
  };
  for (const [question, pattern] of Object.entries(leads)) {
    const text = buildDeterministicCoachAnswer(fnc, question);
    assert.match(text, pattern, question);
    const count = text.split("\n").length;
    assert.ok(count >= 4 && count <= 6, `${question}: ${count} bullets`);
    assert.ok(text.includes(fnc.operator.primarySpot.callout));
    assert.ok(text.includes(fnc.utility.executeTiming.peak.label));
    assert.ok(text.includes("Fnatic"));
  }
  // Non-string questions and a team without Operator data still get an answer.
  assert.match(buildDeterministicCoachAnswer(fnc, undefined), /^- Operator:/);
  const quiet = buildDeterministicCoachAnswer(buildScoutSummary({ teamId: "X1", mapId: "bind", rounds: [rd(2, "attack")] }), "operator?");
  assert.match(quiet, /^- Operator: no Operator hold was recorded/);
  assert.ok(quiet.split("\n").length >= 4);
});

// ===========================================================================
// (i) Cloudflare Worker (default export, fake env, no network)
// ===========================================================================

const ORIGIN = "https://spikesight.test";
const GRID_KEY = "grid-test-key-0123456789abcdef";
const postJson = (path, body, headers = {}) => new Request(`${ORIGIN}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** Replace globalThis.fetch for one test; the original is restored when the test ends. */
function fakeFetch(t, respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}
const noNetwork = (t) => fakeFetch(t, () => {
  throw new Error("network access is not allowed in tests");
});

test("GET /health returns the service descriptor", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/health`), {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /application\/json/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "spikesight-c9");
  assert.deepEqual(body.maps, ["ascent", "haven", "bind", "lotus"]);
  assert.equal(body.teams, 6);
  assert.equal(body.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.deepEqual(body.endpoints, ["GET /health", "GET /api/grid/sample-series", "POST /api/grid/query", "POST /api/scout-coach"]);
  const head = await worker.fetch(new Request(`${ORIGIN}/health`, { method: "HEAD" }), {});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("GET /api/grid/sample-series returns the bundled GRID payload", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/grid/sample-series`), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assert.deepEqual(body, plain(SAMPLE_GRID_SERIES));
  assert.equal(hydrateGridSeries(body).ok, true);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/grid/sample-series`, { method: "DELETE" }), {})).status, 405);
});

test("resolveGridTarget accepts only the two GRID hosts and GraphQL paths", () => {
  assert.deepEqual([...GRID_ALLOWED_HOSTS], ["api-op.grid.gg", "api.grid.gg"]);
  assert.deepEqual([...GRID_ALLOWED_PATHS], ["/central-data/graphql", "/live-data-feed/series-state/graphql"]);
  assert.deepEqual(resolveGridTarget({ endpoint: "central-data" }), { ok: true, url: "https://api-op.grid.gg/central-data/graphql" });
  assert.deepEqual(resolveGridTarget({ endpoint: "series-state" }), { ok: true, url: "https://api-op.grid.gg/live-data-feed/series-state/graphql" });
  assert.deepEqual(resolveGridTarget({ url: "https://api.grid.gg/central-data/graphql" }), { ok: true, url: "https://api.grid.gg/central-data/graphql" });
  assert.deepEqual(resolveGridTarget({ url: "https://api-op.grid.gg/live-data-feed/series-state/graphql" }), { ok: true, url: "https://api-op.grid.gg/live-data-feed/series-state/graphql" });
  // Host comparison is case-insensitive and an explicit :443 is the default port.
  assert.deepEqual(resolveGridTarget({ url: "https://API.GRID.GG:443/central-data/graphql" }), { ok: true, url: "https://api.grid.gg/central-data/graphql" });
});

test("resolveGridTarget refuses hostile and malformed targets", () => {
  const hostile = [
    { url: "http://api-op.grid.gg/central-data/graphql" },                 // not https
    { url: "https://api-op.grid.gg.evil.com/central-data/graphql" },       // look-alike suffix
    { url: "https://evilapi.grid.gg/central-data/graphql" },               // look-alike prefix
    { url: "https://grid.gg/central-data/graphql" },                       // parent domain
    { url: "https://api-op.grid.gg@evil.com/central-data/graphql" },       // userinfo trick
    { url: "https://user:pass@api.grid.gg/central-data/graphql" },         // credentials
    { url: "https://127.0.0.1/central-data/graphql" },                     // IPv4 literal
    { url: "https://[::1]/central-data/graphql" },                         // IPv6 literal
    { url: "https://169.254.169.254/latest/meta-data/" },                  // metadata service
    { url: "https://api.grid.gg:8443/central-data/graphql" },              // other port
    { url: "https://api.grid.gg./central-data/graphql" },                  // trailing dot
    { url: "https://api.grid.gg/other/graphql" },                          // other path
    { url: "https://api.grid.gg/central-data/graphql/../../admin" },       // path traversal
    { url: "https://api.grid.gg/central-data/graphql?next=https://evil.com" },
    { url: "https://api.grid.gg\\@evil.com/central-data/graphql" },        // backslash confusion
    { url: "//api.grid.gg/central-data/graphql" },                         // scheme-relative
    { url: "ftp://api.grid.gg/central-data/graphql" },
    { url: "not a url" },
    { url: "" },
    { url: 42 },
    { url: ["https://api.grid.gg/central-data/graphql"] },
    { endpoint: "admin" },
    { endpoint: "__proto__" },
    {},
    null,
    undefined,
  ];
  for (const input of hostile) {
    let result;
    assert.doesNotThrow(() => { result = resolveGridTarget(input); }, JSON.stringify(input));
    assert.equal(result.ok, false, `refused: ${JSON.stringify(input)}`);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
    assert.equal(result.url, undefined);
  }
  // An explicit url is the one that is checked, even next to a valid endpoint name.
  assert.equal(resolveGridTarget({ endpoint: "central-data", url: "https://evil.com/central-data/graphql" }).ok, false);
});

test("POST /api/grid/query refuses a target off the allowlist without any outbound fetch", async (t) => {
  const calls = noNetwork(t);
  for (const url of ["https://example.com/graphql", "https://api-op.grid.gg.evil.com/central-data/graphql", "http://api.grid.gg/central-data/graphql"]) {
    const res = await worker.fetch(postJson("/api/grid/query", { url, query: "{ __typename }" }, { "x-api-key": GRID_KEY }), {});
    assert.equal(res.status, 400, url);
    const text = await res.text();
    assert.match(JSON.parse(text).error, /GRID target refused/);
    assert.ok(!text.includes(GRID_KEY));
  }
  const noTarget = await worker.fetch(postJson("/api/grid/query", { query: "{ __typename }" }, { "x-api-key": GRID_KEY }), {});
  assert.equal(noTarget.status, 400);
  assert.equal(calls.length, 0);
});

test("POST /api/grid/query forwards an allowed request once with the key header and no redirect following", async (t) => {
  const calls = fakeFetch(t, () => new Response(JSON.stringify({ data: { allSeries: { totalCount: 3 } } }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const query = "query { allSeries { totalCount } }";
  const res = await worker.fetch(postJson("/api/grid/query", { endpoint: "central-data", query, variables: { first: 5 } }, { "x-api-key": GRID_KEY }), {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { data: { allSeries: { totalCount: 3 } } });
  assert.ok(!text.includes(GRID_KEY), "the key is never echoed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api-op.grid.gg/central-data/graphql");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers["x-api-key"], GRID_KEY);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].init.body), { query, variables: { first: 5 } });

  // An explicit allowlisted url and the body apiKey fallback work the same way.
  const viaUrl = await worker.fetch(postJson("/api/grid/query", { url: "https://api.grid.gg/live-data-feed/series-state/graphql", query, apiKey: GRID_KEY }), {});
  assert.equal(viaUrl.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.grid.gg/live-data-feed/series-state/graphql");
  assert.equal(calls[1].init.headers["x-api-key"], GRID_KEY);
  assert.deepEqual(JSON.parse(calls[1].init.body), { query, variables: {} });
});

test("POST /api/grid/query without a key returns the demo sample and performs no fetch", async (t) => {
  const calls = noNetwork(t);
  const res = await worker.fetch(postJson("/api/grid/query", { endpoint: "series-state", query: "{ __typename }" }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, "demo_grid_schema_preview");
  assert.ok(typeof body.note === "string" && body.note.length > 20);
  assert.deepEqual(body.sample, plain(SAMPLE_GRID_SERIES));
  assert.equal(calls.length, 0);
});

test("POST /api/grid/query does not follow an upstream redirect", async (t) => {
  const calls = fakeFetch(t, () => new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } }));
  const res = await worker.fetch(postJson("/api/grid/query", { endpoint: "central-data", query: "{ __typename }" }, { "x-api-key": GRID_KEY }), {});
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.match(JSON.parse(text).error, /redirect/);
  assert.ok(!text.includes("evil.example") && !text.includes(GRID_KEY));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api-op.grid.gg/central-data/graphql");
});

test("POST /api/grid/query validates the request and hides upstream failures and echoed keys", async (t) => {
  let respond = () => {
    throw new TypeError(`connect failed for key ${GRID_KEY}`);
  };
  const calls = fakeFetch(t, (...args) => respond(...args));
  const send = (body, headers = { "x-api-key": GRID_KEY }) => worker.fetch(postJson("/api/grid/query", body, headers), {});

  assert.equal((await send({ endpoint: "central-data", query: "" })).status, 400);
  assert.equal((await send({ endpoint: "central-data", query: "   " })).status, 400);
  assert.equal((await send({ endpoint: "central-data", query: 7 })).status, 400);
  assert.equal((await send({ endpoint: "central-data", query: "q".repeat(20001) })).status, 400);
  assert.equal((await send("{not json")).status, 400);
  assert.equal((await send("[1,2]")).status, 400);
  assert.equal((await send({ endpoint: "central-data", query: "{ a }" }, { "x-api-key": "bad key with spaces" })).status, 400);
  // A quote or a backslash would have to be escaped in JSON, so keys carrying one are refused.
  assert.equal((await send({ endpoint: "central-data", query: "{ a }" }, { "x-api-key": 'k"ey-0123456789' })).status, 400);
  assert.equal((await send({ endpoint: "central-data", query: "{ a }" }, { "x-api-key": "k\\ey-0123456789" })).status, 400);
  assert.equal((await send({ endpoint: "central-data", query: "{ a }", apiKey: 'k"ey-0123456789' }, {})).status, 400);
  assert.equal((await send({ endpoint: "central-data", query: "{ a }" }, { "x-api-key": "k".repeat(257) })).status, 400);
  assert.equal(calls.length, 0, "nothing was fetched for invalid requests");
  assert.equal((await send({ endpoint: "central-data", query: "q".repeat(20000) })).status, 502);     // exactly at the limit: sent
  assert.equal(calls.length, 1);

  const failed = await send({ endpoint: "central-data", query: "{ a }" });
  assert.equal(failed.status, 502);
  const failedText = await failed.text();
  assert.match(JSON.parse(failedText).error, /GRID upstream request failed/);
  assert.ok(!failedText.includes(GRID_KEY) && !failedText.includes("at "), "no key and no stack trace");

  respond = () => new Response(`<html>bad gateway for ${GRID_KEY}</html>`, { status: 503 });
  const html = await send({ endpoint: "central-data", query: "{ a }" });
  assert.equal(html.status, 503);
  const htmlBody = await html.json();
  assert.equal(htmlBody.status, 503);
  assert.equal(htmlBody.raw, "<html>bad gateway for [redacted]</html>");

  respond = () => new Response(JSON.stringify({ errors: [{ message: "UNAUTHENTICATED" }] }), { status: 401 });
  const denied = await send({ endpoint: "central-data", query: "{ a }" });
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { errors: [{ message: "UNAUTHENTICATED" }] });

  // An upstream that echoes the key in escaped forms, in a property name and nested: the reply
  // is redacted on the parsed value, so no escape form survives.
  const slashKey = "abc/DEF+123=xyz-0123456789";
  respond = () => new Response(String.raw`{"echo":"key abc\/DEF\u002b123=xyz-0123456789 end","abc\/DEF+123=xyz-0123456789":{"nested":["abc/DEF+123=xyz-0123456789",7,null,true]}}`, { status: 200 });
  const echoed = await send({ endpoint: "central-data", query: "{ a }" }, { "x-api-key": slashKey });
  assert.equal(echoed.status, 200);
  const echoedText = await echoed.text();
  assert.deepEqual(JSON.parse(echoedText), { echo: "key [redacted] end", "[redacted]": { nested: ["[redacted]", 7, null, true] } });
  assert.ok(!echoedText.includes("DEF") && !echoedText.includes("0123456789"), "no form of the key is left");

  const get = await worker.fetch(new Request(`${ORIGIN}/api/grid/query`), {});
  assert.equal(get.status, 405);
});

test("request bodies are capped before and while they are read", async (t) => {
  const calls = noNetwork(t);
  const chunk = new Uint8Array(8192).fill(0x20);                       // spaces: JSON whitespace
  const endless = () => {
    const seen = { pulled: 0 };
    const body = new ReadableStream({
      pull(controller) {
        seen.pulled += 1;
        if (seen.pulled > 200) controller.close();
        else controller.enqueue(chunk);
      },
    });
    return { seen, init: { method: "POST", body, duplex: "half", headers: { "Content-Type": "application/json", "x-api-key": GRID_KEY } } };
  };

  // No Content-Length: reading stops once the limit is passed. 64,000 bytes is passed by the
  // 8th chunk of 8,192, 20,000 bytes by the 3rd; the other 190 chunks are never pulled.
  const grid = endless();
  const gridRes = await worker.fetch(new Request(`${ORIGIN}/api/grid/query`, grid.init), {});
  assert.equal(gridRes.status, 400);
  assert.match((await gridRes.json()).error, /the body is too large/);
  assert.ok(grid.seen.pulled >= 8 && grid.seen.pulled <= 10, `grid pulled ${grid.seen.pulled} chunks`);
  const coach = endless();
  const coachRes = await worker.fetch(new Request(`${ORIGIN}/api/scout-coach`, coach.init), {});
  assert.equal(coachRes.status, 200);
  assert.match((await coachRes.json()).warning, /Request body ignored \(the body is too large\)/);
  assert.ok(coach.seen.pulled >= 3 && coach.seen.pulled <= 5, `coach pulled ${coach.seen.pulled} chunks`);

  // A declared length over the limit is refused before anything is read.
  const declared = new Request(`${ORIGIN}/api/grid/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "64001", "x-api-key": GRID_KEY },
    body: JSON.stringify({ endpoint: "central-data", query: "{ a }" }),
  });
  const refused = await worker.fetch(declared, {});
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /the body is too large/);
  assert.equal(declared.bodyUsed, false);

  // The limit is in bytes: exactly 20,000 is read, 20,001 is not, and two-byte characters count twice.
  const sized = (bytes) => {
    const base = JSON.stringify({ question: "pistol plan?", teamId: "SEN", pad: "" });
    return base.replace('"pad":""', `"pad":"${"x".repeat(bytes - base.length)}"`);
  };
  assert.equal(Buffer.byteLength(sized(20000)), 20000);
  const atLimit = await (await worker.fetch(postJson("/api/scout-coach", sized(20000)), {})).json();
  assert.equal(atLimit.grounding.teamId, "SEN");
  const over = await (await worker.fetch(postJson("/api/scout-coach", sized(20001)), {})).json();
  assert.match(over.warning, /the body is too large/);
  assert.equal(over.grounding.teamId, "FNC");                          // the defaults were used
  const wide = JSON.stringify({ question: "pistol plan?", teamId: "SEN", pad: "\u00e9".repeat(10000) });
  assert.ok(wide.length < 20000 && Buffer.byteLength(wide) > 20000);
  assert.match((await (await worker.fetch(postJson("/api/scout-coach", wide), {})).json()).warning, /the body is too large/);
  assert.equal(calls.length, 0);
});

test("POST /api/scout-coach answers from Workers AI when the binding responds", async (t) => {
  noNetwork(t);
  const seen = [];
  const env = { AI: { run: async (model, input) => { seen.push({ model, input }); return { response: "- Smoke A Main.\n- Trade the re-peek." }; } } };
  const question = "How do we beat the Fnatic Operator on Ascent defense?";
  const res = await worker.fetch(postJson("/api/scout-coach", { question, teamId: "FNC", mapId: "ascent", context: { note: "scrim tonight" } }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.source, "workers-ai");
  assert.equal(body.model, AI_MODEL);
  assert.equal(body.answer, "- Smoke A Main.\n- Trade the re-peek.");
  assert.equal(body.warning, undefined);
  const summary = buildScoutSummary({ teamId: "FNC", mapId: "ascent" });
  assert.equal(body.grounding.teamId, "FNC");
  assert.equal(body.grounding.mapId, "ascent");
  assert.equal(body.grounding.primaryOperatorSpot, summary.operator.primarySpot.callout);
  assert.equal(body.grounding.utilityEfficiencyScore, summary.utility.utilityEfficiencyScore);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(seen[0].input.max_tokens, 520);
  assert.equal(seen[0].input.temperature, 0.2);
  const [system, user] = seen[0].input.messages;
  assert.equal(system.role, "system");
  assert.match(system.content, /only from the TELEMETRY/);
  assert.match(system.content, /4 to 6/);
  assert.match(system.content, /untrusted/);
  assert.equal(user.role, "user");
  assert.ok(user.content.includes(question));
  assert.ok(user.content.includes(summary.operator.primarySpot.callout));
  assert.ok(user.content.includes("scrim tonight"));

  // The OpenAI-style response shape is read too, and the other rosters and maps are accepted.
  const chat = { AI: { run: async () => ({ choices: [{ message: { content: "- Chat shape." } }] }) } };
  const viaChat = await (await worker.fetch(postJson("/api/scout-coach", { question, teamId: "c9w", mapId: "LOTUS" }), chat)).json();
  assert.deepEqual([viaChat.source, viaChat.answer, viaChat.grounding.teamId, viaChat.grounding.mapId], ["workers-ai", "- Chat shape.", "C9W", "lotus"]);
});

test("POST /api/scout-coach falls back to the deterministic coach with HTTP 200 when the AI fails", async (t) => {
  noNetwork(t);
  const question = "How do we beat the Fnatic Operator on Ascent defense?";
  const expected = buildDeterministicCoachAnswer(buildScoutSummary({ teamId: "FNC", mapId: "ascent" }), question);
  const envs = {
    throws: { AI: { run: async () => { throw new Error("4006: daily allocation used up\n    at stack.frame (worker.js:1:1)"); } } },
    throwsSync: { AI: { run: () => { throw new Error("binding exploded"); } } },
    empty: { AI: { run: async () => ({ response: "   " }) } },
    wrongShape: { AI: { run: async () => ({ response: { nested: true } }) } },
    missing: {},
    undefinedEnv: undefined,
  };
  for (const [name, env] of Object.entries(envs)) {
    const res = await worker.fetch(postJson("/api/scout-coach", { question, teamId: "FNC", mapId: "ascent" }), env);
    assert.equal(res.status, 200, name);
    const body = await res.json();
    assert.equal(body.ok, true, name);
    assert.equal(body.source, "deterministic-coach", name);
    assert.equal(body.answer, expected, name);
    assert.ok(typeof body.warning === "string" && body.warning.length > 0, name);
    assert.ok(!body.warning.includes("stack.frame") && !body.warning.includes("\n"), `${name}: no stack trace`);
    assert.equal(body.grounding.teamId, "FNC");
    // The reason is one of the fixed codes with its fixed sentence, never the provider's wording.
    assert.equal(body.fallbackReason, { throws: "ai-error", throwsSync: "ai-error", empty: "ai-empty", wrongShape: "ai-empty", missing: "ai-unbound", undefinedEnv: "ai-unbound" }[name], name);
    assert.equal(body.warning, COACH_FALLBACKS[body.fallbackReason], name);
  }
  const thrownRes = await worker.fetch(postJson("/api/scout-coach", { question }), envs.throws);
  const thrownText = await thrownRes.text();
  assert.equal(JSON.parse(thrownText).warning, "Workers AI unavailable (request failed); the deterministic coach answered.");
  for (const leaked of ["4006", "allocation", "used up", "exploded", "stack.frame"]) {
    assert.ok(!thrownText.includes(leaked), `the provider text "${leaked}" is not relayed`);
  }
  for (const text of Object.values(COACH_FALLBACKS)) assert.doesNotMatch(text, /neuron|quota|plan|upgrade|4006/i);
});

test("POST /api/scout-coach only spends the model for same-origin requests under the per-address limit", async (t) => {
  noNetwork(t);
  let modelCalls = 0;
  let allowance = 2;
  const limiterKeys = [];
  const env = {
    AI: { run: async () => { modelCalls += 1; return { response: "- Model answer." }; } },
    COACH_LIMITER: { limit: async ({ key }) => { limiterKeys.push(key); allowance -= 1; return { success: allowance >= 0 }; } },
  };
  const question = "pistol plan?";
  const ask = (headers = {}, useEnv = env) => worker.fetch(postJson("/api/scout-coach", { question, teamId: "FNC", mapId: "ascent" }, { "CF-Connecting-IP": "203.0.113.7", ...headers }), useEnv);
  const expected = buildDeterministicCoachAnswer(buildScoutSummary({ teamId: "FNC", mapId: "ascent" }), question);

  // Two calls pass the limiter and reach the model. A request without an Origin header (curl)
  // and one from the dashboard's own origin are both accepted.
  for (const headers of [{}, { Origin: ORIGIN }]) {
    const body = await (await ask(headers)).json();
    assert.deepEqual([body.source, body.answer, body.fallbackReason, body.warning], ["workers-ai", "- Model answer.", undefined, undefined]);
  }
  assert.equal(modelCalls, 2);

  // The third is over the limit: still HTTP 200, answered without the model.
  const limited = await ask();
  assert.equal(limited.status, 200);
  const limitedBody = await limited.json();
  assert.deepEqual([limitedBody.ok, limitedBody.source, limitedBody.fallbackReason, limitedBody.answer], [true, "deterministic-coach", "rate-limited", expected]);
  assert.equal(limitedBody.warning, COACH_FALLBACKS["rate-limited"]);
  assert.ok(limitedBody.warning.includes(`${COACH_LIMIT_PER_MINUTE} per minute`));
  assert.equal(modelCalls, 2);
  assert.deepEqual(limiterKeys, ["203.0.113.7", "203.0.113.7", "203.0.113.7"]);

  // A page on another origin (or an opaque one) reaches neither the limiter nor the model.
  allowance = 100;
  for (const origin of ["https://evil.example", "null", "https://spikesight.test.evil.example", "http://spikesight.test", "not a url"]) {
    const res = await ask({ Origin: origin });
    assert.equal(res.status, 200, origin);
    const body = await res.json();
    assert.deepEqual([body.source, body.fallbackReason, body.answer, body.warning], ["deterministic-coach", "cross-origin", expected, COACH_FALLBACKS["cross-origin"]], origin);
  }
  assert.equal(modelCalls, 2);
  assert.equal(limiterKeys.length, 3);

  // A limiter that fails closes the model instead of opening it.
  const broken = { AI: env.AI, COACH_LIMITER: { limit: async () => { throw new Error("limiter down"); } } };
  const down = await (await ask({}, broken)).json();
  assert.deepEqual([down.source, down.fallbackReason, down.warning], ["deterministic-coach", "limiter-error", COACH_FALLBACKS["limiter-error"]]);
  assert.equal(modelCalls, 2);
  // The limiter is not charged when the model cannot be called anyway.
  await ask({}, { COACH_LIMITER: env.COACH_LIMITER });
  assert.equal(limiterKeys.length, 3);
  // A request without a client address still gets a limiter key.
  const anonymous = await (await worker.fetch(postJson("/api/scout-coach", { question }), env)).json();
  assert.equal(anonymous.source, "workers-ai");
  assert.equal(limiterKeys.at(-1), "unknown");
  assert.equal(modelCalls, 3);

  // The coach is same-origin only: no CORS header on its answers, while the public routes keep theirs.
  const coach = await ask({ Origin: ORIGIN });
  assert.equal(coach.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(limited.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/health`), {})).headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/grid/sample-series`), {})).headers.get("Access-Control-Allow-Origin"), "*");

  // wrangler.jsonc declares the binding with the limit the warning quotes.
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.ratelimits, [{ name: "COACH_LIMITER", namespace_id: "1001", simple: { limit: COACH_LIMIT_PER_MINUTE, period: 60 } }]);
});

test("POST /api/scout-coach falls back when Workers AI does not answer within 12 seconds", async (t) => {
  noNetwork(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = { AI: { run: () => new Promise(() => {}) } };          // never settles
  const pending = worker.fetch(postJson("/api/scout-coach", { question: "pistol plan?", teamId: "SEN", mapId: "haven" }), env);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));   // let the handler reach the race
  t.mock.timers.tick(12000);
  const res = await pending;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "deterministic-coach");
  assert.match(body.warning, /timed out after 12 s/);
  assert.match(body.answer, /^- Pistol rounds:/);
  assert.equal(body.grounding.teamId, "SEN");
});

test("POST /api/scout-coach survives bad bodies, unknown ids and oversized questions", async (t) => {
  noNetwork(t);
  const seen = [];
  const env = { AI: { run: async (model, input) => { seen.push(input); return { response: "- ok" }; } } };
  for (const raw of ["this is not json", "", "[]", "null", "\"text\"", "{\"question\": 5, \"teamId\": {}, \"mapId\": [] }"]) {
    const res = await worker.fetch(postJson("/api/scout-coach", raw), {});
    assert.equal(res.status, 200, JSON.stringify(raw));
    const body = JSON.parse(await res.text());
    assert.equal(body.ok, true);
    assert.equal(body.source, "deterministic-coach");
    assert.deepEqual([body.grounding.teamId, body.grounding.mapId], ["FNC", "ascent"]);
    assert.ok(body.answer.split("\n").length >= 4);
    assert.ok(body.warning.length > 0);
  }
  const unknown = await (await worker.fetch(postJson("/api/scout-coach", { question: "site?", teamId: "NAVI", mapId: "split" }), env)).json();
  assert.deepEqual([unknown.grounding.teamId, unknown.grounding.mapId], ["FNC", "ascent"]);
  assert.match(unknown.warning, /Unknown teamId/);
  assert.match(unknown.warning, /Unknown mapId/);

  // The question is clamped to 600 characters and the context to 4,000 before reaching the model.
  seen.length = 0;
  const long = await worker.fetch(postJson("/api/scout-coach", { question: "q".repeat(5000), teamId: "G2", mapId: "bind", context: { blob: "c".repeat(9000) } }), env);
  assert.equal(long.status, 200);
  assert.equal((await long.json()).source, "workers-ai");
  const user = seen[0].messages[1].content;
  assert.ok(user.includes("q".repeat(600)) && !user.includes("q".repeat(601)));
  assert.ok(user.includes("c".repeat(3900)) && !user.includes("c".repeat(4001)));
});

test("POST /api/scout-coach with dataSource grid-sample grounds on the hydrated Cloud9 vs Fnatic replay", async (t) => {
  noNetwork(t);
  const hydrated = hydrateGridSeries(SAMPLE_GRID_SERIES);
  const replay = buildScoutSummary({ teamId: "FNC", mapId: hydrated.mapId, rounds: hydrated.roundsByTeam.FNC, source: { kind: "grid-replay", seriesId: hydrated.seriesId } });
  const modelled = buildScoutSummary({ teamId: "FNC", mapId: "ascent" });
  const question = "How do we beat the Fnatic Operator on Ascent defense?";

  const res = await worker.fetch(postJson("/api/scout-coach", { question, teamId: "FNC", mapId: "ascent", dataSource: "grid-sample" }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "deterministic-coach");
  assert.equal(body.answer, buildDeterministicCoachAnswer(replay, question));
  assert.deepEqual(body.grounding, plain({ teamId: "FNC", teamName: "Fnatic", mapId: "ascent", dataset: replay.source.label, ...replay.keyNumbers }));
  assert.equal(body.grounding.dataset, "hydrated GRID replay spikesight-sample-c9-fnc-ascent");
  // Fnatic played 23 rounds and lost 10-13 in the replay; the modelled dataset has 24 rounds.
  assert.equal(body.grounding.rounds, 23);
  near(body.grounding.winRate, 10 / 23, 0.0001, "replay win rate");
  assert.equal(modelled.keyNumbers.rounds, 24);
  assert.notDeepEqual(plain(replay.keyNumbers), plain(modelled.keyNumbers));
  assert.notEqual(body.answer, buildDeterministicCoachAnswer(modelled, question));

  // The model is handed the replay telemetry too, and the other replay team is accepted.
  const seen = [];
  const env = { AI: { run: async (model, input) => { seen.push(input); return { response: "- Replay answer." }; } } };
  const viaAi = await (await worker.fetch(postJson("/api/scout-coach", { question, teamId: "C9", dataSource: "grid-sample" }), env)).json();
  assert.deepEqual([viaAi.source, viaAi.answer, viaAi.grounding.teamId, viaAi.grounding.rounds, viaAi.warning], ["workers-ai", "- Replay answer.", "C9", 23, undefined]);
  near(viaAi.grounding.winRate, 13 / 23, 0.0001, "Cloud9 replay win rate");
  assert.ok(seen[0].messages[1].content.includes("hydrated GRID replay spikesight-sample-c9-fnc-ascent"));

  // The replay is on Ascent: another requested map is replaced and reported.
  const otherMap = await (await worker.fetch(postJson("/api/scout-coach", { question, teamId: "FNC", mapId: "haven", dataSource: "grid-sample" }), {})).json();
  assert.equal(otherMap.grounding.mapId, "ascent");
  assert.equal(otherMap.grounding.rounds, 23);
  assert.match(otherMap.warning, /replay was played on Ascent/);
});

test("POST /api/scout-coach ignores any other dataSource value and uses the modelled dataset", async (t) => {
  noNetwork(t);
  const question = "When do they execute?";
  const baseline = await (await worker.fetch(postJson("/api/scout-coach", { question, teamId: "FNC", mapId: "ascent" }), {})).json();
  assert.equal(baseline.grounding.rounds, 24);
  assert.match(baseline.grounding.dataset, /^modelled scenario dataset/);
  for (const dataSource of ["grid-live", "GRID-SAMPLE", " grid-sample", "", 1, true, null, ["grid-sample"], { kind: "grid-sample" }]) {
    const res = await worker.fetch(postJson("/api/scout-coach", { question, teamId: "FNC", mapId: "ascent", dataSource }), {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), baseline, `dataSource ${JSON.stringify(dataSource)}`);
  }
});

test("POST /api/scout-coach with dataSource grid-sample falls back to the modelled dataset for a team outside the replay", async (t) => {
  noNetwork(t);
  const question = "Where does their Operator hold?";
  const modelled = buildScoutSummary({ teamId: "SEN", mapId: "ascent" });
  const res = await worker.fetch(postJson("/api/scout-coach", { question, teamId: "SEN", mapId: "ascent", dataSource: "grid-sample" }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.answer, buildDeterministicCoachAnswer(modelled, question));
  assert.deepEqual(body.grounding, plain({ teamId: "SEN", teamName: "Sentinels", mapId: "ascent", dataset: modelled.source.label, ...modelled.keyNumbers }));
  assert.match(body.grounding.dataset, /^modelled scenario dataset/);
  assert.match(body.warning, /SEN did not play in the GRID sample replay; the modelled dataset was used\./);

  // The requested map is kept for a team that is not in the replay.
  const haven = await (await worker.fetch(postJson("/api/scout-coach", { question, teamId: "PRX", mapId: "haven", dataSource: "grid-sample" }), {})).json();
  assert.deepEqual([haven.grounding.teamId, haven.grounding.mapId, haven.grounding.rounds], ["PRX", "haven", 24]);
  assert.match(haven.warning, /PRX did not play in the GRID sample replay/);
});

test("method handling: coach GET is 405, GRID preflight is 204 with the key header allowed, the coach preflight grants nothing, unknown API routes are 404", async () => {
  const get = await worker.fetch(new Request(`${ORIGIN}/api/scout-coach`), {});
  assert.equal(get.status, 405);
  assert.match(get.headers.get("Allow"), /POST/);
  assert.equal(get.headers.get("Access-Control-Allow-Origin"), null);
  for (const path of ["/api/grid/sample-series", "/api/grid/query"]) {
    const preflight = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: "OPTIONS" }), {});
    assert.equal(preflight.status, 204);
    assert.equal(await preflight.text(), "");
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
    const allowed = preflight.headers.get("Access-Control-Allow-Headers");
    assert.match(allowed, /Content-Type/);
    assert.match(allowed, /x-api-key/);
  }
  // The coach is same-origin only: its preflight answers 204 but grants nothing, so a browser
  // on another origin never sends the JSON request.
  const coachPreflight = await worker.fetch(new Request(`${ORIGIN}/api/scout-coach`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } }), {});
  assert.equal(coachPreflight.status, 204);
  assert.equal(await coachPreflight.text(), "");
  for (const header of ["Access-Control-Allow-Origin", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods"]) {
    assert.equal(coachPreflight.headers.get(header), null, header);
  }
  assert.match(coachPreflight.headers.get("Allow"), /POST/);
  let assetCalls = 0;
  const env = { ASSETS: { fetch: async () => { assetCalls += 1; return new Response("x"); } } };
  const missing = await worker.fetch(new Request(`${ORIGIN}/api/nope`), env);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /Unknown API route/);
  assert.equal(assetCalls, 0);
});

test("static assets: / is served as /index.html with security headers and errors become JSON 500", async () => {
  const requested = [];
  const env = {
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        requested.push(path);
        if (path === "/index.html") return new Response("<!doctype html><title>SpikeSight C9</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
        if (path === "/js/app.js") return new Response("export {};", { headers: { "Content-Type": "text/javascript" } });
        return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      },
    },
  };
  const home = await worker.fetch(new Request(`${ORIGIN}/`), env);
  assert.equal(home.status, 200);
  assert.deepEqual(requested, ["/index.html"]);
  assert.match(await home.text(), /SpikeSight C9/);
  const csp = home.headers.get("Content-Security-Policy");
  assert.equal(csp, "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  assert.equal(home.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(home.headers.get("Referrer-Policy"), "no-referrer");

  const script = await worker.fetch(new Request(`${ORIGIN}/js/app.js`), env);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("Content-Security-Policy"), null);
  assert.equal(script.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/missing.png`), env)).status, 404);
  assert.deepEqual(requested, ["/index.html", "/js/app.js", "/missing.png"]);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/`, { method: "POST", body: "x" }), env)).status, 405);

  const broken = { ASSETS: { fetch: async () => { throw new Error("assets exploded\n    at secret.frame"); } } };
  const res = await worker.fetch(new Request(`${ORIGIN}/`), broken);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: "Internal error." });
});

// ===========================================================================
// Source hygiene
// ===========================================================================

test("analytics sources use no Math.random or Date.now and carry no literal credential", () => {
  const files = ["../public/js/tactical-maps.js", "../public/js/pro-data.js", "../public/js/scout-engine.js", "../worker/index.js", "../wrangler.jsonc"];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /Math\.random\s*\(/, `${file} calls Math.random`);
    assert.doesNotMatch(source, /Date\.now\s*\(|new Date\s*\(/, `${file} reads the clock`);
    assert.doesNotMatch(source, /account_id|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN|Bearer\s+[A-Za-z0-9._-]{12,}/, `${file} contains a credential-like string`);
    assert.doesNotMatch(source, /\bconsole\.(log|info|debug|warn|error)\s*\(/, `${file} logs to the console`);
  }
});
