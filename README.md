# Kimchi City

A mini open-world game starring [@kimchi1x](https://x.com/kimchi1x), styled after his posts: a concrete-and-glass villa with an infinity pool,
a garage of supercars, watches, private jets and yacht days. Drive, shop, make friends, take on story missions, borrow cars and
outrun the cops, GTA style, across **Kimchi Key**, a Forza-style open county of cartoon Miami.

- `index.html` — the game (Three.js 0.169, vendored in `vendor/`). It opens on Kimchi Key; `index.html?map=1`
  (the "classic map" link on the title screen) still plays the original grid town for one more release.
- `runner.html` — the first mini-game, Kimchi Run

Everything is static files with no build step. Saves live in each player's browser, and one save plays on either map.
The old top-down 2D version (`2d.html`, `src/main.js`) is retired.

## Run it locally

```bash
python3 serve.py
```

Then open http://localhost:5173. `serve.py` is a plain file server that tells the browser to re-check files, so edits show up on reload.

## Update the live site

Live at https://kimchi-city.vercel.app (Vercel project `kimchi-city`). From this folder:

```bash
vercel deploy --prod
```

`.vercelignore` is an allowlist: only `index.html`, `runner.html`, `src/`, `vendor/` and `assets/` are uploaded, so anything else in this folder stays on your computer. To publish a new top-level file or folder, add a `!/name` line to it.

## Kimchi Key, the open world

A 2 × 1.8 km county (8 × 7 tiles of 256 m) built from data, not drawn by hand. The full design is
`docs/map-v2-spec.md`; its §12 is the build log of what was decided and how it was really built.

**What is on it.** Coral Heights, a 58 m limestone dome with the villa on the summit, sea cliffs and a five-leg
switchback road; the North Shore with the KIMCHI letters on Lookout Knoll; Koreatown round Seoul Circle (a one-way
roundabout, Fountain Park and Neon Alley); Downtown/Brickell with Kimchi Tower (140 m) and Bayfront Park; the Gables
(barrel-tile houses, banyans, a golf course); the Glades (marsh, ponds you can drive through, mangroves, cypress
domes, the airboat yard); Kimchi Fest and Kimchi Air (the festival hub, a Ferris wheel, the runway drag strip); the
Port (container stacks, cranes, a drift yard); Deco Beach on the island (Ocean Drive, Collins, Lincoln Road, South
Pointe); the Venetian islets and Star Island; and Cape Kimchi with its lighthouse. The **Kimchi Loop** (4.3 km of
highway, T-junctions only) ties it together over the cable-stayed North Causeway, Heights Pass and the Runway
Straight, with about 20 km of road in all. Traffic lights, lane traffic, people on the sidewalks, parked cars,
police and the seven story missions all run on it. The Forza layer (`src/3d/activities.js`) adds speed traps,
speed and drift zones, danger-sign jumps, the race board at the Fest and fast travel between discovered hubs.

**How it is generated** (`src/world-v2.js` `generate()`, synchronous, about 0.4 s in the browser, no three.js, so it
also runs in node):

1. `src/map/mapdata.js` holds the authored county in metres: coast polygons, terrain domes, ridges and
   flattening, every road as control points with its class, the places, jars, photo spots, landmarks and routes.
2. `src/map/terrain.js` builds the natural TERRAIN (2 m vertices) and the coast's distance field;
   `src/map/spline.js` samples the roads (centripetal Catmull-Rom, 2 m) and `src/map/roadnet.js` turns them
   into the RoadNet: nodes, edges, lanes, junction connectors and the sidewalk graph.
3. Road profiles are solved (grades, banking, bridge decks) and carved into GROUND, the walkable surface.
4. `src/map/prefabs.js` places the hand-made sites (the villa, Seoul Circle, the Fest, hangars, mansions),
   `src/map/lots.js` fills every frontage with buildings in its region's style, and `src/map/props.js` adds lamps,
   signals, signs, guardrails, beach props and every tree, palm and shrub (`placeFlora`).
5. The rasters the game reads: SURF (1 m kinds and blocking flags), OCC (what the camera cannot pass), REG
   (regions) and SEADEPTH, then lanes, jars, photo spots and routes, and a validation pass.

`src/world.js` is the facade every module imports; it picks the world once at load (Kimchi Key by default,
the grid with `?map=1`, `globalThis.KC_WORLD`, localStorage `kc-map`, or `KC_WORLD=grid` in node).
`src/sim/` runs the traffic, people and navigation on either world's RoadNet.

**How it is drawn** (`src/3d/cityV2.js` orchestrates; everything streams through the chunk manager,
`src/3d/chunks.js`, which shows each 256 m tile or 128 m cell only near the camera and lets it cast shadows only
near Kimchi):

- `terrain3d.js` — a 2 m terrain grid within 350 m of the camera (vertex splat of grass, sand, limestone, earth and
  paving over Poly Haven detail photos) and an 8 m grid beyond, both coloured from the painted far albedo and the
  ground cover (lawns, dry grass, sand, limestone strata, Glades mud); the 8 m grids are merged into a few meshes.
- `roads3d.js` — road ribbons, junctions, kerbs, markings and bridges; far roads are painted into the albedo.
- `buildings3d.js` — one merged shell mesh per tile for every building, detail cells near the camera, glass
  curtain walls drawn by shader, painted facade atlases per region.
- `props3d.js`, `landmarks3d.js`, `coast3d.js` — street furniture and lights, the landmarks, the sea, ponds and boats.
- `flora3d.js` — every tree, palm, shrub and hedge in three levels of detail (full, light, and a merged far mesh),
  with `palms3d.js` palms and `scatter3d.js` ground plants.
- `sky.js` — sun, moon, haze and the Forza-style blue night. On a clear day the sky stays blue down to the last
  few degrees above the horizon, the far county fades into a light-blue haze, and the clouds are brighter than the
  sky behind them. `graphics.js` — bloom, grade and auto quality.

**Assets it uses.** Poly Haven CC0 photos in `assets/tex/` (asphalt, concrete, granite, sand); Orbio-painted
facade, shop and sign atlases (`tools/gen_city_textures.py` paints them into `refs/city*/`,
`tools/build_city_textures.py` packs them into `assets/tex/`, ~$0.15 a picture, key in `.env`); Quaternius'
Stylized Nature MegaKit (`assets/nature.glb`) and Kay Lousberg's KayKit City Builder Bits (`assets/street.glb`),
both CC0; the Blender-made palms (`assets/palms.glb`) and cars (`assets/cars/`).

### Tools for the map

All in `tools/`, run from this folder with node 22 (no installs). The browser ones need `python3 serve.py` running.

- `node tools/map_check.mjs` — runs the generator cold and checks the spec's invariants (radii, grades, junctions,
  decks over water, places and curbs, jars and photo spots, building overlaps, a strongly connected lane graph,
  sightlines, a deterministic raster hash, generate time); writes `tools/out/map_v2.png`, `terrain.png`, `summary.json`.
