// Kimchi Key v2: the authored map (docs/map-v2-spec.md §2-§6.1, §10). Pure data with no imports, so node,
// a Worker and the browser can all load it. Units are metres: x east, z south, origin at the NW corner of
// the 2048 × 1792 m world. Headings are radians with 0 = east and π/2 = south. world-v2.js turns this into
// rasters, the RoadNet and the containers the game reads; nothing here is computed.

const PI = Math.PI;

export const MAP_VERSION = 2;
export const WORLD = { w: 2048, h: 1792 };
export const SEA_LEVEL = -1.0;     // today's sea plane
export const LAND_BASE = 1.0;      // terrain features are heights above this

// ---------- road classes (§4.2) ----------
// lanes is per direction; dirt and alley are one shared strip (single: true, width wide, modelled as a
// lane each way of half the width). laneW/median/shoulder/parking/walk and halfW are metres (halfW = edge
// of the drivable surface from the centreline, without the sidewalk), speed is the AI cruise in m/s
// (dirt and alley have no AI; theirs only prices routes), grade the steepest allowed rise (fraction),
// minR the tightest centreline radius, bank the most superelevation in degrees. chord is the
// radius-check chord of §4.1 and blend how far the terrain carve eases back to natural ground (§3).
export const ROAD_CLASSES = {
  hwy:     { lanes: 2, laneW: 3.6, median: 3.0, shoulder: 1.5, parking: 0, walk: 0, halfW: 10.2, speed: 26, grade: 0.06, minR: 100, bank: 5, ai: true, chord: 8, blend: 18 },
  blvd:    { lanes: 2, laneW: 3.3, median: 3.0, shoulder: 0, parking: 0, walk: 3.5, halfW: 8.1, speed: 16, grade: 0.06, minR: 60, bank: 0, ai: true, chord: 8, blend: 12 },
  ave:     { lanes: 1, laneW: 3.5, median: 0, shoulder: 0, parking: 2.4, walk: 3.0, halfW: 5.9, speed: 12, grade: 0.08, minR: 40, bank: 0, ai: true, chord: 8, blend: 12 },
  street:  { lanes: 1, laneW: 3.5, median: 0, shoulder: 0.5, parking: 0, walk: 2.5, halfW: 4.0, speed: 10, grade: 0.10, minR: 12, bank: 0, ai: true, chord: 3, blend: 8 },
  coast:   { lanes: 1, laneW: 3.6, median: 0, shoulder: 1.0, parking: 0, walk: 0, halfW: 4.6, speed: 16, grade: 0.08, minR: 40, bank: 3, ai: true, chord: 8, blend: 14 },
  country: { lanes: 1, laneW: 3.5, median: 0, shoulder: 0.5, parking: 0, walk: 0, halfW: 4.0, speed: 14, grade: 0.12, minR: 30, bank: 3, ai: true, chord: 8, blend: 14 },
  switch:  { lanes: 1, laneW: 3.4, median: 0, shoulder: 0.4, parking: 0, walk: 0, halfW: 3.8, speed: 8, grade: 0.14, minR: 12, bank: 0, ai: true, chord: 3, blend: 10 },
  ring:    { lanes: 1, laneW: 5.0, median: 0, shoulder: 0.5, parking: 0, walk: 3.0, halfW: 3.0, speed: 7, grade: 0.04, minR: 12, bank: 0, ai: true, chord: 3, blend: 8, oneway: true },
  dirt:    { lanes: 1, laneW: 3.5, single: true, width: 7, median: 0, shoulder: 0, parking: 0, walk: 0, halfW: 3.5, speed: 8, grade: 0.18, minR: 12, bank: 0, ai: false, chord: 3, blend: 6 },
  alley:   { lanes: 1, laneW: 3.0, single: true, width: 6, median: 0, shoulder: 0, parking: 0, walk: 0, halfW: 3.0, speed: 5, grade: 0.10, minR: 8, bank: 0, ai: false, chord: 3, blend: 6 },
};

// ---------- coast and water (§3) ----------
// Land shapes; anything outside them (and outside the rasters) is sea. Each entry is a list of shapes:
// {poly:[[x,z],...]}, {circle:[x,z], r}, {ellipse:[x,z], rx, rz} or {rect:[x0,z0,x1,z1]}.
export const COAST = {
  mainland: [{ poly: [[56, 600], [52, 700], [48, 800], [40, 900], [36, 1000], [40, 1100], [55, 1180], [85, 1260], [125, 1320],
    [170, 1380], [205, 1445], [228, 1500], [245, 1550], [290, 1588], [380, 1612], [500, 1625], [650, 1630], [800, 1628],
    [900, 1622], [1000, 1608], [1058, 1570], [1080, 1510], [1092, 1450], [1100, 1400], [1112, 1360], [1135, 1335], [1165, 1318],
    [1195, 1295], [1225, 1272], [1250, 1244], [1268, 1210], [1290, 1178], [1302, 1150], [1300, 1122], [1272, 1110], [1268, 1060],
    [1265, 960], [1268, 860], [1266, 760], [1265, 668], [1300, 650], [1318, 610], [1300, 575], [1262, 560], [1262, 480],
    [1266, 400], [1260, 320], [1232, 240], [1180, 160], [1100, 100], [1000, 62], [900, 45], [800, 48], [720, 58], [640, 62],
    [590, 92], [560, 110], [530, 95], [470, 60], [380, 42], [260, 48], [150, 90], [80, 180], [50, 300], [42, 420], [60, 520]] }],
  island: [{ poly: [[1638, 322], [1660, 255], [1720, 198], [1800, 192], [1862, 225], [1886, 320], [1890, 520], [1892, 720],
    [1890, 920], [1886, 1060], [1872, 1160], [1840, 1232], [1785, 1268], [1715, 1272], [1680, 1250], [1652, 1232], [1648, 1190],
    [1630, 1172], [1600, 1152], [1578, 1138], [1580, 1112], [1608, 1098], [1636, 1072], [1652, 1040], [1650, 1000], [1650, 880],
    [1650, 700], [1650, 560], [1648, 470], [1645, 420], [1630, 375]] }],
  key: [{ poly: [[1350, 1370], [1420, 1345], [1520, 1338], [1620, 1350], [1690, 1385], [1730, 1440], [1738, 1505], [1718, 1565],
    [1655, 1590], [1540, 1597], [1430, 1588], [1365, 1552], [1342, 1480]] }],
  islets: [{ circle: [1340, 703], r: 30 }, { circle: [1440, 701], r: 32 }, { circle: [1540, 700], r: 30 }],
  // Star Island, and the land neck (x 1425-1455) that joins it to the MacArthur fill
  star: [{ ellipse: [1440, 1050], rx: 85, rz: 52 }, { rect: [1425, 1095, 1455, 1112] }],
  macarthur_fill: [{ poly: [[1340, 1112], [1530, 1106], [1530, 1155], [1340, 1162]] }],
};

