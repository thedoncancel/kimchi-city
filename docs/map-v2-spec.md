# Kimchi Key v2: final implementation spec

Lead architect's merge of three designs: forza-feel (base, 20.5 total judge points), engine-perf (20.2) and safe-migration (18.8). The base is forza-feel's county: the Kimchi Loop with T-junctions only, the Runway Straight, Heights Pass, a cable-stayed North Causeway, the Venetian islets, MacArthur with Star Island, the Rickenbacker to a lighthouse key, the Port, the Glades, the Gables, a Kimchi Fest hub and Deco Beach.

The map was re-authored at a smaller size to fix the judges' must-fix items. Every road below was sampled with the same centripetal Catmull-Rom (CR) rule the game will use (§4.1). Radii, grades, crossings, T-snaps, water spans and the reveal sightlines were checked by script. The current result is 0 problems, and every crossing is an intended junction.

## 0. Decisions that resolve the judges' must-fix lists

| Must-fix | Resolution |
|---|---|
| "i dont like how its a block" | K-Town becomes **Seoul Circle**: a one-way roundabout, 4 radials, 2 crescents and a neon alley. Downtown keeps a straight Brickell grid with varied blocks (90-160 m), a curving Biscayne Blvd and Kimchi Plaza. The island has an irregular cross-street rhythm and a curving Ocean Drive. Every building faces its street through a local frame. Ocean Drive hotels face east to the beach. |
| Reveal must be in the chase-camera frame (±47° HFOV) | The pass crest is re-routed. At the crest (Loop station 2016) Kimchi Tower sits at +28° and the cable-stayed pylon and Deco skyline at +1°/+12°. 80 m later they are at +17° and −3°. A validator test is added (§4.7). |
| Fog hides vistas | The live HIGH day density is 0.0008 (sky.js:305). v2 uses 0.00055 by day, +0.0006 at golden hour and +0.0008 at night. LOW uses linear fog from 180 to 900 m. Beacon materials (tower crown, letters, pylon lights, lighthouse) use `fog:false`. |
| Driving feel must change | Speed-sensitive steering with a lateral-g cap (`PHYS.gripG` 2.0, handbrake 1.35×), a surface grip table, a slope term, real sim airtime, wall-normal sliding with damage from the normal component only, and substeps of 0.5 m or less. All of it is gated by world data, so the classic 2D and 3D play exactly as today. This is user question 2. |
| Wall scrapes wreck cars / steering locks | Covered by §10. |
| Real bridge decks | Decks sit only over water (2.5D-safe). There are **two height rasters**: GROUND (walkable, includes decks) and TERRAIN (natural, sea bed). The terrain mesh and sea depth come from TERRAIN. |
| Validate splines | Hairpins are authored as 7-point arcs of R 16 m (measured 12.3-13.4 m). Loop arcs are R 130-140 m (measured floor 105 m; the hwy floor is 100). `map_check` enforces this with the shared sampler. |
| No 4-way on the highway | All 21 Loop junctions are T's (§4.4). |
| Session friction | Heights Drive gives a 318 m exit from the villa to the Loop (about 20 s). Every giver place is 0.7-2.1 km by road from the villa (35-70 s). Fast travel to discovered hubs comes in S8. |
| Far-road z-fighting | Far terrain tiles are textured with the painted world albedo. Road ribbons exist only near the camera. Near plane 0.15. No logarithmicDepthBuffer. |
| Draw calls: cars and peds | Car-view far LOD (1 mesh), shadows only inside the shadow box, ped shadow and visibility LOD, pooled views (S3c). |
| Path-based look-ahead, `c.ai.speed` in px/s | §9. |
| Proven on classic first | Lane AI, nav, peds and scaling infrastructure all land and soak on the classic grid (S1, S3) before any v2 rendering (S4+). |
| One import map, no frozen city copy | The world and city **facades** pick an implementation at module evaluation through namespace imports. No import-map tricks; index.html keeps its single static `three` map. Missing names become `undefined`, never link errors. `check_exports` gates every stage. |
| Synchronous generate | v1 is synchronous with a measured budget of 450 ms or less. The pipeline is pure functions over typed arrays, so a Worker can be added in S9 only if the M1 budget fails. |
| `tileAtPx` legacy codes only | Through the LEGACY[12] table. |
| Shadow casters | Chunk casters only within 110 m. Scatter and palm casters only within 60 m. |
| Prewarm | `renderer.compileAsync` after build. Materials are shared across chunks. |
| Save | Key and ids unchanged. `mapVer` and `pr` go through save.js and state.js. The welcome toast is driven by `G.seen.v2welcome`, not `mapVer`. |
| Painted, not "code-built" | S5c paints facade, shop and sign atlases per region style through the existing Orbio pipeline. |
| Advisory signage | Chevrons and advisory speeds are computed from the final grip model: `v = sqrt((gripG + tan(bank)) * 9.81 * R)`, rounded down to 10 km/h, shown only when below 120 km/h. |

**Scale:** world **2048 × 1792 m** (8 × 7 chunks of 256 m), about 2.0 km² of land, Kimchi Loop **4.28 km** (a hypercar laps it in about 100 s), **20.1 km** of road in total, **450 buildings or fewer**. That is the judges' 2.0 × 1.5-2.0 km class; the outer filler was trimmed and every hero region was kept.

## 1. Units and axes