- `node tools/check_exports.mjs` — the world and city facades: every imported name exists in both worlds, nothing
  under `src/map`, `src/sim` or `src/world*.js` reaches three.js, and the facade picks the map as specified.
- `node tools/roadnet_test.mjs`, `node --experimental-vm-modules tools/check_syntax.mjs <files>`.
- The stage tests `tools/s*_test.mjs`, `f*_test.mjs`, `p*_test.mjs` and the soaks (`s1c_v2_soak`, `s6a_soak`,
  `f4_signals_soak`, `s7a_missions_soak`). Most build the v2 world in node; the ones written for the grid set
  `KC_WORLD=grid` (or run them as `KC_WORLD=grid node tools/<test>.mjs`). `node tools/s9_suite.mjs` runs them all.
- `tools/shot.sh '<query>' out.png [w h]` — a headless Chrome screenshot, e.g.
  `tools/shot.sh 'shot=pass_crest&hour=17' /tmp/pass.png` or an aerial with `&cam=x,y,z,lookX,lookY,lookZ` (metres);
  `&hour=21` for night. Bench views: villa_terrace, pass_crest, ktown_circle, downtown_flagler, causeway_hump,
  ocean_drive, fest, glades. `tools/s8_rtshot.mjs` captures moving scenes in real time.
- `node tools/s9_bench.mjs [--hours=13,21] [--uncapped] [--low]` — KC3.bench on every view in headless Chrome
  against the budgets; `node tools/s9_probe.mjs <view>` — where a view's frame time goes (shadows, bloom, terrain,
  materials, clouds), with `--tris`, `--casters` and `--profile`; `node tools/s9_soak.mjs [--sec=900] [--drive=...]`
  — frame times and heap over a long run. Headless GPU timers read 2-3 times high on the M1 (they count idle
  gaps); the Browser pane's `KC3.bench()` is the reference.