// Shore profile per stretch of coast, as runs from one polygon vertex to another in the polygon's own
// point order. Every edge not listed here (the bay shores, the island's west shore, the islets, Star
// Island and the fill) is a seawall. The spec names the cliff, beach and seawall stretches; the mainland's
// north coast east of the cliffs is not named there, so the Lookout Knoll face (to (1000,62)) stays a
// cliff and the low shore east of it is a beach.
export const COAST_KINDS = [
  { coast: 'mainland', from: [1000, 62], to: [60, 520], kind: 'cliff' },       // Coral Heights and the knoll
  { coast: 'mainland', from: [60, 520], to: [1058, 1570], kind: 'beach' },     // west coast z 520-1380 and the south coast
  { coast: 'mainland', from: [1260, 320], to: [1000, 62], kind: 'beach' },     // North Shore, east of the knoll
  { coast: 'island', from: [1660, 255], to: [1785, 1268], kind: 'beach', dune: 2 },   // the Atlantic side, with a dune ridge
  { coast: 'key', kind: 'beach' },                                              // all the way round
];
// Profiles: a cliff drops to cliffY within cliffW; a beach falls to beachY at the waterline over beachW
// (sand); the island's dune is a ridge duneIn metres inland. The sea floor runs through SEA_FLOOR points
// [distance from the shore, depth] and stays at the last depth beyond them.
export const SHORE = { cliffY: -6, cliffW: 6, beachY: -0.8, beachW: 35, duneIn: 15, duneW: 10 };
export const SEA_FLOOR = [[0, -1.5], [120, -8], [300, -20]];

// Inland water: Gator Lagoon is deep (blocks cars), the Glades ponds are shallow and drivable with splash.
// level is the water surface, bed the floor inside the shape.
export const WATER = [
  { id: 'gator_lagoon', name: 'Gator Lagoon', surf: 'WATER', level: 0.2, bed: -3,
    shapes: [{ ellipse: [395, 1140], rx: 45, rz: 35 }, { line: [[430, 1160], [455, 1172]], w: 10 }] },   // + channel to the airboat dock
  { id: 'pond_gator', surf: 'SHALLOW', level: 0.4, bed: 0.1, shapes: [{ circle: [300, 1060], r: 30 }] },
  { id: 'pond_levee', surf: 'SHALLOW', level: 0.4, bed: 0.1, shapes: [{ circle: [520, 1120], r: 28 }] },
  { id: 'pond_west', surf: 'SHALLOW', level: 0.4, bed: 0.1, shapes: [{ circle: [150, 900], r: 26 }] },
];

// ---------- terrain (§3) ----------
// Heights above LAND_BASE, combined by max. A dome is h·(1−r'²)^p with r' the elliptical distance (radius
// r, or per side w/e/n/s); a ridge is a polyline of [x,z,h] giving h·(1−(d/hw)²) with h interpolated
// along it. An override replaces the ground inside rect with the plane y + gz·(z − z0) (absolute metres),
// easing in over the first blend metres inside the rectangle. A cap (after the overrides) only lowers: along
// an axis from `from` heading a, the ground is held under profile [[u, y], ...] (u metres along the axis, y
// absolute), across w0 + u·tan(half) each side, easing out over blend + u·tan(spread) more (terrain.js).
export const TERRAIN = [
  { id: 'coral_heights', kind: 'dome', c: [330, 260], h: 57, r: { w: 270, e: 420, n: 215, s: 330 }, p: 0.85 },
  // the rock cutting at the pass: the Loop is at 26 m against 32-34 m natural ground
  { id: 'heights_spine', kind: 'ridge', pts: [[420, 285, 52], [790, 305, 32], [878, 178, 36]], hw: 120 },
  { id: 'lookout_knoll', kind: 'dome', c: [878, 178], h: 35, r: 165, p: 0.9 },
  { id: 'north_shore', kind: 'ridge', pts: [[950, 190, 30], [1150, 330, 6]], hw: 120 },
  // Skyline Drive rides this, which is why K-Town sits at its foot
  { id: 'east_shoulder', kind: 'ridge', pts: [[800, 318, 29], [1000, 366, 16], [1240, 374, 4]], hw: 150 },
  { id: 'cape_bluff', kind: 'dome', c: [1680, 1500], h: 11, r: 90, p: 1 },
  // the switchbacks sit on this plane
  { id: 'heights_south_face', kind: 'override', rect: [250, 300, 490, 610], y: 58, gz: -0.155, z0: 300, blend: 25 },
  // The villa terrace's vista (§4.7 SL3, lead decision): the summit is broad and the south-face plane falls
  // along the line to K-Town at the same 4.5° as a 1.5 m eye's line of sight, so the hill hid K-Town. Down that
  // line from the villa foot spawn (bearing 0.505 to Seoul Circle) the lawn now banks off the terrace edge
  // (u 12 m, where the villa's pad ends in front of the pool) and the hillside runs 8% down, 2.2 m under the
  // sight line, until it meets the natural ground at the dome's foot. The Heights Gate junction on that line
  // drops from 56 to 53.5 m with it (switchbacks, heights_dr and villa_dr pins).
  { id: 'villa_vista', kind: 'cap', from: [333.7, 263.6], a: 0.505, profile: [[12, 58], [20, 55.9], [260, 36.7]],
    w0: 16, half: 0.08, blend: 10, spread: 0.1, endBlend: 30 },
];

// Districts eased toward a flat height y (a region's polygon, or a coast shape), over blend metres inside it.
export const FLATTEN = [
  { id: 'ktown', region: 'ktown', y: 2.0, blend: 40 },
  { id: 'downtown', region: 'downtown', y: 2.0, blend: 40 },
  { id: 'port', region: 'port', y: 1.8, blend: 30 },
  { id: 'gables', region: 'gables', y: 1.5, blend: 40 },
  { id: 'island', coast: 'island', y: 1.5, blend: 20 },
  { id: 'glades', region: 'glades', y: 0.4, blend: 40 },
  { id: 'fest_airport', region: 'fest_airport', y: 1.2, blend: 40 },
];

