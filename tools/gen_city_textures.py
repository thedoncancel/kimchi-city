#!/usr/bin/env python3
"""Paint the city's textures through the Orbio gateway (Gemini 3 Pro Image): Art Deco windows, a stucco wall,
the 12 shop fronts and their signs. Outputs refs/city/<name>.png; tools/build_city_textures.py turns them into
the game's texture atlases.

Map v2 (Kimchi Key) adds a second set in refs/city2/ (JOBS2): a wall and 4 window bays for each new region style
(ktown, tower, resort, house, warehouse), 8 K-Town blade signs, 6 K-Town neon signs, and 6 more shop fronts with
their sign boards. build_city_textures.py v2 packs them. Wave P3 adds 4 tall Mediterranean windows for the Gables
(house_med_*), which replace the house atlas's shutters; the towers' glass is drawn by the shader since P3.

Key: ORBIO_API_KEY in Kimchi/.env (never printed). About $0.15 a picture; existing pictures are skipped.
Usage: python3 tools/gen_city_textures.py [names...]      today's set (refs/city), or just the named pictures
       python3 tools/gen_city_textures.py --v2 [names...] the map v2 set (refs/city2)
       --dry lists what would be painted and stops; --max N refuses to paint more than N pictures in one run.
"""
import argparse, base64, concurrent.futures as cf, json, pathlib, sys, urllib.error, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from gen_views import URL, MODEL, ROOT, key  # noqa: E402

OUT = ROOT / 'refs' / 'city'
STYLE = ("Hand-painted stylized game texture in the style of Fortnite and Sea of Thieves: clean shapes, soft painterly "
         "brush strokes, bright cheerful colours, gentle even daylight, no harsh shadows. ")
FRONT = "Perfectly flat, straight-on orthographic front view, no perspective, the subject fills the entire picture edge to edge. "

WINDOW = (STYLE + FRONT + "One Miami Art Deco hotel window seen from outside: a crisp white painted frame around a triple window "
          "(three tall panes side by side separated by thin white mullions, and a thin horizontal transom bar near the top), "
          "glass in clear light blue reflecting the sky with one soft diagonal highlight, a white sill along the bottom edge. "
          "Behind the glass: {inside}. Nothing outside the frame: the frame touches all four edges. No text, no people.")
SHOP = (STYLE + FRONT + "The ground-floor front of a small {kind} in a pastel Miami Art Deco street, seen from the sidewalk: one wide "
        "shop window on the left two thirds and a glass door on the right third, both in a {frame} frame, a low kickplate "
        "under the window. Through the glass we see the inside, warmly lit: {inside}. No sign board, no awning, no "
        "lettering or text anywhere, no people outside, no sky, no sidewalk: just the shop front filling the picture.")
SIGN = (STYLE + "A single wide, thin shop sign board, straight-on front view, centred in the picture on a plain flat black "
        "background, spanning almost the full width of the picture. The board reads exactly \"{text}\" in big bold friendly "
        "letters ({fg}) on a {bg} board with a thin {trim} border{extra}. Nothing else in the picture: only this one sign. "
        "Spell the text exactly as given.")