- In the game's console: `KC3.teleport('fest')`, `await KC3.bench()`, `await KC3.soak(900, { route: true })`.

## The GTA layer

- **Story missions**: walk into a yellow marker (yellow letter on the minimap). Seven missions in `src/3d/missions.js`,
  each a list of steps (talk, goto, pickup, dropoff, deliver, race, kill, getcar, wanted, lose, spray, destroy).
  Finished missions are saved in `G.story.done`.
- **Weapons**: fists, pistol, shotgun and assault rifle (`WEAPONS` in `src/3d/combat.js`), sold at K-Arms with ammo and body armor.
  Click the game to grab the mouse; right-click aims over the shoulder, left-click shoots, 1–4 / Q / wheel switch, R reloads.
  F (and the 🔫 touch button) shoots at the nearest target in front.
- **Wanted stars and police** (`src/3d/police.js`): crimes raise the wanted level; police cars chase along the streets,
  officers get out and arrest or shoot. Break line of sight to lose them, respray at K-Spray, or pay fines at the station.
  Health 0 is **WASTED** (wake up at the hospital), being caught is **BUSTED** (walk out of the police station).
- **Cars** take damage, smoke, catch fire and explode. In the car you drive, the windows go clear so you can see Kimchi
  (and a friend) inside.
- **Radio**: three stations composed live with Web Audio (`src/3d/radio.js`); R changes station while driving.

## The luxury life (3D)

- **Money and followers**: a new game starts with $150K, 197.5K followers and a Toro Ursa on the villa drive. Older saves
  get the same welcome package once (`lux` flag in `src/save.js`).
- **Cars** (`CAR_TYPES` in `src/data.js`, models in `src/3d/cars.js`): parody versions of the cars in Kimchi's posts —
  Toro Ursa, Gelände 63, Monarch S680, Royce Phantasma, Cavallo 812, Papaya 750S and the Bolide Chiro hypercar.
  Sold at Kimchi Motors; every car you own is parked on the villa drive (`spawnGarage` in `src/entities.js`).
  Their 3D models are made in Blender by `tools/blender/build_cars.py` and saved to `assets/cars/<type>.glb`
  (rebuild with `~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_cars.py -- [types] [--preview]`).
  The game swaps its own paint, glass and light materials onto them by part name, and falls back to the
  built-in cars in `src/3d/cars.js` if a file doesn't load.
- **Look**: Fortnite-style cartoon (bright sky with puffy clouds in `sky.js`, soft shadows, saturated grade, painted textures).
- **Palms** are made in Blender by `tools/blender/build_palms.py` (`assets/palms.glb`: cartoon serrated fronds, three
  crowns, detailed + light versions swapped by distance, wind sway in `src/3d/palms3d.js`). On Kimchi Key `flora3d.js` plants them in
  coastal groves, boulevard medians and the causeway fill; in the grid town every round tree is a palm and the
  sidewalks get rows of them (`palmSpots` in `cityGrid.js`). None of them block movement.
- **Art Deco streets** (`decoDetails` in `cityGrid.js` and `buildings3d.js`, `decoFacade`/`neonAtlas` in `textures.js`): pastel stucco,
  eyebrow ledges over each window row, glossy windows that mirror the sky, stepped parapets, neon hotel pylons.
- **Painted facades, shop fronts and signs** (Orbio, Gemini 3 Pro Image, ~$0.15 a picture): `tools/gen_city_textures.py`
  paints the stucco, four window styles, the 12 shop fronts and their 12 signs into `refs/city/`, and
  `tools/build_city_textures.py` turns them into the atlases in `assets/tex/` (`facade*.jpg`, `shops*.jpg`,
  `signs.jpg`, including the night-glow versions). The game swaps them in for its canvas paintings once they load
  (`replaceCanvas` in `textures.js`); each shop bay shows the front that matches its sign.
- **Characters** are modelled in Blender by `tools/blender/build_char3d.py` (`assets/chars3d/<name>.glb` + `.json`):
  Kimchi and his outfits, the friends, pedestrians, cops and the rival, each a spec of body, hair style, top,
  bottoms, shoes and hat. They use the same 17-bone skeleton as the old photo-built people (`src/3d/char3d.js`),
  so every animation and pose works on them; anyone without a model falls back to the photo version.
  `tools/blender/glb_pack.py` packs the files small (1-byte normals, colours and weights).