// ---------- regions (§2) ----------
// The index is the REG raster code. Polygons tile the world without overlaps (the spec's bounds are
// approximate and overlap; where they did, the district named first in a pair keeps the strip:
// Heights over the Glades at z 560-600, K-Town over the Gables at z 600-760) and are clipped to land
// when rasterised. The island splits at z 840. traffic and peds are the population densities; floors
// and maxH are the building limits the lots use.
export const REGIONS = [
  { id: 'heights', name: 'Coral Heights', style: 'mansion', traffic: 0.15, peds: 0.1,
    pts: [[0, 0], [710, 0], [710, 380], [720, 380], [720, 600], [0, 600]] },
  { id: 'north_shore', name: 'North Shore', style: 'estate', traffic: 0.2, peds: 0.1, maxH: 12,
    pts: [[710, 0], [1330, 0], [1330, 380], [710, 380]] },
  { id: 'ktown', name: 'Koreatown', style: 'ktown', traffic: 0.9, peds: 1.0, floors: [3, 6], maxH: 18,
    pts: [[720, 380], [1000, 380], [1000, 760], [720, 760]] },
  // the north row between the Loop and 14th St (z 470) stays low-rise
  { id: 'downtown', name: 'Downtown', style: 'tower', traffic: 1.0, peds: 0.8, floors: [12, 45], lowRise: { z1: 470, floors: [3, 5] },
    pts: [[1000, 380], [1330, 380], [1330, 672], [1300, 672], [1300, 962], [1000, 962]] },
  { id: 'gables', name: 'The Gables', style: 'house', traffic: 0.4, peds: 0.3,
    pts: [[560, 600], [720, 600], [720, 760], [1000, 760], [1000, 1290], [560, 1290]] },
  { id: 'glades', name: 'The Glades', style: 'shack', traffic: 0.2, peds: 0.05,
    pts: [[0, 600], [560, 600], [560, 1290], [0, 1290]] },
  { id: 'fest_airport', name: 'Kimchi Fest & Kimchi Air', style: 'hangar', traffic: 0.3, peds: 0.6,
    pts: [[0, 1290], [1330, 1290], [1330, 1792], [0, 1792]] },
  { id: 'port', name: 'Port', style: 'warehouse', traffic: 0.5, peds: 0.1,
    pts: [[1000, 962], [1320, 962], [1320, 1290], [1000, 1290]] },
  { id: 'collins', name: 'Deco Beach North', style: 'resort', traffic: 0.7, peds: 0.7, floors: [8, 18],
    pts: [[1610, 0], [2048, 0], [2048, 840], [1610, 840]] },
  // Ocean Drive's hotels run taller than the rest of South Beach
  { id: 'deco', name: 'Deco Beach', style: 'deco', traffic: 0.8, peds: 1.0, floors: [2, 4], oceanDrive: { floors: [3, 6] },
    pts: [[1610, 840], [2048, 840], [2048, 1300], [1570, 1300], [1570, 1090], [1610, 1090]] },
  { id: 'islets', name: 'Venetian Islets & Star Island', style: 'mansion', traffic: 0.1, peds: 0.1,
    pts: [[1330, 0], [1610, 0], [1610, 1090], [1570, 1090], [1570, 1290], [1320, 1290], [1320, 962], [1300, 962],
      [1300, 672], [1330, 672]] },
  // runs up to z 1290 west of x 1570, so the strip of bay between the islets and the key (x 1330-1570,
  // z 1290-1300) belongs to a region too
  { id: 'cape', name: 'Cape Kimchi', style: 'none', traffic: 0.3, peds: 0.2,
    pts: [[1330, 1290], [1570, 1290], [1570, 1300], [2048, 1300], [2048, 1792], [1330, 1792]] },
];

// Building height caps along the views the drive is built around.
export const VIEW_CORRIDORS = [{ id: 'pass_reveal', pts: [[790, 296], [1265, 322], [1265, 346], [790, 336]], maxH: 12 }];

// What the §4.7 sightlines look at: a point (m), the target's height h (the ray aims at its mid-height above
// the ground there) or an absolute height y, and r, how far short of the point the ray stops (the target's own
// footprint). lots.js keeps every lot under these rays and tools/map_check.mjs tests them, both from this table.
//  kimchi_tower  r 23: past the corners of its 32 m square, since the tower is a building in OCC
//  island        the resort towers mid-island, north of the line to Kimchi Tower (from the villa that line
//                runs at −12°; this one at −15.5° passes 53 m clear of the tower, over the low-rise north row)
//  ktown         Seoul Circle and K-Town's 18 m cap
//  bay           the open bay north of Bayfront Park, 1 m over the water: the villa terrace's view over the
//                bay (F3), past Heights Drive's mansions and Downtown's low-rise north row
export const SIGHT_TARGETS = {
  kimchi_tower: { x: 1175, z: 515, h: 140, r: 23 },
  causeway_pylon: { x: 1440, z: 318, h: 62, r: 3 },
  deco_north: { x: 1790, z: 500, h: 60, r: 10 },        // the curved resort (deco_resort) leads Collins' skyline
  ktown: { x: 870, z: 560, h: 18, r: 0 },
  island: { x: 1770, z: 600, h: 40, r: 0 },
  bay: { x: 1420, z: 460, y: 0, r: 0 },
  lighthouse: { x: 1712, z: 1548, h: 30, r: 3 },
};