JOBS = {
    'stucco': (STYLE + "A seamless tileable texture of smooth painted stucco wall, very light warm white with faint hand-painted "
               "brush strokes and tiny plaster bumps. Flat, evenly lit, no objects, no edges, no shadows, fills the frame.", '1:1'),
    'win_blinds': (WINDOW.format(inside="white venetian blinds pulled half way down, a dim room beyond"), '4:3'),
    'win_plant': (WINDOW.format(inside="a green potted plant on the inner sill and soft pastel pink curtains drawn to the sides"), '4:3'),
    'win_curtain': (WINDOW.format(inside="sheer cream curtains, a cosy lamp glowing in the room"), '4:3'),
    'win_dark': (WINDOW.format(inside="a shady room with a ceiling fan and a framed picture on the far wall"), '4:3'),
}
SHOPS = [  # (name, kind of shop, frame colour, what's inside) in the order of SHOP_SIGNS in src/3d/textures.js
    ('chicken', 'Korean fried chicken restaurant', 'red', 'a counter with fried chicken baskets, red stools, menu lights'),
    ('noraebang', 'karaoke (noraebang) bar', 'purple', 'a purple neon-lit room with a big screen, microphones and sofas'),
    ('pcbang', 'gaming PC cafe', 'blue', 'rows of gaming computers with glowing blue screens and gaming chairs'),
    ('cafe', 'coffee shop', 'dark brown wooden', 'a coffee counter with an espresso machine, pastries, wooden tables and hanging bulbs'),
    ('boba', 'bubble tea shop', 'pink', 'a pastel counter with colourful bubble tea cups, plants and pink chairs'),
    ('bbq', 'Korean barbecue restaurant', 'black', 'tables with round grills, hanging extractor hoods and warm light'),
    ('pharmacy', 'pharmacy', 'green', 'tidy white shelves of medicine boxes and a clean counter'),
    ('bakery', 'bakery', 'warm orange', 'shelves and baskets of bread, croissants and cakes in a glass display'),
    ('mart', 'convenience store', 'teal', 'snack shelves, drink fridges with glowing doors and a till'),
    ('salon', 'hair salon', 'black', 'salon chairs facing round mirrors with lights, plants and a pink wall'),
    ('arcade', 'arcade', 'hot pink', 'colourful arcade machines and claw machines glowing with lights'),
    ('tteokbokki', 'Korean street food (tteokbokki) shop', 'red', 'a big pan of red rice cakes, fish cakes on skewers and steam'),
]
SIGNS = [  # same order: text, letter colour, board colour, trim colour, extra detail
    ('CHICKEN 치킨', 'cream white', 'tomato red', 'gold', ', with a little cartoon chicken drumstick icon'),
    ('NORAEBANG 노래방', 'pale pink glowing neon', 'deep purple', 'pink neon', ', with a microphone icon'),
    ('PC BANG', 'white', 'electric blue', 'light blue', ', with a little computer mouse icon'),
    ('CAFE 카페', 'cream', 'dark coffee brown', 'gold', ', with a steaming coffee cup icon'),
    ('BOBA TEA', 'white', 'candy pink', 'white', ', with a bubble tea cup icon'),
    ('BBQ 고기', 'golden yellow', 'charcoal black', 'gold', ', with a small flame icon'),
    ('PHARMACY 약국', 'white', 'emerald green', 'white', ', with a white cross icon'),
    ('BAKERY 빵', 'dark brown', 'warm golden orange', 'cream', ', with a bread loaf icon'),
    ('MART24', 'white', 'teal', 'white', ', with a shopping basket icon'),
    ('HAIR SALON', 'pastel pink', 'black', 'pink', ', with a pair of scissors icon'),
    ('ARCADE', 'bright yellow glowing neon', 'hot pink', 'yellow neon', ', with a joystick icon'),
    ('TTEOKBOKKI 떡볶이', 'cream', 'chilli red', 'orange', ', with a pair of chopsticks icon'),
]
for n, kind, frame, inside in SHOPS:
    JOBS['shop_' + n] = (SHOP.format(kind=kind, frame=frame, inside=inside), '16:9')
for (n, *_), (text, fg, bg, trim, extra) in zip(SHOPS, SIGNS):
    JOBS['sign_' + n] = (SIGN.format(text=text, fg=fg, bg=bg, trim=trim, extra=extra), '21:9')

# ---------- map v2: one wall and 4 window bays per region style, K-Town signs, 6 more shops (refs/city2) ----------
OUT2 = ROOT / 'refs' / 'city2'
WALL = (STYLE + "A seamless tileable texture of {what}. Flat, straight-on, evenly lit, no objects, no windows, no edges, "
        "no frame, no shadows: the surface fills the whole picture edge to edge.")
# every bay is painted to fill its picture, so build_city_textures.py can drop it into an exact box on the wall
BAY = STYLE + FRONT + "{what} Nothing outside it: {edge} touches all four edges of the picture. {extra}"
NO_TEXT = "No text, no people, no sky or wall around it, no white margin or empty background around it."
KEYED = (STYLE + FRONT + "{what} The window with its surround stands alone, centred, on a plain flat solid pure green "
         "(#00FF00) chroma-key background that fills the rest of the picture, with a small green margin on every side. "
         "No wall, no shadow on the green, no text, no people.")
KTOWN_WIN = ("One window of a small Seoul-style shop-and-apartment building in Koreatown: a sliding aluminium window "
             "with a silver frame, split into two panes by a vertical middle bar, light blue glass with one soft diagonal "
             "highlight. Behind the glass: {inside}.")