- Authored data (`src/map/mapdata.js`) is in **metres**: x east, z south, origin at the NW corner, all coordinates non-negative.
- The sim stays in px: `px = m * 16`. `BOUNDS = {x0:0, y0:0, x1:32768, y1:28672}`.
- 3D: X = px/16, Z = py/16, Y up in metres. Heading `a = atan2(dz,dx)`, with 0 = east and π/2 = south. 3D `rotation.y = -a`.
- `SEA_LEVEL = -1.0` (today's sea plane). `LAND_BASE = 1.0`.
- Right-hand traffic. The right-hand normal of travel direction (tx,tz) is (−tz, tx).
- **Local frames for prefabs and buildings:** origin at the old block-interior corner, sizes in m (0..40), front/door side = local +z, front-centre = local (20,40).
- World transform with facing `a`:
  - `wx = F.x + (lx−20)·sin a + (lz−40)·cos a`
  - `wz = F.z − (lx−20)·cos a + (lz−40)·sin a`
  - where F is the world position of local (20,40).
  - With a = π/2 this is today's south-facing layout.
- Local headings transform as `a_world = a_local + (a − π/2)`.

## 2. Regions

| id | name | bounds (m, approx.) | style | traffic / peds | character |
|---|---|---|---|---|---|
| heights | Coral Heights | x 40-720, z 40-610 | mansion | .15/.1 | A 58 m limestone dome with sea cliffs on the N and W and a hidden cove at (560,110). The villa is on the summit, a five-leg switchback road runs down the south face, Heights Drive follows the east ridge, and about 6 glass mansions stand on Heights Dr. Jars 0 and 2. |
| north_shore | North Shore & Lookout Knoll | x 700-1265, z 40-330 | estate | .2/.1 | Knoll 36 m at (878,178). KIMCHI letters 18 m tall on the south face. Crest Road runs here. View corridor (max building height 12 m). Jar 1. Photo spots skyline and kimchi_sign. |
| ktown | Koreatown, Seoul Circle | x 720-1000, z 380-760 | ktown | .9/1.0 | Roundabout r 42 around Fountain Park, radials, crescents, Neon Alley. Buildings of 3-6 floors with blade signs and lanterns, capped at 18 m. K-Town gate over Seoul Ave. Places park, mart, kimchi. Photo spots park and neon. Jars 18 and 19. |
| downtown | Downtown / Brickell | x 1000-1265, z 380-962 | tower | 1.0/.8 | Glass and Deco-crown towers of 12-45 floors. The north row between the Loop and 14th St is low-rise (3-5 floors). Kimchi Tower (140 m) stands at (1175,515) on Kimchi Plaza. Bayfront Park peninsula with a fountain at (1292,612). Places police and hospital. Jars 15, 16 and 17. |
| gables | The Gables | x 560-1000, z 600-1290 | house | .4/.3 | Barrel-tile houses with lawns and hedges, and banyans on Coral Way. Granada Golf Course (open grass) at x 560-670, z 700-940. Place yuna. Jar 20. |
| glades | The Glades | x 40-560, z 560-1290 | shack | .2/.05 | Marsh at 0.4 m with shallow drivable ponds, the Gator Lagoon (deep water), the airboat dock, the dirt Gator Run and the observation tower. A1A Sunset Drive runs along the west beach. Anchor bandanaYard. Photo spot glades. Jars 3, 4, 5 and 24. |
| fest_airport | Kimchi Fest & Kimchi Air | x 40-1140, z 1290-1640 | hangar | .3/.6 | The festival hub: KIMCHI FEST arch, stage, a 40 m Ferris wheel, the Kimchi Motors autoshow and the race board. The 720 m runway doubles as a drag strip. Jet Blast Beach. Places dealer and jet. Photo spots motors, fest, jet and jetblast. Jars 6, 7, 8 and 9. |
| port | Port | x 1000-1300, z 962-1290 | warehouse | .5/.1 | Candy-coloured container stacks, 3 pink 45 m cranes on the seawall and the Port Yard drift loop. Places spray and guns. Jar 10. |
| collins | Deco Beach north (Collins) | island, z < 840 | resort | .7/.7 | Resort towers of 8-18 floors, the curved Fontainebleau-style hotel at (1790,500), North Beach dunes. Jars 21 and 22. |
| deco | Deco Beach south (South Beach) | island, z ≥ 840 | deco | .8/1.0 | Pastel Deco hotels of 2-4 floors (Ocean Drive 3-6) facing east to Lummus Park, the Beachwalk and the beach. Lincoln Road Boutique Row. South Pointe and the marina. Places watches, fashion, marina. Photo spots ocean and boutiques. Jar 23. |
| islets | Venetian islets & Star Island | bay | mansion | .1/.1 | Garden islets and 6 Star Island mansions. Anchor stolenCarLot. Jars 13 and 14. |
| cape | Cape Kimchi key | x 1340-1740, z 1338-1597 | none | .3/.2 | Dunes, an 11 m bluff, a 30 m lighthouse with a rotating beam, and the Lighthouse Hairpin. Photo spot lighthouse. Jars 11 and 12. |

Region polygons (mapdata `REGIONS[].pts`) are the bounds above, clipped to land. Island regions split at z = 840.

## 3. Terrain, coast and water (mapdata, metres)

**COAST** (land polygons; anything outside them, and anything outside the rasters, is sea):

```
mainland: [[56,600],[52,700],[48,800],[40,900],[36,1000],[40,1100],[55,1180],[85,1260],[125,1320],[170,1380],[205,1445],[228,1500],[245,1550],[290,1588],[380,1612],[500,1625],[650,1630],[800,1628],[900,1622],[1000,1608],[1058,1570],[1080,1510],[1092,1450],[1100,1400],[1112,1360],[1135,1335],[1165,1318],[1195,1295],[1225,1272],[1250,1244],[1268,1210],[1290,1178],[1302,1150],[1300,1122],[1272,1110],[1268,1060],[1265,960],[1268,860],[1266,760],[1265,668],[1300,650],[1318,610],[1300,575],[1262,560],[1262,480],[1266,400],[1260,320],[1232,240],[1180,160],[1100,100],[1000,62],[900,45],[800,48],[720,58],[640,62],[590,92],[560,110],[530,95],[470,60],[380,42],[260,48],[150,90],[80,180],[50,300],[42,420],[60,520]]
island: [[1638,322],[1660,255],[1720,198],[1800,192],[1862,225],[1886,320],[1890,520],[1892,720],[1890,920],[1886,1060],[1872,1160],[1840,1232],[1785,1268],[1715,1272],[1680,1250],[1652,1232],[1648,1190],[1630,1172],[1600,1152],[1578,1138],[1580,1112],[1608,1098],[1636,1072],[1652,1040],[1650,1000],[1650,880],[1650,700],[1650,560],[1648,470],[1645,420],[1630,375]]
key: [[1350,1370],[1420,1345],[1520,1338],[1620,1350],[1690,1385],[1730,1440],[1738,1505],[1718,1565],[1655,1590],[1540,1597],[1430,1588],[1365,1552],[1342,1480]]
islets: circle (1340,703) r30, circle (1440,701) r32, circle (1540,700) r30; Star Island ellipse c(1440,1050) rx85 rz52 plus a land neck x 1425-1455 to the fill
macarthur_fill: [[1340,1112],[1530,1106],[1530,1155],[1340,1162]]
```

**Coast kinds** (shore profile):
- cliff: mainland, from (60,520) north and east to (640,62). Land drops to −6 m within 6 m (ROCK).
- beach: mainland west coast z 520-1380, mainland south coast, island east coast, key.
- seawall: every bay shore, the island's west shore, the islets.

Beach profile: from the base down to −0.8 m at the waterline over 35 m (SAND). The island gets a +2 m dune ridge 15 m inland of its Atlantic beach. Sea floor: −1.5 m at the shore, −8 m at 120 m and −20 m at 300 m, taken from the coast distance field.

**WATER** (inland):
- Gator Lagoon: deep WATER, level 0.2, bed −3. Ellipse c(395,1140) rx45 rz35, plus a 10 m channel from (430,1160) to the airboat dock (455,1172).
- Shallow ponds: SHALLOW, level 0.4, bed 0.1, drivable with splash. Circles (300,1060) r30, (520,1120) r28, (150,900) r26.

**TERRAIN features.** Heights are added to `LAND_BASE` 1.0. Domes use `h·(1−r'²)^p`, where r' is the elliptical distance. Ridges are polylines of [x,z,h] that give `h·(1−(d/hw)²)`. Features are combined by `max`. Overrides blend over the width given.
- dome `coral_heights`: c(330,260), h 57, radii w270 e420 n215 s330, p 0.85.
- ridge `heights_spine`: [[420,285,52],[790,305,32],[878,178,36]], hw 120. This gives the rock cutting at the pass: the road is at 26 m against 32-34 m natural ground, a cut of up to 10 m.
- dome `lookout_knoll`: c(878,178), h 35, r 165, p 0.9.
- ridge `north_shore`: [[950,190,30],[1150,330,6]], hw 120.
- ridge `east_shoulder`: [[800,318,29],[1000,366,16],[1240,374,4]], hw 150. Skyline Drive rides this, which is why K-Town sits at its foot.
- dome `cape_bluff`: c(1680,1500), h 11, r 90, p 1.
- override `heights_south_face`: rectangle x 250-490, z 300-610, `h = 58 − 0.155·(z−300)`, blend 25 m. The switchbacks sit on this.

**Flatten** (blend toward y inside the polygon): ktown 2.0 (blend 40), downtown 2.0 (40), port 1.8 (30), gables 1.5 (40), island 1.5 (20), glades 0.4 (40), fest_airport 1.2 (40).

**Pads:**
- villa: prefab footprint plus 6 m, y 58.
- every other prefab and lot: flat at the max of its footprint corners, with a 6 m blend.

**Carve:** after the road profiles are solved (§4.2).
- Under the road, GROUND equals the road surface.
- Within halfW + walk + 1 m, TERRAIN = road − 0.20 m.
- Beyond that, a smoothstep back to natural over 18/12/8/14/10/6 m for hwy/ave+blvd/street/country+coast/switch/dirt.
- Nearest road sample wins.
- Measured cut/fill: switchbacks −7.8 m at most, Heights Dr −9.0, Crest Rd −6.9, Loop −10.2 in the pass cutting (allowed up to 12 for the flagged cutting). Bridges are excluded.

**VIEW_CORRIDORS:** `[{id:'pass_reveal', pts:[[790,296],[1265,322],[1265,346],[790,336]], maxH:12}]`.

## 4. Road network (exact data)

### 4.1 Sampling rule (shared by spline.js, the game, the tools and the validator)

- Centripetal Catmull-Rom with α = 0.5.
- Open curves get mirrored phantom ends: `P[-1] = 2P0−P1`, `P[n] = 2P[n−1]−P[n−2]`. Closed curves wrap.
- Each segment is sub-sampled uniformly in t at 0.25 m, then resampled to 1 m arc length (2 m for runtime edges, 1 m where |k| > 1/40).
- Frames: `right = (−tz, tx)`. Never Frenet frames.
- Radius check: a 3-point circle with chord 3 m (switch, street, dirt, alley, ring) or 8 m (others).

### 4.2 Classes

| cls | lanes/dir | laneW | median | shoulder / parking | walk | halfW | AI m/s | grade max | min R | bank max | AI |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hwy | 2 | 3.6 | 3.0 (Jersey barrier on decks, palms on fill) | 1.5 | 0 | 10.2 | 26 | 6% | 100 | 5° | yes |
| blvd | 2 | 3.3 | 3.0 palm median | 0 | 3.5 | 8.1 | 16 | 6% | 60 | 0 | yes |
| ave | 1 | 3.5 | 0 | parking 2.4 | 3.0 | 5.9 | 12 (collins_ocean 9) | 8% | 40 | 0 | yes |
| street | 1 | 3.5 | 0 | 0.5 | 2.5 | 4.0 | 10 | 10% | 12 | 0 | yes |
| coast | 1 | 3.6 | 0 | 1.0 | 0 (promenade where flagged) | 4.6 | 16 | 8% | 40 (key_loop 30) | 3° | yes |
| country | 1 | 3.5 | 0 | 0.5 | 0 | 4.0 | 14 | 12% | 30 | 3° | yes |
| switch | 1 | 3.4 | 0 | 0.4 | 0 | 3.8 | 8 | 14% | 12 | 0 | yes |
| ring | 1, one-way | 5.0 | 0 | 0.5 | 3.0 | 3.0 | 7 | 4% | 12 | 0 | yes |
| dirt | single 7 m | - | - | - | 0 | 3.5 | - | 18% | 12 | 0 | no |
| alley | single 6 m | - | - | - | 0 | 3.0 | - | 10% | 8 | 0 | no |

**Profiles:**
- Authored `y` pins are `[ctrlIndex, y]`, interpolated by control parameter. Unpinned stations follow terrain.
- Smoothing: a 30 m window, then a forward/backward grade clamp per class.
- Every junction node is pinned to the mean of its incident edges.
- Bank = clamp(k · v² / g · 0.5, ±bankMax).

### 4.3 ROADS (metres; `cls`, flags, control points)

```
loop (Kimchi Loop) hwy closed; travel order = clockwise; y=[[0,2],[4,2],[12,2],[13,4.9],[14,7.9],[15,11.3],[16,14.8],[17,18.2],[18,21.1],[19,23.6],[20,26],[21,22.5],[22,18.7],[23,14.8],[24,11],[25,7.5],[26,4.5],[27,7.5],[28,10.9],[29,14],[30,11.8],[31,10.2],[32,8.5],[33,7.3],[34,6],[35,4.8],[36,3.6],[37,2.5],[38,2],[50,2],[52,3],[54,4],[55,3],[56,2.5],[57,3],[58,4],[59,3.5],[60,2.5],[61,2],[69,2]]
[[1075.8,1300],[980,1300],[900,1300],[700,1300],[520,1298],[400,1288],[318,1258],[258,1205],[225,1130],[214,1040],[213,940],[218,850],[238,765],[280,690],[345,628],[430,575],[515,515],[590,445],[650,385],[710,342],[780,322],[855,330],[935,352],[1015,374],[1095,388],[1170,388],[1235,374],[1300,352],[1370,332],[1440,318],[1480,312],[1510,310],[1540,310],[1565.4,312.5],[1589.7,319.9],[1612.2,331.9],[1631.9,348.1],[1648.1,367.8],[1660.1,390.3],[1667.5,414.6],[1670,440],[1670,470],[1670,560],[1670,700],[1670,850],[1670,970],[1670,1000],[1667.5,1025.4],[1660.1,1049.7],[1648.1,1072.2],[1631.9,1091.9],[1612.2,1108.1],[1589.7,1120.1],[1565.4,1127.5],[1540,1130],[1510,1130.5],[1440,1134],[1365,1137],[1335,1138],[1308.3,1140.6],[1282.6,1148.2],[1258.8,1160.6],[1237.7,1177.3],[1220.3,1197.7],[1205.4,1219],[1190.5,1240.3],[1173.1,1260.7],[1152,1277.4],[1128.2,1289.8],[1102.5,1297.4]]
switchbacks (Coral Heights Switchbacks) switch; y=[[0,56],[4,51],[10,49],[14,41.5],[20,39.5],[24,32],[30,30],[34,22.5],[40,20.5],[45,9.5]]
[[385,292],[378,312],[362,326],[330,333],[295,334],[287,336.1],[281.1,342],[279,350],[281.1,358],[287,363.9],[295,366],[330,370],[380,378],[418,382],[435,382],[443,384.1],[448.9,390],[451,398],[448.9,406],[443,411.9],[435,414],[400,418],[350,426],[312,431],[295,431],[287,433.1],[281.1,439],[279,447],[281.1,455],[287,460.9],[295,463],[335,467],[385,474],[423,479],[440,479],[448,481.1],[453.9,487],[456,495],[453.9,503],[448,508.9],[440,511],[415,512],[392,520],[377,540],[376,565],[384,590]]
heights_dr (Heights Drive) country; y=[[0,56],[1,52.6],[2,47.7],[3,41.7],[4,36.1],[5,30.6],[6,25]]  [[385,292],[420,287],[470,290],[530,302],[585,318],[640,330],[697,339]]
crest_rd (Crest Road) country; y=[[0,25.5],[3,30],[6,36],[9,32],[12,18],[15,7.5]]  [[806,312],[815,288],[838,268],[855,244],[858,220],[865,196],[882,178],[915,168],[952,178],[985,202],[1015,232],[1052,248],[1090,262],[1120,292],[1140,332],[1150,377]]
villa_dr (Villa Drive, private, ai:false) street; y=[[0,56],[2,58]]  [[385,292],[372,280],[362,262],[357,256]]
seoul_ave (Seoul Avenue, K-Town gate at z 400) ave  [[870,346],[870,470],[870,518]]
ring (Seoul Circle) ring closed oneway (CCW)  [[912,560],[908.8,543.9],[899.7,530.3],[886.1,521.2],[870,518],[853.9,521.2],[840.3,530.3],[831.2,543.9],[828,560],[831.2,576.1],[840.3,589.7],[853.9,598.8],[870,602],[886.1,598.8],[899.7,589.7],[908.8,576.1]]
han_ro (Han-ro / Flagler St, neon main street) street  [[912,560],[1000,560],[1115,560],[1232,560]]
myeong (Myeong-dong / Ponce) street  [[870,602],[870,707.6],[871,800],[873,880],[875,962]]
granada (Itaewon-ro / Granada Blvd) ave  [[828,560],[750,560],[718,590],[698,640],[684,700],[677,770],[676,860],[684,960],[712,1050],[742,1140],[735,1220],[705,1290]]
nw_crescent street  [[780,560],[786.9,525.6],[806.4,496.4],[835.6,476.9],[870,470]]
se_crescent street  [[1000,630],[974.4,664.4],[943.8,687.8],[908.2,702.6],[870,707.6]]
neon_alley (Hongdae Neon Alley) alley  [[840.3,530.3],[823.4,513.4],[806.4,496.4]]
miami_ave ave  [[1000,382],[1000,470],[1000,560],[1000,630],[1000,710],[1000,820],[1000,962],[1000,1052],[1002,1180],[1005,1288]]
st14 (14th St) street  [[870,470],[1000,470],[1115,470],[1228,470]]
st6 (NE 6th St) street  [[1000,710],[1115,710],[1239,710]]
st1 (SE 1st St) street  [[1000,820],[1115,820],[1240,820]]
ne2nd (NE 2nd Ave) street  [[1115,470],[1115,560],[1115,710],[1115,820],[1115,962]]
biscayne (Biscayne Blvd) blvd  [[1225,389],[1228,470],[1232,560],[1239,710],[1240,820],[1236,900],[1230,962]]
coral_way (banyans x 600-1000) ave  [[226,975],[300,970],[420,966],[508,963],[600,962],[684,960],[780,961],[875,962],[1000,962],[1115,962],[1230,962]]
alhambra (Alhambra Circle) street  [[678,810],[725,822],[772,850],[800,898],[795,940],[782,962]]
sevilla (Sevilla Ave) street  [[712,1050],[850,1052],[1000,1052]]
venetian (Venetian Causeway, 3 m promenade N side) coast  [[1239,710],[1300,706],[1340,703],[1400,702],[1440,701],[1500,700],[1540,700],[1600,700],[1659,700]]
st71 street  [[1677,420],[1745,420],[1815,421]]
collins_ocean (Collins Ave north of z 840, Ocean Drive south; parking W, Lummus Park + Beachwalk E) ave  [[1815,320],[1815,421],[1814,560],[1813,700],[1813,840],[1812,960],[1811,1085],[1810,1150]]
deco_ave (Deco Avenue, palm median) blvd  [[1745,420],[1745,560],[1745,700],[1745,840],[1745,960],[1745,1085],[1745,1238]]
st41 street  [[1681,560],[1745,560],[1814,560]]
lincoln (Lincoln Road, Boutique Row, planters, slow) street  [[1680,840],[1745,840],[1813,840]]
st15 street  [[1682,960],[1745,960],[1812,960]]
st5 (5th St) street  [[1652,1087],[1745,1085],[1811,1085]]
south_pointe street  [[1810,1150],[1798,1205],[1765,1236],[1745,1238],[1706,1230],[1700,1215]]
star_spur street  [[1440,1122],[1440,1090]]
star_ring street closed  [[1440,1090],[1482.4,1078.3],[1500,1050],[1482.4,1021.7],[1440,1010],[1397.6,1021.7],[1380,1050],[1397.6,1078.3]]
port_blvd ave  [[1115,962],[1112,1040],[1110,1095]]
port_yard (drift loop) street closed  [[1075,1115],[1110,1095],[1160,1093],[1193,1113],[1190,1145],[1150,1160],[1100,1156],[1076,1140]]
rickenbacker coast; y=[[0,2],[2,8],[4,2]]  [[1215,1226],[1250,1260],[1290,1300],[1330,1340],[1368,1385]]
key_loop (A1A Key Loop) coast closed minR 30  [[1380,1395],[1440,1373],[1520,1366],[1600,1374],[1660,1400],[1695,1440],[1708,1490],[1690,1530],[1650,1548],[1580,1556],[1500,1553],[1430,1540],[1390,1508],[1370,1460]]
festival_way blvd  [[820,1313],[820,1340],[820,1365]]
fest_ring (drift zone) street closed  [[700,1365],[820,1365],[940,1365],[962,1400],[940,1460],[820,1462],[700,1460],[680,1415]]
airport_rd ave  [[962,1400],[1000,1405],[1040,1410]]
airport_perim street  [[680,1415],[600,1440],[480,1462],[360,1475],[270,1490]]
a1a (A1A Sunset Drive) coast  [[226.8,760.7],[175,770],[120,795],[85,845],[68,930],[66,1020],[75,1100],[100,1165],[150,1205],[205,1218],[248.3,1212.1]]
gator_run dirt  [[300,968],[300,905],[322,845],[380,800],[450,795],[500,840],[512,905],[508,962]]
airboat_rd dirt  [[420,966],[425,1040],[440,1110],[462,1170]]
```

**Measured (length m / min R m / max grade):**

| road | length | min R | max grade |
|---|---|---|---|
| loop | 4283 | 105.5 | 5.7% |
| switchbacks | 867 | 12.3 | 11.7% |
| heights_dr | 318 | 121 | 10.3% |
| crest_rd | 532 | 29.6 | 11.6% |
| granada | 846 | 42.7 | flat |
| nw_crescent | 141 | 50.6 | flat |
| ring | 264 | 38.9 | flat |
| alhambra | 228 | 40 | flat |
| south_pointe | 199 | 24.9 | flat |
| star_ring | 316 | 17 | flat |
| port_yard | 314 | 15.6 | flat |
| key_loop | 881 | 30.7 | flat |
| fest_ring | 701 | 26.1 | flat |
| a1a | 668 | 78.7 | flat |
| gator_run | 466 | 55.1 | flat |
| rickenbacker | 221 | 371 | 6.2% |

Totals: hwy 4283, street 5537, ave 3970, coast 2190, blvd 1444, switch 867, country 850, dirt 676, ring 264, alley 48.

### 4.4 Loop junctions

All Loop junctions are T's. Station is metres from (1075.8,1300) in travel order; side is relative to travel.

| station | road end | side |
|---|---|---|
| 70 | miami_ave | R/N |
| 256 | festival_way | L/S |
| 371 | granada | R/N |
| 844 | a1a S | L/W |
| 1083 | coral_way | R/E |
| 1296 | a1a N | L/W |
| 1525 | switchbacks (Heights Gate) | L |
| 1928 | heights_dr | L |
| 2036 | crest_rd W | L |
| 2105 | seoul_ave | R |
| 2240 | miami_ave | R |
| 2389 | crest_rd E | L |
| 2462 | biscayne | R |
| 2975 | st71 | L |
| 3113 | st41 | L |
| 3253 | venetian | R |
| 3394 | lincoln | L |
| 3513 | st15 | L |
| 3639 | st5 | L |
| 3857 | star_spur | R |
| 4123 | rickenbacker | L |

The crest is at station 2016 (26 m). Opposite-side T's are never closer than 65 m.

**X nodes:** only between non-hwy roads, at the points where the §4.3 roads cross. Signal candidates (enabled in S6a only if the soak passes): (870,470), (1000,560), (1115,560), (1115,710), (1115,820), (1000,962), (1115,962), (1239,710), (684,960), (1745,560), (1745,840), (1745,960), (1745,1085). Every other node is priority/yield (Loop, ring and Deco Ave are priority) or all-way reservation.

### 4.5 Bridges

Spans are derived automatically: stations whose centreline TERRAIN is below SEA_LEVEL+0.3, plus 6 m abutments. Measured:

| bridge | span | style |
|---|---|---|
| North Causeway | Loop 2506-2893 m, from (1264,365) to (1633,350) | `cable`: deck from the profile up to 14 m at the 62 m A-frame pylon (1440,318), Jersey barriers, piers every 30 m |
| MacArthur east | 3718-3766 m | `viaduct`, 4 m |
| MacArthur west | 3958-3996 m | `viaduct`, 4 m |
| Venetian | 4 spans: 27-71, 131-168, 234-271, 332-411 m | `bascule`: 3.5 m decks, bascule houses mid-span |
| Rickenbacker | 39-199 m | `arch`: 8 m crest, white arch at (1290,1300) |
| Marina pier | from (1650,1205) to (1602,1205) | `pier`, 5 m wide; peds and photos only (BLOCK_CAR at the root) |

### 4.6 Paths (ped-only; promenades are PLAZA or DECK, no AI)

- Beachwalk at x 1848, z 300-1150.
- Bayfront Riverwalk at x 1270-1300, z 400-950.
- Venetian promenade.
- Glades boardwalk from (380,800) to the tower at (362,742): DECK, bollards.
- Cove Stairs from (530,302) to (560,118): PLAZA steps, bollards at the top.
- Knoll path from the lookout (882,178) to (918,252).

Cars may physically drive on the Beachwalk and Riverwalk (not BLOCKED; user question 7) but never on the boardwalk or stairs.

### 4.7 Sightline tests (map_check)

Bearing relative to the road tangent must be ±30° or less, and the ray is clear on OCC/GROUND from a 1.5 m eye height to the landmark mid-height.
- **SL1**, Loop eastbound at stations 2016-2100: kimchi_tower +28→+17 (measured), pylon +1→−14, deco_north +12→−3.
- **SL2**, Loop westbound at (1560,311): tower −28.
- **SL3**, villa foot spawn facing 0.5 rad: tower −12, K-Town 0, island −12, lighthouse +14.

## 5. Places, photo spots, jars, anchors, routes, activities, landmarks

### 5.1 PLACES

Each place is a prefab (today's world.js branch moved verbatim into a local frame; §1). Columns: front F (local (20,40)) in metres; facing a in radians. door, foot (= door + 2.2 m·facing), curb (= door + 10 m·facing on the drivable yard or road) and giver were computed by the formulas in §7 and are listed for checking.

| key | prefab | F | a | door | foot | curb |
|---|---|---|---|---|---|---|
| home | villa | (350,268) | 0.5 | (331.8,262.6) | (333.7,263.6) | (340.5,267.4) |
| park | park_circle | centre (870,560) | - | (870,564.4), nomenu | - | - |
| mart | mart | (956,553.5) | π/2 | (956,538.9) | (956,541.1) | (956,548.9) |
| kimchi | kimchi | (876.5,655) | π | (891.1,653) | (888.9,653) | (881.1,653) |
| yuna | yuna | (804,881) | 2.62 | (815.7,872) | (813.8,873.1) | (807,877) |
| dealer | dealer (autoshow) | (880,1371.5) | −π/2 | (888,1390.1) | (888,1387.9) | (888,1380.1) |
| police | police | (1058,716.5) | −π/2 | (1058,731.1) | (1058,728.9) | (1058,721.1) |
| hospital | hospital | (1227.4,890) | 0 | (1216.8,890) | (1219,890) | (1226.8,890) |
| spray | spray | (1104,1030) | 0 | (1085.4,1030) | (1087.6,1030) | bay (1095.4,1030) r 9 |
| guns | guns | (1122,1030) | π | (1136.6,1030) | (1134.4,1030) | (1126.6,1030) |
| watches | watches | (1711,833.5) | π/2 | (1711,818.9) | (1711,821.1) | (1711,828.9) |
| fashion | fashion | (1711,846.5) | −π/2 | (1711,861.1) | (1711,858.9) | (1711,851.1) |
| jet | jet | (1040,1455) | π/2 | (1052,1432.4) | (1052,1434.6) | (1052,1442.4) |
| marina | marina | (1650,1205) | π | (1672.6,1201) | (1670.4,1201) | (1662.6,1201) |

Prefab extras (world metres):
- **home.garage** [8], facing 0.5: (325.2,241.7) (328,236.6) (332.6,245.7) (335.3,240.6) (339.9,249.7) (342.7,244.6) (347.3,253.8) (350.1,248.7). villa_dr ends at the garage court mouth (357,256).
- **dealer.displaySpots** [7], facing π/2: (894.8,1385.9) (885.4,1385.9) (876,1385.9) (866.6,1385.9) (890.2,1376.9) (880.8,1376.9) (871.4,1376.9).
- **police.spots** [3], facing π/2: (1070,724.5) (1058,724.5) (1046,724.5).
- **jet.plane**: (1032.4,1438.6), a −π/2. The apron links south to the runway through a LOT taxi link x 1000-1060, z 1455-1505.
- **marina.pier**: {x:1650, z:1205, a:π, len:48}. The four yachts move into the pier frame.
- **Hangouts** (validated to lie within 14 m of an AI lane): mochi at the park (891.2,581.2), bao (949,546.9), yuna (807,877), dex (895,1382.1).
- **park** is a new prefab: a fountain at the circle centre, a plaza cross and benches. Today's photo offset becomes (882,572).

### 5.2 PHOTO_SPOTS

Fields are {id, x, z, bonus, look?, time?}. The ids are stable.

| id | position | bonus | look | time |
|---|---|---|---|---|
| villa | (342.7,270.9) | 1.2 | - | - |
| motors | (866.4,1401.5) | 1.0 | - | - |
| park | (882,572) | 0.8 | - | - |
| boutiques | (1728,836) | 1.0 | - | - |
| jet | (1042.4,1448.6) | 1.5 | - | - |
| marina | (1652.8,1203) | 1.4 | - | golden |
| ocean | (1838,1000) | 1.3 | - | golden |
| skyline | (888,186) | 1.4 | kimchi_tower | - |
| kimchi_sign | (918,252) | 1.3 | - | night |
| causeway | (1440,331), deck shoulder | 1.3 | pylon | - |
| lighthouse | (1690,1556) | 1.5 | - | night |
| neon | (823,513) | 1.2 | - | night |
| glades | (362,742) | 1.0 | - | - |
| jetblast | (262,1528) | 1.4 | - | - |
| fest | (800,1424) | 1.1 | - | - |

A matching time or an in-frame look target gives ×1.25.

### 5.3 JARS

Index = jar id, and ids 0..24 are kept. Coordinates: (560,118) (930,210) (266,447) (365,742) (345,832) (470,1185) (255,1530) (790,1446) (1015,1528) (1030,1452) (1180,1060) (1700,1536) (1540,1586) (1440,688) (1440,1022) (1305,610) (1150,505) (1262,396) (823,513) (856,546) (760,842) (1840,262) (1852,700) (1607,1205, pier) (50,985). The generator nudges each jar up to 8 m onto a walkable, non-hwy cell.

### 5.4 ANCHORS

- bandanaYard {x:480, z:1150, a:π, r:25}: a LOT yard at x 465-515, z 1130-1175. Dialogue: "the airboat yard in the Glades".
- stolenCarLot {x:1440, z:1050, a:π/2}: the Star Island motor court, joined to the spur by a LOT strip to (1440,1086).
- raceStart {x:960, z:1296.7, a:π}: the westbound inner lane of the Runway Straight.

### 5.5 ROUTES

Routes are resolved onto the RoadNet at load. Gates are oriented by the tangent, w = road width + 4 m, passed by segment crossing.
- bay_loop (Street Kings): a full Loop lap from raceStart in travel order, a gate every 200 m (21 gates).
- hillclimb: Loop station 1525, up the switchbacks to (385,292).
- deco_sprint: collins_ocean from (1815,330), then south_pointe to (1700,1215).
- glades_scramble: from (300,968) along gator_run to (508,962), then coral_way west to (300,968). 2 laps.
- runway_drag: straight gates from (320,1528) to (1000,1528).
- key_coastal: from Loop station 4123, Rickenbacker, one key_loop lap, then back.

### 5.6 ACTIVITIES

- Speed traps: st_runway (876,1300); st_deco (1745,640); st_coral (560,962).
- Average-speed zones: sz_causeway (Loop 2506-2893); sz_rick (the whole Rickenbacker); sz_key (key_loop from (1650,1548) to (1430,1540)).
- Drift zones: dz_switch (all switchbacks); dz_yard (port_yard); dz_fest (fest_ring); dz_light (key_loop from (1660,1400) to (1650,1548)).
- Danger-sign jumps: 1.2 m wedge, 10 m run, sharp drop, authored as TERRAIN bumps. j_crest at (858,220), heading north; j_gator at (322,845); j_levee at (430,1075); j_port, a container ramp at (1150,1158) heading west.
- Event board: a kiosk at (835,1380).
- Fast-travel hubs (discovered on first visit): villa foot, Seoul Circle (870,505), Fest (820,1350), Lincoln Rd (1745,830), Kimchi Air (1052,1434.6).

### 5.7 LANDMARKS

`{id, kind, x, z, a, h}`:
- kimchi_tower (1175,515), base 32×32, h 140, colour-cycling LED crown (`fog:false`).
- kimchi_letters (920,232), a 1.27, letters 18 m tall, 86 m wide, emissive at night.
- causeway_pylon (1440,318), h 62, 8 stays per side.
- lighthouse (1712,1548), h 30, beam at 0.25 Hz at night.
- fest_arch over festival_way at (820,1340), span 22 m, h 11.
- ferris_wheel (790,1440), diameter 40 m, axis east-west, 0.02 Hz.
- fest_stage (720,1415), facing east.
- port_cranes (1256,995) (1256,1040) (1256,1085), h 45, pink.
- control_tower (985,1478), h 22.
- ktown_gate over Seoul Ave at (870,400), span 18 m, h 9.
- bayfront_fountain (1292,612).
- glades_tower (362,742), h 12.
- deco_resort, a curved hotel at (1790,500), h 60.
- rickenbacker_arch (1290,1300), span 60 m.
- Venetian bascule houses at the 4 span centres.
- kimchi_one, from places.jet.plane.

**Bench views v2** (`world.benchViews`):
- villa_terrace (333.7,263.6, yaw 0.5)
- pass_crest (785,322, in car heading −0.05)
- ktown_circle (870,505, facing S)
- downtown_flagler (1060,560, facing E)
- causeway_hump (1440,318, in car heading 0)
- ocean_drive (1813,950, facing N)
- fest (820,1350, facing S)
- glades (300,960, facing N)

**Grid bench views:** home foot spawn, park, motors, boutiques, marina, jet.

**titleView v2:** a 120 s loop through these camera points (m): (1500,60,180), (1440,40,330), (1180,90,560), (880,60,560), (800,70,1380), (330,50,1000), (330,90,250), (880,60,180). Look targets lead by 0.15 of the period. Grid: today's orbit.

## 6. Data model

### 6.1 mapdata.js

Pure data with no imports, loadable in Node.

`MAP_VERSION=2`, `WORLD={w:2048,h:1792}`, `SEA_LEVEL`, `LAND_BASE`, `ROAD_CLASSES` (§4.2), `COAST`, `COAST_KINDS`, `WATER`, `TERRAIN`, `FLATTEN`, `REGIONS`, `ROADS` (`[{id,name,cls,pts,closed?,oneway?,y?,minR?,ai?,speed?,promenade?}]`), `SIGNALS`, `PATHS`, `PLACES`, `LANDMARKS`, `PHOTO_SPOTS`, `JARS`, `ANCHORS`, `ROUTES`, `ACTIVITIES`, `VIEW_CORRIDORS`, `BENCH_VIEWS`, `TITLE_PATH`, `PHYS` (§10).

### 6.2 Rasters

Built by world-v2 `generate()`. Typed arrays, row-major, origin at world (0,0); outside the rasters is sea.

- **SURF:** Uint8Array, 2048×1792, 1 m cells.
  - Low nibble is the kind: ROAD 0, WALK 1, GRASS 2, BUILD 3, LOT 4, PLAZA 5, WATER 6 (all as today), SAND 7, DIRT 8, SHALLOW 9, DECK 10, ROCK 11.
  - High-nibble flags: 0x10 BLOCK_CAR, 0x20 BLOCK_FOOT, 0x40 JCT (no parking or idling), 0x80 NOPED.
  - BUILD, WATER and ROCK set both blocks. Rails, guardrails, Jersey barriers and bollards set BLOCK_CAR and are rasterised 2 m thick.
  - `LEGACY[12] = [0,1,2,3,4,5,6,5,2,6,0,3]`: SAND→PLAZA, DIRT→GRASS, SHALLOW→WATER, DECK→ROAD, ROCK→BUILD.
- **GROUND:** Float32Array 1025×897 vertices at 2 m. Walkable or drivable surface without the curb offset (carved terrain, banked roads, pads, decks).
- **TERRAIN:** Float32Array 1025×897. Equal to GROUND except under decks, where it is natural ground or sea bed. Used for the terrain mesh, the sea depth and the cliff test.
- **OCC:** Uint8Array 1024×896 at 2 m. `max(ground, roof, deck)` rounded up to whole metres, clamped to 255.
- **REG:** Uint8Array 256×224 at 8 m. Region index.
- **SEADEPTH:** Uint8Array 1024×896 = `clamp((SEA_LEVEL − TERRAIN)/20, 0, 1)·255`, taken from the water mask (ponds use their own level).

`groundY(px,py) = bilinear(GROUND) + CURB[kind]`, where WALK, PLAZA and BUILD add 0.16 and LOT adds 0.04.

### 6.3 RoadNet (px, shared by both worlds)

- `nodes[{id,x,y,gy,kind:'T'|'X'|'end'|'corner'|'ring',control:'priority'|'signal'|'allway'|'none',edges[],phase}]`
- `edges[{id,road,name,cls,a,b,n,x,y,s,tx,ty,k,gy,bank:Float32Array (2 m step),len,lanesF,lanesB,laneW,halfW,walkW,median,speed,ai,deck:[[s0,s1]],oneway}]`
- `lanes[{id,edge,dir:±1,i,off,len,next:[connId],cars:[] }]`
- `conns[{id,node,from,to,x,y:Float32Array (1 m),len,turn:'s'|'l'|'r'|'u',conflicts:Int16Array,yield:bool}]`
- `walks` (sidewalk graph: paths `{pts,len,a,b,cross}` plus zones)
- a 32 m segment hash.

Construction:
- Endpoints within 16 m of another road become T nodes at the projection, and the side road is extended to the node (the code's snap; see §12.1).
- Interior crossings become X nodes. An X on the hwy or on a deck is a fatal error.
- Nodes within 3 m are merged.
- Closed roads with one node become self-loop edges.
- Lane centre = edge centre + right·(median/2 + (i+0.5)·laneW) for the lane's own direction.

### 6.4 Buildings (v2)

```
{id, cx, cz, w, d, h, base (m), a (facing), style, region, floors, wall, roof, trim, sign, awning, house, shop, place?,
 door:{x,y,a} (px), curb:{x,y,a} (px), deliver, tile:'tx,tz' (256 m), cell:'cx,cz' (128 m)}
```

Grid buildings keep tile x/y/w/h and gain `door.a = π/2`.

### 6.5 Places contract (both worlds)

```
{key,name,icon,color,door:{x,y,a},b?,foot:{x,y,a},curb:{x,y,a},giver:{x,y},hangout:{x,y},bay?,pier?,garage?,spawn?(=garage[0], legacy),spots?,plane?,nomenu?}
```

On grid:
- door.a = π/2.
- foot = door + (0,30 px) for home, + (0,40 px) for hospital and police, otherwise + (0,30).
- curb = door.
- giver = today's giverSpot search result.
- hangout = door + (100,60).
- bay = door + (0,40), r 120 px.

### 6.6 Save (key `kimchi-city-save-v1`)

- New fields: `mapVer` (1|2, informational) and `pr:{traps:{},zones:{},jumps:{},events:{},found:{}}`. Both have state.js defaults.
- Jar, photo, place and mission ids are unchanged.
- Jar completion counts `jarSpots.filter(j=>G.jars.has(j.id)).length`; the "ALL 25" text reads the count from data.
- The one-time v2 toast is gated by `G.seen.v2welcome`.
- The 2D autosave preserves every field because all of it goes through save.js.

## 7. Module contracts

- **src/world.js** (facade)
  - `import * as GRID from './world-grid.js'; import * as V2 from './world-v2.js'`.
  - KIND = `globalThis.KC_WORLD || ?map= || localStorage 'kc-map' || DEFAULT` (DEFAULT is `'grid'` until S9). `1|grid|classic` selects grid, `2|v2` selects v2. If `V2.READY !== true`, fall back to grid.
  - Re-exports the union of names with `export const X = W.X`. A name missing from the chosen world is `undefined`.
  - **Rule:** world modules export only constants, functions, and containers created at module evaluation and filled in place by `generate()`. They never reassign an export.
- **World API v2** (both worlds)
  - Constants: `KIND, MAP_VERSION, READY, PX_PER_M=16, T=64, SIZE, BOUNDS, SEA_LEVEL, PHYS`, kind codes `ROAD..ROCK`.
  - Functions:
    - `generate()` (idempotent)
    - `tileAtPx(x,y)` (legacy 0..6)
    - `surfaceAt(x,y)`
    - `blockedPx/blockedCarPx/blockedFootPx(x,y)`
    - `wallNormalPx(x,y,out)`: returns out or null; grid returns null
    - `groundY(x,y)`
    - `gripAt(x,y)` → `{max,lat}`
    - `sightClear(x0,y0,h0,x1,y1,h1)`
    - `regionAt(x,y)`
    - `mapImage()` → `{canvas,k,x0,y0}`, where k is canvas px per sim px
    - `hash`
  - Containers: `places, buildings, trees, palms, lamps, deco, solids, photoSpots, jarSpots, parkedSpawns, displaySpots, deliveryDoors[{b,curb}], anchors, routes, activities, landmarks, regions, roads (RoadNet), benchViews, titleView`.
  - Grid-only: `tiles, N, P, BLOCKS, roadCenter, tileAt, makeMinimap, draw*`.
  - v2-only: `grids{surf,ground,terrain,occ,reg,seaDepth,w,h}, coast, water, viewCorridors`.
- **src/world-grid.js:** today's world.js verbatim, plus the API above:
  - `groundY` = today's H table
  - `roads` from gridroads
  - `anchors`/`routes` from blockCenter and RACE
  - `PHYS` = classic (§10)
  - `mapImage` wraps `makeMinimap(4)` with `.k = 4/64`
  - `sightClear` = blockedPx samples every 24 px (identical to clearLine).
- **src/world-v2.js:** `generate()` pipeline:
  1. coast mask and SDF
  2. TERRAIN
  3. RoadNet (spline, junctions)
  4. profiles and carve → GROUND
  5. prefabs, then pads
  6. lots
  7. SURF stamping
  8. props
  9. OCC, SEADEPTH, REG
  10. lanes and walks
  11. jars, photos, anchors, routes
  12. validation (issues to `console.warn` in the browser)

  It exports `READY=true` and a `timing{}` object with per-step ms.
- **src/map/spline.js**
  - `sampleCurve(pts,{closed,step=2})` → `{x,z,s,tx,tz,k,n,len}`
  - `pointAt(c,s,out)`
  - `nearestOnCurve(c,x,z,hint)` → `{i,s,x,z,d,side}`
  - `offsetCurve(c,d)`
  - `bezier(p0,t0,p3,t3,step)` → `{x,z,len}`
  - `segX(...)`
- **src/map/raster.js:** `KIND, FLAG, LEGACY, CURB, GRIP, makeGrid, fillPoly, fillRibbon, fillOBB, strokeLine, distanceTransform`.
- **src/map/terrain.js:** `buildTerrain(data,grids)` → `{heightAt,slopeAt,normalAt,solveProfiles(net),carve(net),pad(poly,y,blend),seaDepth()}`.
- **src/map/roadnet.js:** `buildRoadNet(roads,classes,{heightAt,snap=16,px=16})` → RoadNet with these methods:
  - `nearest(x,y,{maxD,ai})`
  - `nearestLane(x,y,a)`
  - `lanePoint(id,s,out)`
  - `randomLanePoint({x,y,rMin,rMax,ai=true,minGap,cls,notVisible})`
  - `route(x0,y0,x1,y1,{ai=false})` → `{pts:Float32Array,len,steps}`
  - `routeLength(...)` (Infinity if none)
  - `follow(nav,x,y,lookPx)` → `[x,y]`
  - `signalAt(node,edge)`
  - `edgesNear(x,y,r,cb)`
  - `walkPoint/randomWalkPoint`
- **src/map/gridroads.js:** `latticeRoads()` returns ROADS (m) for the 7×7 lattice: street, 1+1, laneW 4 m (lane centre ±2 m = today's laneOff), speed 9-13.75 m/s.
- **src/map/prefabs.js:** `PREFABS[key](F,a)` → `{buildings,place,surfaces,deco,palms,trees,lamps,solids,parking,display?,garage?,spots?,plane?,pier?,photo?}`, plus `park_circle`, `fest_grounds`, `hangar_row`, `star_mansions`.
- **src/map/lots.js:** `placeBuildings(net,regions,grids,rng,{corridors,exclusions})` → `buildings[]`; `STYLE`.
- **src/map/props.js:** `placeProps(net,grids,regions,rng)` → `{lamps,palms,trees,signals,chevrons,gantries,dangerSigns,billboards,furniture,guardrails,fences,beachProps}`.
- **src/map/mapimage.js:** `renderMap(world,pxPerM=1)` returns a canvas 2048×1792 with region tints, hillshade, roads by class, footprints and water; it is also the minimap and big-map base. `farAlbedo(world)` returns a 1024×896 canvas (no hillshade) for far terrain.
- **src/sim/traffic.js:** `aiAttach(car,lanePt,{max})`, `updateAICar(c,dt)`, `updateSignals(dt)`, `trafficStats()`.
- **src/sim/peds.js:** `walkPed(p,dt)`, `snapToWalk(p,maxD=400)`, `whiskerMove(e,dx,dy,r)`.
- **src/sim/population.js:** `CAPS`, `updatePopulation(dt,focus,{tier,view})`, `respawnPed(p)`, `clearPopulation()`. Grid is global mode (24 traffic, 46 peds, as today).
- **src/sim/nav.js:**
  - `roadWaypoint(c,tx,ty)` → `[x,y]` (same signature)
  - `curvatureAhead(c,distPx)`
  - `routeTo(c,tx,ty)`
  - `predictPath(car,distPx)`
- **src/entities.js:** exports unchanged. Adds `CFG.gripG`, `CFG.airG` (set from PHYS by main3d).
- **src/3d/city.js** (facade): `import * as CG from './cityGrid.js'; import * as CV from './cityV2.js'`. It picks by `world.KIND`. It exports `buildCity(scene)` → `{group,update(cam,t),setNight(k),chunks}`, plus `S, MAP(=max(w,h) m), WORLD_M, surfaceY(=world.groundY), occluderTop(xm,zm), nearestLamps(xm,zm,n,out), lampHeads, fountains, sea, mountains, yachts, clearTreesForCamera`.
- **src/3d/cityGrid.js:** today's city.js builders. Top-level texture creation is wrapped in a lazy `mats()`. It exports `occluderTop` from heightGrid and `nearestLamps` (sort).
- **src/3d/cityV2.js** orchestrates chunks, terrain3d, coast3d, roads3d, buildings3d, props3d, landmarks3d, palms and scatter.
- **src/3d/chunks.js:** `makeChunkManager(scene,{budgetMs})` → `{add(obj,{tile,layer,far,castR=110}), lazy(cellKey,buildGen,{within,drop}), update(camera,focus,dt), buildAround(xm,zm,r), stats()}`.
- Other 3D builders:
  - `terrain3d.buildTerrain3D(world,chunks,{albedo})`
  - `coast3d.buildCoast3D(world,group)` → `{sea,yachts,update(t)}`
  - `roads3d.buildRoads3D(world,chunks,mats)`
  - `buildings3d.registerBuildings(world,chunks)`
  - `props3d.buildProps3D(world,chunks)` → `{nearestLamps,update}`
  - `landmarks3d.buildLandmarks(world,group,chunks)` → `{update(t,night)}`
- **src/3d/geo.js:** Builder gains `setMatrix(m4|null)` (applied after UVs), typed growable buffers, `ribbon(frames,profile,opts)`, and `build({indexed})`.
- **src/3d/cars.js:** `syncCar(v,c,dt,groundFn,steer,running)`; car far LOD; `recycleCarView(v,type,color)`.
- **src/3d/bench.js:** `installBench(ctx)` → `KC3.teleport(name)`, `KC3.bench(names?)` → `[{view,calls,tris,gpuMs,cpuMs}]`, `KC3.soak(sec,{route})` → report.
- **src/3d/activities.js:** `updateActivities(dt)`, `activityMarks()`, `startEvent(id)`, `onBigMapClick(x,y)`.
- **tools/check_exports.mjs:**
  - Parses every `import {…} from '…world.js'` and `…city.js'`.
  - Every name used by a shared module (entities, ui, save, missions, police, combat, fx, hud3d, lifestyle, main3d) must be defined in both worlds or listed in a per-file kind allowlist (cityGrid may use grid-only names; cityV2 builders may use v2-only names).
  - Fails if `src/map/*`, `src/sim/*` or `world*.js` import `three` or `src/3d/*`.
- **tools/map_check.mjs:** checks the §11.2 invariants and writes `tools/out/map_v2.png` (zlib PNG writer, no dependencies) and `summary.json`.

## 8. Compatibility shims

- **2D:** 2d.html gets `<script>globalThis.KC_WORLD='grid'</script>` before main.js. main.js is unchanged. It shares entities.js and ui.js and therefore gets the lane AI on the lattice, with `PHYS.classic` keeping today's feel. It never runs the v2 generator (the module only loads).
- **Flat literals** (S0): these move to ground-relative values: combat y<0.1, enemy target 0.9, explosion 0.8, car bubble 2.4 (main3d:1018), job arrow 2 (main3d:1041), shadow focus y 0 (main3d:981), jet 0.04, lamp pool 0.18, yachts −1.75.
- **heightGrid /4·N:** reads in main3d 896-902/913-917 and combat 94-101 become `occluderTop(xm,zm)` plus a `groundY` test.
- **Door-south offsets:** main3d 231/430-435/505, entities 124, police 200 and missions giverSpot all move to place.foot, place.hangout, place.bay and place.giver. hero.heading = foot.a and cam.yaw = foot.a − π, which reproduces today's π/2 and −π/2 on grid.
- **Minimap scale:** `S/(N*T)` (ui 451/502) and `imgK` (hud3d 50) move to `mapImage().k` and `BOUNDS`. The 3D big-map arrow uses `p.heading ?? (p.face<0?π:0)`.
- **missions:** `node()`, `blockCenter`, RACE, RIVAL_SPOT, VAN_SPOT, `node(rand*7)` and the BLOCKS clamp move to anchors, routes, `roads.randomLanePoint` and BOUNDS. Car arrivals target `place.curb`.

## 9. AI

**Traffic** (`c.ai={lane,s,speed px/s (authoritative; external writes such as entities:323 =0 and combat:154 ×0.5 are honoured),max,next,rsv,stuck,ghost,wait}`):
- Target speed = min(edge speed × driver factor 0.85-1.1, `sqrt(3.2 m/s²/max|k|)` over the next 20 + 1.2v m, IDM-lite `(gap−7 m)/1.2 s`, stop line).
- Acceleration +2.5 m/s², braking −7 m/s².
- Look-ahead walks the agent's own path (rest of the lane, the planned connector, the next lane) and checks:
  - sorted lane car lists
  - the player car, police and mission cars, following friends, and non-walking peds within 2.2 m of the path.
- Junctions:
  - The connector is chosen 30 m before the lane end with weights s .5 / r .3 / l .2 (Loop through-traffic .75).
  - A reservation is granted only when no conflicting connector is occupied or reserved, and on yield approaches when no priority car will reach the conflict point within 4.5 s and the target lane has 12 m free.
  - The ring is priority; entries yield.
- Lane changes only on hwy and blvd, when the leader is below 70% of target speed and there is a 25 m gap; blended over 2 s.
- Position comes from the lane polyline. `c.a` = tangent and `c.vx/vy` = speed·tangent, so a car keeps its momentum when carjacked or when its driver is shot.
- Stuck for more than 4 s gives 1.5 s of ghosting. Stuck for more than 25 s out of view despawns the car.
- Signals: 2 phases, 14 s green, 3 s amber, 2 s all-red, offset by hash(node). Off until the S6a soak passes.

**Population (v2):**
- Cars: spawn 180-380 m out of view, despawn beyond 460 m out of view. Region density × class weight (hwy 1.5, blvd 1.2, street 1, coast .8, country .4, switch .3).
- Parked cars: materialise within 220 m and vanish beyond 300 m unless touched.
- Peds: spawn 45-150 m out of view, despawn beyond 190 m.
- Caps: Medium/High 24 traffic, 34 peds, 30 parked. Low 16, 22, 18.
- Dealer, garage, police and mission cars are never streamed.

**Peds:**
- Sidewalk paths at halfW + walk/2, joined at corner arcs. Crosswalks only at signal and allway nodes, used when no car is within 15 m on the approaching lanes.
- Zones (plazas, Fest, beach, piers) use wander targets.
- Continuous heading at 0.9-1.4 m/s.
- After a flee or knock-back, a ped walks to the nearest path within 25 m or despawns when unseen. This fixes today's stuck-on-road bug.
- Never on hwy or NOPED cells.

**Police:**
- `roadWaypoint` = cached A* (cost = len/speed + 4 s per signal), replanned every 1 s, when the target moves more than 40 m, or when the car leaves an 18 m corridor. It returns a pure-pursuit point at clamp(8 + 0.6v, 10, 40) m.
- Off-network (more than 25 m from any lane): direct to the target if a straight drivable line exists.
- `steerTo` adds `o.curv` braking (v ≤ 1.15·sqrt(9·R)).
- Spawn with randomLanePoint 220-420 m out of view, heading along the route.
- Drive-away: route to a node more than 500 m away.
- 3+ stars: one roadblock 280-400 m ahead on predictPath (two cruisers angled, 25 s).
- 4-5 stars: interceptors (max ×1.3, acceleration ×1.2).
- Evade radii stay 1300/900 px, using `sightClear` (terrain and buildings block, water does not). The minimap shows a search circle.
- Officers on foot: whisker slide (±35°, ±70°), plus a 64×64 m BFS flow field over `blockedFootPx` at 2 Hz while stuck.

**Missions:**
- The race rival follows the route polyline with curvature speed at 1.25× traffic grip and ±10% rubber-banding.
- The boss spawns at least 600 m away on hwy/blvd/coast, wanders to random nodes, and flees to the neighbour that maximises distance.
- Deliveries (missions and ui jobs): `deliveryDoors` within a route-length band of 500-1500 m; timer = route/18 m/s + 20 s.

## 10. Physics (PHYS gate)

- `PHYS.classic = {gripG:0, slope:false, air:false, wall:'axis', substepPx:Infinity, gripTable:'classic'}`.
- `PHYS.v2 = {gripG:2.0, slope:true, air:true, wall:'normal', substepPx:8, gripTable:'v2'}`.

**driveCar:**
- Speed cap and lateral damping come from `gripAt`. v2 table (max/lat): ROAD, DECK and LOT 1/1; WALK and PLAZA .95/1; GRASS .72/.85; DIRT .85/.75; SAND .6/.7; SHALLOW .5/.6, with splash. Classic is GRASS .55, everything else 1.
- Yaw rate is capped so that ω·|v| ≤ gripG·9.81·16, or 1.35× that with the handbrake.
- Slope term: `fwd −= 9.81·16·0.6·grade·dt`.
- In the air: no steering or throttle; `c.vh −= airG·9.81·dt`. Takeoff happens when the ground falls away faster than the ballistic path by more than 0.15 m. Landing applies a squash.

**moveCar** substeps to 0.5 m or less. On contact it takes n = `wallNormalPx`, removes the inward normal velocity with restitution .15, keeps the tangential velocity ×.98, and takes damage and shake from |v·n| only. If rotating into a wall, it pushes out along n by up to 0.5 m instead of reverting `c.a`.

Car state: `c.gy` (m), `c.vh` (m/s), `c.air` (s).

## 11. Rendering, performance and validation

### 11.1 Rendering

- **Chunks:** 256 m tiles (8×7) hold terrain, roads and building shells. 128 m cells hold building detail, props, palms and scatter.
- **Terrain:**
  - LOD0 is a 2 m grid (129² per tile) within 350 m (20 m hysteresis). LOD1 is an 8 m grid with 3 m skirts.
  - All-sea tiles are skipped.
  - LOD0 gets a vertex splat (grass, sand, dirt/rock, wet sand) over the Poly Haven photos at world UV 1/6 m (MeshStandard on HIGH, Lambert on LOW).
  - LOD1 samples the far albedo, so far roads are painted.
  - Near plane 0.15, far 2600 (LOW 1200).
- **Roads** (ribbons only for tiles within 400 m):
  - Class cross-sections: asphalt with u across and v = s/4 m, shoulders, a 0.16 m curb face, sidewalks with 2 m joints, verge.
  - Ribbons sit 0.20 m above TERRAIN, with verge vertices snapped to terrain + 0.03.
  - Junctions: trims of maxHalfW + corner radius (6/9/12 m), quadratic fillets, ShapeUtils, world-XZ UVs.
  - One vertex-coloured paint mesh per tile, lifted 2 cm with polygonOffset, fading to asphalt beyond 120 m.
  - Bridges: per §4.5, with instanced piers.
  - W-beam guardrails where fill is over 2 m or R is under 60 m on country/switch roads.
  - About 5 materials per tile.
- **Buildings:**
  - Shells for every building, merged per tile (one material, about 30 tris each), always resident.
  - Detail cells within 220 m (High 300) from a velocity-prioritised queue: 3 ms slices, LRU of 36 cells, spawn area built synchronously.
  - Today's decoDetails, villa, luxShop, door and roofs run in local frames through `setMatrix`.
  - Per-region facade, shop and sign atlases come from S5c.
- **Props:** instanced lamps every 30-40 m, palms (blvd median every 12 m, Ocean Dr every 9 m, causeway fill every 15 m, beaches), banyans, signals, chevrons, gantries 150 m before Loop T's, danger signs, billboards on the Runway Straight and the causeways.
- **Scatter:** streamed per 64 m cell within 140 m (Low 70). Shadows only within 60 m.
- **Lights:** fixed at 6/3 lamp lights, positioned by `nearestLamps` buckets.
- **Sea:** a 6 km plane with a SEADEPTH shader. Inland ponds are flat meshes at their own level. Beach props follow beach coast segments.
- **Car LOD:** full view within 70 m, then one merged mesh out to 220 m. Shadows only inside the shadow box.
- **Ped rigs:** no shadow beyond 40 m, hidden beyond 110 m. Views and rigs are pooled.
- `renderer.compileAsync` after build.

### 11.2 Budgets and checks

**Budgets** (M1, 1440×800, Medium):
- GPU ≤ 8.0 ms in every bench view (the S0 grid baseline is 5.5 ms; auto-quality steps down at 12).
- Calls, main + shadow pass: ≤ 380 worst view, ≤ 260 on hwy/hills, Low ≤ 220.
- Triangles ≤ 1.2 M; shadow ≤ 400 k.
- JS ≤ 11 ms p95 including render submission: sim + AI ≤ 2, build slice ≤ 3, instancing ≤ 1.
- Load: generate ≤ 450 ms, buildCity ≤ 1.0 s, first frame ≤ 3 s.
- Memory: rasters about 13 MB, map canvas 14.7 MB, far albedo about 5 MB GPU, terrain about 16 MB, detail cells ≤ 54 MB, heap ≤ 450 MB and flat over 15 minutes.

**map_check invariants:**
1. Radii, grades and cut/fill per class (§4.2, §3).
2. No hwy or deck X junctions, and no unplanned crossings.
3. Decks only over water.
4. 14 places, each with door, foot, curb (≤ 12 m and routable from the home foot), giver and hangout (≤ 14 m from a lane for friend homes).
5. 7 displaySpots, 8 garage slots, 3 police spots.
6. 25 jars and 15 photo spots walkable.
7. Buildings: no overlaps, ≤ 450 in total.
8. The AI lane graph is strongly connected.
9. SL1-SL3 pass.
10. Deterministic raster hash.
11. Generate time.

**Risks:** scope (mitigated by a ladder of 25 stages and a flag), junction meshing at the ring and crescents (fallback disc), AI deadlocks (reservation, ghosting, soak), tunnelling (substeps), facade repetition (S5c), emptiness (activity every 300-600 m), the shared save, and walking time (fast travel).

## 12. Build log: decisions and as-built corrections

Where this section and an earlier one differ, this section wins. "As built" items describe the code, which is the reference. "Open" items wait for the lead.

### 12.1 Lead decisions (binding)

- Handling is PHYS.v2 as specified (Forza-style grip). The map size is as specified. Sessions start at the villa.
- The 2D game (2d.html, src/main.js) is retired at the end. It must keep loading, but gets no 2D-only work and no 2D verification.
- **Routes:** each world exports `routes` keyed by id. v2 has bay_loop, hillclimb, deco_sprint, glades_scramble, runway_drag and key_coastal, plus the alias `street_kings === bay_loop`. The grid exports `street_kings`. Missions read `routes.street_kings`, falling back to `bay_loop`.
- **Regions:** the 240×10 m gap (x 1330-1570, z 1290-1300) is closed in mapdata. `regionAt` and REG return 'sea' (the last `regions` entry) for sea cells. An 8 m REG cell over the sea keeps its polygon's region when any of its 2 m vertices is land, road, deck or pier.
- **Steep side roads:** seoul_ave (15.8%) and miami_ave (15.2%) are deliberate climbs to the highway. Mapdata gives them `maxGrade: 0.16, steep: true`, and map_check passes them.
- **Junction snap** is 16 m (§6.3).
- **generate()** exports `timing{}` (ms per step, plus `total`). The target is 450 ms; up to about 900 ms cold on the M1 is accepted for now. S9 may move it to a Worker.
- **world-v2 READY** has been `true` since S2b. Since S4a, index.html?map=2 builds the v2 renderer (cityV2); on the grid world cityV2.buildCity refuses and the city facade picks cityGrid. Since S9 the default is v2; the grid is `?map=1`, `KC_WORLD` or the saved `kc-map` (kept for one release).
- The grid's lattice RoadNet costs about 50 ms of grid generate(), which is accepted.

Decided after wave 2 (binding):
- **Kimchi Tower** is a full building (lots.js `TOWER_BUILDING = true`; see §12.2 World data, wave 3).
- **Population density scaling** is accepted: FULL 0.75, FLOOR 0.25 for traffic and 0.1 for people (population.js).
- **High chunk cache:** maxCells 48 on High, 36 otherwise (cityV2 `MAX_CELLS`).
- **Low-sun shadows** past the 110 m cast radius are accepted.
- **Traffic and Kimchi on foot:** traffic never ghosts through Kimchi on foot; it stops and honks, and he is never counted as stuck. This is an exception to "stuck > 4 s gives 1.5 s of ghosting".
- **Signals** were to be switched on only if F4's soaks passed. They passed (f4_signals_soak seeds 1-12 and two 20-minute runs; seeds 1 and 4 again at the wave-3 integration), so mapdata `SIGNALS.enabled = true` since the wave-3 integration.
- **SL2** stays a map_check WARN.
- **Routes:** `street_kings === bay_loop` on v2 (above).

Decided for wave 4 (binding):
- **View budget for this wave:** every v2 bench view at Medium, 1440×800, ≤ 9.5 ms GPU, ≤ 350 draw calls and ≤ 1.5 M triangles (main + shadow), measured with KC3.bench on the user's M1. §11.2's 8.0 ms / 1.2 M stays the S9 target. Node tests that count only the city (s4a_city_test) hold it to 230 calls and 1.25 M, leaving room for cars, people, sky and post.
- **Art direction:** Forza Horizon quality in the stylised cartoon Miami: varied land, dense vegetation where it belongs, haze, glass curtain-wall towers, readable nights. Added textures ≤ 10 MB in total; at most 30 new Orbio pictures in the wave.

### 12.2 As built (S1b, S1c, S2b, S2c, S3a, S3b, S3c, S6a; wave 3 at the end)

**Traffic and people (§9)**
- **Following:** the gap term is min((gap − 7 m)/1.2 s, the speed that stops in the gap at 6 m/s²).
- **Junction conflicts:** roadnet's `conns[].conflicts` lists only connectors whose centre lines cross, so it misses the opposing left/left pairs (50 on the grid, 21 on v2). `traffic.junctionConflicts(cid)` adds every pair from different lanes whose centre lines pass within 2.6 m. Anything that tests junction conflicts (soaks, police) uses it.
- **Lane changes** (hwy and blvd) wait until the car has cleared the junction behind it, and need room on the new lane for the whole 2 s slide. The nose turns into the slide by up to 0.3 rad, while c.vx/vy stay speed × tangent.
- **Streamed cars on v2** arrive with max(20 m, 9 m + 1.2 s × arrival speed) to the car ahead.
- **Grid traffic:** cars taken from traffic (carjacked, or the driver shot) are replaced, so 24 keep driving. Three of the cars left about are kept; past that, the longest-left ones out of view are removed.
- **Peds** drift to their side of the pavement at 0.2 m per metre walked (at most 11.3°), and not at all while waiting at a kerb. After a fright, a ped whose nearest path is a crosswalk walks to the pavement at that crosswalk's nearer end.
- **Kerb parking (v2):** bays every 7 m down the avenues' 2.4 m parking lanes, kept 10 m from junction mouths and the places' kerbs, bays and garages, and 4 m from delivery kerbs. Collins parks on its W side all along.

**Navigation (§9)**
- **Pursuit:** the look is clamp(8 + 0.6v, 10, 40) m. In bends it is shortened so the line to the aim point stays within 1.5 m of the route (never under 5 m).
- **No U-turns for near-ties:** a car moving faster than 5 m/s whose best route starts back the way it came takes the route from 0.6 s ahead instead, if that costs no more than 3 s extra.
- **curvatureAhead** counts a bend of radius R at distance d as R + 2d, plus the car's own heading error.
- **Grid distances** for police and missions stay at today's px values, in TUNE tables keyed by KIND:
  - cops spawn 1500-3000 px out; called-off cops head for a node more than 2400 px away and vanish at 2400 px;
  - roadblocks go up 1400-2600 px ahead;
  - the boss spawns at least 1600 px away on any street and wanders to goals more than 1500 px away;
  - deliveries use a 900-3000 px band.

  v2 uses the §9 values.
- **Race rival:** grip RIVAL_GRIP = 17.5 m/s², instead of 1.25× traffic grip (that made Dex take 77 s for the grid race he drives in 41 s today). Top speed is 520 px/s on the grid and uncapped on v2. The ±10% rubber band acts on top speed, acceleration and grip, at full effect 40 m apart.
- **Race gates** pass on a forward crossing within w/2 + 4 m.
- **Car tuning:** interceptors and the rival set `c.tune {max, acc}`. police.steerTo applies it around driveCar through CFG.carMax/carAcc.
- **For the minimap:** police exports `search {x, y, r: 1300}`, `lastSeen` and `roadblock {cars, x, y, t}`. `nav.deliveryRoute(x, y, {min, max})` returns `{door, curb, len}`.

**Physics (§10)**
- **Wall turns:** a wall met within 45° starts a turn of the nose along the wall at (speed along the wall − 3 m/s)/3 m rad/s, at most 4 rad/s and for at most 0.5 s. There is no turn below 3 m/s along the wall.
- **Barriers along a road:** within a road's halfW + 2 m, when the cells agree within 25°, the road's normal sets the turn target and the damage. The velocity response and push-out keep the cells' normal.
- **Grounded vertical speed** is the grade over the last 3 m (the wheelbase), so sidewalk ripples no longer launch the car.
- **New car fields:** `c.wallTurn {a, s, w, t}` and `c.roll`.
- **gripG** stays 2.0. Indian Creek Bend holds at 170 km/h (0.77 m wide) and runs 1.03 m wide at 175.

**World data (§4.7, §5.7, §6.2, §7)**
- **Decks in GROUND:** GROUND under decks reaches DECK_REACH = 3 m past the deck edge, and TERRAIN there stays the natural ground or the sea bed. People-only decks sit at least DECK_FREEBOARD = 1.5 m over the water: the marina pier at its root's height (1.5 m), the Riverwalk at the seawall top (2.0 m). Deck vertices join terrain's roadMask, so later pads leave them alone.
- **Kimchi Tower** (superseded in wave 3, see below) was first kept out of `world.buildings` (`TOWER_BUILDING = false`), with its 32×32 m footprint stamped into SURF as BUILD with both blocks.
- **Buildings:** there were 384 (361 frontage lots plus 23 prefab buildings); 385 with the tower since F3.
- **Props:** `placeProps` returns every §7 list. W-beam and Jersey rails set BLOCK_CAR, and 31 abutment walls set BLOCK_CAR and BLOCK_FOOT, in SURF, on verge cells and the Loop's deck median only.
- **mapImage()** paints in about 120-190 ms on first use.

**Rendering (§7, §11.1)**
- **chunks.js lazy cells:** `lazy(key, gen, {within?, drop?, layer?})` follows its layer's far every frame ('detail' by default), and drop defaults to within + 40. A built cell shows at d ≤ drop and hides past drop + 20.
- **chunks.js API:** `uploadFirst(attr, n)` sends only the drawn copies, and `stats()` adds `waiting`.
- **chunks.js cache:** the 36-cell LRU never evicts a cell in use, so at High's 300 m detail it runs to about 44 cells.
- **Shadows:** chunk shadow casters are kept within 110 m on both tiers (cityGrid CAST_R).
- **cars.js:** adds `compileFor(renderer, obj, camera, target, lightsFrom)`. main3d prewarms into `gfx.passes.composer.readBuffer` on High, and into the screen on the phone tier.
- **Car shadows:** main3d's `castCars()` runs right after `sky.update`.

#### Wave 3 (F1-F4, S4a, S4b, S5a, S5b, S7b)

**Car against car (F1, v2 only)**
- v2 tests the cars' boxes (population `carOverlap`, separating axes), not the grid's circles. A contact pushes the cars apart by inverse mass (mass = len × wid) and trades an impulse with restitution .3 and Coulomb friction .3.
- A traffic car takes only the part of the impulse along its lane: knocked from behind it is shoved on, head on it slows or stops, from the side it drives on. So §9's "entities:323 = 0" is now the grid only; v2 adds the along-lane impulse to `ai.speed`.
- Display cars don't move. A traffic car ghosting free (`ai.ghost > 0` or `ai.through` is that car) passes through.
- The share of a push that would put a car into a wall goes to the other car; a traffic car that cannot push the other car clear stops.
- An off-centre hit sets `c.knock`: 0.04 rad per m/s of speed given, times the lever, at most 0.35 rad, spread over 0.25 s (at most 1.4 rad/s). A knock that would turn the car into a wall is pushed out or ends.
- Streamed parked cars appear only with 0.3 m clear round their box. A bumped parked car is "touched" and never streams out (§9 as written).
- The grid keeps its circles bit for bit (tools/f1_grid_test against the pre-rebuild copy).

**Navigation (F2)**
- Road-only dodging applies only when the car itself is on the carriageway and aims at it. A car in a car park, on a driveway or knocked off the road sees every car and may pass over any drivable ground.
- `nav.onCarriageway`: a road cell, plus its nearest edge's half width + 1 m measured through `roads.hash` (the same answer as `roads.nearest`). Each car's result is cached by position. If roadnet.js changes its segment hash, `cwMargin` in nav.js is the one place to update.
- steerTo's stuck test: the window runs from the furthest back the car has been in it, and time rolling backward does not count. Back within 1 m of the stuck spot with under 0.5 m progress in 0.4 s, it backs off again at once (not while ramming, `o.ignore`). The back-up count resets 2 m past the stuck spot or 20 m from it; wriggle after 4 back-ups.
- Driveways: a target place with `place.approach` is reached along it; without one (the grid) nav falls back to `place.curb`.
- Tuning baselines: grid Dex race 56.1-58.2 s, v2 Dex race 76.8-80.0 s, v2 cop reach at 2 stars 9.3-30.2 s, grid cop reach median 6.8 s (max 10.3).

**World data (F3)**
- `world.deco` carries every `placeProps` list, each record tagged with `list` ('prefab', 'signals', 'chevrons', 'gantries', 'dangerSigns', 'billboards', 'furniture', 'guardrails', 'fences', 'beachProps') and told apart by `kind`. Signal records keep `group` (the phase group). Shapes and units are in the header of world-v2.js.
- Sidewalks: at a junction a road's round end is paved only to the widest other road's half width there. `stampWalks` then puts WALK under every sidewalk path except crosswalks (on road cells only where no lane or connector runs). No metre of sidewalk path lies on a carriageway.
- `place.approach = {pts: Float32Array px (lane point first, curb last), n, len (px), lane, s (px), edge, road}` for all 14 places, never from the highway. Grass or sand it crosses becomes a 5 m LOT driveway. The grid has none.
- **Kimchi Tower** is building 23 (kind 'landmark', landmark 'kimchi_tower', style 'tower', 32×32×140 m, 142 m in OCC); `landmarks.kimchi_tower.building` points to it. buildings3d builds the shell; landmarks3d builds only the LED crown. 385 buildings.
- mapdata `SIGHT_TARGETS` (read by lots.js and map_check): the island point is (1770,600) at −15.5° (§4.7 gave −12°), a new 'bay' target 1 m over the water at (1420,460), tower r 23. SL3 K-Town passes again (44 of 88 rooftops seen from the terrace).
- TERRAIN kind 'cap' (terrain.js `applyCap`): `villa_vista` lowers the hill up to about 7 m under the villa-Seoul Circle line. The villa pad is L-shaped (front edge at local z 36; the garage court keeps +6 m). The Heights Gate junction is at 53.5 m; villa_dr pins `[[0,53.5],[1,55.3],[2,57.3],[3,58]]`, `maxGrade: 0.12`, `steep: true`.
- crest_rd: points 2-5 lie on the line (806,312)-(865,196), with a rounded 40 m knoll crest; 526.8 m long, min R 42.6 m (country total 845 m). j_crest is at (838.6,247.8).
- generate() is about 510 ms cold on a quiet machine (accepted up to 900).

**Traffic (F4)**
- Lane changes count the cars on the target lane and those still coming into it (on a connector into it, or at a lane end with one planned), at the station they will reach; the 25 m gap grows when closing on a car.
- Junction conflicts also include connector pairs where two of the biggest cars would come within 20 cm (193 more pairs on v2, none on the grid).
- Per-lane stop-line setbacks (`traffic.stopLine(lane)`): 3 v2 lanes, none on the grid.
- Amber: a car stops when it would reach the line after the red and can still stop. Streamed cars are put behind the line at a speed that can stop there.
- A car stops short of the body of a car from its own lane on another connector, and sees a car that has just gone over its line. Yielding cars give way to a priority car waiting at its line. At lights the car that asked first goes first, including cars waiting for the same exit lane.
- Waiting at a red does not count toward the 8 s line-stuck time. A car does not ghost through a stuck car in its own lane.
- `trafficStats().stuckPct` leaves out time held by a red light (`ai.stillX`, `ai.red`); `stoppedPct` is the raw share.

**People (F4)**
- After a fright, the search for a sidewalk goes out to 80 m when there is none within 25 m. People run over road cells (2.5× their pace) while walking back. The 8 s road grace and LOST_T add the time the walk back takes at the person's pace (`p.snapEta`).
- A crosswalk needs max(15 m, v²/(2·5 m/s²) + 4 m) clear to each moving car; a traffic car standing still blocks it only within 4 m. (Visible on the grid too: people now cross in front of cars waiting at all-way junctions.)

**Terrain, coast and sky (S4a)**
- Terrain is MeshLambert plus sky fill. Its point and spot light loops are skipped by a per-frame uniform while every lamp, headlight and police light is off (`lampGate`, no recompile). Detail lookups stop where the detail has faded (170 m and 280 m). Rock starts at about 30°.
- `toneAlbedo` repaints the far albedo once after the first frame: water and shallows become stone on the coast, mud in the marsh and paving more than 3 m above the sea; decks take the colour of the ground round them. mapimage.farAlbedo itself is unchanged.
- Water is MeshBasic, lit by hand, with no shadows. Past the map edge the sea keeps the edge's depth and blends to 20 m over 400 m. The depth texture stores the shelving, so foam is measured from the waterline; ponds share the sea's ripple texture and have no rolling lines.
- Seawalls follow runs of connected shore edges and stand only where the ground goes under the water within 5.5 m and falls away from the shore. Fill flanks at the MacArthur landing and the causeways are natural stony banks. coast3d builds the marina pier (roads3d skips the 'pier' bridge). Yachts take berths from a table and slide out to water with a 3 m gap.
- sky.js `V2_NIGHT` (skyKeep 0.22, moon 0.5) is an interim v2 night floor; the grid's values are unchanged.

**Roads (S4b)**
- Road tiles are drawn to terrain3d `LOD0_R` (350 m, 250 m on the phone tier) with the terrain's 20 m hysteresis, not 400 m.
- 5 materials: asphalt, concrete, paint, dirt and a joint-free stone (walls, bridges, revetments). A tile is at most 5 draw calls; bridges 2. The roads total about 287 k triangles.
- Kerb roll-up is capped at 0.2 m; past that a stone kerb wall (at most 0.8 m) holds the ground back. Sidewalk outer edges rise up to 0.3 m to meet pad lawns.
- Abutment patches are stone revetments (1:1.5, hipped), not walls. The asphalt (and the paint's fade) mixes a second rotated, enlarged lookup to hide tiling.
- Junction ring vertices are lifted up to 0.3 m where terrain would come within 5 cm; nodes 2 and 47 are meshed in rings round a lattice centre. Jump ramps are humps the width of the carve's lift, with berms.

**Buildings (S5a)**
- v2 builds the villa design 0.5 m inside its footprint at the sides and back and 1.55 m at the front (buildings3d `VILLA_IN`), so the ground-floor glass stands under the cantilever; the 7 glass mansions share it.
- The office lobby is its own picture (textures `lobbyInterior`, painted at real proportions) repeated every 12 m; interior atlas rows are 1024×256.
- Colour layers are 1024 px on High, 768 on Auto, 512 on Low; a stack's mipmaps are made once its queue is empty. Hotel names are handed out in turn along Collins.
- Lit windows read night from the material's light uniforms, with no scene traversal.

**Props and landmarks (S5b)**
- Light pools are 1 m grids draped over groundY (props3d `drapePool`), merged per 256 m tile (41 tiles, 517 pools, about 175 k triangles), drawn after dark within 170 m (Low 119 m), fading over the last 30%, fog off. `props.stats().pools` reports them.
- Traffic lights come from `deco` list 'signals': the KayKit model with props3d's lenses, coloured from `roads.signalAt(node, edge)` and dark while the signals are off.
- landmarks3d puts each pylon strip's centre line on the causeway_pylon entry (`strips`); s5b_test holds them to roads3d's leg faces. The lighthouse beam is a soft shader (`softBeam`, BEAM_GLOW 0.24).

**Maps and markers (S7b)**
- Minimap range 2600-7200 px (10-50 m/s, easing over 0.7 s, look-ahead 0.35 R). The GPS is worked out at most once a second (Douglas-Peucker 0.75 m), to the main mission beacon before a delivery. ui exports `mapPins`, `bigMapHooks`, `bigMapStats` and `mapPicture`. Photo and giver markers use 12-marker pools. Jar seen flags are shared between maps.
- save.js and state.js are unchanged since S0d.

**Integration (wave 3)**
- mapdata `SIGNALS.enabled = true` (§12.1). The raster hash is unchanged (83c3081c).
- Stale test assertions brought in line with these decisions: s2c_lots_test (exactly one building is the tower), s0b_city_test (cityV2 refuses the grid world), s4a_city_test (the lamps are props3d's), s5b_test (the lens checks start from the signals off and put them back).

#### Wave 4 (P1-P4, S6b, S7a, S8, S9)

**Terrain look (P1)**
- terrain.js `groundCover` adds `brown` (lawn upkeep, 0..1) from a 24 m yard noise, the patch noises, the region's dryness and worn edges 3-9 m from walks and roads. `COVER_RGB` has a four-step lawn ramp (lawnLush, lawn [92,114,66], lawnDry, lawnBurnt), warmer rock and earth (rock [156,138,108], rockDark, rockWarm, dirt), mud [72,66,50], hammock [58,88,50] and golden sawgrass [154,140,86].
- `toneAlbedo` paints 3.2 m limestone strata with dark seams into stone pixels (`strata()`); the shader's slope tint is #907b60 and its bed contrast 0.45, fading by 90 m.
- Glades: a mud rim full to about 10 m from the water and gone by 20 m; hammocks have their own isle mask (no sawgrass).
- The cover is lazy: `buildTerrain3D` no longer computes it; `terrain.cover` is a getter, `ready()` runs from the first `setAlbedo` (after the first frame) and re-splats the near grids built so far. `T3.coverOf(world)` is cached per `world.grids`. Read it after the first frame, never inside buildCity.

**Vegetation (P2)**
- props.js `placeFlora`: denser woods (spacing 0.62 → 0.42 in the cores, an understory tree), a mangrove fringe 6-22 m deep, sawgrass tufts in noise patches (new export `marshAt(x, z)`, metres → 0..1), wild shrubs gathered by trees, verges, banks and dunes, tree-pit palms marked `pit: true`. About 8,570 trees and 7,300 tufts.
- flora3d: two bald cypress shapes (`cone`, `cone_b`); the far mesh is split into 768 m squares and uses 3-triangle spikes for trunks and tufts; tall grass stays at 50/60 m. At night, foliage bluer than green loses 60% of its saturation, keyed to `light.sun`.
- placeFlora runs inside buildCity (about 170-230 ms plus 50-66 ms building).

**Buildings (P3)**
- Tower night windows light in blocks of about 1.5 bays × 2 floors, each busy or dark, colour per block; far away a tower averages about 0.13.
- Heights villas: windows on every wall, teak terraces, green or solar roofs, one clad volume, closed cantilever soffits, glass balustrades (rows with uv v < 0 on the curtain and glass layers are balustrade and light no room; real walls keep v ≥ 0).
- Champagne glass only on towers of 7-24 floors (sleek 33, banded 24, stone 18, champagne 4). LED crowns are dark by day. The sun glare in the mirrored sky reads `directionalLights[0]`, which must stay sky.js's sun.

**Villa, nights and landmarks (P4)**
- prefabs.js exports `VILLA_POOL`, `VILLA_TERRACE` and `villaFrame(door)`. The pool's WATER cells start at local z 25 (pool 20 × 7 m), so the §5.1 foot spot is 1.4 m clear of the water; main3d's `standAt` also moves Kimchi to the nearest clear spot. props3d `villaTerrace()` draws the deck, coping, infinity edge, planters and the pool water (one shader quad with faked depth). The villa prefab returns `out.pool = {obb, y}` (not forwarded by world-v2).
- sky.js v2 night: `V2_NIGHT = {skyKeep 0.22, moon 0.72, fill #4a66ad ×0.32, env +0.12, exposure +20%}`, a blue city-glow band at the horizon. This replaces S4a's interim floor.
- Seoul Circle gets 12 ring lamps and 8 park-path lamps (prefab lamps, `world.lamps` 497 → 517). Neon Alley's festoons, lanterns and pink pools are props3d-only (no `lampHeads`).
- `landmarkSolids(world)` / `applyLandmarkSolids(world)` stamp BLOCK flags into SURF and tops into OCC once (`grids.landmarkSolids`). landmarks3d's `buildLandmarks` runs it, so headless sims that only call `generate()` do not have them (see §12.3). The Ferris wheel slab is at 0.16 m (walkable, cars blocked).

**Cars, camera and feet (S6b)**
- cars.js `syncCar(v, c, dt, ground, …)`: `ground` is a number on the grid (unchanged, eased) or a function (v2: surfaceY). On v2 the car pitches and rolls with the plane through its four wheel contacts (Euler YZX), at most 2.5 rad/s and never more than 7 cm off at the furthest wheel; each wheel follows up to a 1:1 grade, steps ease at 6/s, ±12 cm suspension, lifted for the slope under it.
- Airtime: a car is free when `c.air > 0` or `c.gy` is 5 mm over the ground; the body flies at max(plane, c.gy + take-off offset fading at 3/s), wheels hang 10 cm, `c.squash` sinks it up to 14 cm.
- A pose jump no car could drive is drawn as a skid offset eased over 0.35 s; past 4 m it shows at once. `wheelGap(v, ground)` measures it.
- main3d v2 chase camera tests a 0.6 m disc (0.3 m shoulder) against the ground and `occluderTop`, keeps 0.45 m clear, pulls in to 4 m (car) / 1.8 m (foot), then lifts in 0.08 rad steps to 1.25 rad. Kimchi's feet follow smooth slopes at once. Cars in SHALLOW throw spray.
- main3d calls `updateWorld(dt, {tier, view})` on v2: tier 'low' on the phone tier or gfx level ≥ 3, 'high' at Ultra/High, else 'medium'; view = camera FOV ×1.4 to 260 m plus a 40 m bubble. The grid gets no options.
- Dev hooks (only with `?shot=`): `&route=x0,z0,x1,z1[,vmax]`, `&go=x,z,heading[,speed]`, `&freeze=<s>|air`; `KC3.metrics`. tools/s6b_test.mjs and s8_slide_test.mjs cut main3d's source at marker lines (`const CAM_R = 0.6`, `const desired = new THREE.Vector3()`, `const FOOT_GRADE`, `// Spray where`, `const SLIDE_DRAW`, `let pruneT`); keep them.

**Missions and police (S7a)**
- Rival on v2: 42 m/s, ±7.5% band at full effect 40 m apart (grid unchanged). Police on v2 see 170 m, officers on foot 70 m, sirens 260 m; the search circle's radius is the see distance.
- K-Spray always resprays a car with `c.sprayJob`, and a respray keeps hp above 100. `goto` to a place may finish at its curb in a car. Friends dropped off go home once Kimchi is 120 m away (1500 px on the grid). Yuna's damage limit is 30 on v2. The Red Bandanas stand 9 m round the airboat yard.
- Photo spots: ×1.25 each for the matching time (golden hour 17:00-19:30, night 20:00-05:00) and for the landmark in frame (on screen with a clear line of sight), on top of the light multiplier. lifestyle exports `photoView` (main3d may set `photoView.camera`).
- Friends' `v2Lines` (data.js) are appended to their chat lines on v2 by missions.js.

**Open-world layer (S8)**
- The drift is drawn by main3d `syncMine`: the whole car turned about its front axle by the slide, capped at 40°, via `activities.slidePose`; front wheels `v.steer + slide` (±0.75 rad); speedometer `vf / cos(slide)`; `slideRoom` shrinks the slide to 2/3, 1/3 or 0 where a swung rear wheel would stand more than 10 cm off the slope. The chassis is never yawed for a slide.
- busyReason also refuses during a delivery; getting wanted during an event's countdown or race abandons it; hub popups wait for the event to end; held toasts come out one per 1.5 s. Countdown at 29vh (phones 36vh), clamp(84px, 13.5vw, 135px). The big map's backdrop is the picture's average edge colour with a 1.5% edge fade.

**Default and sky (S9)**
- src/world.js picks v2 by default; the grid with `?map=1`, `globalThis.KC_WORLD`, `kc-map` or (node) the `KC_WORLD` environment variable. index.html's map link is a module reading `KIND`. tools/s9_suite.mjs runs every node check, giving the grid-era tests `KC_WORLD=grid`.
- sky.js, Kimchi Key high tier: `clear = dayMix × (1 − golden)`; the sky within 0.3 rad of the horizon dims up to 34%·clear; the tint goes (0.82, 0.95, 1.12) → (0.58, 0.77, 1.04) with `clear`; the haze band's top 0.12 → 0.04 rad; below the horizon the dome is the haze colour (`under`); day haze #9cc6e8; cloud day colour (1.42, 1.38, 1.30), gold ×1.2. Day fog stays 0.00055 (§0). The grid keeps its values.

**Integration (wave 4)**
- Stale test assertions brought in line: s2b_world_test (the default is v2; the grid via KC_WORLD='grid'), s4a_city_test (dry-water floor 50 instead of 100, now that the villa pool is real water; the city's bench budget 230 calls / 1.25 M per §12.1 wave 4).
- Headless bench and soaks after wave 4 are in the wave-4 integration report.

### 12.3 Open

Resolved in wave 3 and moved to §12.1 or §12.2: Kimchi Tower, density scaling, the High chunk cache, low-sun shadows, traffic and Kimchi on foot, j_crest, signals, world-v2 props, SL3 K-Town.
Resolved in wave 4 (§12.2 Wave 4): main3d's `updateWorld(dt, {tier, view})`, cars.js `c.gy`/`c.squash`, the villa pool and its invisible wall (the new-game spawn is clear), sky.js `V2_NIGHT`, and the camera against overhangs (S6b's 0.6 m disc).

Sim and data:
- **Landmark solids in generate():** they are stamped only by landmarks3d, so node sims and soaks miss them. Add `applyLandmarkSolids({ landmarks, roads, deco, groundY, surfaceAt, palms, trees, grids, SAND, GRASS, SEA_LEVEL })` to world-v2 `generate()` step 11 after `addLandmarks` (clear `grids.landmarkSolids` first, so a second generate() stamps the fresh rasters), and update p4_test's "landmarks3d stamps" check.
- **Fest arch columns on the sidewalk:** the two arch columns at about (810, 1340) and (830, 1340) sit on walk path 167, so people walk through them (integration soak with the solids applied: 8-61 samples on every v2 seed). Move the columns off the walk, or route the walk round them (prefabs.js / world-v2 walks).
- **Car pushes and nav:** police cars and the nav-driven car follow traffic at contact distance and, with F1's along-lane impulse, shove it into the car ahead (v2 soak seed 7: 4 pairs under 3 m).
- **nav.dodge and kerb parking (S7a):** a car parked in a kerb bay 3-3.5 m to the side counts as in the way (PASS 3.5 m), so AI drivers crawl at 2-3 m/s down avenues with parking. AI drivers (Dex, cops) also hit cars stopped at junctions; side-road traffic does not see managed cars.
- **Street Kings** is close on v2 (Dex 42 m/s against the Ursa's 43.9); a sloppy driver may need many tries. 41.5 m/s is the easier option.
- **Grid:** the forced-ghost merge (traffic.js) and the carjacked driver placed off the map (entities.js `enterCar`, peds.js) still fail grid soak seed 7.
- **Bump-touched parked cars** never stream out (F1): accept, or drop bump-touched (not driven) cars out of view beyond 300 m.
- **population.js** `STUCK_DROP` reads `ai.still`, which includes red-light waits; `ai.stillX` would keep queued cars.
- **Fleeing people** run onto highways and NOPED cells (entities.js); peds.js brings them back.
- **World data for the renderers:** sand fill horns beside deck ends (terrain.js carve); GROUND 0.4-0.6 m over the Loop's design at node 3; a scatter rock through node 5's fillet (stamp fillets as ROAD); bench views causeway_hump and pass_crest put the car on the centre line or the median barrier.

Rendering and look:
- **GPU time:** after wave 4, headless KC3.bench at Medium (tools/s9_bench.mjs, median of 2, ×0.59) gives 6.7-8.5 ms by day and 7.7-8.6 ms at 21:00, 84-282 calls and 0.27-1.31 M triangles: the wave budget (§12.1) holds in every view, and the M1 numbers need the Browser pane. Load: generate 334-392 ms, buildCity 708-812 ms, first frame 1.65-2.0 s. §11.2's 8.0 ms / 1.2 M is not met by villa_terrace (1.29 M); the lever S9 names is terrain3d `LOD0_R` 350 → 300 (roads3d and cityV2 follow it).
- **High detail distance:** cityV2 never calls `chunks.setFar('detail', 300)`, so detail cells stop at 220 m on every tier.
- **Night from the air:** the night fog (0.0008) and blue fill turn the island into a dark blue wash from about 1 km; streets show no lamp points beyond the 170 m light pools (sky.js, props3d).
- **Night palms:** palm fronds stay bright lime at 21:00 on Ocean Drive while other foliage darkens (palms3d / flora3d palm material).
- **Look defects after wave 4** (owners in brackets): the Fest grounds are a bare cream slab with a kiosk and the Ferris wheel (props/prefabs); the boulevard median and fest junction ped slab read as a tan boardwalk across the asphalt (roads3d); resort and Deco mid-rises still read as pastel window mosaics from the air (buildings3d); the Heights lot pads are pale and bare round the villas, and a hillside trail is painted near-white (terrain3d / flora); open fields between the Fest, the airport and the south island are still flat lawn with sparse trees (props.js flora density); the billboard backs are black (props3d); the airboat yard is a bare asphalt square (prefabs/props); the villa terrace deck is near-white in sun.
- **Big map and HUD (S8):** the rotating minimap turns the picture's own labels upside down; hide the region title and radio name during an event's travel and countdown (hud3d.js). The big-map picture has a darker band along its right edge (mapimage). Region names are painted into the picture; `renderMap` needs a `{labels}` option (S7b).
- **Pond spray** shares the 420-point particle pool; a fast pond crossing holds 150-250 (S6b).
- **Drift score** is a turn-rate stand-in; retune the [3, 8, 14] marks after a human drive (S8).
- **Day fog:** S9 kept `V2_FOG.day` at 0.00055 (§0 and s4a_city_test line 401 pin it); 0.0004 would thin the haze.
- **KIMCHI letters and the pylon** cannot be read from the villa_terrace eye point (letters' heading, a higher terrace camera, or the villa umbrella).