- **AI-made characters** (the look of the Tripo/TRELLIS examples): `tools/hf3d.py` turns a T-pose picture into a
  textured 3D model with the free TRELLIS.2 Space on Hugging Face (`HF_TOKEN` in `.env`, a few per day), and
  `tools/blender/rig_ai_char.py` rigs it to the game skeleton as `assets/chars3d/<name>_ai.glb` (and takes the
  green-screen spill out of its texture; `tools/despill_glb.py` does the same to an existing file). The game uses a
  character's `_ai` version first, then the modelled one, then the photo one. Kimchi has one so far; a daily
  scheduled task makes the next cast member.
- **Painted faces** (`src/3d/face.js`): AI-made models come out with soft, smeared faces, so a painted one goes
  over the front of the head. `tools/gen_faces.py <name>` paints a straight-on portrait and the same portrait with
  closed eyes through Orbio (`refs/faces/`); `tools/blender/build_face.py <name>_ai <name>` finds the eyes and
  mouth on the model (rays cast at its head, colours read off its texture) and on the portrait, fits one to the
  other and writes `assets/chars3d/<name>_ai_face.jpg` plus a `face` entry in the model's json (check picture:
  `refs/faces/<name>_ai_check.png`). In game the face is a thin shell on the head bone, faded into the skin at its
  edges and lit as a smooth rounded face; the character blinks every few seconds.