TOWER = ("One floor-to-ceiling glass panel of a modern Miami downtown glass skyscraper: a slim silver aluminium frame "
         "around one big pane of glass. {inside}")
RESORT = ("One balcony bay of a white Miami Beach resort hotel tower: a wide sliding glass balcony door with a white frame "
          "fills the picture, with {rail} across the lower third in front of it. {inside}")
HOUSE = "One window of a cream Mediterranean Revival house in Coral Gables, Miami: {what}"
# map v2 wave P3: tall Spanish and Italian windows for the Gables, in place of the shutters and flower boxes that
# read Northern European (build_city_textures.py uses these four for the house atlas)
HOUSE_MED = ("One tall window of a warm cream stucco Mediterranean Revival villa in Coral Gables, Miami (Spanish and "
             "Italian style), seen straight on: {what}")
WARE = "One window of a candy-coloured Miami port warehouse: {what}"
BLADE = (STYLE + "A single tall, narrow vertical blade sign of a Seoul street shop (the kind that sticks out sideways from "
         "Korean buildings), straight-on front view, centred on a plain flat black background, filling almost the full "
         "height of the picture. The board is about four times as tall as it is wide. It reads exactly \"{text}\", the "
         "letters stacked vertically from top to bottom, one syllable per row, in big bold friendly letters ({fg}) on a "
         "{bg} board with a {trim} border{extra}. Nothing else in the picture: only this one sign. Spell the text exactly "
         "as given.")
NEON = (STYLE + "A glowing neon tube sign on a slim dark backing panel, straight-on front view, centred on a plain flat "
        "black background, spanning almost the full width of the picture and about a quarter as tall as it is wide. It "
        "reads exactly \"{text}\" in bright {color} neon tube letters with a soft glow{extra}. Nothing else in the "
        "picture: only this one sign. Spell the text exactly as given.")