// ---------- roads (§4.3) ----------
// {id, name, cls, pts, closed?, oneway?, y?, minR?, ai?, speed?, ...flags}. pts are the centripetal
// Catmull-Rom control points (§4.1); y pins are [control index, height m], interpolated by control
// parameter, and stations outside the pins follow the terrain. Endpoints within 15 m of another road
// become T junctions; interior crossings become X junctions.
// south_pointe's fifth point is (1710,1230), not the spec's (1706,1230). The §4.3 table (199 m, R 24.9 m)
// was measured before its end moved from (1680,1205) to (1700,1215) by the marina; with the new end the
// last bend is R 10.4 m, under the street floor of 12. Moving that one point 4 m east keeps both ends
// and gives R 15.2 m (177 m long).
export const ROADS = [
  // travel order is clockwise; station 0 is the first point
  { id: 'loop', name: 'Kimchi Loop', cls: 'hwy', closed: true, travel: 'cw', y: [[0, 2], [4, 2], [12, 2], [13, 4.9],
        [14, 7.9], [15, 11.3], [16, 14.8], [17, 18.2], [18, 21.1], [19, 23.6], [20, 26], [21, 22.5], [22, 18.7], [23, 14.8],
        [24, 11], [25, 7.5], [26, 4.5], [27, 7.5], [28, 10.9], [29, 14], [30, 11.8], [31, 10.2], [32, 8.5], [33, 7.3],
        [34, 6], [35, 4.8], [36, 3.6], [37, 2.5], [38, 2], [50, 2], [52, 3], [54, 4], [55, 3], [56, 2.5], [57, 3], [58, 4],
        [59, 3.5], [60, 2.5], [61, 2], [69, 2]],
    pts: [[1075.8, 1300], [980, 1300], [900, 1300], [700, 1300], [520, 1298], [400, 1288], [318, 1258], [258, 1205],
          [225, 1130], [214, 1040], [213, 940], [218, 850], [238, 765], [280, 690], [345, 628], [430, 575], [515, 515],
          [590, 445], [650, 385], [710, 342], [780, 322], [855, 330], [935, 352], [1015, 374], [1095, 388], [1170, 388],
          [1235, 374], [1300, 352], [1370, 332], [1440, 318], [1480, 312], [1510, 310], [1540, 310], [1565.4, 312.5],
          [1589.7, 319.9], [1612.2, 331.9], [1631.9, 348.1], [1648.1, 367.8], [1660.1, 390.3], [1667.5, 414.6], [1670, 440],
          [1670, 470], [1670, 560], [1670, 700], [1670, 850], [1670, 970], [1670, 1000], [1667.5, 1025.4], [1660.1, 1049.7],
          [1648.1, 1072.2], [1631.9, 1091.9], [1612.2, 1108.1], [1589.7, 1120.1], [1565.4, 1127.5], [1540, 1130],
          [1510, 1130.5], [1440, 1134], [1365, 1137], [1335, 1138], [1308.3, 1140.6], [1282.6, 1148.2], [1258.8, 1160.6],
          [1237.7, 1177.3], [1220.3, 1197.7], [1205.4, 1219], [1190.5, 1240.3], [1173.1, 1260.7], [1152, 1277.4],
          [1128.2, 1289.8], [1102.5, 1297.4]] },
  // the Heights Gate junction (the first point of the switchbacks, Heights Drive and Villa Drive) sits on the
  // villa terrace's line of sight to K-Town, so it is 53.5 m (§4.3: 56) with the villa_vista cap
  { id: 'switchbacks', name: 'Coral Heights Switchbacks', cls: 'switch', y: [[0, 53.5], [4, 51], [10, 49], [14, 41.5],
        [20, 39.5], [24, 32], [30, 30], [34, 22.5], [40, 20.5], [45, 9.5]],
    pts: [[385, 292], [378, 312], [362, 326], [330, 333], [295, 334], [287, 336.1], [281.1, 342], [279, 350], [281.1, 358],
          [287, 363.9], [295, 366], [330, 370], [380, 378], [418, 382], [435, 382], [443, 384.1], [448.9, 390], [451, 398],
          [448.9, 406], [443, 411.9], [435, 414], [400, 418], [350, 426], [312, 431], [295, 431], [287, 433.1], [281.1, 439],
          [279, 447], [281.1, 455], [287, 460.9], [295, 463], [335, 467], [385, 474], [423, 479], [440, 479], [448, 481.1],
          [453.9, 487], [456, 495], [453.9, 503], [448, 508.9], [440, 511], [415, 512], [392, 520], [377, 540], [376, 565],
          [384, 590]] },
  { id: 'heights_dr', name: 'Heights Drive', cls: 'country', y: [[0, 53.5], [1, 52.6], [2, 47.7], [3, 41.7], [4, 36.1],
        [5, 30.6], [6, 25]],
    pts: [[385, 292], [420, 287], [470, 290], [530, 302], [585, 318], [640, 330], [697, 339]] },
  // Crest Road climbs from the Loop to the Lookout Knoll in one straight (§4.3 had an S-bend there: its second to
  // fifth points lie on the line from the first to the sixth now), so j_crest has a straight run-up and a
  // straight landing at 30-45 m/s. The knoll's top is a rounded crest (the pins between control 5.26 and 6.58,
  // 40 m of parabola, §4.3: one pin of 36 m at control 6) that a car at 45 m/s rides over without taking off.
  { id: 'crest_rd', name: 'Crest Road', cls: 'country', y: [[0, 25.5], [3, 30], [5.26, 34.42], [5.63, 35.07], [6, 35.43],
        [6.29, 35.51], [6.58, 35.3], [9, 32], [12, 18], [15, 7.5]],
    pts: [[806, 312], [818.2, 288], [828.4, 268], [840.6, 244], [852.8, 220], [865, 196], [882, 178], [915, 168], [952, 178],
          [985, 202], [1015, 232], [1052, 248], [1090, 262], [1120, 292], [1140, 332], [1150, 377]] },
  // ends at the garage court mouth. A private drive: it climbs 4.5 m from the lowered Heights Gate (53.5 m) to
  // the garage court (58 m) in 46 m, a little over the street grade, so it carries its own maxGrade
  { id: 'villa_dr', name: 'Villa Drive', cls: 'street', ai: false, private: true, y: [[0, 53.5], [1, 55.3], [2, 57.3], [3, 58]],
    maxGrade: 0.12, steep: true, pts: [[385, 292], [372, 280], [362, 262], [357, 256]] },
  // the K-Town gate spans it at z 400. Seoul Ave and the north end of Miami Ave are deliberate steep climbs
  // (up to 16%) from the flat districts to the Loop, which is pinned 15-22 m high on Skyline Drive just north
  // of them; maxGrade overrides the class grade for that road (steep: true marks it for the validator).
  { id: 'seoul_ave', name: 'Seoul Avenue', cls: 'ave', gate: [870, 400], maxGrade: 0.16, steep: true,
    pts: [[870, 346], [870, 470], [870, 518]] },
  // one-way, counter-clockwise on the map (the point order)
  { id: 'ring', name: 'Seoul Circle', cls: 'ring', closed: true, oneway: true,
    pts: [[912, 560], [908.8, 543.9], [899.7, 530.3], [886.1, 521.2], [870, 518], [853.9, 521.2], [840.3, 530.3],
          [831.2, 543.9], [828, 560], [831.2, 576.1], [840.3, 589.7], [853.9, 598.8], [870, 602], [886.1, 598.8],
          [899.7, 589.7], [908.8, 576.1]] },
  // the neon main street
  { id: 'han_ro', name: 'Han-ro', cls: 'street', alt: 'Flagler St', neon: true,
    pts: [[912, 560], [1000, 560], [1115, 560], [1232, 560]] },
  { id: 'myeong', name: 'Myeong-dong', cls: 'street', alt: 'Ponce',
    pts: [[870, 602], [870, 707.6], [871, 800], [873, 880], [875, 962]] },
  { id: 'granada', name: 'Itaewon-ro', cls: 'ave', alt: 'Granada Blvd',
    pts: [[828, 560], [750, 560], [718, 590], [698, 640], [684, 700], [677, 770], [676, 860], [684, 960], [712, 1050],
          [742, 1140], [735, 1220], [705, 1290]] },
  { id: 'nw_crescent', name: 'NW Crescent', cls: 'street',
    pts: [[780, 560], [786.9, 525.6], [806.4, 496.4], [835.6, 476.9], [870, 470]] },
  { id: 'se_crescent', name: 'SE Crescent', cls: 'street',
    pts: [[1000, 630], [974.4, 664.4], [943.8, 687.8], [908.2, 702.6], [870, 707.6]] },
  { id: 'neon_alley', name: 'Hongdae Neon Alley', cls: 'alley',
    pts: [[840.3, 530.3], [823.4, 513.4], [806.4, 496.4]] },
  { id: 'miami_ave', name: 'Miami Avenue', cls: 'ave', maxGrade: 0.16, steep: true,
    pts: [[1000, 382], [1000, 470], [1000, 560], [1000, 630], [1000, 710], [1000, 820], [1000, 962], [1000, 1052],
          [1002, 1180], [1005, 1288]] },
  { id: 'st14', name: '14th St', cls: 'street',
    pts: [[870, 470], [1000, 470], [1115, 470], [1228, 470]] },
  { id: 'st6', name: 'NE 6th St', cls: 'street',
    pts: [[1000, 710], [1115, 710], [1239, 710]] },
  { id: 'st1', name: 'SE 1st St', cls: 'street',
    pts: [[1000, 820], [1115, 820], [1240, 820]] },
  { id: 'ne2nd', name: 'NE 2nd Ave', cls: 'street',
    pts: [[1115, 470], [1115, 560], [1115, 710], [1115, 820], [1115, 962]] },
  { id: 'biscayne', name: 'Biscayne Blvd', cls: 'blvd',
    pts: [[1225, 389], [1228, 470], [1232, 560], [1239, 710], [1240, 820], [1236, 900], [1230, 962]] },
  // banyans over x 600-1000
  { id: 'coral_way', name: 'Coral Way', cls: 'ave', banyans: [600, 1000],
    pts: [[226, 975], [300, 970], [420, 966], [508, 963], [600, 962], [684, 960], [780, 961], [875, 962], [1000, 962],
          [1115, 962], [1230, 962]] },
  { id: 'alhambra', name: 'Alhambra Circle', cls: 'street',
    pts: [[678, 810], [725, 822], [772, 850], [800, 898], [795, 940], [782, 962]] },
  { id: 'sevilla', name: 'Sevilla Ave', cls: 'street',
    pts: [[712, 1050], [850, 1052], [1000, 1052]] },
  // 3 m promenade on the north side
  { id: 'venetian', name: 'Venetian Causeway', cls: 'coast', promenade: { side: 'N', w: 3 },
    pts: [[1239, 710], [1300, 706], [1340, 703], [1400, 702], [1440, 701], [1500, 700], [1540, 700], [1600, 700],
          [1659, 700]] },
  { id: 'st71', name: '71st St', cls: 'street',
    pts: [[1677, 420], [1745, 420], [1815, 421]] },
  // Ocean Drive south of z 840; parking on the west side, Lummus Park and the Beachwalk east
  { id: 'collins_ocean', name: 'Collins Ave', cls: 'ave', alt: 'Ocean Drive', altFromZ: 840, speed: 9, parking: 'W', park: 'E',
    pts: [[1815, 320], [1815, 421], [1814, 560], [1813, 700], [1813, 840], [1812, 960], [1811, 1085], [1810, 1150]] },
  // palm median
  { id: 'deco_ave', name: 'Deco Avenue', cls: 'blvd', palms: true,
    pts: [[1745, 420], [1745, 560], [1745, 700], [1745, 840], [1745, 960], [1745, 1085], [1745, 1238]] },
  { id: 'st41', name: '41st St', cls: 'street',
    pts: [[1681, 560], [1745, 560], [1814, 560]] },
  { id: 'lincoln', name: 'Lincoln Road', cls: 'street', alt: 'Boutique Row', planters: true, slow: true,
    pts: [[1680, 840], [1745, 840], [1813, 840]] },
  { id: 'st15', name: '15th St', cls: 'street',
    pts: [[1682, 960], [1745, 960], [1812, 960]] },
  { id: 'st5', name: '5th St', cls: 'street',
    pts: [[1652, 1087], [1745, 1085], [1811, 1085]] },
  { id: 'south_pointe', name: 'South Pointe Drive', cls: 'street',
    pts: [[1810, 1150], [1798, 1205], [1765, 1236], [1745, 1238], [1710, 1230], [1700, 1215]] },
  { id: 'star_spur', name: 'Star Island Spur', cls: 'street',
    pts: [[1440, 1122], [1440, 1090]] },
  { id: 'star_ring', name: 'Star Island Drive', cls: 'street', closed: true,
    pts: [[1440, 1090], [1482.4, 1078.3], [1500, 1050], [1482.4, 1021.7], [1440, 1010], [1397.6, 1021.7], [1380, 1050],
          [1397.6, 1078.3]] },
  { id: 'port_blvd', name: 'Port Boulevard', cls: 'ave',
    pts: [[1115, 962], [1112, 1040], [1110, 1095]] },
  // the drift loop
  { id: 'port_yard', name: 'Port Yard', cls: 'street', closed: true,
    pts: [[1075, 1115], [1110, 1095], [1160, 1093], [1193, 1113], [1190, 1145], [1150, 1160], [1100, 1156], [1076, 1140]] },
  { id: 'rickenbacker', name: 'Rickenbacker Causeway', cls: 'coast', y: [[0, 2], [2, 8], [4, 2]],
    pts: [[1215, 1226], [1250, 1260], [1290, 1300], [1330, 1340], [1368, 1385]] },
  { id: 'key_loop', name: 'A1A Key Loop', cls: 'coast', closed: true, minR: 30,
    pts: [[1380, 1395], [1440, 1373], [1520, 1366], [1600, 1374], [1660, 1400], [1695, 1440], [1708, 1490], [1690, 1530],
          [1650, 1548], [1580, 1556], [1500, 1553], [1430, 1540], [1390, 1508], [1370, 1460]] },
  { id: 'festival_way', name: 'Festival Way', cls: 'blvd',
    pts: [[820, 1313], [820, 1340], [820, 1365]] },
  // the Fest drift zone
  { id: 'fest_ring', name: 'Fest Ring', cls: 'street', closed: true,
    pts: [[700, 1365], [820, 1365], [940, 1365], [962, 1400], [940, 1460], [820, 1462], [700, 1460], [680, 1415]] },
  { id: 'airport_rd', name: 'Airport Road', cls: 'ave',
    pts: [[962, 1400], [1000, 1405], [1040, 1410]] },
  { id: 'airport_perim', name: 'Airport Perimeter', cls: 'street',
    pts: [[680, 1415], [600, 1440], [480, 1462], [360, 1475], [270, 1490]] },
  { id: 'a1a', name: 'A1A Sunset Drive', cls: 'coast',
    pts: [[226.8, 760.7], [175, 770], [120, 795], [85, 845], [68, 930], [66, 1020], [75, 1100], [100, 1165], [150, 1205],
          [205, 1218], [248.3, 1212.1]] },
  { id: 'gator_run', name: 'Gator Run', cls: 'dirt',
    pts: [[300, 968], [300, 905], [322, 845], [380, 800], [450, 795], [500, 840], [512, 905], [508, 962]] },
  { id: 'airboat_rd', name: 'Airboat Road', cls: 'dirt',
    pts: [[420, 966], [425, 1040], [440, 1110], [462, 1170]] },
];

