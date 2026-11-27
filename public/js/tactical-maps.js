// SpikeSight C9 - tactical map geometry (pure module: no DOM, no I/O).
//
// Data provenance
// - `transform` and `callouts` are copied from the public community endpoint
//   https://valorant-api.com/v1/maps (fields xMultiplier, yMultiplier, xScalarToAdd,
//   yScalarToAdd and callouts[].location, in game units).
// - Minimap transform (note the swapped axes):
//     nx = gameY * xMultiplier + xScalarToAdd
//     ny = gameX * yMultiplier + yScalarToAdd
//   Both results are in 0..1 with (0, 0) at the top-left corner of the minimap.
// - `zones` and `connectors` are schematic shapes drawn for this project around those
//   callout coordinates. They are not traced from any Riot Games artwork.

const RAW_MAPS = {
  ascent: {
    name: "Ascent",
    sites: ["A", "B"],
    transform: { xMultiplier: 0.00007, yMultiplier: -0.00007, xScalarToAdd: 0.813895, yScalarToAdd: 0.573242 },
    callouts: [
      ["A", "Tree", 3980.91, -5938.76],
      ["A", "Lobby", 4489.03, -3014.05],
      ["A", "Main", 5321.62, -4710.13],
      ["A", "Window", 4023.02, -8180.69],
      ["A", "Site", 6153.59, -6626.21],
      ["Attacker Side", "Spawn", 60, 50],
      ["B", "Lobby", -1490.59, -1389.97],
      ["B", "Main", -1983.67, -5840.81],
      ["B", "Boat House", -4484.77, -7763.36],
      ["Mid", "Bottom", 1122.23, -5951.7],
      ["B", "Site", -2344.06, -7548.51],
      ["Mid", "Catwalk", 2315.79, -4127.26],
      ["Mid", "Cubby", 3387.32, -5129.76],
      ["Defender Side", "Spawn", 1995.24, -9744.92],
      ["A", "Garden", 3773.67, -7551.35],
      ["Mid", "Market", 1089.1, -7363.19],
      ["Mid", "Courtyard", 1222.7, -4586.6],
      ["Mid", "Link", -632.09, -4280.26],
      ["Mid", "Pizza", 1801.57, -7262.17],
      ["A", "Rafters", 6129.89, -8210],
      ["Mid", "Top", 2753.93, -2129.62],
      ["A", "Wine", 7358.74, -4689.27],
    ],
  },
  haven: {
    name: "Haven",
    sites: ["A", "B", "C"],
    transform: { xMultiplier: 0.000075, yMultiplier: -0.000075, xScalarToAdd: 1.09345, yScalarToAdd: 0.642728 },
    callouts: [
      ["A", "Garden", 3100.26, -4683.6],
      ["A", "Link", 4244.42, -10715.68],
      ["A", "Lobby", 3438.54, -6260.41],
      ["A", "Long", 6209.7, -6901.14],
      ["A", "Sewer", 3452.87, -7915.72],
      ["A", "Site", 6309.31, -9225.7],
      ["Attacker Side", "Spawn", 1741.76, -2642.79],
      ["B", "Back", 1966.16, -10664.77],
      ["B", "Site", 1884.71, -9231.33],
      ["C", "Link", -87.76, -10004.42],
      ["C", "Lobby", -1642.19, -5720.34],
      ["C", "Long", -3356.81, -5990.87],
      ["C", "Garage", 180.08, -7999.58],
      ["C", "Window", -10.13, -8993.24],
      ["C", "Site", -2378.13, -9010.56],
      ["C", "Cubby", -2119.77, -6561.6],
      ["Defender Side", "Spawn", 2946.3, -12714.71],
      ["Mid", "Doors", 151.12, -6262.92],
      ["Mid", "Courtyard", 1822.13, -6712.69],
      ["Mid", "Window", 1950.22, -5567.91],
      ["A", "Tower", 6721.4, -10472.52],
    ],
  },
  bind: {
    name: "Bind",
    sites: ["A", "B"],
    transform: { xMultiplier: 0.000059, yMultiplier: -0.000059, xScalarToAdd: 0.576941, yScalarToAdd: 0.967566 },
    callouts: [
      ["A", "Exit", 7550.41, 5874.5],
      ["A", "Link", 6365.64, -1007.02],
      ["A", "Lobby", 6113.24, 3158.82],
      ["A", "Short", 7983.35, 803.96],
      ["A", "Site", 10747.9, 2664.44],
      ["A", "Teleporter", 9432.3, 489.88],
      ["Attacker Side", "Spawn", 161.65, 77.51],
      ["B", "Exit", 8921.41, -1763.23],
      ["B", "Hall", 12981.88, -4941.75],
      ["B", "Link", 6361.57, -2621.18],
      ["B", "Fountain", 5737.15, -5390.45],
      ["B", "Long", 7666.67, -6512.8],
      ["B", "Short", 7424.13, -3056.45],
      ["B", "Site", 11108.11, -4831.46],
      ["B", "Teleporter", 9027.78, -7223.81],
      ["B", "Window", 8826.79, -4309.41],
      ["A", "Bath", 9106.54, 4449.66],
      ["Attacker Side", "Cave", 3920.39, 256.94],
      ["A", "Cubby", 8605.17, 174.9],
      ["Defender Side", "Spawn", 14641.92, -1017.67],
      ["B", "Elbow", 11212.9, -7095.33],
      ["B", "Garden", 9144.1, -5598.13],
      ["A", "Lamps", 10649.47, 79.9],
      ["A", "Tower", 12872.58, 2556.77],
    ],
  },
  lotus: {
    name: "Lotus",
    sites: ["A", "B", "C"],
    transform: { xMultiplier: 0.000072, yMultiplier: -0.000072, xScalarToAdd: 0.454789, yScalarToAdd: 0.917752 },
    callouts: [
      ["A", "Top", 9260.3, 5045.59],
      ["A", "Drop", 9516.38, 6092.89],
      ["A", "Site", 7735.54, 5557.31],
      ["A", "Hut", 7917.46, 5557.31],
      ["A", "Tree", 6149.53, 5557.31],
      ["A", "Door", 5608.76, 5203.91],
      ["A", "Main", 5288.3, 4159.76],
      ["A", "Rubble", 4401.07, 4918.19],
      ["A", "Root", 4401.07, 3294.15],
      ["A", "Lobby", 2685.95, 2927.18],
      ["C", "Lobby", 1403.57, -1576.59],
      ["B", "Pillars", 3565.37, 668.18],
      ["B", "Main", 4876.83, -47.87],
      ["C", "Door", 4818.67, -1752.8],
      ["B", "Site", 6368.03, 668.18],
      ["A", "Link", 6011.07, 2087.65],
      ["B", "Upper", 7682.94, 1517.36],
      ["C", "Waterfall", 6719.8, -1994.3],
      ["C", "Link", 7504.11, -1377.89],
      ["A", "Stairs", 8257.88, 3860.93],
      ["C", "Mound", 3863.72, -1576.59],
      ["C", "Main", 5311.26, -3148.16],
      ["C", "Bend", 5657.52, -5281.44],
      ["C", "Site", 6676.66, -4265.88],
      ["C", "Hall", 7902.06, -4265.88],
      ["C", "Gravel", 8936.88, -1752.29],
      ["Defender Side", "Spawn", 9686.77, 1697.82],
      ["Attacker Side", "Spawn", 1401.29, 777.3],
    ],
  },
};

