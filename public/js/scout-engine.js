// SpikeSight C9 - scouting analytics engine.
//
// Pure module: no DOM, no I/O, no Date.now, no Math.random. The same file runs in the
// browser, in the Cloudflare Worker and in the node:test suite. Every stochastic result
// comes from mulberry32(seed), so identical inputs always give identical outputs.
//
// Layers
//   1. Utility placement and ability analysis  (filterUtility, clusterUtility, computeUtilityMetrics)
//   2. Operator tendency and sniper profiler   (buildOperatorProfile, recommendAntiOp, sight cone maths)
//   3. Economy and round win probability       (classifyEconomy, roundWinProbability, simulateMap, ...)
//   4. GRID hydrator, scouting summary, dossier and deterministic coach

import { MAP_IDS, getMap, getCallout, gameToNormalized, clamp01, nearestCallout } from "./tactical-maps.js";
import { TEAMS, getTeamRounds, findTeamId, mulberry32, classifyEconomy, VALORANT_RULES, UTILITY_RADIUS } from "./pro-data.js";

export { mulberry32, classifyEconomy, VALORANT_RULES };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
// "+ 0" turns a negative zero into 0 so rounded values compare and serialise cleanly.
const round1 = (n) => Math.round(n * 10) / 10 + 0;
const round2 = (n) => Math.round(n * 100) / 100 + 0;
const round4 = (n) => Math.round(n * 10000) / 10000 + 0;
const ratio = (part, whole) => (whole > 0 ? part / whole : 0);
const pct = (v) => `${Math.round((isNum(v) ? v : 0) * 100)}%`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const list = (v) => (Array.isArray(v) ? v : []);

/** Most frequent value of a list; ties go to the alphabetically first value. Null when empty. */
function modal(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && String(value) < String(best))) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Key with the largest value; ties go to the alphabetically first key. Null when empty. */
function topKey(shares) {
  let best = null;
  for (const key of Object.keys(shares ?? {}).sort()) {
    if (best === null || shares[key] > shares[best]) best = key;
  }
  return best;
}

// ===========================================================================
// LAYER 1 - Utility placement and ability analysis
// ===========================================================================

export const UTILITY_TYPES = Object.freeze(["smoke", "flash", "recon", "molly"]);

export const UTILITY_LABELS = Object.freeze({
  smoke: "Smokes",
  flash: "Flashes",
  recon: "Recon/Info",
  molly: "Mollies/Post-Plant",
});

/** Round phases used by the filter. `postplant` has no fixed clock window: it starts at the plant. */
export const ROUND_PHASES = Object.freeze([
  Object.freeze({ id: "default", label: "0\u201330s Default", from: 0, to: 30 }),
  Object.freeze({ id: "execute", label: "30\u201365s Execute", from: 30, to: 65 }),
  Object.freeze({ id: "postplant", label: "Post-Plant", from: null, to: null }),
]);

const EXECUTE_START = 30;

/**
 * Phase of one utility event inside its round.
 *   postplant  event.postPlant is true, or round.plantTime is a number and event.time >= plantTime
 *   default    otherwise, event.time < 30
 *   execute    otherwise (30 s and later, before the plant)
 * A missing or non-finite time counts as 0.
 */
export function classifyPhase(event, round) {
  if (event?.postPlant === true) return "postplant";
  const time = Number.isFinite(Number(event?.time)) ? Number(event.time) : 0;
  if (isNum(round?.plantTime) && time >= round.plantTime) return "postplant";
  return time < EXECUTE_START ? "default" : "execute";
}

/**
 * Flatten the utility events of `rounds`, keeping only the requested ones.
 *   types  array or Set of utility types; omitted = every type
 *   side   "attack" | "defense" | "both" (default)
 *   phase  "default" | "execute" | "postplant" | "all" (default)
 * Each returned event is a copy with roundNumber, side and phase added.
 */
export function filterUtility(rounds, { types, side = "both", phase = "all" } = {}) {
  const typeSet = types == null ? null : new Set(types);
  const out = [];
  for (const round of list(rounds)) {
    if (!round) continue;
    if (side !== "both" && side != null && round.side !== side) continue;
    for (const event of list(round.utilityEvents)) {
      if (!event || (typeSet && !typeSet.has(event.type))) continue;
      const eventPhase = classifyPhase(event, round);
      if (phase !== "all" && phase != null && eventPhase !== phase) continue;
      out.push({ ...event, roundNumber: round.roundNumber, side: round.side, phase: eventPhase });
    }
  }
  return out;
}

/**
 * Spatial density clusters (greedy leader clustering, deterministic for a given input order).
 * Walk the events in order: an event joins the first existing cluster of the same type whose
 * running centroid is within `radius` (normalised units), otherwise it starts a new cluster.
 * Output per cluster:
 *   x, y    centroid = mean of member positions
 *   count   number of members
 *   share   count / all clustered events
 *   radius  distance from the centroid to its farthest member, never less than radius / 2
 * Sorted by count (largest first); equal counts keep first-seen order.
 */
export function clusterUtility(events, { radius = 0.05 } = {}) {
  const merge = isNum(radius) && radius > 0 ? radius : 0.05;
  const clusters = [];
  let total = 0;
  for (const event of list(events)) {
    const x = event?.position?.x;
    const y = event?.position?.y;
    if (!isNum(x) || !isNum(y)) continue;
    total += 1;
    let home = null;
    for (const c of clusters) {
      if (c.type === event.type && Math.hypot(c.sx / c.count - x, c.sy / c.count - y) <= merge) {
        home = c;
        break;
      }
    }
    if (!home) {
      home = { type: event.type, sx: 0, sy: 0, count: 0, members: [], order: clusters.length };
      clusters.push(home);
    }
    home.sx += x;
    home.sy += y;
    home.count += 1;
    home.members.push([x, y]);
  }
  return clusters
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map((c) => {
      const cx = c.sx / c.count;
      const cy = c.sy / c.count;
      const spread = c.members.reduce((m, [x, y]) => Math.max(m, Math.hypot(x - cx, y - cy)), 0);
      return {
        type: c.type,
        x: round4(cx),
        y: round4(cy),
        count: c.count,
        share: ratio(c.count, total),
        radius: round4(Math.max(spread, merge / 2)),
      };
    });
}

/**
 * Sites of one round, read from the team's own telemetry.
 *   attackedSite  attack round:  plantSite, else the most frequent `site` of its execute-phase utility
 *                 defense round: plantSite, else the most frequent `site` of its execute and
 *                                post-plant utility (the reaction to the hit)
 *   stackedSite   defense round only: the most frequent `site` among default-phase utility
 *                 events and Operator hold spots (the setup before the hit)
 * Ties go to the alphabetically first site. Null when the round carries no site.
 */
export function roundSites(round) {
  const events = list(round?.utilityEvents);
  const sitesWhere = (test) => events
    .filter((e) => e && typeof e.site === "string" && e.site && test(classifyPhase(e, round)))
    .map((e) => e.site);
  const plant = typeof round?.plantSite === "string" && round.plantSite ? round.plantSite : null;
  if (round?.side === "attack") {
    return { attackedSite: plant ?? modal(sitesWhere((p) => p === "execute")), stackedSite: null };
  }
  const holds = list(round?.operatorHoldSpots).map((h) => h?.site).filter((s) => typeof s === "string" && s);
  return {
    attackedSite: plant ?? modal(sitesWhere((p) => p !== "default")),
    stackedSite: modal([...sitesWhere((p) => p === "default"), ...holds]),
  };
}

/** Execute timing histogram buckets, in seconds into the round. The last one is open-ended. */
export const EXECUTE_BUCKETS = Object.freeze([
  [30, 35], [35, 40], [40, 45], [45, 50], [50, 55], [55, 60], [60, 65], [65, null],
].map(([from, to]) => Object.freeze({ label: to === null ? `${from}s+` : `${from}-${to}s`, from, to })));

function shareMap(counts, sites) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const keys = [...new Set([...(sites ?? []), ...Object.keys(counts)])].sort();
  const out = {};
  if (total === 0) return out;
  for (const key of keys) out[key] = (counts[key] ?? 0) / total;
  return out;
}

/**
 * Utility metrics for one team's rounds. Formulas (all counts are over the given rounds):
 *
 *   utilityEfficiencyScore = 100 * (utility events with enemiesAffected >= 1 or assistedKill true)
 *                                / (all utility events)                         range 0..100, 1 decimal
 *   flashAssistRate        = (flashes with assistedKill true) / (all flashes)   range 0..1
 *   executeTiming          = for every attack round, the time of its first execute-phase utility
 *                            event (time >= 30 s and before the plant). Those times are counted
 *                            into EXECUTE_BUCKETS; share = bucket count / rounds with such an
 *                            event; medianSeconds = median of the times (mean of the two middle
 *                            values for an even count); peak = fullest bucket (first on ties)
 *   siteBias.attack[S]     = attack rounds whose attackedSite is S / attack rounds with a site
 *   siteBias.defense[S]    = defense rounds whose stackedSite is S / defense rounds with a site
 *                            (attackedSite and stackedSite are defined in roundSites)
 *
 * Shares of one side sum to 1. Pass { mapId } to list every site of the map (zero shares
 * included). Empty input returns zeros, empty lists and empty objects, never NaN.
 */
