// The classic city's streets as authored roads (docs/map-v2-spec.md §7), so the grid runs on the same
// RoadNet as the v2 map. Today's lattice is 7 x 7: road k runs along roadCenter(k) = k * 896 + 64 px,
// that is k * 56 + 4 metres, both east-west and north-south, from the first road to the last.
// Pure data: no imports, runs in node.

// The cross-section matches the tiles: a road is 2 tiles (8 m) wide with one 4 m lane each way, so the lane
// centres sit 2 m (32 px, today's laneOff) either side of the centre line, and the sidewalk tile beside it
// is 4 m wide. Traffic today cruises at 140-220 px/s (8.75-13.75 m/s); 12.5 m/s is the edge speed whose
// fastest driver (x1.1) matches today's fastest car.
export const LATTICE_STREET = { cls: 'street', lanes: 1, laneW: 4, median: 0, halfW: 4, walk: 4, speed: 12.5, ai: true };

const NAMES_EW = ['North Street', '2nd Street', '3rd Street', '4th Street', '5th Street', '6th Street', 'South Street'];
const NAMES_NS = ['West Avenue', '2nd Avenue', '3rd Avenue', '4th Avenue', '5th Avenue', '6th Avenue', 'Ocean Drive'];

// The 14 lattice roads in metres: 'ew0'..'ew6' run east along z = c(k), 'ns0'..'ns6' run south along
// x = c(k). Each has a control point at every crossing, so all 49 crossings are authored junctions.
// The four perimeter roads have no tiles beyond them, so they keep only their inland sidewalk. Sides are
// relative to the road's direction (south is down): eastbound ew0's right is south, ew6's left is north;
// southbound ns0's left is east, ns6's right is west.
export function latticeRoads({ T = 64, P = 14, BLOCKS = 6, pxPerM = 16 } = {}) {
  const c = k => (k * P * T + T) / pxPerM;
  const ks = Array.from({ length: BLOCKS + 1 }, (_, k) => k);
  // the override that drops a perimeter road's outer sidewalk (first road, last road, none in between)
  const noOuter = (k, first, last) => (k === 0 ? first : k === BLOCKS ? last : {});
  const roads = [];
  for (const k of ks) roads.push({ id: `ew${k}`, name: NAMES_EW[k] || `Street ${k}`, ...LATTICE_STREET,
    ...noOuter(k, { walkL: 0 }, { walkR: 0 }), pts: ks.map(j => [c(j), c(k)]) });
  for (const k of ks) roads.push({ id: `ns${k}`, name: NAMES_NS[k] || `Avenue ${k}`, ...LATTICE_STREET,
    ...noOuter(k, { walkR: 0 }, { walkL: 0 }), pts: ks.map(j => [c(k), c(j)]) });
  return roads;
}