// Junctions that may get traffic lights (enabled in S6a only if the traffic soak passes). Every other
// junction is priority/yield (the Loop, the ring and Deco Ave have priority) or an all-way reservation.
export const SIGNALS = {
  enabled: true,     // switched on after F4's signal soaks passed (lead decision, spec §12.1)
  priority: ['loop', 'ring', 'deco_ave'],
  candidates: [[870, 470], [1000, 560], [1115, 560], [1115, 710], [1115, 820], [1000, 962], [1115, 962], [1239, 710],
    [684, 960], [1745, 560], [1745, 840], [1745, 960], [1745, 1085]],
};

// ---------- paths (§4.6): people only, no AI ----------
// surf is the kind they are stamped with ('auto' = PLAZA on land, DECK over water); cars: false adds
// BLOCK_CAR. The spec gives the marina pier's width (5 m); the other widths are this file's choice.
export const PATHS = [
  { id: 'beachwalk', name: 'Beachwalk', kind: 'promenade', surf: 'PLAZA', w: 4, cars: true, pts: [[1848, 300], [1848, 1150]] },
  // along the bay at x 1270, swinging out to x 1300 round Bayfront Park
  { id: 'riverwalk', name: 'Bayfront Riverwalk', kind: 'promenade', surf: 'auto', w: 4, cars: true,
    pts: [[1270, 400], [1270, 560], [1292, 578], [1300, 612], [1292, 646], [1270, 668], [1270, 950]] },
  { id: 'venetian_promenade', name: 'Venetian Promenade', kind: 'promenade', road: 'venetian', side: 'N', w: 3, cars: true },
  { id: 'glades_boardwalk', name: 'Glades Boardwalk', kind: 'boardwalk', surf: 'DECK', w: 3, cars: false, bollards: 'both',
    pts: [[380, 800], [362, 742]] },
  { id: 'cove_stairs', name: 'Cove Stairs', kind: 'stairs', surf: 'PLAZA', w: 3, cars: false, bollards: 'top', pts: [[530, 302], [560, 118]] },
  { id: 'knoll_path', name: 'Lookout Path', kind: 'path', surf: 'PLAZA', w: 2.5, cars: true, pts: [[882, 178], [918, 252]] },
  { id: 'marina_pier', name: 'Marina Pier', kind: 'pier', surf: 'DECK', w: 5, cars: false, blockAt: 'root', pts: [[1650, 1205], [1602, 1205]] },
];