JOBS2 = {
    # walls: near-white so the per-building pastel tint reads; build_city_textures.py mirrors them into a seamless tile
    'ktown_wall': (WALL.format(what="small glazed rectangular facade tiles in pale cream and off-white, laid in neat "
                               "horizontal rows with thin light grey grout, a typical Seoul street building wall, about "
                               "twenty tiles across"), '1:1'),
    'tower_wall': (WALL.format(what="smooth brushed pale silver aluminium cladding panels, almost white, with very faint "
                               "vertical brushing"), '1:1'),
    'resort_wall': (WALL.format(what="smooth white painted concrete with a very fine sandy grain and faint warm "
                                "sun-bleached patches"), '1:1'),
    'house_wall': (WALL.format(what="rough hand-troweled Mediterranean stucco in warm cream, with soft swirly trowel "
                               "marks and tiny bumps"), '1:1'),
    # ribbed sheet metal was blocked three times by Gemini (IMAGE_RECITATION), so the port gets tilt-up concrete:
    # build_city_textures.py draws the panel joints and reveals along the cell edges
    'ware_wall': (WALL.format(what="off-white painted tilt-up concrete with faint plywood formwork marks, a few tiny "
                              "air holes and soft grey weathering streaks"), '1:1'),
    # K-Town: 2.4 m x 1.6 m windows
    'ktown_win_lace': (BAY.format(what=KTOWN_WIN.format(inside="white lace curtains gathered to the sides and two small "
                                  "potted plants with red flowers on the inner sill"), edge="the window frame",
                                  extra=NO_TEXT), '3:2'),
    'ktown_win_lanterns': (BAY.format(what=KTOWN_WIN.format(inside="a cosy little Korean restaurant room with three red "
                                      "paper lanterns hanging from the ceiling and warm light"), edge="the window frame",
                                      extra=NO_TEXT), '3:2'),
    'ktown_win_blinds': (BAY.format(what=KTOWN_WIN.format(inside="grey vertical office blinds half open and a small "
                                    "potted cactus on the sill"), edge="the window frame", extra=NO_TEXT), '3:2'),
    'ktown_win_sign': (BAY.format(what=KTOWN_WIN.format(inside="a billiard hall with a green pool table under a lamp; big "
                                  "bold red vinyl Korean letters stuck on the glass read exactly \"당구장\" across the "
                                  "middle"), edge="the window frame",
                                  extra="Spell the Korean text exactly as given; no other text, no people."), '3:2'),
    # downtown towers: 2.84 m x 2.4 m glass panels (a spandrel band at each floor line)
    'tower_glass_sky': (BAY.format(what=TOWER.format(inside="The teal-blue glass mirrors a bright blue sky with fluffy white "
                                   "clouds and one soft diagonal highlight."), edge="the frame", extra=NO_TEXT), '5:4'),
    'tower_glass_office': (BAY.format(what=TOWER.format(inside="The clear, light blue glass shows a bright office inside: "
                                      "desks with computer monitors, office chairs, a potted plant and rows of ceiling "
                                      "lights, with a faint sky reflection."), edge="the frame", extra=NO_TEXT), '5:4'),
    'tower_glass_blinds': (BAY.format(what=TOWER.format(inside="A white roller blind is pulled two thirds of the way down "
                                      "inside; the lower part of the glass mirrors blue sky."), edge="the frame",
                                      extra=NO_TEXT), '5:4'),
    'tower_glass_home': (BAY.format(what=TOWER.format(inside="The glass shows a stylish apartment living room inside: a "
                                    "pastel sofa, a floor lamp and a big monstera plant, with a faint sky reflection."),
                                    edge="the frame", extra=NO_TEXT), '5:4'),
    # Collins resort towers: 2.4 m x 2.5 m balcony bays (a white slab edge at each floor line)
    'resort_bay_towel': (BAY.format(what=RESORT.format(rail="a white horizontal-bar balcony railing", inside="A turquoise "
                                    "and white striped beach towel hangs over the railing; sheer white curtains inside."),
                                    edge="the door frame", extra=NO_TEXT), '1:1'),
    'resort_bay_table': (BAY.format(what=RESORT.format(rail="a frosted glass balcony railing", inside="Behind it stand a "
                                    "little round white table, two chairs and a potted palm; the glass doors mirror a "
                                    "blue sky."), edge="the door frame", extra=NO_TEXT), '1:1'),
    'resort_bay_curtain': (BAY.format(what=RESORT.format(rail="a white horizontal-bar balcony railing", inside="Coral pink "
                                      "curtains are half drawn inside and a pink flamingo pool float leans against the "
                                      "railing."), edge="the door frame", extra=NO_TEXT), '1:1'),
    'resort_bay_view': (BAY.format(what=RESORT.format(rail="a slim white balcony railing", inside="The clear glass doors "
                                   "mirror the turquoise ocean and a blue sky with one soft diagonal highlight."),
                                   edge="the door frame", extra=NO_TEXT), '1:1'),
    # Gables houses: 2.4 m x 1.55 m windows with their shutters or surrounds
    'house_win_shutters': (BAY.format(what=HOUSE.format(what="a white-framed window with small square panes, flanked by "
                                      "open louvred wooden shutters painted sage green; the shutters and the window "
                                      "together fill the picture. Behind the glass: a cosy room with a lamp."),
                                      edge="the shutters and frame", extra=NO_TEXT), '3:2'),
    'house_win_arch': (BAY.format(what=HOUSE.format(what="a window with a round arched top and a black wrought-iron "
                                  "decorative grille over the glass, set in a rectangular terracotta tile surround that "
                                  "fills the whole picture, a warm room behind."), edge="the terracotta surround",
                                  extra=NO_TEXT), '3:2'),
    'house_win_flowers': (BAY.format(what=HOUSE.format(what="a white-framed window with powder-blue open shutters and a "
                                     "wooden flower box of red geraniums under the sill; the shutters, window and flower "
                                     "box fill the picture."), edge="the shutters and frame", extra=NO_TEXT), '3:2'),
    'house_win_lace': (BAY.format(what=HOUSE.format(what="a window in a carved cream stone surround that fills the picture, "
                                  "white lace curtains and a little blue ceramic vase on the sill."),
                                  edge="the stone surround", extra=NO_TEXT), '3:2'),
    # Gables houses, wave P3: 1.9 m x 2.15 m tall Mediterranean windows (portrait). An arched window cannot fill its
    # picture, so these are painted on a flat chroma-key green that build_city_textures.py keys out.
    'house_med_arch': (KEYED.format(what=HOUSE_MED.format(what="a tall round-arched casement window with slim dark wooden "
                                  "frames and small panes, set in a smooth cast-stone surround with a keystone, a little "
                                  "black wrought-iron balconette with curly scrolls across its lower part, a warm room "
                                  "glimpsed behind the glass.")), '3:4'),
    'house_med_twin': (KEYED.format(what=HOUSE_MED.format(what="a pair of tall round-arched windows side by side, separated "
                                  "by a slim twisted stone column, under one carved cream cast-stone surround with a small "
                                  "shell relief above, dark wooden frames, warm light behind the glass.")), '3:4'),
    'house_med_reja': (KEYED.format(what=HOUSE_MED.format(what="a tall rectangular window behind a projecting dark-stained "
                                  "wooden spindle grille (a Spanish reja) of turned balusters, with a little sloping roof "
                                  "of terracotta barrel tiles above it on carved wooden brackets, a cosy lamp-lit room "
                                  "behind.")), '3:4'),
    'house_med_awning': (KEYED.format(what=HOUSE_MED.format(what="a tall arched French window with slim white frames and "
                                    "small panes, under a scalloped terracotta-and-cream striped canvas awning, a black "
                                    "wrought-iron Juliet balcony rail across the bottom, sheer curtains inside.")), '3:4'),
    # port warehouses: 2.6 m x 1.46 m high windows (a third of the cells stay blank wall)
    'ware_win_steel': (BAY.format(what=WARE.format(what="a wide industrial steel-framed factory window made of many small "
                                  "rectangular panes (3 rows by 6 columns), the frame painted dark green, a few panes "
                                  "slightly milky."), edge="the frame", extra=NO_TEXT), '16:9'),
    'ware_win_louvre': (BAY.format(what=WARE.format(what="a wide galvanised metal louvred ventilation grille with "
                                   "horizontal slats in a chunky frame."), edge="the frame", extra=NO_TEXT), '16:9'),
    'ware_win_wired': (BAY.format(what=WARE.format(what="a wide wired-glass window (fine wire mesh in the glass) in a "
                                  "chunky white steel frame; inside, a workshop lit by fluorescent tubes with stacked "
                                  "cardboard boxes and a little forklift."), edge="the frame", extra=NO_TEXT), '16:9'),
    'ware_win_blocks': (BAY.format(what=WARE.format(what="a wide panel of frosted glass blocks (glass bricks) set in a "
                                   "chunky sky-blue steel frame."), edge="the frame", extra=NO_TEXT), '16:9'),
}
BLADES = [  # (name, text, letter colour, board colour, trim, extra): signs_ktown.jpg columns 0..7 in this order
    ('chikin', '치킨', 'white', 'tomato red', 'yellow', ', with a little fried chicken drumstick icon at the top'),
    ('norae', '노래방', 'pale pink glowing neon', 'deep purple', 'pink neon tube', ', with a microphone icon at the top'),
    ('hof', '호프', 'deep brown', 'golden yellow', 'white', ', with a frothy beer mug icon at the top'),
    ('pcbang', 'PC방', 'white', 'electric blue', 'light blue neon tube', ', with a little computer mouse icon at the top'),
    ('gogi', '고기집', 'golden yellow', 'charcoal black', 'gold', ', with a small flame icon at the top'),
    ('bunsik', '분식', 'white', 'warm orange', 'red', ', with a tteokbokki skewer icon at the top'),
    ('danggu', '당구장', 'white', 'teal', 'white', ', with a pool ball icon at the top'),
    ('hansik', '한식당', 'cream', 'dark red', 'gold', ', ringed with little round light bulbs, with a rice bowl icon at the top'),
]
NEONS = [  # (name, text, tube colour, extra): signs_ktown.jpg neon cells in this order
    ('seoul', '서울 SEOUL', 'hot pink', ', with a small heart'),
    ('soju', '소주 SOJU', 'bright green', ', with a little soju bottle'),
    ('kbbq', 'K-BBQ', 'orange-red', ', with a flame'),
    ('open', 'OPEN 24H 영업중', 'icy blue and white', ''),
    ('pocha', '포차 POCHA', 'warm yellow', ', with a little paper lantern'),
    ('kpop', 'K-POP', 'magenta and cyan', ', with a star'),
]
SHOPS2 = [  # two more shop rows for downtown, Collins and Deco Beach: shops2.jpg cells 12..17 in this order
    ('surf', 'surf shop', 'turquoise', 'surfboards standing in racks, colourful wetsuits and beach shorts on rails'),
    ('gelato', 'ice cream parlour', 'mint green', 'a glass counter of colourful gelato tubs, waffle cones and pastel stools'),
    ('swimwear', 'beach fashion boutique', 'white', 'mannequins in bright swimsuits, straw hats and sunglasses on stands'),
    ('cafecito', 'Cuban coffee window cafe', 'sunny yellow', 'a counter with tiny coffee cups, pastries and a vintage '
     'espresso machine'),
    ('sushi', 'sushi bar', 'light natural wood', 'a long wooden counter with a sushi chef station, plates of colourful sushi '
     'and paper lanterns'),
    ('florist', 'flower shop', 'sage green', 'buckets and shelves full of bright flower bouquets and potted plants'),
]
SIGNS2 = [  # same order: text, letter colour, board colour, trim colour, extra detail
    ('SURF SHOP', 'white', 'turquoise', 'yellow', ', with a little surfboard icon'),
    ('GELATO', 'chocolate brown', 'mint green', 'white', ', with an ice cream cone icon'),
    ('SWIMWEAR', 'hot pink', 'white', 'pink', ', with a little sun icon'),
    ('CAFECITO', 'dark brown', 'sunny yellow', 'brown', ', with a tiny coffee cup icon'),
    ('SUSHI BAR 스시', 'white', 'navy blue', 'red', ', with a sushi roll icon'),
    ('FLOWERS 꽃집', 'white', 'sage green', 'pink', ', with a flower icon'),
]
for n, text, fg, bg, trim, extra in BLADES:
    JOBS2['blade_' + n] = (BLADE.format(text=text, fg=fg, bg=bg, trim=trim, extra=extra), '9:16')