- **Motion capture** (`src/3d/anim.js`): everyone moves with Quaternius' Universal Animation Library 1 + 2 (CC0,
  quaternius.com): idle, walk, jog, sprint, jumps, punches, pistol ready/aim, falling and getting up, talking and
  more. `tools/blender/retarget_ual.py UAL1.glb UAL2.glb` retargets the clips onto our 17-bone skeleton
  (`assets/anims/ual.json` + `ual.bin`, 16-bit, ~240 KB) and measures each cycle's stride speed and foot timing.
  - Walk, jog and sprint blend by real ground speed on one step clock (aligned on the left foot's landing), and
    the playback rate is matched to the speed, so planted feet stay put (measured: ~0.05 m/s of slip at 5.5 m/s).
  - State changes ease out of a frozen snapshot of the last pose; characters lean into turns; a pistol uses the
    motion-captured ready and aim poses (blended by aim pitch), rifles and shotguns the procedural ones (`guns.js`).
  - Speeds match the clips: jog 5.5 m/s (W), sprint 9.4 m/s (Shift), walking people 1.2 m/s; starting, stopping
    and breaking into a sprint take a moment (`readInput` in `main3d.js`).
- **Asset packs** (free, CC0): `assets/nature.glb` (grass, clover, flowers, ferns, bushes, rocks, park trees from
  Quaternius' Stylized Nature MegaKit, quaternius.com) and `assets/street.glb` (traffic lights from Kay Lousberg's
  KayKit City Builder Bits, kaylousberg.com), packed by `tools/blender/pack_assets.py` and scattered by
  `src/3d/scatter3d.js` (by `flora3d.js` on Kimchi Key; `natureSpots` / `streetSpots` in `cityGrid.js` on the grid). `three`'s GLTFLoader is in `vendor/addons/loaders`.
- **Ground and sea**: road, sidewalk, plaza and beach use CC0 photo textures from Poly Haven (polyhaven.com) in
  `assets/tex/` (asphalt_02, concrete_floor_worn_001, granite_tile, aerial_beach_01), toned to the cartoon palette
  when they load (`upgradeGround` in `textures.js`). The sea is a shader (`coast3d.js` on Kimchi Key, `buildCoast` in `cityGrid.js` on the grid): turquoise shallows to deep
  blue, foam at the waterline and wave lines rolling in.
- **Traffic cars** (sedan, hatchback, taxi, police, sports): Quaternius' CC0 Low Poly Cars, converted by
  `tools/blender/convert_qcars.py` into the same parts as the other cars (`assets/cars/<type>.glb` + `traffic.json`
  with each model's axles, wheel size and track).
- **Street life** (`props3d.js` on Kimchi Key, `buildStreetLife` in `cityGrid.js` on the grid): cafe terraces in front of shops, benches, bins, hydrants,
  hedges and flower beds, and lifeguard towers, umbrellas and towels on the beach. Visual only.
- **Graphics tiers** (`src/3d/quality.js`): computers get the physical sky that also lights and reflects in
  everything (`sky.js`), PBR materials, clear-coat paint, bloom and a colour grade (`graphics.js`, three.js add-ons
  in `vendor/addons`); phones get the light version. Force one with `?gfx=high` / `?gfx=low`, or the Graphics
  switch on the title screen.
  - Quality levels: Ultra (adds ambient occlusion), High, Medium, Low, Lowest: resolution, bloom and shadow detail.
    Auto starts on Medium and times the graphics card every frame (`EXT_disjoint_timer_query_webgl2`): it steps
    down when a frame takes it over ~12 ms and up when there's lots of room, and remembers where it settled
    (`kc-gfx-level2`). On an M1 at 1440x800 the grid town took Medium ~5.5 ms, High ~11 ms, Ultra ~55 ms; Kimchi Key's
    bench views take about 7-8.6 ms on Medium (budget: 8 ms, 380 draw calls, 1.2 M triangles). Draw calls are what
    the M1 feels most, so far terrain, clouds, shells and plants are merged or instanced.
  - Bloom, tone mapping and the grade are one cheap pass (`FilmPass`): the glow is blurred at a quarter and an
    eighth of the screen size. three's UnrealBloomPass and GTAO cost ~19 and ~18 ms a frame on an M1.
  - **FPS meter**: press <kbd>&#96;</kbd> or <kbd>F3</kbd> (or add `?fps=1`) for frames per second, the slowest
    frame, the graphics card's time per frame and the quality level.
- **Photo spots** (`photoSpots` from the world, `src/map/mapdata.js` on Kimchi Key, posting in `src/3d/lifestyle.js`): press P at a pink marker to post.
  Followers depend on the spot, the car in the shot, your fit and watch, and golden hour; brand deals pay cash.
- **Shops**: Maison K (fits, accessories, leather goods, caviar), Chrono Row (four watches, worn on Kimchi's wrist),
  Kimchi Air (charter or buy the jet; trips to Napa, Paris, St. Moritz, Dubai, Maldives) and the Yacht Club.
- **Outfits** are whole extra models of Kimchi: `python3 tools/gen_outfits.py`, then `build_char.py kimchi_<outfit> ...`.

## Characters

Every person in the 3D game is built from T-pose pictures on a green screen (front, back and side),
not from a 3D modelling tool. The pictures are drawn through the Orbio gateway using the key in
`.env` (`ORBIO_API_KEY=...`); about $0.15 per picture.

1. Describe the character in `tools/cast.json`, then draw their three views:
   `python3 tools/gen_cast.py <name>` (writes `refs/<name>-tpose.png`, `-back.png`, `-side.png`)
2. Measure them and pack the texture:
   `python3 tools/build_char.py <name> refs/<name>-tpose.png --back refs/<name>-back.png --side refs/<name>-side.png`
   (writes `assets/chars/<name>.json` and `.webp`; needs numpy and Pillow)
3. Check the result at http://localhost:5173/tools/charview.html?char=<name>
4. Add the name to `CAST` in `src/3d/main3d.js`.

`src/3d/photochar.js` sculpts the body from those measurements, wraps the pictures around it,
and gives it a skeleton (shoulders, elbows, hips, knees, feet) for walking, running and jumping.
`refs/` and `tools/` stay on your computer; only `assets/` goes online.

## Code map

- `src/world.js` the world facade (`src/world-v2.js` Kimchi Key, `src/world-grid.js` the classic grid, `src/map/` the
  v2 generator, `src/sim/` traffic, people and navigation), `src/entities.js` simulation (player, cars, traffic, people), `src/ui.js` menus, shop, jobs and HUD, `src/data.js` items, cars and friends
- `src/3d/` the 3D view: `city.js` the city facade (`cityV2.js` Kimchi Key, `cityGrid.js` the grid town), `photochar.js` characters built from pictures, `char3d.js` modelled and
  AI-made characters, `anim.js` motion capture, `face.js` painted faces, `cars.js` car models,
  `sky.js` day and night, `fx.js` particles and markers, `hud3d.js` labels, minimap and the GTA HUD, `main3d.js` camera, controls and game loop
- GTA systems: `combat.js` weapons, bullets, damage and explosions, `guns.js` gun models and poses, `police.js` wanted level and AI drivers,
  `missions.js` story, `shops3d.js` K-Arms, hospital and police menus, `radio.js`, `gunsfx.js` sounds