// ---------- bridges (§4.5) ----------
// Spans are found by the generator: road stations whose natural ground is below SEA_LEVEL + 0.3, plus
// 6 m abutments. This table says how each one is built; deck is the deck height where the road has no
// y pins (the Loop's causeways are pinned).
export const BRIDGE_RULE = { below: 0.3, abutment: 6 };
export const BRIDGES = [
  { id: 'north_causeway', road: 'loop', style: 'cable', at: [1440, 318], pylon: { x: 1440, z: 318, h: 62, stays: 8 }, piers: 30, barrier: 'jersey' },
  { id: 'macarthur_east', road: 'loop', style: 'viaduct', at: [1555, 1129], deck: 4 },
  { id: 'macarthur_west', road: 'loop', style: 'viaduct', at: [1320, 1139], deck: 4 },
  { id: 'venetian', road: 'venetian', style: 'bascule', deck: 3.5, houses: 'mid-span' },
  { id: 'rickenbacker', road: 'rickenbacker', style: 'arch', crest: 8, arch: { x: 1290, z: 1300, span: 60 } },
  { id: 'marina_pier', path: 'marina_pier', style: 'pier' },
];

// ---------- places (§5.1) ----------
// Each place is a prefab (today's world.js layout moved into a local frame, §1) placed by its front
// centre F (local (20,40)) and facing a. door, foot, curb, giver, the garage, display and police spots,
// the plane and the pier are computed from the prefab by world-v2. hangout is authored where a friend
// lives there (each within 14 m of an AI lane).
export const PLACES = {
  home: { key: 'home', name: "Kimchi's Villa", icon: '🏠', color: '#d4af37', prefab: 'villa', F: [350, 268], a: 0.5 },
  park: { key: 'park', name: 'Park', icon: '🌳', color: '#5a9a45', prefab: 'park_circle', F: [870, 560], a: PI / 2, centre: true,
    nomenu: true, hangout: [891.2, 581.2] },
  mart: { key: 'mart', name: 'K-Mart', icon: '🛒', color: '#3d9a6a', prefab: 'mart', F: [956, 553.5], a: PI / 2, hangout: [949, 546.9] },
  kimchi: { key: 'kimchi', name: 'Kimchi House', icon: '🌶️', color: '#e8622c', prefab: 'kimchi', F: [876.5, 655], a: PI },
  yuna: { key: 'yuna', name: "Yuna's House", icon: '💜', color: '#9b7be0', prefab: 'yuna', F: [804, 881], a: 2.62, hangout: [807, 877] },
  dealer: { key: 'dealer', name: 'Kimchi Motors', icon: '🏎️', color: '#b89350', prefab: 'dealer', F: [880, 1371.5], a: -PI / 2,
    autoshow: true, hangout: [895, 1382.1] },
  police: { key: 'police', name: 'Police Station', icon: '🚓', color: '#2f6fd6', prefab: 'police', F: [1058, 716.5], a: -PI / 2 },
  hospital: { key: 'hospital', name: 'Hospital', icon: '🏥', color: '#e85d5d', prefab: 'hospital', F: [1227.4, 890], a: 0 },
  spray: { key: 'spray', name: 'K-Spray', icon: '🎨', color: '#a06be0', prefab: 'spray', F: [1104, 1030], a: 0, drive: true },
  guns: { key: 'guns', name: 'K-Arms', icon: '🔫', color: '#8c8f93', prefab: 'guns', F: [1122, 1030], a: PI },
  watches: { key: 'watches', name: 'Chrono Row', icon: '⌚', color: '#d4af37', prefab: 'watches', F: [1711, 833.5], a: PI / 2 },
  fashion: { key: 'fashion', name: 'Maison K', icon: '👜', color: '#c9a96e', prefab: 'fashion', F: [1711, 846.5], a: -PI / 2 },
  // the apron links south to the runway through a LOT taxiway [x0, z0, x1, z1]
  jet: { key: 'jet', name: 'Kimchi Air', icon: '✈️', color: '#e9e4d8', prefab: 'jet', F: [1040, 1455], a: PI / 2, taxi: [1000, 1455, 1060, 1505] },
  marina: { key: 'marina', name: 'Yacht Club', icon: '🛥️', color: '#5aa9ff', prefab: 'marina', F: [1650, 1205], a: PI, pierLen: 48 },
};