export function computeUtilityMetrics(rounds, { mapId } = {}) {
  const sites = mapId == null ? null : getMap(mapId).sites;
  const all = list(rounds).filter(Boolean);
  let events = 0;
  let effective = 0;
  let flashes = 0;
  let assistedFlashes = 0;
  let postPlantEvents = 0;
  const typeCounts = { smoke: 0, flash: 0, recon: 0, molly: 0 };
  const executeTimes = [];
  const attackCounts = {};
  const defenseCounts = {};
  let attackRounds = 0;
  let defenseRounds = 0;

  for (const round of all) {
    let firstExecute = null;
    for (const e of list(round.utilityEvents)) {
      if (!e) continue;
      events += 1;
      if (Object.prototype.hasOwnProperty.call(typeCounts, e.type)) typeCounts[e.type] += 1;
      if (Number(e.enemiesAffected) >= 1 || e.assistedKill === true) effective += 1;
      if (e.type === "flash") {
        flashes += 1;
        if (e.assistedKill === true) assistedFlashes += 1;
      }
      const phase = classifyPhase(e, round);
      if (phase === "postplant") postPlantEvents += 1;
      if (round.side === "attack" && phase === "execute" && isNum(e.time) && (firstExecute === null || e.time < firstExecute)) {
        firstExecute = e.time;
      }
    }
    const { attackedSite, stackedSite } = roundSites(round);
    if (round.side === "attack") {
      attackRounds += 1;
      if (firstExecute !== null) executeTimes.push(firstExecute);
      if (attackedSite) attackCounts[attackedSite] = (attackCounts[attackedSite] ?? 0) + 1;
    } else if (round.side === "defense") {
      defenseRounds += 1;
      if (stackedSite) defenseCounts[stackedSite] = (defenseCounts[stackedSite] ?? 0) + 1;
    }
  }

  const sorted = [...executeTimes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const buckets = EXECUTE_BUCKETS.map((b) => {
    const count = sorted.filter((t) => t >= b.from && (b.to === null || t < b.to)).length;
    return { label: b.label, from: b.from, to: b.to, count, share: ratio(count, sorted.length) };
  });
  let peak = null;
  for (const b of buckets) if (b.count > 0 && (peak === null || b.count > peak.count)) peak = b;

  const typeShares = {};
  for (const type of UTILITY_TYPES) typeShares[type] = ratio(typeCounts[type], events);

  return {
    utilityEfficiencyScore: round1(100 * ratio(effective, events)),
    flashAssistRate: round4(ratio(assistedFlashes, flashes)),
    executeTiming: { buckets, medianSeconds: round1(median), rounds: sorted.length, peak },
    siteBias: { attack: shareMap(attackCounts, sites), defense: shareMap(defenseCounts, sites) },
    typeCounts,
    typeShares,
    postPlantEvents,
    sampleSize: {
      rounds: all.length,
      attackRounds,
      defenseRounds,
      utilityEvents: events,
      effectiveEvents: effective,
      flashes,
      assistedFlashes,
    },
  };
}

// ===========================================================================
// LAYER 2 - Operator tendency and sniper profiler
// ===========================================================================

const DEFAULT_FOV_DEG = 18;
const DEFAULT_RANGE = 0.2;

/**
 * Read position, unit sightline, fov and range from either a raw hold spot
 * ({ position: { x, y }, sightline: { dx, dy }, fovDeg, range }) or an aggregated
 * profile spot ({ x, y, dx, dy, fovDeg, range }). `valid` is false for non-finite
 * numbers or a zero-length sightline.
 */
function spotGeometry(spot) {
  const x = Number(spot?.position?.x ?? spot?.x);
  const y = Number(spot?.position?.y ?? spot?.y);
  const dx = Number(spot?.sightline?.dx ?? spot?.dx);
  const dy = Number(spot?.sightline?.dy ?? spot?.dy);
  const len = Math.hypot(dx, dy);
  const valid = [x, y, dx, dy].every(Number.isFinite) && len > 1e-9;
  return {
    x,
    y,
    ux: valid ? dx / len : 0,
    uy: valid ? dy / len : 0,
    fovDeg: isNum(spot?.fovDeg) && spot.fovDeg > 0 ? Math.min(spot.fovDeg, 360) : DEFAULT_FOV_DEG,
    range: isNum(spot?.range) && spot.range > 0 ? spot.range : DEFAULT_RANGE,
    valid,
  };
}

/**
 * Bearing of a sightline in degrees, 0..360, in minimap space (x grows right, y grows DOWN):
 * (1, 0) = 0 right, (0, 1) = 90 down, (-1, 0) = 180 left, (0, -1) = 270 up.
 * Returns null for a zero-length or non-finite vector.
 */
export function sightlineAngleDeg(dx, dy) {
  if (!isNum(dx) || !isNum(dy) || Math.hypot(dx, dy) < 1e-9) return null;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return round4((deg + 360) % 360);
}

/**
 * Polygon points of the sight cone in SVG user units: the apex (the hold position) followed
 * by `steps + 1` points on the arc at distance `range`, swept from -fovDeg / 2 to +fovDeg / 2
 * around the sightline. Returns [] when the spot has no usable sightline.
 */
export function sightlineCone(spot, { size = 1000, steps = 8 } = {}) {
  const g = spotGeometry(spot);
  if (!g.valid) return [];
  const n = Math.max(1, Math.floor(steps));
  const base = Math.atan2(g.uy, g.ux);
  const half = (g.fovDeg / 2) * (Math.PI / 180);
  const points = [[round2(g.x * size), round2(g.y * size)]];
  for (let i = 0; i <= n; i += 1) {
    const a = base - half + (2 * half * i) / n;
    points.push([round2((g.x + Math.cos(a) * g.range) * size), round2((g.y + Math.sin(a) * g.range) * size)]);
  }
  return points;
}

/**
 * True when `point` is inside the spot's sight cone: within `range` of the hold position and
 * within fovDeg / 2 of the sightline. The hold position itself counts as inside. A zero-length
 * sightline, or any non-finite number, returns false.
 */
export function isInSightCone(spot, point) {
  const g = spotGeometry(spot);
  if (!g.valid) return false;
  const px = Number(point?.x);
  const py = Number(point?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
  const vx = px - g.x;
  const vy = py - g.y;
  const dist = Math.hypot(vx, vy);
  if (dist > g.range + 1e-9) return false;
  if (dist < 1e-9) return true;
  const cos = (vx * g.ux + vy * g.uy) / dist;
  return cos >= Math.cos((g.fovDeg / 2) * (Math.PI / 180)) - 1e-9;
}

/**
 * Aggregate Operator hold spots over a team's rounds. Formulas:
 *
 *   spot.holds               = hold records at that callout
 *   spot.firstBloodPickRate  = spot.firstBloods / spot.holds
 *   spot.rePeekRate          = spot.rePeeks / spot.holds
 *   spot x, y, fovDeg, range = mean over its holds; dx, dy = normalised mean of the unit sightlines
 *   operatorRoundRate        = rounds with at least one hold / all rounds
 *   buyRoundOpFrequency      = FULL_BUY rounds with a hold / FULL_BUY rounds
 *   ecoRoundOpFrequency      = ECO and HALF_BUY rounds with a hold / ECO and HALF_BUY rounds
 *   firstBloodPickRate       = all first-blood holds / all holds
 *   rePeekRate               = all re-peeked holds / all holds
 *   primarySpot              = the spot with the most holds (then most first bloods, then name)
 *
 * No holds gives zeros, an empty spot list and primarySpot null.
 */
export function buildOperatorProfile(rounds) {
  const all = list(rounds).filter(Boolean);
  const byCallout = new Map();
  let opRounds = 0;
  let buyRounds = 0;
  let buyOpRounds = 0;
  let ecoRounds = 0;
  let ecoOpRounds = 0;
  let holds = 0;
  let firstBloods = 0;
  let rePeeks = 0;
  let kills = 0;

  for (const round of all) {
    const spots = list(round.operatorHoldSpots).filter(Boolean);
    const hasOp = spots.length > 0;
    if (hasOp) opRounds += 1;
    if (round.economyState === "FULL_BUY") {
      buyRounds += 1;
      if (hasOp) buyOpRounds += 1;
    } else if (round.economyState === "ECO" || round.economyState === "HALF_BUY") {
      ecoRounds += 1;
      if (hasOp) ecoOpRounds += 1;
    }
    for (const h of spots) {
      const key = typeof h.callout === "string" && h.callout ? h.callout : "Unknown";
      let agg = byCallout.get(key);
      if (!agg) {
        agg = { callout: key, players: [], sides: [], sites: [], watches: [], n: 0, sx: 0, sy: 0, sdx: 0, sdy: 0, sfov: 0, srange: 0, firstBloods: 0, rePeeks: 0, kills: 0 };
        byCallout.set(key, agg);
      }
      const g = spotGeometry(h);
      agg.n += 1;
      if (Number.isFinite(g.x) && Number.isFinite(g.y)) {
        agg.sx += g.x;
        agg.sy += g.y;
      }
      agg.sdx += g.ux;
      agg.sdy += g.uy;
      agg.sfov += g.fovDeg;
      agg.srange += g.range;
      if (h.firstBlood === true) agg.firstBloods += 1;
      if (h.rePeeked === true) agg.rePeeks += 1;
      const k = Number.isFinite(Number(h.kills)) ? Math.max(0, Number(h.kills)) : 0;
      agg.kills += k;
      if (typeof h.player === "string" && h.player) agg.players.push(h.player);
      if (round.side === "attack" || round.side === "defense") agg.sides.push(round.side);
      if (typeof h.site === "string" && h.site) agg.sites.push(h.site);
      if (typeof h.watch === "string" && h.watch) agg.watches.push(h.watch);
      holds += 1;
      if (h.firstBlood === true) firstBloods += 1;
      if (h.rePeeked === true) rePeeks += 1;
      kills += k;
    }
  }

  const spots = [...byCallout.values()].map((a) => {
    const len = Math.hypot(a.sdx, a.sdy);
    const dx = len > 1e-9 ? round4(a.sdx / len) : 0;
    const dy = len > 1e-9 ? round4(a.sdy / len) : 0;
    return {
      callout: a.callout,
      player: modal(a.players) ?? "Operator",
      side: modal(a.sides),
      site: modal(a.sites),
      watch: modal(a.watches),
      x: round4(a.sx / a.n),
      y: round4(a.sy / a.n),
      dx,
      dy,
      angleDeg: sightlineAngleDeg(dx, dy),
      fovDeg: round1(a.sfov / a.n),
      range: round4(a.srange / a.n),
      holds: a.n,
      firstBloods: a.firstBloods,
      firstBloodPickRate: round4(a.firstBloods / a.n),
      rePeeks: a.rePeeks,
      rePeekRate: round4(a.rePeeks / a.n),
      kills: a.kills,
    };
  }).sort((a, b) => b.holds - a.holds || b.firstBloods - a.firstBloods || (a.callout < b.callout ? -1 : a.callout > b.callout ? 1 : 0));

  return {
    spots,
    rounds: all.length,
    operatorRounds: opRounds,
    holds,
    kills,
    operatorRoundRate: round4(ratio(opRounds, all.length)),
    buyRounds,
    buyRoundOpFrequency: round4(ratio(buyOpRounds, buyRounds)),
    ecoRounds,
    ecoRoundOpFrequency: round4(ratio(ecoOpRounds, ecoRounds)),
    firstBloodPickRate: round4(ratio(firstBloods, holds)),
    rePeekRate: round4(ratio(rePeeks, holds)),
    primarySpot: spots[0] ?? null,
  };
}

/** A spot whose re-peek rate is strictly above this gets a re-peek punish recommendation. */
export const RE_PEEK_PUNISH_THRESHOLD = 0.5;

/**
 * Ranked anti-Operator counters for the top `limit` hold spots (most holds first).
 * For each spot the watched callout is spot.watch when it names a callout of the map, otherwise
 * the callout nearest to the point 80% of the way down the sightline. Counters per spot:
 *   smoke      35% of the way from the hold spot to the watched callout (cuts the line near the scope)
 *   flash      75% of the way (pops inside the scope's view just before the entry crosses)
 *   trade      only when rePeekRate > 0.5: keep a rifle on the line and trade the second peek
 *   jump-peek  only when rePeekRate <= 0.5: bait the first shot, expect a reposition
 *   avoid      only when holds >= 2 and firstBloodPickRate >= 0.5: do not dry-peek that lane
 * Every counter position lies on the segment from the hold spot to the watched callout. If that
 * segment leaves the cone (a hold whose sightline points away from the callout) the position
 * falls back to the same fraction along the sightline itself, so isInSightCone is always true.
 */
export function recommendAntiOp(mapId, profile, { limit = 3 } = {}) {
  const map = getMap(mapId);
  const out = [];
  const spots = list(profile?.spots).slice(0, Math.max(0, limit));
  spots.forEach((spot, index) => {
    const g = spotGeometry(spot);
    if (!g.valid) return;
    let watched = typeof spot.watch === "string" ? getCallout(map.id, spot.watch) : null;
    if (!watched) watched = nearestCallout(map.id, g.x + g.ux * g.range * 0.8, g.y + g.uy * g.range * 0.8);
    const reach = Math.hypot(watched.x - g.x, watched.y - g.y);
    const along = (fraction) => {
      let p = { x: g.x + (watched.x - g.x) * fraction, y: g.y + (watched.y - g.y) * fraction };
      if (!isInSightCone(spot, p)) {
        const d = Math.min(g.range, reach > 1e-9 ? reach : g.range) * fraction;
        p = { x: g.x + g.ux * d, y: g.y + g.uy * d };
      }
      return { x: round4(clamp01(p.x)), y: round4(clamp01(p.y)) };
    };
    const add = (type, fraction, text, extra = {}) => {
      out.push({ rank: out.length + 1, spotRank: index + 1, spot: spot.callout, type, from: watched.name, target: spot.callout, ...along(fraction), text, rePeekPunish: false, ...extra });
    };
    const who = spot.player ?? "The Operator";
    const fb = pct(spot.firstBloodPickRate);
    const rp = pct(spot.rePeekRate);
    add("smoke", 0.35, `Smoke the ${spot.callout} Operator line before anyone crosses ${watched.name}: ${who} held it on ${spot.holds} round(s) with a ${fb} first-blood pick rate.`);
    add("flash", 0.75, `Pop a flash from ${watched.name} toward ${spot.callout} and swing on the pop, so the scope is blind when the entry crosses.`);
    if (spot.rePeekRate > RE_PEEK_PUNISH_THRESHOLD) {
      add("trade", 1, `Punish the re-peek: ${who} re-peeks ${spot.callout} on ${rp} of holds, so keep a second rifle on the same line from ${watched.name} and trade the second peek.`, { rePeekPunish: true });
    } else {
      add("jump-peek", 1, `Jump-peek ${watched.name} to bait the first shot from ${spot.callout}. The re-peek rate is ${rp}, so expect a reposition and clear the next angle instead of waiting for a second peek.`);
    }
    if (spot.holds >= 2 && spot.firstBloodPickRate >= 0.5) {
      add("avoid", 1, `Do not dry-peek ${watched.name} on defaults: ${spot.callout} converted ${spot.firstBloods} first blood(s) in ${spot.holds} holds. Take space on another lane first.`);
    }
  });
  return out;
}

// ===========================================================================
// LAYER 3 - Economy and round win probability (Markov chain + Monte Carlo)
// ===========================================================================

/** Economy states in ascending strength. classifyEconomy (pro-data.js) returns one of these. */
export const ECONOMY_STATES = Object.freeze(["PISTOL", "ECO", "HALF_BUY", "FULL_BUY"]);

export const ECONOMY_LABELS = Object.freeze({
  PISTOL: "Pistol",
  ECO: "Eco",
  HALF_BUY: "Half-Buy / Bonus",
  FULL_BUY: "Full Buy",
});

/**
 * Count and win rate per economy state, plus pistol-round win rate per side.
 *   states[S].winRate = rounds in state S that were won / rounds in state S
 *   pistol[side]      = the same over PISTOL rounds played on that side
 */
export function summarizeEconomy(rounds) {
  const all = list(rounds).filter(Boolean);
  const states = {};
  for (const id of ECONOMY_STATES) states[id] = { label: ECONOMY_LABELS[id], count: 0, wins: 0, winRate: 0, averageLoadout: 0 };
  const pistol = { attack: { rounds: 0, wins: 0, winRate: 0 }, defense: { rounds: 0, wins: 0, winRate: 0 }, rounds: 0, wins: 0, winRate: 0 };
  const loadoutSum = { PISTOL: 0, ECO: 0, HALF_BUY: 0, FULL_BUY: 0 };
  let wins = 0;
  for (const round of all) {
    const won = round.won === true;
    if (won) wins += 1;
    const s = states[round.economyState];
    if (!s) continue;
    s.count += 1;
    if (won) s.wins += 1;
    loadoutSum[round.economyState] += isNum(round.loadoutValue) ? round.loadoutValue : 0;
    if (round.economyState === "PISTOL") {
      pistol.rounds += 1;
      if (won) pistol.wins += 1;
      const side = pistol[round.side];
      if (side && typeof side === "object") {
        side.rounds += 1;
        if (won) side.wins += 1;
      }
    }
  }
  for (const id of ECONOMY_STATES) {
    states[id].winRate = round4(ratio(states[id].wins, states[id].count));
    states[id].averageLoadout = Math.round(ratio(loadoutSum[id], states[id].count));
  }
  pistol.attack.winRate = round4(ratio(pistol.attack.wins, pistol.attack.rounds));
  pistol.defense.winRate = round4(ratio(pistol.defense.wins, pistol.defense.rounds));
  pistol.winRate = round4(ratio(pistol.wins, pistol.rounds));
  return { states, pistol, rounds: all.length, wins, winRate: round4(ratio(wins, all.length)) };
}

/**
 * MODEL ASSUMPTIONS (not measured statistics). Probability that the row team wins a round
 * against the column team, by economy state, before side and strength adjustments. The matrix
 * is symmetric around 0.5: P[a][b] = 1 - P[b][a]. PISTOL only meets PISTOL in a real match;
 * the mixed cells reuse the ECO values so the function is total.
 */
export const ROUND_WIN_MATRIX = Object.freeze({
  PISTOL: Object.freeze({ PISTOL: 0.5, ECO: 0.5, HALF_BUY: 0.3, FULL_BUY: 0.12 }),
  ECO: Object.freeze({ PISTOL: 0.5, ECO: 0.5, HALF_BUY: 0.3, FULL_BUY: 0.12 }),
  HALF_BUY: Object.freeze({ PISTOL: 0.7, ECO: 0.7, HALF_BUY: 0.5, FULL_BUY: 0.32 }),
  FULL_BUY: Object.freeze({ PISTOL: 0.88, ECO: 0.88, HALF_BUY: 0.68, FULL_BUY: 0.5 }),
});

/** MODEL ASSUMPTION: round win edge of the attacking side per map (negative = defender-sided). */
export const MAP_ATTACK_EDGE = Object.freeze({ ascent: -0.02, haven: 0.01, bind: -0.01, lotus: 0.01 });

/**
 * Round win probability for "our" team:
 *   p = ROUND_WIN_MATRIX[ourEconomy][theirEconomy]
 *     + MAP_ATTACK_EDGE[mapId]   when we attack (subtracted when we defend; 0 for an unknown map)
 *     + strengthEdge             (clamped to -0.3..0.3)
 * clamped to [0.02, 0.98]. An unknown economy state is treated as FULL_BUY.
 */
export function roundWinProbability({ ourEconomy, theirEconomy, ourSide, mapId, strengthEdge = 0 } = {}) {
  const row = ROUND_WIN_MATRIX[ourEconomy] ?? ROUND_WIN_MATRIX.FULL_BUY;
  const base = row[theirEconomy] ?? row.FULL_BUY;
  const mapEdge = Object.prototype.hasOwnProperty.call(MAP_ATTACK_EDGE, mapId) ? MAP_ATTACK_EDGE[mapId] : 0;
  const sideEdge = ourSide === "attack" ? mapEdge : ourSide === "defense" ? -mapEdge : 0;
  const edge = Number.isFinite(Number(strengthEdge)) ? clamp(Number(strengthEdge), -0.3, 0.3) : 0;
  return clamp(base + sideEdge + edge, 0.02, 0.98);
}

/**
 * Simulator constants. Credits are TEAM totals (five players), matching the `credits` and
 * `loadoutValue` fields of the round data. Rule values come from VALORANT_RULES; the buy
 * policy and the carry-over shares are model assumptions.
 */
export const SIM_MODEL = Object.freeze({
  teamSize: 5,
  pistolBank: 5 * VALORANT_RULES.pistolCredits,          // 4,000
  pistolSpend: 3400,                                      // what a team spends on a pistol round
  fullBuyCost: 21500,                                     // rifle + full armour + utility for five
  saveSpend: 2000,                                        // light buy on a save round
  halfBuyShare: 0.7,                                      // share of the bank spent after a win without full-buy money
  winnerCarry: 0.6,                                       // share of the loadout the winner keeps
  loserCarry: 0.1,                                        // share of the loadout the loser keeps
  winCredits: 5 * VALORANT_RULES.winReward,               // 15,000
  lossCredits: Object.freeze(VALORANT_RULES.lossRewards.map((v) => 5 * v)), // 9,500 / 12,000 / 14,500
  plantCredits: 5 * VALORANT_RULES.plantReward,           // 1,500 to the attackers when the spike is planted
  winnerKillCredits: 5 * VALORANT_RULES.killReward,       // 1,000 (five kills)
  loserKillCredits: 2 * VALORANT_RULES.killReward,        // 400 (two kills)
  bankCap: 5 * VALORANT_RULES.creditCap,                  // 45,000
  plantProbAttackWin: 0.75,
  plantProbAttackLoss: 0.4,
  overtimeBank: 25000,                                    // 5,000 each in every overtime round
  overtimeRoundCap: 12,                                   // then sudden death: the next lead decides the map
  defuseSeconds: 7,                                       // the defenders need this long on a planted spike
  plantSeconds: 4,                                        // the attackers need this long to plant
  clockRampSeconds: 20,                                   // seconds over which the clock stops being a problem
});

/** How chooseBuy arrived at a buy; `start.ourBuyPolicy` of simulateMap names the baseline. */
export const BUY_POLICY_LABELS = Object.freeze({
  pistol: "pistol buy",
  "full-buy": "full buy",
  force: "force buy (whole bank)",
  "must-buy": "must-buy round (whole bank)",
  bonus: "bonus buy (70% of the bank after a won round)",
  save: "save (light buy, at most 2,000)",
});

const DEFAULT_SEED = 1337;
const MAX_TRIALS = 20000;

function toInt(value, fallback, lo, hi) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

/**
 * 1 when "our" team has won the map, -1 when the opponent has, 0 while it is still live.
 * First to 13 with a two-round lead. Once the 12 overtime rounds are over (more than 36 rounds
 * played) sudden death applies: any lead decides the map, so a map never ends level.
 */
export function mapWinner(our, their) {
  if (our >= VALORANT_RULES.roundsToWin && our - their >= 2) return 1;
  if (their >= VALORANT_RULES.roundsToWin && their - our >= 2) return -1;
  const regulationAndOvertime = 2 * VALORANT_RULES.roundsPerHalf + SIM_MODEL.overtimeRoundCap;
  if (our + their > regulationAndOvertime && our !== their) return our > their ? 1 : -1;
  return 0;
}

/** Team loss bonus by the loss streak going into the lost round: 9,500 / 12,000 / 14,500. */
export function lossBonusCredits(lossStreak) {
  const steps = SIM_MODEL.lossCredits;
  return steps[toInt(lossStreak, 0, 0, steps.length - 1)];
}

const flipSide = (side) => (side === "attack" ? "defense" : "attack");

/**
 * Our side in the round after `roundNumber`: sides swap going into round 13 and before every
 * overtime round (25 and later).
 */
export function sideForNextRound(roundNumber, side) {
  const next = roundNumber + 1;
  return next === 13 || next > 24 ? flipSide(side) : side;
}

function normaliseSimState(params) {
  const p = params && typeof params === "object" ? params : {};
  const ourScore = toInt(p.ourScore, 0, 0, 60);
  const theirScore = toInt(p.theirScore, 0, 0, 60);
  const roundNumber = ourScore + theirScore + 1;
  const pistol = VALORANT_RULES.pistolRounds.includes(roundNumber);
  const defaultBank = pistol ? SIM_MODEL.pistolBank : 22000;
  let ourLossStreak = toInt(p.ourLossStreak, 0, 0, 10);
  let theirLossStreak = toInt(p.theirLossStreak, 0, 0, 10);
  const ourCredits = toInt(p.ourCredits, defaultBank, 0, SIM_MODEL.bankCap);
  const theirCredits = toInt(p.theirCredits, defaultBank, 0, SIM_MODEL.bankCap);
  // Exactly one team won the previous round, so two streaks of 0 are not a real state after
  // round 1: they mean the caller did not say. The loser is then derived (a model assumption):
  // the team behind on score, or at a level score the team with the smaller bank, starts on a
  // loss streak of 1. Pistol rounds reset both streaks, so nothing is derived for them.
  let streakSource = pistol ? "pistol" : "input";
  if (!pistol && ourLossStreak === 0 && theirLossStreak === 0) {
    const lead = ourScore - theirScore || ourCredits - theirCredits;
    streakSource = lead === 0 ? "unknown" : "derived";
    if (lead < 0) ourLossStreak = 1;
    else if (lead > 0) theirLossStreak = 1;
  }
  return {
    ourScore,
    theirScore,
    roundNumber,
    ourCredits,
    theirCredits,
    ourLossStreak,
    theirLossStreak,
    streakSource,
    ourCarried: toInt(p.ourCarried, 0, 0, 30000),
    theirCarried: toInt(p.theirCarried, 0, 0, 30000),
    ourSide: p.ourSide === "defense" ? "defense" : "attack",
    mapId: MAP_IDS.includes(p.mapId) ? p.mapId : null,
    strengthEdge: Number.isFinite(Number(p.strengthEdge)) ? clamp(Number(p.strengthEdge), -0.3, 0.3) : 0,
    firstRoundDecision: p.firstRoundDecision === "force" || p.firstRoundDecision === "save" ? p.firstRoundDecision : null,
    trials: toInt(p.trials ?? 1000, 1000, 1, MAX_TRIALS),
    seed: Number.isFinite(Number(p.seed ?? DEFAULT_SEED)) ? Number(p.seed ?? DEFAULT_SEED) >>> 0 : DEFAULT_SEED,
  };
}

/**
 * Buy policy of one team for one round. Returns { spend, loadout, economy, policy }, where
 * `policy` is a key of BUY_POLICY_LABELS.
 *   pistol round                      spend 3,400                                  "pistol"
 *   decision "save"                   spend min(bank, 2,000)                       "save"
 *   bank covers the full buy          spend what is missing to reach 21,500        "full-buy"
 *   decision "force"                  spend the whole bank                         "force"
 *   a must-buy round                  spend the whole bank                         "must-buy"
 *   won the previous round            spend 70% of the bank (bonus / half buy)     "bonus"
 *   otherwise                         spend min(bank, 2,000)                       "save"
 * loadout = carried gear + spend, classified with classifyEconomy. `team` is
 * { credits, carried, lastWon }. Exported so the tests can pin each rule.
 */
export function chooseBuy(team, roundNumber, mustBuy, decision) {
  let spend;
  let loadout;
  let policy;
  if (VALORANT_RULES.pistolRounds.includes(roundNumber)) {
    spend = Math.min(team.credits, SIM_MODEL.pistolSpend);
    loadout = spend;
    policy = "pistol";
  } else {
    const missing = Math.max(0, SIM_MODEL.fullBuyCost - team.carried);
    if (decision === "save") {
      spend = Math.min(team.credits, SIM_MODEL.saveSpend);
      policy = "save";
    } else if (team.credits >= missing) {
      spend = missing;
      policy = "full-buy";
    } else if (decision === "force" || mustBuy) {
      spend = team.credits;
      policy = decision === "force" ? "force" : "must-buy";
    } else if (team.lastWon) {
      spend = Math.round(team.credits * SIM_MODEL.halfBuyShare);
      policy = "bonus";
    } else {
      spend = Math.min(team.credits, SIM_MODEL.saveSpend);
      policy = "save";
    }
    loadout = team.carried + spend;
  }
  return { spend, loadout, economy: classifyEconomy({ roundNumber, loadoutValue: loadout }), policy };
}

/**
 * Apply one round result to a team state { credits, lossStreak, carried, lastWon } in place:
 * pay for the buy, add the win or loss credits (the loss bonus follows the streak going into
 * the round), the plant bonus and the cap, and update the streak and the carried gear.
 * Exported so the tests can pin the credit rules.
 */
export function settleSimRound(team, buy, won, plantBonus) {
  team.credits -= buy.spend;
  if (won) {
    team.credits += SIM_MODEL.winCredits + SIM_MODEL.winnerKillCredits;
    team.lossStreak = 0;
    team.carried = Math.round(buy.loadout * SIM_MODEL.winnerCarry);
  } else {
    team.credits += lossBonusCredits(team.lossStreak) + SIM_MODEL.loserKillCredits;
    team.lossStreak += 1;
    team.carried = Math.round(buy.loadout * SIM_MODEL.loserCarry);
  }
  if (plantBonus) team.credits += SIM_MODEL.plantCredits;
  team.credits = Math.min(team.credits, SIM_MODEL.bankCap);
  team.lastWon = won;
}

/**
 * Seeded Monte Carlo over a Markov chain of rounds. State: both scores, both team banks, both
 * loss streaks, carried gear and our side.
 *
 * Starting state: exactly one team won the previous round. A team with a loss streak of 0 whose
 * opponent has a streak above 0 is that winner. When both streaks are 0 (not supplied) the
 * loser is derived: the team behind on score, or at a level score the team with the smaller
 * bank, starts on a streak of 1 (`start.streakSource` is then "derived"; "unknown" when score
 * and banks are both level, "pistol" on rounds 1 and 13, "input" otherwise).
 *
 * Each simulated round:
 *   1. round 13 resets both banks to 4,000 (pistol); every overtime round sets them to 25,000
 *   2. both teams buy with chooseBuy (must-buy rounds: 12, 24, opponent on 12, overtime);
 *      `firstRoundDecision` ("force" | "save") overrides OUR buy in the first simulated round only
 *   3. p = roundWinProbability(economies, side, map, strengthEdge); we win when rng() < p
 *   4. a second rng() draw decides the plant (75% when the attackers win, 40% when they lose)
 *   5. credits: win 15,000 + 1,000 kill money, loss 9,500 / 12,000 / 14,500 by streak + 400,
 *      plant 1,500 to the attackers, team cap 45,000; the winner keeps 60% of its loadout as
 *      carried gear, the loser 10%
 *   6. sides swap going into round 13 and before every overtime round
 * The map ends when a team has 13 or more rounds and leads by two. After 12 overtime rounds
 * sudden death applies: the first lead decides the map (19-18 from 18-18), so no trial ends
 * level, whatever score it started from.
 *
 * Returns
 *   mapWinProb          maps won / trials
 *   halfWinProb         share of trials in which we are AHEAD on total score when the current
 *                       half ends (after round 12 in the first half; after round 24 or at the
 *                       end of the map in the second half; equal to mapWinProb in overtime)
 *   halfTieProb         share of trials level at that point (6-6 or 12-12)
 *   comebackProb        probability that the side currently behind on score wins the map
 *                       (mapWinProb when we trail, 1 - mapWinProb when they trail, null when level)
 *   expectedFinalScore  mean final score { our, their }
 *   standardError       sqrt(p * (1 - p) / trials) with p = mapWinProb
 *   ci95                [p - 1.96 * se, p + 1.96 * se] clamped to [0, 1]
 *   scoreDistribution   [{ score: "13-10", our, their, count, share, won }] best result first
 *   start               { roundNumber, ourSide, ourEconomy, theirEconomy, ourLoadout,
 *                         theirLoadout, roundWinProb, ourBuyPolicy, theirBuyPolicy } of the first
 *                         simulated round (the policies are keys of BUY_POLICY_LABELS), plus
 *                         { ourLossStreak, theirLossStreak, streakSource } as used
 * Same inputs and seed give deep-equal output.
 */
export function simulateMap(params = {}) {
  const s = normaliseSimState(params);
  const { trials, seed } = s;
  const scoreDiff = s.ourScore - s.theirScore;
  const trailing = scoreDiff < 0 ? "us" : scoreDiff > 0 ? "them" : null;
  const decided = mapWinner(s.ourScore, s.theirScore);

  if (decided !== 0) {
    const p = decided === 1 ? 1 : 0;
    return {
      trials,
      seed,
      mapWinProb: p,
      halfWinProb: p,
      halfTieProb: 0,
      comebackProb: 0,
      trailing,
      expectedFinalScore: { our: s.ourScore, their: s.theirScore },
      standardError: 0,
      ci95: [p, p],
      scoreDistribution: [{ score: `${s.ourScore}-${s.theirScore}`, our: s.ourScore, their: s.theirScore, count: trials, share: 1, won: decided === 1 }],
      start: {
        roundNumber: s.roundNumber, ourSide: s.ourSide, ourEconomy: null, theirEconomy: null, ourLoadout: 0, theirLoadout: 0, roundWinProb: p,
        ourBuyPolicy: null, theirBuyPolicy: null, ourLossStreak: s.ourLossStreak, theirLossStreak: s.theirLossStreak, streakSource: s.streakSource,
      },
    };
  }

  const rng = mulberry32(seed);
  const halfEnd = s.roundNumber <= 12 ? 12 : s.roundNumber <= 24 ? 24 : null;
  const scores = new Map();
  let mapWins = 0;
  let halfWins = 0;
  let halfTies = 0;
  let sumOur = 0;
  let sumTheir = 0;
  let start = null;

  for (let trial = 0; trial < trials; trial += 1) {
    // The winner of the previous round is the team on no loss streak whose opponent is on one.
    const us = { score: s.ourScore, credits: s.ourCredits, lossStreak: s.ourLossStreak, carried: s.ourCarried, lastWon: s.ourLossStreak === 0 && s.theirLossStreak > 0 };
    const them = { score: s.theirScore, credits: s.theirCredits, lossStreak: s.theirLossStreak, carried: s.theirCarried, lastWon: s.theirLossStreak === 0 && s.ourLossStreak > 0 };
    let side = s.ourSide;
    let first = true;
    let halfRecorded = halfEnd === null;
    let winner = 0;

    while (winner === 0) {
      const roundNumber = us.score + them.score + 1;
      const overtime = roundNumber > 24;
      if (roundNumber === 1 || roundNumber === 13) {
        for (const t of [us, them]) {
          t.credits = SIM_MODEL.pistolBank;
          t.carried = 0;
          t.lossStreak = 0;
          t.lastWon = false;
        }
      } else if (overtime) {
        for (const t of [us, them]) {
          t.credits = SIM_MODEL.overtimeBank;
          t.carried = 0;
        }
      }
      const lastOfHalf = roundNumber === 12 || roundNumber === 24;
      const ourBuy = chooseBuy(us, roundNumber, lastOfHalf || overtime || them.score >= 12, first ? s.firstRoundDecision : null);
      const theirBuy = chooseBuy(them, roundNumber, lastOfHalf || overtime || us.score >= 12, null);
      const p = roundWinProbability({ ourEconomy: ourBuy.economy, theirEconomy: theirBuy.economy, ourSide: side, mapId: s.mapId, strengthEdge: s.strengthEdge });
      if (first && start === null) {
        start = {
          roundNumber, ourSide: side, ourEconomy: ourBuy.economy, theirEconomy: theirBuy.economy, ourLoadout: ourBuy.loadout, theirLoadout: theirBuy.loadout, roundWinProb: p,
          ourBuyPolicy: ourBuy.policy, theirBuyPolicy: theirBuy.policy, ourLossStreak: s.ourLossStreak, theirLossStreak: s.theirLossStreak, streakSource: s.streakSource,
        };
      }
      const weWin = rng() < p;
      const plantRoll = rng();
      const weAttack = side === "attack";
      const attackersWon = weAttack === weWin;
      const planted = plantRoll < (attackersWon ? SIM_MODEL.plantProbAttackWin : SIM_MODEL.plantProbAttackLoss);
      settleSimRound(us, ourBuy, weWin, planted && weAttack);
      settleSimRound(them, theirBuy, !weWin, planted && !weAttack);
      if (weWin) us.score += 1;
      else them.score += 1;

      winner = mapWinner(us.score, them.score);
      if (!halfRecorded && (roundNumber === halfEnd || winner !== 0)) {
        halfRecorded = true;
        if (us.score > them.score) halfWins += 1;
        else if (us.score === them.score) halfTies += 1;
      }
      side = sideForNextRound(roundNumber, side);
      first = false;
    }

    if (winner === 1) mapWins += 1;
    if (halfEnd === null && winner === 1) halfWins += 1;
    sumOur += us.score;
    sumTheir += them.score;
    const key = us.score * 100 + them.score;
    scores.set(key, (scores.get(key) ?? 0) + 1);
  }

  const mapWinProb = mapWins / trials;
  const standardError = Math.sqrt((mapWinProb * (1 - mapWinProb)) / trials);
  const scoreDistribution = [...scores.entries()]
    .map(([key, count]) => {
      const our = Math.floor(key / 100);
      const their = key % 100;
      return { score: `${our}-${their}`, our, their, count, share: count / trials, won: our > their };
    })
    .sort((a, b) => (b.our - b.their) - (a.our - a.their) || b.our - a.our);

  return {
    trials,
    seed,
    mapWinProb,
    halfWinProb: halfWins / trials,
    halfTieProb: halfTies / trials,
    comebackProb: trailing === null ? null : trailing === "us" ? mapWinProb : 1 - mapWinProb,
    trailing,
    expectedFinalScore: { our: round2(sumOur / trials), their: round2(sumTheir / trials) },
    standardError,
    ci95: [clamp(mapWinProb - 1.96 * standardError, 0, 1), clamp(mapWinProb + 1.96 * standardError, 0, 1)],
    scoreDistribution,
    start,
  };
}

/**
 * Force-buy expected value for the round about to be played. Runs simulateMap twice with the
 * same seed: once with our first round forced (spend the whole bank), once saved (light buy).
 *   forceBuyEV     = forceWinProb - saveWinProb          (map win probability gained by forcing)
 *   standardError  = sqrt(seForce^2 + seSave^2)
 *   recommendation = "EVEN" when |forceBuyEV| < 2 * standardError, else "FORCE" or "SAVE"
 */
export function evaluateForceBuy(state = {}) {
  const force = simulateMap({ ...state, firstRoundDecision: "force" });
  const save = simulateMap({ ...state, firstRoundDecision: "save" });
  const forceBuyEV = force.mapWinProb - save.mapWinProb;
  const standardError = Math.sqrt(force.standardError ** 2 + save.standardError ** 2);
  let recommendation = "EVEN";
  if (Math.abs(forceBuyEV) >= 2 * standardError && forceBuyEV !== 0) recommendation = forceBuyEV > 0 ? "FORCE" : "SAVE";
  return {
    trials: force.trials,
    seed: force.seed,
    forceWinProb: force.mapWinProb,
    saveWinProb: save.mapWinProb,
    forceBuyEV,
    standardError,
    recommendation,
    forceEconomy: force.start.ourEconomy,
    saveEconomy: save.start.ourEconomy,
    forceRoundWinProb: force.start.roundWinProb,
    saveRoundWinProb: save.start.roundWinProb,
  };
}

/** The four situations evaluateSaveVsRetake tells apart, by our side and the spike. */
export const SAVE_SCENARIOS = Object.freeze({
  retake: Object.freeze({ id: "retake", playCall: "RETAKE", label: "Retake", noun: "the retake" }),
  "post-plant-hold": Object.freeze({ id: "post-plant-hold", playCall: "HOLD", label: "Post-plant hold", noun: "the post-plant hold" }),
  "site-hold": Object.freeze({ id: "site-hold", playCall: "HOLD", label: "Site hold", noun: "the site hold" }),
  execute: Object.freeze({ id: "execute", playCall: "EXECUTE", label: "Execute", noun: "the execute" }),
});

/** Share of the clock team's chance that the remaining time still allows (0 below the action time). */
function clockFactor(time, planted) {
  const actionSeconds = planted ? SIM_MODEL.defuseSeconds : SIM_MODEL.plantSeconds;
  return clamp((time - actionSeconds) / SIM_MODEL.clockRampSeconds, 0, 1);
}

/**
 * Round win probability of the team that has to beat the clock: the defenders once the spike is
 * planted (a defuse takes 7 s), the attackers before the plant (a plant takes 4 s).
 *   duel         = own^2 / (own^2 + opp^2)       (square-law man advantage; 1 when no opponent
 *                                                 is alive, 0 when nobody on the clock team is)
 *   timeFactor   = clamp((timeRemaining - actionSeconds) / 20, 0, 1)
 *   plantPenalty = 0.9 when the spike is planted and an opponent is alive, otherwise 1
 *   p            = duel * timeFactor * plantPenalty
 * Before the plant, attackers with no defender left alive have already won (p = 1).
 */
function clockTeamWinProb(own, opp, time, planted) {
  if (own === 0) return 0;
  if (!planted && opp === 0) return 1;
  const duel = opp === 0 ? 1 : (own * own) / (own * own + opp * opp);
  const plantPenalty = planted && opp > 0 ? 0.9 : 1;
  return clamp(duel * clockFactor(time, planted) * plantPenalty, 0, 1);
}

/**
 * Save-versus-retake call for the round in progress (we are short-handed or the spike is down).
 * The clock belongs to one team: once the spike is planted the DEFENDERS must defuse, before
 * the plant the ATTACKERS must plant. The same seconds are therefore bad news for one side and
 * good news for the other, and the call depends on our side:
 *
 *   ourSide   spike      scenario          we ...                    call when playing on
 *   defense   planted    retake            have to beat the clock    RETAKE
 *   attack    planted    post-plant-hold   run the clock down        HOLD
 *   defense   not yet    site-hold         run the clock down        HOLD
 *   attack    not yet    execute           have to beat the clock    EXECUTE
 *
 *   c                = clockTeamWinProb(clock team alive, other team alive, timeRemaining, planted)
 *   playWinProb      = c when we are the clock team, otherwise 1 - c
 *   saveRoundWinProb = chance the round is still won when we save: 0 when we are the clock team
 *                      (saving concedes the round); otherwise 1 when no opponent is alive,
 *                      playWinProb when none of us is, and else 1 - timeFactor (the opponents
 *                      still need the time to defuse or plant unopposed)
 *
 *   playEV = playWinProb * W(round won, weapons kept) + (1 - playWinProb) * W(round lost, weapons lost)
 *   saveEV = saveRoundWinProb * W(round won, weapons kept) + (1 - saveRoundWinProb) * W(round lost, weapons kept)
 * where W is simulateMap(...).mapWinProb from the next round with the same seed, so both EVs
 * are map win probabilities. `weaponsValue` is the team value of the gear the survivors hold
 * (default 3,900 per survivor). call = the scenario's play call when playEV > saveEV or when
 * playing on is certain to win the round (playWinProb = 1), otherwise "SAVE".
 * retakeWinProb and retakeEV repeat playWinProb and playEV under the names of the retake.
 */
export function evaluateSaveVsRetake({ alive = 0, enemiesAlive = 0, timeRemaining = 0, spikePlanted = true, weaponsValue, ...state } = {}) {
  const a = toInt(alive, 0, 0, 5);
  const e = toInt(enemiesAlive, 0, 0, 5);
  const time = Number.isFinite(Number(timeRemaining)) ? Math.max(0, Number(timeRemaining)) : 0;
  const planted = spikePlanted !== false;
  const value = Number.isFinite(Number(weaponsValue ?? NaN)) ? clamp(Math.round(Number(weaponsValue)), 0, 30000) : a * 3900;

  const s = normaliseSimState(state);
  const weAttack = s.ourSide === "attack";
  const weAreClockTeam = planted ? !weAttack : weAttack;
  const scenario = SAVE_SCENARIOS[planted ? (weAttack ? "post-plant-hold" : "retake") : (weAttack ? "execute" : "site-hold")];

  let playWinProb;
  let saveRoundWinProb;
  if (weAreClockTeam) {
    playWinProb = clockTeamWinProb(a, e, time, planted);
    saveRoundWinProb = 0;
  } else {
    playWinProb = 1 - clockTeamWinProb(e, a, time, planted);
    if (e === 0) saveRoundWinProb = 1;
    else if (a === 0) saveRoundWinProb = playWinProb;
    else saveRoundWinProb = 1 - clockFactor(time, planted);
  }

  const ourPlant = planted && weAttack ? SIM_MODEL.plantCredits : 0;
  const theirPlant = planted && !weAttack ? SIM_MODEL.plantCredits : 0;
  const cap = (n) => Math.min(SIM_MODEL.bankCap, n);
  const next = {
    mapId: s.mapId,
    strengthEdge: s.strengthEdge,
    trials: s.trials,
    seed: s.seed,
    ourSide: sideForNextRound(s.roundNumber, s.ourSide),
  };
  const winGain = SIM_MODEL.winCredits + SIM_MODEL.winnerKillCredits;
  const afterWin = simulateMap({
    ...next,
    ourScore: s.ourScore + 1,
    theirScore: s.theirScore,
    ourCredits: cap(s.ourCredits + winGain + ourPlant),
    theirCredits: cap(s.theirCredits + lossBonusCredits(s.theirLossStreak) + SIM_MODEL.loserKillCredits + theirPlant),
    ourLossStreak: 0,
    theirLossStreak: s.theirLossStreak + 1,
    ourCarried: value,
    theirCarried: 0,
  });
  const lostRound = {
    ...next,
    ourScore: s.ourScore,
    theirScore: s.theirScore + 1,
    theirCredits: cap(s.theirCredits + winGain + theirPlant),
    ourLossStreak: s.ourLossStreak + 1,
    theirLossStreak: 0,
    theirCarried: Math.round(SIM_MODEL.fullBuyCost * SIM_MODEL.winnerCarry),
  };
  const afterLoss = simulateMap({
    ...lostRound,
    ourCredits: cap(s.ourCredits + lossBonusCredits(s.ourLossStreak) + SIM_MODEL.loserKillCredits + ourPlant),
    ourCarried: 0,
  });
  const afterSave = simulateMap({
    ...lostRound,
    ourCredits: cap(s.ourCredits + lossBonusCredits(s.ourLossStreak) + ourPlant),
    ourCarried: value,
  });

  const playEV = playWinProb * afterWin.mapWinProb + (1 - playWinProb) * afterLoss.mapWinProb;
  const saveEV = saveRoundWinProb * afterWin.mapWinProb + (1 - saveRoundWinProb) * afterSave.mapWinProb;
  const call = playEV > saveEV || playWinProb === 1 ? scenario.playCall : "SAVE";
  const situation = `${a}v${e} on ${weAttack ? "attack" : "defense"}, ${planted ? "spike planted" : "spike not planted"}, ${round1(time)}s left`;
  const weapons = `${value.toLocaleString("en-US")} credits of weapons`;
  const action = planted ? `${SIM_MODEL.defuseSeconds} s to defuse` : `${SIM_MODEL.plantSeconds} s to plant`;
  const clock = weAreClockTeam ? `We have to beat the clock: we need ${action}.` : `The clock is on our side: the opponents need ${action}.`;
  const reasoning = call === "SAVE"
    ? `Save (${situation}): ${scenario.noun} only wins ${pct(playWinProb)} of the time, worth ${pct(playEV)} map win probability, while keeping ${weapons} is worth ${pct(saveEV)}. ${clock}`
    : `${scenario.label} (${situation}): the round is won ${pct(playWinProb)} of the time, which is worth ${pct(playEV)} map win probability against ${pct(saveEV)} for saving ${weapons}. ${clock}`;

  return {
    scenario: scenario.id,
    playCall: scenario.playCall,
    playWinProb,
    playEV,
    saveRoundWinProb,
    saveEV,
    call,
    reasoning,
    retakeWinProb: playWinProb,
    retakeEV: playEV,
    weaponsValue: value,
    trials: s.trials,
    seed: s.seed,
    mapWinProbIfRoundWon: afterWin.mapWinProb,
    mapWinProbIfRoundLost: afterLoss.mapWinProb,
    mapWinProbIfSaved: afterSave.mapWinProb,
  };
}

// ===========================================================================
// LAYER 4 - GRID hydrator, scouting summary, dossier and deterministic coach
// ===========================================================================

const MAX_SEGMENTS = 60;
const MAX_EVENTS_PER_LIST = 200;
const MAX_WARNINGS = 40;

/** Untrusted text -> single-line string without control characters, cut to `max` characters. */
function cleanText(value, max = 60) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function normaliseSide(value) {
  const side = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (side === "attack" || side === "attacker" || side === "attackers") return "attack";
  if (side === "defense" || side === "defence" || side === "defender" || side === "defenders") return "defense";
  return null;
}

function hydrate(payload) {
  const fail = (reason) => ({ ok: false, reason });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("Payload is not a GRID series state object.");
  const state = payload.data?.seriesState ?? payload.seriesState ?? payload;
  if (!state || typeof state !== "object" || Array.isArray(state)) return fail("Payload has no seriesState object.");
  if (!Array.isArray(state.games) || state.games.length === 0) return fail("seriesState.games is missing or empty.");
  const game = state.games.find((g) => g && typeof g === "object" && Array.isArray(g.segments));
  if (!game) return fail("No game with a segments list was found.");
  const mapName = typeof game.map?.name === "string" ? game.map.name.trim().toLowerCase() : "";
  if (!MAP_IDS.includes(mapName)) return fail(`Unknown map "${cleanText(game.map?.name, 30)}". Supported maps: ${MAP_IDS.join(", ")}.`);
  if (game.segments.length === 0) return fail("The game has no round segments.");
  if (game.segments.length > MAX_SEGMENTS) return fail(`The game has ${game.segments.length} segments; at most ${MAX_SEGMENTS} are accepted.`);

  const map = getMap(mapName);
  const t = map.transform;
  const scale = Math.abs(t.xMultiplier);
  const warnings = [];
  let warningCount = 0;
  const warn = (text) => {
    warningCount += 1;
    if (warnings.length < MAX_WARNINGS) warnings.push(text);
  };

  const declared = Array.isArray(game.teams) && game.teams.length === 2 ? game.teams : state.teams;
  if (!Array.isArray(declared) || declared.length !== 2) return fail("Exactly two teams are required.");
  const teams = declared.map((entry, index) => {
    const name = cleanText(entry?.name, 60);
    const known = findTeamId(name);
    return { name, teamId: known ?? `TEAM${index + 1}`, known: known !== null, gridId: cleanText(entry?.id, 60), declaredScore: isNum(entry?.score) ? entry.score : null };
  });
  if (!teams[0].name || !teams[1].name) return fail("Both teams need a name.");
  if (teams[0].teamId === teams[1].teamId) return fail("The two teams must be different.");
  for (const team of teams) {
    if (!team.known) warn(`Team "${team.name}" is not one of the six curated rosters; kept as ${team.teamId}.`);
  }
  const resolveTeam = (ref) => {
    const text = cleanText(typeof ref === "object" && ref !== null ? ref.name ?? ref.id : ref, 60).toLowerCase();
    if (!text) return null;
    const viaRoster = findTeamId(text);
    return teams.find((team) => team.name.toLowerCase() === text || (team.gridId && team.gridId.toLowerCase() === text) || team.teamId.toLowerCase() === text || (viaRoster !== null && team.teamId === viaRoster)) ?? null;
  };

  const validSite = (value) => {
    const site = typeof value === "string" ? value.trim().toUpperCase() : "";
    return map.sites.includes(site) ? site : null;
  };
  const toPoint = (raw) => {
    if (!isNum(raw?.x) || !isNum(raw?.y)) return null;
    const n = gameToNormalized(map.id, raw.x, raw.y);
    if (n.x < -0.05 || n.x > 1.05 || n.y < -0.05 || n.y > 1.05) return null;
    return { x: round4(clamp01(n.x)), y: round4(clamp01(n.y)) };
  };
  // Minimap dx comes from game y and minimap dy from game x (see tactical-maps.js).
  const toDirection = (raw) => {
    if (!isNum(raw?.dx) || !isNum(raw?.dy)) return null;
    const nx = raw.dy * t.xMultiplier;
    const ny = raw.dx * t.yMultiplier;
    const len = Math.hypot(nx, ny);
    return len < 1e-12 ? null : { dx: round4(nx / len), dy: round4(ny / len) };
  };
  const toLength = (raw, fallback, lo, hi) => (isNum(raw) && raw > 0 ? clamp(raw * scale, lo, hi) : fallback);
  const toTime = (raw, where) => {
    if (isNum(raw) && raw >= 0) return round1(Math.min(raw, 300));
    warn(`${where}: time is not a number, set to 0.`);
    return 0;
  };
  const capped = (value, where) => {
    const items = list(value);
    if (items.length > MAX_EVENTS_PER_LIST) warn(`${where}: only the first ${MAX_EVENTS_PER_LIST} entries were read.`);
    return items.slice(0, MAX_EVENTS_PER_LIST);
  };

  const score = { [teams[0].teamId]: 0, [teams[1].teamId]: 0 };
  const roundsByTeam = { [teams[0].teamId]: [], [teams[1].teamId]: [] };
  const seenRounds = new Set();

  game.segments.forEach((seg, index) => {
    if (!seg || typeof seg !== "object") {
      warn(`Segment ${index + 1} is not an object and was skipped.`);
      return;
    }
    let roundNumber = toInt(seg.roundNumber ?? seg.sequenceNumber, null, 1, MAX_SEGMENTS);
    if (roundNumber === null) {
      roundNumber = index + 1;
      warn(`Segment ${index + 1} has no usable roundNumber; its position was used.`);
    }
    if (seenRounds.has(roundNumber)) {
      warn(`Round ${roundNumber} appears twice; the later segment was skipped.`);
      return;
    }
    seenRounds.add(roundNumber);
    const where = `Round ${roundNumber}`;

    const winner = resolveTeam(seg.winner);
    if (winner) score[winner.teamId] += 1;
    else warn(`${where}: the winner is not one of the two teams.`);

    const plantSite = validSite(seg.plantSite);
    if (seg.plantSite != null && plantSite === null) warn(`${where}: plantSite is not a site of ${map.name}; treated as no plant.`);
    const plantTime = plantSite !== null && isNum(seg.plantTime) && seg.plantTime >= 0 ? round1(seg.plantTime) : null;

    const teamsRead = new Set();
    for (const entry of list(seg.teams).slice(0, 4)) {
      const team = entry && typeof entry === "object" ? resolveTeam(entry.name) ?? resolveTeam(entry.id) : null;
      if (!team) {
        warn(`${where}: a team entry does not match either team and was skipped.`);
        continue;
      }
      if (teamsRead.has(team.teamId)) {
        warn(`${where}: ${team.name} is listed twice; the later entry was skipped.`);
        continue;
      }
      const side = normaliseSide(entry.side);
      if (!side) {
        warn(`${where}: ${team.name} has no valid side and was skipped.`);
        continue;
      }
      let loadoutValue = 0;
      if (isNum(entry.loadoutValue) && entry.loadoutValue >= 0) loadoutValue = Math.round(entry.loadoutValue);
      else warn(`${where}: ${team.name} loadoutValue is not a number, set to 0.`);
      const economyState = classifyEconomy({ roundNumber, loadoutValue });
      if (typeof entry.economyState === "string" && ECONOMY_STATES.includes(entry.economyState) && entry.economyState !== economyState) {
        warn(`${where}: ${team.name} declared ${entry.economyState} but its loadout value classifies as ${economyState}.`);
      }

      const utilityEvents = [];
      for (const e of capped(entry.utilityEvents, `${where} utilityEvents`)) {
        if (!e || typeof e !== "object" || !UTILITY_TYPES.includes(e.type)) {
          warn(`${where}: utility event with unknown type "${cleanText(e?.type, 20)}" was dropped.`);
          continue;
        }
        const position = toPoint(e.position);
        if (!position) {
          warn(`${where}: ${e.type} event without a usable position was dropped.`);
          continue;
        }
        utilityEvents.push({
          type: e.type,
          ability: cleanText(e.ability, 40),
          agent: cleanText(e.agent, 30),
          player: cleanText(e.player, 40),
          time: toTime(e.time, `${where} ${e.type}`),
          position,
          direction: toDirection(e.direction),
          radius: round4(toLength(e.radius, UTILITY_RADIUS[e.type], 0.005, 0.2)),
          enemiesAffected: toInt(e.enemiesAffected, 0, 0, 5),
          assistedKill: e.assistedKill === true,
          postPlant: e.postPlant === true,
          site: validSite(e.site),
        });
      }
      utilityEvents.sort((a, b) => a.time - b.time);

      const killEvents = [];
      for (const k of capped(entry.killEvents, `${where} killEvents`)) {
        const killerPosition = k && typeof k === "object" ? toPoint(k.killerPosition) : null;
        const victimPosition = k && typeof k === "object" ? toPoint(k.victimPosition) : null;
        if (!killerPosition || !victimPosition) {
          warn(`${where}: kill event without usable positions was dropped.`);
          continue;
        }
        killEvents.push({
          time: toTime(k.time, `${where} kill`),
          killer: cleanText(k.killer, 40),
          victim: cleanText(k.victim, 40),
          weapon: cleanText(k.weapon, 30),
          killerPosition,
          victimPosition,
          firstBlood: k.firstBlood === true,
        });
      }

      const operatorHoldSpots = [];
      for (const h of capped(entry.operatorHoldSpots, `${where} operatorHoldSpots`)) {
        const position = h && typeof h === "object" ? toPoint(h.position) : null;
        if (!position) {
          warn(`${where}: Operator hold spot without a usable position was dropped.`);
          continue;
        }
        let sightline = toDirection(h.sightline);
        if (!sightline) {
          sightline = { dx: 0, dy: 0 };
          warn(`${where}: Operator hold spot has no usable sightline; kept without a cone.`);
        }
        const watched = typeof h.watch === "string" ? getCallout(map.id, cleanText(h.watch, 40)) : null;
        operatorHoldSpots.push({
          player: cleanText(h.player, 40),
          position,
          sightline,
          fovDeg: isNum(h.fovDeg) && h.fovDeg > 0 ? round1(clamp(h.fovDeg, 1, 180)) : DEFAULT_FOV_DEG,
          range: round4(toLength(h.range, DEFAULT_RANGE, 0.01, 1.5)),
          firstBlood: h.firstBlood === true,
          rePeeked: h.rePeeked === true,
          kills: toInt(h.kills, 0, 0, 5),
          callout: cleanText(h.callout, 40) || nearestCallout(map.id, position.x, position.y).name,
          watch: watched ? watched.name : null,
          site: validSite(h.site),
        });
      }

      teamsRead.add(team.teamId);
      roundsByTeam[team.teamId].push({
        roundNumber,
        side,
        economyState,
        loadoutValue,
        credits: isNum(entry.credits) && entry.credits >= 0 ? Math.round(entry.credits) : 0,
        won: winner ? winner.teamId === team.teamId : entry.won === true,
        winCondition: cleanText(seg.winCondition, 30) || null,
        plantSite,
        plantTime,
        utilityEvents,
        killEvents,
        operatorHoldSpots,
      });
    }
  });

  for (const team of teams) {
    roundsByTeam[team.teamId].sort((a, b) => a.roundNumber - b.roundNumber);
    if (team.declaredScore !== null && team.declaredScore !== score[team.teamId]) {
      warn(`Declared score ${team.declaredScore} for ${team.name} disagrees with ${score[team.teamId]} rounds won in the segments.`);
    }
  }
  if (warningCount > warnings.length) warnings.push(`${warningCount - warnings.length} more warnings were suppressed.`);

  const [a, b] = teams;
  return {
    ok: true,
    seriesId: cleanText(state.id, 80) || "unknown",
    mapId: map.id,
    mapName: map.name,
    teams: teams.map((team) => ({
      name: team.name,
      teamId: team.teamId,
      score: score[team.teamId],
      declaredScore: team.declaredScore,
      won: score[team.teamId] > score[team === a ? b.teamId : a.teamId],
    })),
    score,
    roundCount: seenRounds.size,
    roundsByTeam,
    warnings,
    warningCount,
  };
}

/**
 * Turn a GRID Series State style payload into per-team round lists in the pro-data.js round
 * shape. Accepts { data: { seriesState } }, { seriesState } or a bare seriesState. Positions,
 * directions, radii and ranges arrive in GAME units and are converted with gameToNormalized.
 * Never throws: returns { ok: false, reason } for input it cannot use, and drops or coerces
 * malformed events while recording a line in `warnings`. Each team's score is recomputed from
 * the segment winners; a declared score that disagrees is reported as a warning.
 */
export function hydrateGridSeries(payload) {
  try {
    return hydrate(payload);
  } catch {
    return { ok: false, reason: "Malformed GRID payload: it could not be read." };
  }
}

function sideRecord(rounds, side) {
  const subset = rounds.filter((r) => r.side === side);
  const wins = subset.filter((r) => r.won === true).length;
  return { rounds: subset.length, wins, winRate: round4(ratio(wins, subset.length)) };
}

/**
 * One plain object with everything the dashboard, the dossier and the coach need for a team on
 * a map. `rounds` defaults to the modelled dataset getTeamRounds(teamId, mapId). Pass
 * `source: { kind: "grid-replay", seriesId }` with hydrated rounds, and `teamName` for a team
 * that is not one of the six rosters.
 *
 *   siteWinRates[side][S] = rounds on that side whose attackedSite is S: { rounds, wins, winRate }
 *   pistol.attack / pistol.defense = the PISTOL rounds on that side: { rounds, wins, winRate,
 *       sites: { S: count }, favouredSite, plan } (attack counts attackedSite, defense counts
 *       stackedSite, falling back to attackedSite; `plan` is the modelled playbook line and is
 *       null for replay data)
 */
export function buildScoutSummary({ teamId, mapId, rounds, source, teamName } = {}) {
  const map = getMap(mapId);
  const team = typeof teamId === "string" && Object.prototype.hasOwnProperty.call(TEAMS, teamId) ? TEAMS[teamId] : null;
  const data = rounds === undefined ? getTeamRounds(teamId, map.id) : list(rounds).filter(Boolean);
  let src;
  if (source && typeof source === "object" && source.kind === "grid-replay") {
    const seriesId = cleanText(source.seriesId, 80) || "unknown";
    src = { kind: "grid-replay", seriesId, label: `hydrated GRID replay ${seriesId}` };
  } else if (rounds === undefined) {
    src = { kind: "modelled", seriesId: null, label: "modelled scenario dataset (seeded model shaped like GRID Series State, not official match statistics)" };
  } else {
    src = { kind: "custom", seriesId: null, label: "supplied round data" };
  }

  const utility = computeUtilityMetrics(data, { mapId: map.id });
  const operator = buildOperatorProfile(data);
  const antiOp = recommendAntiOp(map.id, operator);
  const economy = summarizeEconomy(data);
  const wins = data.filter((r) => r.won === true).length;

  const siteWinRates = { attack: {}, defense: {} };
  for (const side of ["attack", "defense"]) {
    for (const site of map.sites) siteWinRates[side][site] = { rounds: 0, wins: 0, winRate: 0 };
  }
  const pistolSide = (plan) => ({ rounds: 0, wins: 0, winRate: 0, sites: {}, favouredSite: null, plan });
  const playbook = src.kind === "modelled" && team ? team.maps[map.id].pistol : null;
  const pistol = {
    rounds: economy.pistol.rounds,
    wins: economy.pistol.wins,
    winRate: economy.pistol.winRate,
    attack: pistolSide(playbook ? playbook.attackPlan : null),
    defense: pistolSide(playbook ? playbook.defensePlan : null),
  };
  for (const round of data) {
    if (round.side !== "attack" && round.side !== "defense") continue;
    const { attackedSite, stackedSite } = roundSites(round);
    const cell = attackedSite ? siteWinRates[round.side][attackedSite] : null;
    if (cell) {
      cell.rounds += 1;
      if (round.won === true) cell.wins += 1;
    }
    if (round.economyState === "PISTOL") {
      const p = pistol[round.side];
      p.rounds += 1;
      if (round.won === true) p.wins += 1;
      const site = round.side === "attack" ? attackedSite : stackedSite ?? attackedSite;
      if (site) p.sites[site] = (p.sites[site] ?? 0) + 1;
    }
  }
  for (const side of ["attack", "defense"]) {
    for (const site of map.sites) {
      const cell = siteWinRates[side][site];
      cell.winRate = round4(ratio(cell.wins, cell.rounds));
    }
    pistol[side].winRate = round4(ratio(pistol[side].wins, pistol[side].rounds));
    pistol[side].favouredSite = topKey(pistol[side].sites);
  }

  const primary = operator.primarySpot;
  const favouredAttackSite = topKey(utility.siteBias.attack);
  const favouredDefenseSite = topKey(utility.siteBias.defense);
  const peak = utility.executeTiming.peak;

  return {
    teamId: typeof teamId === "string" ? cleanText(teamId, 20) : "",
    teamName: team ? team.name : cleanText(teamName, 60) || cleanText(teamId, 20) || "Unknown team",
    shortName: team ? team.shortName : cleanText(teamId, 20),
    gameChangers: team ? team.gameChangers : false,
    mapId: map.id,
    mapName: map.name,
    sites: [...map.sites],
    source: src,
    roundCount: data.length,
    record: {
      wins,
      losses: data.length - wins,
      winRate: round4(ratio(wins, data.length)),
      attack: sideRecord(data, "attack"),
      defense: sideRecord(data, "defense"),
    },
    utility,
    operator,
    antiOp,
    economy,
    pistol,
    siteWinRates,
    keyNumbers: {
      rounds: data.length,
      winRate: round4(ratio(wins, data.length)),
      utilityEfficiencyScore: utility.utilityEfficiencyScore,
      flashAssistRate: utility.flashAssistRate,
      primaryOperatorSpot: primary ? primary.callout : null,
      primaryOperatorPlayer: primary ? primary.player : null,
      primaryOperatorHolds: primary ? primary.holds : 0,
      operatorFirstBloodPickRate: primary ? primary.firstBloodPickRate : 0,
      operatorRePeekRate: primary ? primary.rePeekRate : 0,
      operatorRoundRate: operator.operatorRoundRate,
      buyRoundOpFrequency: operator.buyRoundOpFrequency,
      ecoRoundOpFrequency: operator.ecoRoundOpFrequency,
      topCounter: antiOp.length > 0 ? antiOp[0].text : null,
      executeWindow: peak ? peak.label : null,
      executeWindowShare: peak ? peak.share : 0,
      medianExecuteSeconds: utility.executeTiming.medianSeconds,
      favouredAttackSite,
      favouredAttackSiteShare: favouredAttackSite ? utility.siteBias.attack[favouredAttackSite] : 0,
      favouredDefenseSite,
      favouredDefenseSiteShare: favouredDefenseSite ? utility.siteBias.defense[favouredDefenseSite] : 0,
      pistolWinRate: pistol.winRate,
      pistolAttackSite: pistol.attack.favouredSite,
      pistolDefenseSite: pistol.defense.favouredSite,
    },
  };
}

/** Text for a Markdown table cell or a list line: no pipes, no line breaks. */
const md = (value) => String(value ?? "").replace(/[|\r\n]+/g, " ").trim();

function pistolLine(label, p) {
  if (p.rounds === 0) return `- ${label} pistol: no pistol round on this side in the sample.`;
  const site = p.favouredSite ? `${p.favouredSite} site` : "no clear site";
  const plan = p.plan ? ` Playbook: ${md(p.plan)}.` : "";
  return `- ${label} pistol: ${p.wins} won of ${p.rounds} (${pct(p.winRate)}), ${label === "Attack" ? "hit" : "stacked"} ${site}.${plan}`;
}

/**
 * Markdown scouting dossier. Sections, in this order: title, Operator Tendencies, Execute
 * Timings, Pistol Round Tendencies, Site Win Rates, Utility Profile, Anti-Strat Game Plan and a
 * closing data-source line. `kpis` is a list of { id, label, value } for the dashboard.
 */
export function generateDossier(summary, { ourTeamId } = {}) {
  const s = summary;
  const k = s.keyNumbers;
  const op = s.operator;
  const u = s.utility;
  const ours = typeof ourTeamId === "string" && Object.prototype.hasOwnProperty.call(TEAMS, ourTeamId) ? TEAMS[ourTeamId].name : null;
  const lines = [];

  lines.push(`# SpikeSight C9 Anti-Strat Dossier: ${md(s.teamName)} on ${md(s.mapName)}`);
  lines.push("");
  lines.push(`${ours ? `Prepared for: ${ours}. ` : ""}Sample: ${s.roundCount} rounds, ${s.record.wins} won and ${s.record.losses} lost (attack ${s.record.attack.wins}/${s.record.attack.rounds}, defense ${s.record.defense.wins}/${s.record.defense.rounds}).`);
  lines.push("");

  lines.push("## Operator Tendencies");
  if (op.spots.length === 0) {
    lines.push(`- No Operator hold was recorded in ${s.roundCount} rounds.`);
  } else {
    lines.push(`- Operator out on ${op.operatorRounds} of ${op.rounds} rounds (${pct(op.operatorRoundRate)}): ${pct(op.buyRoundOpFrequency)} of full-buy rounds, ${pct(op.ecoRoundOpFrequency)} of eco and half-buy rounds.`);
    lines.push(`- First-blood pick rate ${pct(op.firstBloodPickRate)}, re-peek rate ${pct(op.rePeekRate)} over ${op.holds} holds.`);
    lines.push("");
    lines.push("| Hold spot | Player | Watches | Holds | First-blood pick rate | Re-peek rate | Kills |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
    for (const spot of op.spots) {
      lines.push(`| ${md(spot.callout)} | ${md(spot.player)} | ${md(spot.watch ?? "-")} | ${spot.holds} | ${pct(spot.firstBloodPickRate)} | ${pct(spot.rePeekRate)} | ${spot.kills} |`);
    }
  }
  lines.push("");

  lines.push("## Execute Timings");
  if (u.executeTiming.rounds === 0) {
    lines.push("- No attack round with execute-phase utility in the sample.");
  } else {
    lines.push(`- Median first execute utility: ${u.executeTiming.medianSeconds}s over ${u.executeTiming.rounds} attack rounds.`);
    lines.push(`- Most common window: ${u.executeTiming.peak.label} (${pct(u.executeTiming.peak.share)} of those rounds).`);
    lines.push("");
    lines.push("| Window | Rounds | Share |");
    lines.push("| --- | ---: | ---: |");
    for (const b of u.executeTiming.buckets) lines.push(`| ${b.label} | ${b.count} | ${pct(b.share)} |`);
  }
  lines.push("");

  lines.push("## Pistol Round Tendencies");
  lines.push(`- Pistol rounds won: ${s.pistol.wins} of ${s.pistol.rounds} (${pct(s.pistol.winRate)}).`);
  lines.push(pistolLine("Attack", s.pistol.attack));
  lines.push(pistolLine("Defense", s.pistol.defense));
  lines.push("");

  lines.push("## Site Win Rates");
  lines.push("| Side | Site | Rounds | Wins | Win rate | Site bias |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const side of ["attack", "defense"]) {
    for (const site of s.sites) {
      const cell = s.siteWinRates[side][site];
      lines.push(`| ${side === "attack" ? "Attack" : "Defense"} | ${site} | ${cell.rounds} | ${cell.wins} | ${pct(cell.winRate)} | ${pct(u.siteBias[side][site] ?? 0)} |`);
    }
  }
  lines.push("");
  lines.push("Attack rows count the site they hit. Defense rows count the site that was hit against them; the defense bias column is the site they stacked before the hit.");
  lines.push("");

  lines.push("## Utility Profile");
  lines.push(`- Utility Efficiency Score: ${u.utilityEfficiencyScore} / 100 (${u.sampleSize.effectiveEvents} of ${u.sampleSize.utilityEvents} utility events affected an enemy or assisted a kill).`);
  lines.push(`- Flash Assist Rate: ${pct(u.flashAssistRate)} (${u.sampleSize.assistedFlashes} of ${u.sampleSize.flashes} flashes).`);
  lines.push(`- Mix: ${UTILITY_TYPES.map((type) => `${UTILITY_LABELS[type]} ${u.typeCounts[type]} (${pct(u.typeShares[type])})`).join(", ")}.`);
  lines.push(`- Post-plant utility events: ${u.postPlantEvents}.`);
  lines.push("");

  lines.push("## Anti-Strat Game Plan");
  const plan = [];
  for (const rec of s.antiOp.slice(0, 4)) plan.push(md(rec.text));
  if (u.executeTiming.peak) {
    plan.push(`Hold defensive utility for the hit: their first execute utility lands in the ${u.executeTiming.peak.label} window on ${pct(u.executeTiming.peak.share)} of attack rounds (median ${u.executeTiming.medianSeconds}s).`);
  }
  if (k.favouredAttackSite) {
    const cell = s.siteWinRates.attack[k.favouredAttackSite];
    plan.push(`Weight the ${k.favouredAttackSite} site on defense: it takes ${pct(k.favouredAttackSiteShare)} of their attacks and they win ${pct(cell.winRate)} of rounds there.`);
  }
  if (k.favouredDefenseSite) {
    plan.push(`On attack, start away from the ${k.favouredDefenseSite} site: they stack it on ${pct(k.favouredDefenseSiteShare)} of defense rounds.`);
  }
  plan.push(`Economy: they win ${pct(s.economy.states.FULL_BUY.winRate)} of full-buy rounds, ${pct(s.economy.states.HALF_BUY.winRate)} of half-buy or bonus rounds and ${pct(s.economy.states.ECO.winRate)} of eco rounds. Expect the Operator on ${pct(op.buyRoundOpFrequency)} of full buys.`);
  plan.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  lines.push("");
  lines.push("---");
  lines.push(`Data source: ${md(s.source.label)}.`);

  const kpis = [
    { id: "utility-efficiency", label: "Utility Efficiency Score", value: `${u.utilityEfficiencyScore} / 100` },
    { id: "flash-assist", label: "Flash Assist Rate", value: pct(u.flashAssistRate) },
    { id: "operator-spot", label: "Primary Operator spot", value: k.primaryOperatorSpot ?? "None" },
    { id: "operator-first-blood", label: "Operator first-blood pick rate", value: pct(k.operatorFirstBloodPickRate) },
    { id: "execute-median", label: "Median execute time", value: `${u.executeTiming.medianSeconds}s` },
    { id: "attack-site", label: "Favoured attack site", value: k.favouredAttackSite ? `${k.favouredAttackSite} (${pct(k.favouredAttackSiteShare)})` : "None" },
    { id: "pistol-win-rate", label: "Pistol win rate", value: pct(k.pistolWinRate) },
  ];

  return { markdown: lines.join("\n"), kpis };
}

/** Question topics understood by the deterministic coach, checked in this order. */
const COACH_TOPICS = [
  ["retake", /\b(retake|retakes|post[- ]?plant|defuse)\b/],
  ["pistol", /\bpistols?\b/],
  ["operator", /\b(operator|op|ops|sniper|awp|scope|chamber)\b/],
  ["economy", /\b(eco|ecos|economy|force|forcing|save|saving|buy|buys|credits|bonus)\b/],
  ["execute", /\b(execute|executes|timing|timings|hit|hits|when|rush|rushes)\b/],
  ["site", /\b(site|sites|bias|plant|plants|stack|stacks)\b/],
];

/** Topic of a coaching question: "operator" | "economy" | "pistol" | "execute" | "site" | "retake" | null. */
export function detectCoachTopic(question) {
  const text = typeof question === "string" ? question.toLowerCase() : "";
  for (const [topic, pattern] of COACH_TOPICS) if (pattern.test(text)) return topic;
  return null;
}

/**
 * Telemetry-grounded answer that needs no model: 5 or 6 bullet lines (one string, lines start
 * with "- "), every number taken from `summary`. The bullet that matches the question topic is
 * moved to the top. Bullets: Operator spot and first-blood pick rate, top anti-Operator
 * counter (only when there is one), execute window, favoured sites, pistol tendency, and either
 * the economy bullet or, for a retake question, the retake bullet.
 */
export function buildDeterministicCoachAnswer(summary, question) {
  const s = summary;
  const k = s.keyNumbers;
  const op = s.operator;
  const u = s.utility;
  const topic = detectCoachTopic(question);
  const bullets = [];

  if (op.primarySpot) {
    const spot = op.primarySpot;
    bullets.push(["operator", `Operator: ${spot.player} holds ${spot.callout}${spot.watch ? ` watching ${spot.watch}` : ""} on ${spot.holds} of ${op.holds} Operator holds, with a ${pct(spot.firstBloodPickRate)} first-blood pick rate and a ${pct(spot.rePeekRate)} re-peek rate.`]);
  } else {
    bullets.push(["operator", `Operator: no Operator hold was recorded for ${s.teamName} in ${s.roundCount} rounds on ${s.mapName}, so play standard anti-rifle spacing.`]);
  }
  if (s.antiOp.length > 0) bullets.push(["counter", `Counter: ${s.antiOp[0].text}`]);

  if (u.executeTiming.peak) {
    bullets.push(["execute", `Execute timing: the first execute utility most often lands in the ${u.executeTiming.peak.label} window (${pct(u.executeTiming.peak.share)} of ${u.executeTiming.rounds} attack rounds, median ${u.executeTiming.medianSeconds}s), so hold defensive utility until then.`]);
  } else {
    bullets.push(["execute", "Execute timing: no attack round with execute-phase utility in the sample, so there is no timing read."]);
  }

  const attackSite = k.favouredAttackSite;
  const defenseSite = k.favouredDefenseSite;
  const sitePart = attackSite
    ? `${s.teamName} attack the ${attackSite} site on ${pct(k.favouredAttackSiteShare)} of attack rounds and win ${pct(s.siteWinRates.attack[attackSite].winRate)} of them`
    : `${s.teamName} show no attack site preference in the sample`;
  const stackPart = defenseSite ? `; on defense they stack ${defenseSite} on ${pct(k.favouredDefenseSiteShare)} of rounds, so open away from it` : "";
  bullets.push(["site", `Site bias: ${sitePart}${stackPart}.`]);

  const pa = s.pistol.attack;
  const pd = s.pistol.defense;
  const pistolParts = [];
  if (pa.rounds > 0) pistolParts.push(`attack pistol goes ${pa.favouredSite ?? "to no clear site"}${pa.favouredSite ? " site" : ""} (${pa.wins} of ${pa.rounds} won)`);
  if (pd.rounds > 0) pistolParts.push(`defense pistol stacks ${pd.favouredSite ?? "no clear site"}${pd.favouredSite ? " site" : ""} (${pd.wins} of ${pd.rounds} won)`);
  bullets.push(["pistol", pistolParts.length > 0
    ? `Pistol rounds: ${pistolParts.join("; ")}; overall pistol win rate ${pct(s.pistol.winRate)}.`
    : "Pistol rounds: no pistol round in the sample."]);

  if (topic === "retake") {
    const hit = attackSite ?? s.sites[0];
    const cell = s.siteWinRates.defense[hit];
    bullets.push(["retake", `Retake: ${s.teamName} used ${u.postPlantEvents} post-plant utility events in ${s.roundCount} rounds and win ${pct(s.record.defense.winRate)} of defense rounds (${cell.wins} of ${cell.rounds} when ${hit} is hit). Expect post-plant lineups and only retake with numbers or a full utility set.`]);
  } else {
    const st = s.economy.states;
    bullets.push(["economy", `Economy: the Operator comes out on ${pct(op.buyRoundOpFrequency)} of full-buy rounds against ${pct(op.ecoRoundOpFrequency)} of eco and half-buy rounds; they win ${pct(st.FULL_BUY.winRate)} of full buys, ${pct(st.HALF_BUY.winRate)} of half-buy or bonus rounds and ${pct(st.ECO.winRate)} of ecos.`]);
  }

  const wanted = topic === "operator" && !op.primarySpot ? "operator" : topic;
  const lead = bullets.findIndex(([id]) => id === wanted);
  if (lead > 0) bullets.unshift(...bullets.splice(lead, 1));
  return bullets.map(([, text]) => `- ${text}`).join("\n");
}
