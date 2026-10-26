#!/usr/bin/env python3
"""Draw Kimchi in other outfits (same face, hair and T-pose) through the Orbio gateway, so the game
can build one 3D model per outfit.

For each outfit: a front T-pose from Kimchi's own T-pose picture, then back and side views drawn from
that new front. Outputs refs/kimchi_<outfit>-tpose.png, -back.png and -side.png; then build each with
  python3 tools/build_char.py kimchi_<outfit> refs/kimchi_<outfit>-tpose.png --back ... --side ...

Usage:
  python3 tools/gen_outfits.py              # every outfit that is missing
  python3 tools/gen_outfits.py denim        # only this one
"""
import concurrent.futures as cf, pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from gen_views import COMMON, VIEWS, ROOT, key  # noqa: E402
from gen_cast import call  # noqa: E402

OUTFITS = {
    'denim': "a light-wash blue denim trucker jacket worn open over a plain white crew-neck t-shirt, black wide-leg "
             "trousers with a black leather belt, and black woven leather loafers",
    'hoodie': "an oversized bright red hoodie with the hood down, black wide-leg trousers and black leather sneakers",
    'black': "an all-black outfit: a black cropped bomber jacket zipped halfway over a black t-shirt, black wide-leg "
             "trousers and black woven leather loafers",
}
FRONT = (
    "The attached image is Kimchi, a MALE teenage boy (he/him), rendered in a 3D animated-film style, standing in a "
    "T-pose on a flat pure green (#00FF00) screen. Render EXACTLY this same character - same face, same hair, same skin "
    "tone, same body proportions and height, same T-pose with both arms held straight out horizontally, palms down, legs "
    "straight and slightly apart, facing the camera, same camera distance and height, full body from the top of the "
    "head to the shoes with nothing cropped, centered, on a flat pure green background with no floor shadow - but now "
    "wearing a different outfit: {outfit}. Keep the silver watch on his left wrist. No text, no labels, no logos."
)


def make(name, outfit, api_key):
    refs = ROOT / 'refs'
    front = refs / f'kimchi_{name}-tpose.png'
    done = []
    if not front.exists():
        done.append(call(FRONT.format(outfit=outfit), refs / 'kimchi-tpose.webp', front, api_key))
    desc = f"Kimchi, a MALE teenage boy (he/him) wearing {outfit.split(',')[0]}"
    for view in ('back', 'side'):
        out = refs / f'kimchi_{name}-{view}.png'
        if not out.exists():
            done.append(call(COMMON.format(desc=desc) + VIEWS[view], front, out, api_key))
    return name, done


def main():
    picks = sys.argv[1:] or list(OUTFITS)
    api_key = key()
    with cf.ThreadPoolExecutor(3) as pool:
        futs = {pool.submit(make, n, OUTFITS[n], api_key): n for n in picks}
        for f in cf.as_completed(futs):
            try:
                name, made = f.result()
                print(f'{name}: {made or "already there"}', flush=True)
            except Exception as e:  # noqa: BLE001
                print(f'{futs[f]}: FAILED {e}', flush=True)


if __name__ == '__main__':
    main()