// ---------- photo spots (§5.2) ----------
// The ids are stable (saves keep them). look names a landmark that gives ×1.25 when it is in frame;
// time gives ×1.25 at that time of day.
export const PHOTO_SPOTS = [
  { id: 'villa', name: 'Villa Infinity Pool', x: 342.7, z: 270.9, bonus: 1.2 },
  { id: 'motors', name: 'Kimchi Motors', x: 866.4, z: 1401.5, bonus: 1.0 },
  { id: 'park', name: 'Fountain Park', x: 882, z: 572, bonus: 0.8 },
  { id: 'boutiques', name: 'Boutique Row', x: 1728, z: 836, bonus: 1.0 },
  { id: 'jet', name: 'Private Jet', x: 1042.4, z: 1448.6, bonus: 1.5 },
  { id: 'marina', name: 'Marina Sunset', x: 1652.8, z: 1203, bonus: 1.4, time: 'golden' },
  { id: 'ocean', name: 'Ocean Drive', x: 1838, z: 1000, bonus: 1.3, time: 'golden' },
  { id: 'skyline', name: 'Lookout Knoll', x: 888, z: 186, bonus: 1.4, look: 'kimchi_tower' },
  { id: 'kimchi_sign', name: 'KIMCHI Letters', x: 918, z: 252, bonus: 1.3, time: 'night' },
  { id: 'causeway', name: 'North Causeway', x: 1440, z: 331, bonus: 1.3, look: 'causeway_pylon', deck: true },   // on the deck shoulder
  { id: 'lighthouse', name: 'Cape Kimchi Lighthouse', x: 1690, z: 1556, bonus: 1.5, time: 'night' },
  { id: 'neon', name: 'Neon Alley', x: 823, z: 513, bonus: 1.2, time: 'night' },
  { id: 'glades', name: 'Glades Tower', x: 362, z: 742, bonus: 1.0 },
  { id: 'jetblast', name: 'Jet Blast Beach', x: 262, z: 1528, bonus: 1.4 },
  { id: 'fest', name: 'Kimchi Fest', x: 800, z: 1424, bonus: 1.1 },
];

// ---------- kimchi jars (§5.3) ----------
// The index is the jar id (0..24, kept from the grid). The generator nudges each one up to 8 m onto a
// walkable cell that is not a highway.
export const JARS = [
  [560, 118], [930, 210], [266, 447], [365, 742], [345, 832], [470, 1185], [255, 1530], [790, 1446], [1015, 1528], [1030, 1452],
  [1180, 1060], [1700, 1536], [1540, 1586], [1440, 688], [1440, 1022], [1305, 610], [1150, 505], [1262, 396], [823, 513], [856, 546],
  [760, 842], [1840, 262], [1852, 700], [1607, 1205], [50, 985],
].map(([x, z], id) => ({ id, x, z, ...(id === 23 ? { pier: true } : {}) }));

// ---------- mission anchors (§5.4) ----------
export const ANCHORS = {
  // a LOT yard [x0, z0, x1, z1] by the airboat dock
  bandanaYard: { x: 480, z: 1150, a: PI, r: 25, yard: [465, 1130, 515, 1175], say: 'the airboat yard in the Glades' },
  // the Star Island motor court, joined to the spur by a LOT strip
  stolenCarLot: { x: 1440, z: 1050, a: PI / 2, strip: [[1440, 1050], [1440, 1086]] },
  // the westbound inner lane of the Runway Straight
  raceStart: { x: 960, z: 1296.7, a: PI },
};

// ---------- race routes (§5.5) ----------
// Resolved onto the RoadNet at load. A leg follows one road from one point to another (lap: the whole of
// a closed road) or is a straight line; gates sit every gateEvery metres (or at the leg ends), face along
// the tangent, are the road's width + gateExtra wide and count when the car's path crosses them.
export const ROUTES = [
  { id: 'bay_loop', name: 'Street Kings', start: 'raceStart', laps: 1, gateEvery: 200, gateExtra: 4, legs: [{ road: 'loop', lap: true }] },
  { id: 'hillclimb', name: 'Heights Hillclimb', start: { road: 'loop', s: 1525 }, laps: 1, gateEvery: 200, gateExtra: 4,
    legs: [{ road: 'switchbacks', from: [384, 590], to: [385, 292] }] },
  { id: 'deco_sprint', name: 'Deco Sprint', laps: 1, gateEvery: 200, gateExtra: 4,
    legs: [{ road: 'collins_ocean', from: [1815, 330], to: [1810, 1150] }, { road: 'south_pointe', from: [1810, 1150], to: [1700, 1215] }] },
  { id: 'glades_scramble', name: 'Glades Scramble', laps: 2, gateEvery: 200, gateExtra: 4,
    legs: [{ road: 'gator_run', from: [300, 968], to: [508, 962] }, { road: 'coral_way', from: [508, 963], to: [300, 970] }] },
  { id: 'runway_drag', name: 'Runway Drag', laps: 1, gateEvery: 200, gateExtra: 4, legs: [{ line: [[320, 1528], [1000, 1528]] }] },
  { id: 'key_coastal', name: 'Key Coastal', start: { road: 'loop', s: 4123 }, laps: 1, gateEvery: 200, gateExtra: 4,
    legs: [{ road: 'rickenbacker', from: [1215, 1226], to: [1368, 1385] }, { road: 'key_loop', lap: true },
      { road: 'rickenbacker', from: [1368, 1385], to: [1215, 1226] }] },
];