// ---------------------------------------------------------------------------
// Schematic zone specifications. Every shape is anchored on a real callout, so a
// zone always contains the callout it is named after.
//   oct(callout, halfWidth, halfHeight)  chamfered rectangle (sites, spawns)
//   box(callout, halfWidth, halfHeight)  rectangle (plant zones, chokes, lanes)
//   span([callouts], pad)                padded bounding box of several callouts (mid)
// ---------------------------------------------------------------------------
const oct = (callout, hw, hh, ox = 0, oy = 0) => ({ shape: "oct", callouts: [callout], hw, hh, ox, oy });
const box = (callout, hw, hh, ox = 0, oy = 0) => ({ shape: "box", callouts: [callout], hw, hh, ox, oy });
const span = (callouts, pad) => ({ shape: "span", callouts, pad });
const zone = (id, label, kind, site, shape, extra = {}) => ({ id, label, kind, site, shape, ...extra });

const ZONE_SPECS = {
  ascent: [
    zone("site-a", "A Site", "site", "A", oct("A Site", 0.08, 0.065)),
    zone("plant-a", "A Spike Plant", "plant", "A", box("A Site", 0.042, 0.034)),
    zone("site-b", "B Site", "site", "B", oct("B Site", 0.08, 0.07)),
    zone("plant-b", "B Spike Plant", "plant", "B", box("B Site", 0.042, 0.036)),
    zone("mid", "Mid", "mid", null, span(["Mid Courtyard", "Mid Bottom"], 0.042)),
    zone("spawn-attack", "Attacker Spawn", "spawn", null, oct("Attacker Side Spawn", 0.06, 0.065)),
    zone("spawn-defense", "Defender Spawn", "spawn", null, oct("Defender Side Spawn", 0.055, 0.065)),
    zone("choke-a-main", "A Main", "choke", "A", box("A Main", 0.042, 0.036)),
    zone("choke-b-main", "B Main", "choke", "B", box("B Main", 0.035, 0.036)),
    zone("choke-mid-top", "Mid Top", "choke", null, box("Mid Top", 0.04, 0.036)),
    zone("choke-market", "Market", "choke", "B", box("Mid Market", 0.03, 0.026)),
    zone("lane-a-lobby", "A Lobby", "lane", "A", box("A Lobby", 0.045, 0.04)),
    zone("lane-b-lobby", "B Lobby", "lane", "B", box("B Lobby", 0.05, 0.04)),
    zone("lane-catwalk", "Catwalk", "lane", null, box("Mid Catwalk", 0.035, 0.03)),
    zone("lane-a-tree", "Tree", "lane", "A", box("A Tree", 0.035, 0.03)),
    zone("lane-a-garden", "Garden", "lane", "A", box("A Garden", 0.028, 0.03, -0.02, 0.012)),
    zone("lane-a-rafters", "Rafters", "lane", "A", box("A Rafters", 0.026, 0.035, -0.006, 0)),
    zone("lane-a-wine", "Wine", "lane", "A", box("A Wine", 0.035, 0.028)),
    zone("lane-mid-link", "Link", "lane", null, box("Mid Link", 0.035, 0.034)),
    zone("lane-b-boathouse", "Boat House", "lane", "B", box("B Boat House", 0.04, 0.034)),
  ],
  haven: [
    zone("site-a", "A Site", "site", "A", oct("A Site", 0.075, 0.07)),
    zone("plant-a", "A Spike Plant", "plant", "A", box("A Site", 0.04, 0.035)),
    zone("site-b", "B Site", "site", "B", oct("B Site", 0.06, 0.058)),
    zone("plant-b", "B Spike Plant", "plant", "B", box("B Site", 0.034, 0.032)),
    zone("site-c", "C Site", "site", "C", oct("C Site", 0.075, 0.065)),
    zone("plant-c", "C Spike Plant", "plant", "C", box("C Site", 0.04, 0.034)),
    zone("mid", "Mid", "mid", null, span(["Mid Courtyard"], 0.05)),
    zone("spawn-attack", "Attacker Spawn", "spawn", null, oct("Attacker Side Spawn", 0.055, 0.065)),
    zone("spawn-defense", "Defender Spawn", "spawn", null, oct("Defender Side Spawn", 0.055, 0.065)),
    zone("choke-a-long", "A Long", "choke", "A", box("A Long", 0.045, 0.036)),
    zone("choke-a-sewer", "A Sewer", "choke", "A", box("A Sewer", 0.035, 0.034)),
    zone("choke-mid-window", "Mid Window", "choke", "B", box("Mid Window", 0.03, 0.034)),
    zone("choke-c-garage", "Garage", "choke", "C", box("C Garage", 0.036, 0.032)),
    zone("choke-c-long", "C Long", "choke", "C", box("C Long", 0.045, 0.036)),
    zone("lane-a-lobby", "A Lobby", "lane", "A", box("A Lobby", 0.04, 0.035)),
    zone("lane-a-garden", "A Garden", "lane", "A", box("A Garden", 0.04, 0.035)),
    zone("lane-a-tower", "Tower", "lane", "A", box("A Tower", 0.018, 0.035, -0.004, 0)),
    zone("lane-a-link", "A Link", "lane", "A", box("A Link", 0.03, 0.035)),
    zone("lane-b-back", "B Back", "lane", "B", box("B Back", 0.03, 0.035)),
    zone("lane-mid-doors", "Mid Doors", "lane", null, box("Mid Doors", 0.032, 0.03)),
    zone("lane-c-window", "C Window", "lane", "C", box("C Window", 0.028, 0.028)),
    zone("lane-c-link", "C Link", "lane", "C", box("C Link", 0.03, 0.03)),
    zone("lane-c-lobby", "C Lobby", "lane", "C", box("C Lobby", 0.04, 0.034)),
  ],
  bind: [
    zone("site-a", "A Site", "site", "A", oct("A Site", 0.07, 0.068)),
    zone("plant-a", "A Spike Plant", "plant", "A", box("A Site", 0.038, 0.035)),
    zone("site-b", "B Site", "site", "B", oct("B Site", 0.068, 0.062)),
    zone("plant-b", "B Spike Plant", "plant", "B", box("B Site", 0.036, 0.033)),
    zone("spawn-attack", "Attacker Spawn", "spawn", null, oct("Attacker Side Spawn", 0.065, 0.035)),
    zone("spawn-defense", "Defender Spawn", "spawn", null, oct("Defender Side Spawn", 0.065, 0.05)),
    zone("choke-a-short", "A Short", "choke", "A", box("A Short", 0.034, 0.03)),
    zone("choke-a-bath", "A Bath (Showers)", "choke", "A", box("A Bath", 0.03, 0.03, 0.004, 0)),
    zone("choke-b-long", "B Long", "choke", "B", box("B Long", 0.03, 0.03, 0.002, 0.004)),
    zone("choke-b-window", "B Window (Hookah)", "choke", "B", box("B Window", 0.028, 0.03)),
    zone("choke-b-garden", "B Garden", "choke", "B", box("B Garden", 0.03, 0.026)),
    // Bind has no Mid. Its two one-way teleporters are the rotation lanes.
    zone("tp-a", "A Teleporter", "lane", "A", box("A Teleporter", 0.02, 0.02), { teleporter: true, exitCallout: "B Exit" }),
    zone("tp-b", "B Teleporter", "lane", "B", box("B Teleporter", 0.02, 0.02, -0.004, -0.004), { teleporter: true, exitCallout: "A Exit" }),
    zone("lane-a-lobby", "A Lobby", "lane", "A", box("A Lobby", 0.045, 0.04)),
    zone("lane-a-lamps", "Lamps", "lane", "A", box("A Lamps", 0.03, 0.03)),
    zone("lane-a-tower", "Tower", "lane", "A", box("A Tower", 0.035, 0.028)),
    zone("lane-a-link", "A Link", "lane", "A", box("A Link", 0.03, 0.028)),
    zone("lane-cave", "Cave", "lane", null, box("Attacker Side Cave", 0.035, 0.04)),
    zone("lane-b-link", "B Link", "lane", "B", box("B Link", 0.03, 0.028)),
    zone("lane-b-short", "B Short", "lane", "B", box("B Short", 0.028, 0.024)),
    zone("lane-b-fountain", "Fountain", "lane", "B", box("B Fountain", 0.04, 0.036)),
    zone("lane-b-elbow", "Elbow", "lane", "B", box("B Elbow", 0.03, 0.035)),
    zone("lane-b-hall", "B Hall", "lane", "B", box("B Hall", 0.035, 0.026)),
  ],
  lotus: [
    zone("site-a", "A Site", "site", "A", oct("A Site", 0.062, 0.066)),
    zone("plant-a", "A Spike Plant", "plant", "A", box("A Site", 0.034, 0.034)),
    zone("site-b", "B Site", "site", "B", oct("B Site", 0.055, 0.05)),
    zone("plant-b", "B Spike Plant", "plant", "B", box("B Site", 0.032, 0.03)),
    zone("site-c", "C Site", "site", "C", oct("C Site", 0.062, 0.06)),
    zone("plant-c", "C Spike Plant", "plant", "C", box("C Site", 0.034, 0.032)),
    // Lotus has no callout named Mid: B Main and B Pillars form the central lane.
    zone("mid", "Mid (B Main)", "mid", null, span(["B Main", "B Pillars"], 0.03)),
    zone("spawn-attack", "Attacker Spawn", "spawn", null, oct("Attacker Side Spawn", 0.06, 0.05)),
    zone("spawn-defense", "Defender Spawn", "spawn", null, oct("Defender Side Spawn", 0.055, 0.05)),
    zone("choke-a-main", "A Main", "choke", "A", box("A Main", 0.036, 0.034)),
    zone("choke-a-tree", "A Tree", "choke", "A", box("A Tree", 0.035, 0.026)),
    zone("choke-a-link", "A Link", "choke", "B", box("A Link", 0.03, 0.03)),
    zone("choke-c-main", "C Main", "choke", "C", box("C Main", 0.034, 0.034)),
    zone("choke-c-link", "C Link", "choke", "B", box("C Link", 0.028, 0.028)),
    zone("lane-a-lobby", "A Lobby", "lane", "A", box("A Lobby", 0.04, 0.036)),
    zone("lane-a-root", "A Root", "lane", "A", box("A Root", 0.026, 0.03)),
    zone("lane-a-rubble", "Rubble", "lane", "A", box("A Rubble", 0.03, 0.026)),
    zone("lane-a-stairs", "Stairs", "lane", "A", box("A Stairs", 0.03, 0.03)),
    zone("lane-a-top", "A Top", "lane", "A", box("A Top", 0.03, 0.026)),
    zone("lane-b-upper", "B Upper", "lane", "B", box("B Upper", 0.03, 0.028)),
    zone("lane-c-door", "C Door", "lane", "C", box("C Door", 0.028, 0.026)),
    zone("lane-c-mound", "Mound", "lane", "C", box("C Mound", 0.03, 0.03)),
    zone("lane-c-lobby", "C Lobby", "lane", "C", box("C Lobby", 0.04, 0.036)),
    zone("lane-c-waterfall", "Waterfall", "lane", "C", box("C Waterfall", 0.026, 0.024)),
    // The label sits in the upper part of the box so that it clears the "C SITE" heading below it.
    zone("lane-c-hall", "C Hall", "lane", "C", box("C Hall", 0.03, 0.022), { labelDy: -0.014 }),
    zone("lane-c-bend", "Bend", "lane", "C", box("C Bend", 0.026, 0.02, 0, 0.014)),
  ],
};