for n, text, color, extra in NEONS:
    JOBS2['neon_' + n] = (NEON.format(text=text, color=color, extra=extra), '21:9')
for n, kind, frame, inside in SHOPS2:
    JOBS2['shop2_' + n] = (SHOP.format(kind=kind, frame=frame, inside=inside), '16:9')
for (n, *_), (text, fg, bg, trim, extra) in zip(SHOPS2, SIGNS2):
    JOBS2['sign2_' + n] = (SIGN.format(text=text, fg=fg, bg=bg, trim=trim, extra=extra), '21:9')


def call(name, prompt, aspect, api_key, out=OUT):
    body = {'model': MODEL, 'prompt': prompt, 'aspect_ratio': aspect}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'})
    last = None
    for _ in range(2):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                cost = r.headers.get('X-Orbio-Cost')
                data = json.load(r)
            imgs = data.get('data') or []
            if not imgs: raise RuntimeError('no image returned')
            (out / f'{name}.png').write_bytes(base64.b64decode(imgs[0]['b64_json']))
            return name, cost
        except urllib.error.HTTPError as e:
            last = RuntimeError(f'{e.code}: {e.read().decode()[:300]}')
            if e.code in (400, 402, 413, 422): break
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='*')
    ap.add_argument('--v2', action='store_true', help='the map v2 set (refs/city2)')
    ap.add_argument('--dry', action='store_true', help='list what would be painted, paint nothing')
    ap.add_argument('--max', type=int, default=None, help='refuse to paint more than this many pictures')
    args = ap.parse_args()
    jobs, out = (JOBS2, OUT2) if args.v2 else (JOBS, OUT)
    unknown = [n for n in args.names if n not in jobs]
    if unknown: sys.exit(f'unknown picture(s): {" ".join(unknown)}')
    out.mkdir(parents=True, exist_ok=True)
    want = args.names or list(jobs)
    todo = [n for n in want if not (out / f'{n}.png').exists()]
    print(f'{len(todo)} to paint into {out.relative_to(ROOT)} (about ${0.15 * len(todo):.2f})', flush=True)
    if args.dry:
        print(' '.join(todo)); return
    if args.max is not None and len(todo) > args.max:
        sys.exit(f'{len(todo)} pictures is over --max {args.max}; nothing painted')
    api_key = key()
    total = 0.0
    with cf.ThreadPoolExecutor(4) as pool:
        futs = {pool.submit(call, n, *jobs[n], api_key, out): n for n in todo}
        for f in cf.as_completed(futs):
            try:
                n, cost = f.result()
                total += float(cost or 0)
                print(f'{n}: ok  cost={cost}', flush=True)
            except Exception as e:  # noqa: BLE001
                print(f'{futs[f]}: FAILED {e}', flush=True)
    print(f'total cost {total:.3f}')


if __name__ == '__main__':
    main()