// ---------- activities (§5.6) ----------
// Zones on a road run from one point to another along it (or the whole road, or Loop stations s0..s1).
// Jumps are 1.2 m wedges with a 10 m run and a sharp drop, built into the ground: the lip is at (x,z)
// and the car takes off heading along the road's point order there.
export const ACTIVITIES = {
  speedTraps: [{ id: 'st_runway', x: 876, z: 1300 }, { id: 'st_deco', x: 1745, z: 640 }, { id: 'st_coral', x: 560, z: 962 }],
  speedZones: [
    { id: 'sz_causeway', road: 'loop', s0: 2506, s1: 2893 },
    { id: 'sz_rick', road: 'rickenbacker' },
    { id: 'sz_key', road: 'key_loop', from: [1650, 1548], to: [1430, 1540] },
  ],
  driftZones: [
    { id: 'dz_switch', road: 'switchbacks' },
    { id: 'dz_yard', road: 'port_yard' },
    { id: 'dz_fest', road: 'fest_ring' },
    { id: 'dz_light', road: 'key_loop', from: [1660, 1400], to: [1650, 1548] },
  ],
  jumps: [
    // heading up Crest Road's straight (NNE), 72 m past its first point: it lands before the knoll's top bend
    // even at 45 m/s (§5.6 had (858,220), where a fast flight ran out over the crest and the bend)
    { id: 'j_crest', x: 838.6, z: 247.8, road: 'crest_rd', h: 1.2, run: 10 },
    { id: 'j_gator', x: 322, z: 845, road: 'gator_run', h: 1.2, run: 10 },
    { id: 'j_levee', x: 430, z: 1075, road: 'airboat_rd', h: 1.2, run: 10 },
    { id: 'j_port', x: 1150, z: 1158, road: 'port_yard', h: 1.2, run: 10, container: true },   // a container ramp, heading west
  ],
  eventBoard: { x: 835, z: 1380 },
  // fast-travel hubs, unlocked on the first visit
  hubs: [
    { id: 'villa', name: 'Villa', place: 'home' },        // the villa foot spot
    { id: 'seoul_circle', name: 'Seoul Circle', x: 870, z: 505 },
    { id: 'fest', name: 'Kimchi Fest', x: 820, z: 1350 },
    { id: 'lincoln', name: 'Lincoln Rd', x: 1745, z: 830 },
    { id: 'kimchi_air', name: 'Kimchi Air', x: 1052, z: 1434.6 },
  ],
};

// ---------- landmarks (§5.7) ----------
// {id, kind, x, z, a, h} plus what the builders need. Beacon parts (crown, letters, pylon lights, beam)
// ignore fog.
export const LANDMARKS = [
  { id: 'kimchi_tower', kind: 'tower', x: 1175, z: 515, a: 0, h: 140, w: 32, d: 32, crown: 'led' },
  { id: 'kimchi_letters', kind: 'letters', x: 920, z: 232, a: 1.27, h: 18, w: 86, glow: 'night' },
  { id: 'causeway_pylon', kind: 'pylon', x: 1440, z: 318, a: 0, h: 62, stays: 8 },
  { id: 'lighthouse', kind: 'lighthouse', x: 1712, z: 1548, a: 0, h: 30, beamHz: 0.25 },
  { id: 'fest_arch', kind: 'arch', x: 820, z: 1340, a: PI / 2, h: 11, span: 22, road: 'festival_way' },
  { id: 'ferris_wheel', kind: 'wheel', x: 790, z: 1440, a: 0, h: 42, d: 40, hz: 0.02 },   // axle east-west
  { id: 'fest_stage', kind: 'stage', x: 720, z: 1415, a: 0, h: 12 },                       // facing east
  { id: 'port_crane_1', kind: 'crane', x: 1256, z: 995, a: 0, h: 45, color: 'pink' },
  { id: 'port_crane_2', kind: 'crane', x: 1256, z: 1040, a: 0, h: 45, color: 'pink' },
  { id: 'port_crane_3', kind: 'crane', x: 1256, z: 1085, a: 0, h: 45, color: 'pink' },
  { id: 'control_tower', kind: 'control_tower', x: 985, z: 1478, a: 0, h: 22 },
  { id: 'ktown_gate', kind: 'gate', x: 870, z: 400, a: PI / 2, h: 9, span: 18, road: 'seoul_ave' },
  { id: 'bayfront_fountain', kind: 'fountain', x: 1292, z: 612, a: 0, h: 4 },
  { id: 'glades_tower', kind: 'lookout', x: 362, z: 742, a: 0, h: 12 },
  { id: 'deco_resort', kind: 'resort', x: 1790, z: 500, a: 0, h: 60, curved: true },
  { id: 'rickenbacker_arch', kind: 'bridge_arch', x: 1290, z: 1300, a: PI / 4, h: 14, span: 60, road: 'rickenbacker' },
  { id: 'venetian_bascules', kind: 'bascule_houses', bridge: 'venetian', at: 'span centres' },
  { id: 'kimchi_one', kind: 'jet', place: 'jet' },                                         // sits on places.jet.plane
];

// ---------- views ----------
// Bench and screenshot views (§5.7): Kimchi (or his car, car: true) at (x,z) facing heading, and the camera
// looking along yaw.
export const BENCH_VIEWS = [
  { name: 'villa_terrace', x: 333.7, z: 263.6, heading: 0.5, yaw: 0.5, car: false },
  { name: 'pass_crest', x: 785, z: 322, heading: -0.05, yaw: -0.05, car: true },
  { name: 'ktown_circle', x: 870, z: 505, heading: PI / 2, yaw: PI / 2, car: false },
  { name: 'downtown_flagler', x: 1060, z: 560, heading: 0, yaw: 0, car: false },
  { name: 'causeway_hump', x: 1440, z: 318, heading: 0, yaw: 0, car: true },
  { name: 'ocean_drive', x: 1813, z: 950, heading: -PI / 2, yaw: -PI / 2, car: false },
  { name: 'fest', x: 820, z: 1350, heading: PI / 2, yaw: PI / 2, car: false },
  { name: 'glades', x: 300, z: 960, heading: -PI / 2, yaw: -PI / 2, car: false },
];

// The title camera: a period-second loop through these points [x, y, z] (y up), looking ahead by lead of
// the period.
export const TITLE_PATH = {
  period: 120, lead: 0.15,
  pts: [[1500, 60, 180], [1440, 40, 330], [1180, 90, 560], [880, 60, 560], [800, 70, 1380], [330, 50, 1000], [330, 90, 250], [880, 60, 180]],
};

// ---------- driving (§10) ----------
// v2 handling: a lateral-g cap (2.0 g, ×1.35 with the handbrake), slope, real airtime, sliding along wall
// normals and substeps of 8 px (0.5 m). The grip per surface is raster.GRIP[gripTable].
export const PHYS = { gripG: 2.0, slope: true, air: true, wall: 'normal', substepPx: 8, gripTable: 'v2' };