// Walkable connections between callouts, drawn as corridors under the zones.
// A third element `true` marks a one-way teleporter link.
const CONNECTOR_SPECS = {
  ascent: [
    ["Attacker Side Spawn", "A Lobby"], ["A Lobby", "A Main"], ["A Main", "A Site"], ["A Main", "A Wine"],
    ["A Site", "A Rafters"], ["A Site", "A Tree"], ["A Tree", "A Garden"], ["A Garden", "A Window"],
    ["A Rafters", "A Window"], ["A Window", "Defender Side Spawn"],
    ["Attacker Side Spawn", "Mid Top"], ["Mid Top", "Mid Catwalk"], ["Mid Catwalk", "Mid Courtyard"],
    ["Mid Catwalk", "Mid Cubby"], ["Mid Cubby", "A Tree"], ["Mid Courtyard", "Mid Bottom"],
    ["Mid Bottom", "Mid Pizza"], ["Mid Pizza", "Mid Market"], ["Mid Bottom", "Mid Market"],
    ["Mid Market", "B Site"], ["Mid Market", "Defender Side Spawn"], ["Mid Courtyard", "Mid Link"],
    ["Mid Link", "B Main"], ["Attacker Side Spawn", "B Lobby"], ["B Lobby", "B Main"], ["B Main", "B Site"],
    ["B Site", "B Boat House"], ["B Site", "Defender Side Spawn"],
  ],
  haven: [
    ["Attacker Side Spawn", "A Garden"], ["A Garden", "A Lobby"], ["A Lobby", "A Long"], ["A Long", "A Site"],
    ["A Lobby", "A Sewer"], ["A Sewer", "A Site"], ["A Site", "A Tower"], ["A Tower", "A Link"],
    ["A Link", "Defender Side Spawn"], ["A Link", "B Back"],
    ["Attacker Side Spawn", "Mid Window"], ["Mid Window", "Mid Courtyard"], ["Mid Courtyard", "B Site"],
    ["B Site", "B Back"], ["B Back", "Defender Side Spawn"], ["Mid Courtyard", "Mid Doors"],
    ["Mid Doors", "C Garage"], ["C Garage", "C Window"], ["C Window", "C Link"], ["C Link", "B Back"],
    ["C Link", "Defender Side Spawn"], ["Attacker Side Spawn", "C Lobby"], ["C Lobby", "C Cubby"],
    ["C Lobby", "C Long"], ["C Long", "C Site"], ["C Cubby", "C Site"], ["C Site", "C Link"],
  ],
  bind: [
    ["Attacker Side Spawn", "Attacker Side Cave"], ["Attacker Side Cave", "A Link"], ["Attacker Side Cave", "B Link"],
    ["A Link", "A Lobby"], ["A Lobby", "A Bath"], ["A Lobby", "A Exit"], ["A Bath", "A Site"],
    ["A Link", "A Short"], ["A Short", "A Cubby"], ["A Cubby", "A Teleporter"], ["A Short", "A Lamps"],
    ["A Lamps", "A Site"], ["A Site", "A Tower"], ["A Tower", "Defender Side Spawn"],
    ["B Link", "B Short"], ["B Short", "B Window"], ["B Short", "B Exit"], ["B Window", "B Site"],
    ["B Link", "B Fountain"], ["B Fountain", "B Long"], ["B Long", "B Teleporter"], ["B Long", "B Garden"],
    ["B Garden", "B Site"], ["B Site", "B Elbow"], ["B Elbow", "B Long"], ["B Site", "B Hall"],
    ["B Hall", "Defender Side Spawn"],
    ["A Teleporter", "B Exit", true], ["B Teleporter", "A Exit", true],
  ],
  lotus: [
    ["Attacker Side Spawn", "A Lobby"], ["A Lobby", "A Root"], ["A Root", "A Main"], ["A Lobby", "A Rubble"],
    ["A Rubble", "A Door"], ["A Main", "A Door"], ["A Door", "A Tree"], ["A Tree", "A Site"],
    ["A Site", "A Hut"], ["A Site", "A Stairs"], ["A Stairs", "A Top"], ["A Top", "A Drop"],
    ["A Top", "Defender Side Spawn"], ["A Main", "A Link"], ["A Link", "B Site"],
    ["Attacker Side Spawn", "B Pillars"], ["B Pillars", "B Main"], ["B Main", "B Site"], ["B Site", "B Upper"],
    ["B Upper", "Defender Side Spawn"], ["B Main", "C Door"], ["C Door", "C Mound"],
    ["Attacker Side Spawn", "C Lobby"], ["C Lobby", "C Mound"], ["C Mound", "C Main"], ["C Main", "C Site"],
    ["C Main", "C Bend"], ["C Site", "C Hall"], ["C Hall", "C Gravel"], ["C Gravel", "Defender Side Spawn"],
    ["C Site", "C Waterfall"], ["C Waterfall", "C Link"], ["C Link", "C Gravel"], ["C Link", "B Site"],
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const round4 = (n) => Math.round(n * 10000) / 10000;

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Clamp any value into [0, 1]; non-finite input becomes 0. */
export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function shapePoints(shape, calloutByName, mapId) {
  const anchors = shape.callouts.map((name) => {
    const c = calloutByName.get(name.toLowerCase());
    if (!c) throw new Error(`tactical-maps: unknown callout "${name}" on ${mapId}`);
    return c;
  });
  if (shape.shape === "span") {
    const xs = anchors.map((c) => c.x);
    const ys = anchors.map((c) => c.y);
    const x0 = Math.min(...xs) - shape.pad;
    const x1 = Math.max(...xs) + shape.pad;
    const y0 = Math.min(...ys) - shape.pad;
    const y1 = Math.max(...ys) + shape.pad;
    const k = shape.pad * 0.4;
    return [[x0 + k, y0], [x1 - k, y0], [x1, y0 + k], [x1, y1 - k], [x1 - k, y1], [x0 + k, y1], [x0, y1 - k], [x0, y0 + k]];
  }
  const cx = anchors[0].x + shape.ox;
  const cy = anchors[0].y + shape.oy;
  const x0 = cx - shape.hw;
  const x1 = cx + shape.hw;
  const y0 = cy - shape.hh;
  const y1 = cy + shape.hh;
  if (shape.shape === "oct") {
    const k = Math.min(shape.hw, shape.hh) * 0.35;
    return [[x0 + k, y0], [x1 - k, y0], [x1, y0 + k], [x1, y1 - k], [x1 - k, y1], [x0 + k, y1], [x0, y1 - k], [x0, y0 + k]];
  }
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function buildMap(id, raw) {
  const t = raw.transform;
  const callouts = raw.callouts.map(([superRegion, region, gameX, gameY]) => ({
    id: slugify(`${superRegion} ${region}`),
    name: `${superRegion} ${region}`,
    region,
    superRegion,
    game: { x: gameX, y: gameY },
    x: gameY * t.xMultiplier + t.xScalarToAdd,
    y: gameX * t.yMultiplier + t.yScalarToAdd,
  }));
  const calloutByName = new Map(callouts.map((c) => [c.name.toLowerCase(), c]));

  const zones = ZONE_SPECS[id].map((spec) => {
    const points = shapePoints(spec.shape, calloutByName, id).map(([x, y]) => [round4(clamp01(x)), round4(clamp01(y))]);
    const center = {
      x: round4(points.reduce((s, p) => s + p[0], 0) / points.length),
      y: round4(points.reduce((s, p) => s + p[1], 0) / points.length),
    };
    const z = { id: spec.id, label: spec.label, kind: spec.kind, site: spec.site, callout: spec.shape.callouts[0], center, points };
    // Optional vertical shift of the drawn label (normalised units) for zones whose default
    // label position would run into a neighbour's.
    if (Number.isFinite(spec.labelDy)) z.labelDy = spec.labelDy;
    if (spec.teleporter) {
      const exit = calloutByName.get(spec.exitCallout.toLowerCase());
      if (!exit) throw new Error(`tactical-maps: unknown teleporter exit "${spec.exitCallout}" on ${id}`);
      z.teleporter = true;
      z.oneWay = true;
      z.exitCallout = exit.name;
      z.exit = { x: round4(exit.x), y: round4(exit.y) };
    }
    return z;
  });

  const connectors = CONNECTOR_SPECS[id].map(([fromName, toName, teleporter]) => {
    const from = calloutByName.get(fromName.toLowerCase());
    const to = calloutByName.get(toName.toLowerCase());
    if (!from || !to) throw new Error(`tactical-maps: unknown connector "${fromName}" -> "${toName}" on ${id}`);
    return {
      id: `${from.id}--${to.id}`,
      from: from.name,
      to: to.name,
      teleporter: teleporter === true,
      points: [[round4(from.x), round4(from.y)], [round4(to.x), round4(to.y)]],
    };
  });

  return { id, name: raw.name, sites: [...raw.sites], transform: { ...t }, callouts, zones, connectors };
}

// ---------------------------------------------------------------------------
// Public data
// ---------------------------------------------------------------------------
export const MAP_IDS = Object.freeze(["ascent", "haven", "bind", "lotus"]);

export const MAPS = deepFreeze(Object.fromEntries(MAP_IDS.map((id) => [id, buildMap(id, RAW_MAPS[id])])));

/** Order used by zoneAt when shapes are nested: the most specific kind wins. */
export const ZONE_KIND_PRIORITY = Object.freeze(["plant", "site", "choke", "mid", "spawn", "lane"]);

/** Return the map object or throw a RangeError naming the valid ids. */
export function getMap(mapId) {
  const key = typeof mapId === "string" ? mapId.toLowerCase() : "";
  if (!Object.prototype.hasOwnProperty.call(MAPS, key)) {
    throw new RangeError(`Unknown map id "${String(mapId)}". Valid ids: ${MAP_IDS.join(", ")}.`);
  }
  return MAPS[key];
}

// ---------------------------------------------------------------------------
// Coordinate transforms
// ---------------------------------------------------------------------------

/** Game units -> normalised minimap coordinates (not clamped). */
export function gameToNormalized(mapId, gameX, gameY) {
  const t = getMap(mapId).transform;
  return {
    x: Number(gameY) * t.xMultiplier + t.xScalarToAdd,
    y: Number(gameX) * t.yMultiplier + t.yScalarToAdd,
  };
}

/** Exact inverse of gameToNormalized: normalised minimap coordinates -> game units. */
export function normalizedToGame(mapId, x, y) {
  const t = getMap(mapId).transform;
  return {
    x: (Number(y) - t.yScalarToAdd) / t.yMultiplier,
    y: (Number(x) - t.xScalarToAdd) / t.xMultiplier,
  };
}

/** Normalised point -> SVG user units for a square viewBox of `size`. */
export function normalizedToSvg(point, size = 1000) {
  return { x: Number(point.x) * size, y: Number(point.y) * size };
}

// ---------------------------------------------------------------------------
// Spatial queries
// ---------------------------------------------------------------------------

/** Even-odd ray casting. `point` is { x, y } or [x, y]; `polygon` is [[x, y], ...]. */
export function pointInPolygon(point, polygon) {
  const px = Array.isArray(point) ? point[0] : point?.x;
  const py = Array.isArray(point) ? point[1] : point?.y;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The zone containing the point (most specific kind first), or null. */
export function zoneAt(mapId, x, y) {
  const map = getMap(mapId);
  for (const kind of ZONE_KIND_PRIORITY) {
    for (const z of map.zones) {
      if (z.kind === kind && pointInPolygon({ x, y }, z.points)) return z;
    }
  }
  return null;
}

/** "A" | "B" | "C" when the point is inside a site polygon or its plant zone, else null. */
export function siteAt(mapId, x, y) {
  const map = getMap(mapId);
  for (const z of map.zones) {
    if ((z.kind === "plant" || z.kind === "site") && pointInPolygon({ x, y }, z.points)) return z.site;
  }
  return null;
}

/**
 * Look a callout up by super region and region ("A", "Site"), or by its full
 * name in the first argument ("A Site"). Case-insensitive. Returns null when absent.
 */
export function getCallout(mapId, superRegion, region) {
  const map = getMap(mapId);
  const wanted = (region === undefined ? String(superRegion ?? "") : `${superRegion} ${region}`).trim().toLowerCase();
  return map.callouts.find((c) => c.name.toLowerCase() === wanted) ?? null;
}

/** The callout closest to a normalised point (never null: every map has callouts). */
export function nearestCallout(mapId, x, y) {
  const map = getMap(mapId);
  let best = map.callouts[0];
  let bestD = Infinity;
  for (const c of map.callouts) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** The site letter whose "X Site" callout is closest to the point. */
export function nearestSite(mapId, x, y) {
  const map = getMap(mapId);
  let best = map.sites[0];
  let bestD = Infinity;
  for (const site of map.sites) {
    const c = map.callouts.find((k) => k.superRegion === site && k.region === "Site");
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = site;
    }
  }
  return best;
}
