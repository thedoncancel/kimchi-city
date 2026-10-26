#!/usr/bin/env python3
"""Generate the cast (friends and pedestrians) in the same style as Kimchi, through the Orbio gateway.

For each character in tools/cast.json: a front T-pose (Kimchi's T-pose is only the style/pose
reference), then back and side views drawn from that new front. Also a title-screen pose of Kimchi.
Outputs refs/<name>-tpose.png, refs/<name>-back.png, refs/<name>-side.png and refs/kimchi-hero.png.

Usage:
  python3 tools/gen_cast.py                # everything missing
  python3 tools/gen_cast.py mochi bao      # only these
  python3 tools/gen_cast.py hero           # only Kimchi's title pose
"""
import base64, concurrent.futures as cf, io, json, pathlib, sys, urllib.error, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from gen_views import COMMON, VIEWS, URL, MODEL, ROOT, key  # noqa: E402
from PIL import Image  # noqa: E402

STYLE_REF = ROOT / 'refs' / 'kimchi-tpose.webp'
FRONT = (
    "The attached image shows the art style, pose and framing to copy: a 3D animated-film style character render "
    "in a T-pose on a flat pure green (#00FF00) screen. Create a NEW, DIFFERENT character in exactly that style, pose "
    "and framing: {desc}. Same T-pose with both arms held straight out horizontally, palms down, legs straight and "
    "slightly apart, facing the camera, full body from the top of the head to the shoes with nothing cropped, centered, "
    "same size in the frame and same camera height, flat pure green background with no floor shadow. Do not copy the "
    "reference person's face, hair or clothes. No text, no labels."
)
HERO = (
    "The attached image is Kimchi, a MALE teenage boy (he/him), rendered in a 3D animated-film style. Render EXACTLY "
    "this character - same face, hair, dark t-shirt, belt, wide black trousers, silver watch and black woven loafers - "
    "in a relaxed, confident standing pose with both hands in his trouser pockets and a slight smile, body turned "
    "three-quarters toward the camera, full body from head to shoes with nothing cropped, centered, on a flat pure "
    "green (#00FF00) background with no floor shadow. No text."
)


def jpeg_uri(path, size=1024):
    """References go in as ~1024px JPEGs: big PNGs get rejected with 413."""
    im = Image.open(path).convert('RGB')
    im.thumbnail((size, size))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=90)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def call(prompt, ref_path, out_path, api_key):
    body = {'model': MODEL, 'prompt': prompt, 'aspect_ratio': '1:1',
            'input_references': [{'type': 'image_url', 'image_url': {'url': jpeg_uri(ref_path)}}]}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {
        'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'})
    last = None
    for _ in range(2):   # one retry for flaky provider errors
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.load(r)
            imgs = data.get('data') or []
            if not imgs:
                raise RuntimeError('no image returned')
            out_path.write_bytes(base64.b64decode(imgs[0]['b64_json']))
            return out_path.name
        except urllib.error.HTTPError as e:
            last = RuntimeError(f'{e.code}: {e.read().decode()[:300]}')
            if e.code in (400, 402, 413, 422):
                break
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def make(name, desc, api_key):
    refs = ROOT / 'refs'
    front = refs / f'{name}-tpose.png'
    done = []
    if not front.exists():
        done.append(call(FRONT.format(desc=desc), STYLE_REF, front, api_key))
    short = desc.split(',')[0] if ',' in desc else desc
    for view in ('back', 'side'):
        out = refs / f'{name}-{view}.png'
        if not out.exists():
            done.append(call(COMMON.format(desc=short) + VIEWS[view], front, out, api_key))
    return name, done


def main():
    cast = json.loads((ROOT / 'tools' / 'cast.json').read_text())
    picks = sys.argv[1:] or list(cast) + ['hero']
    api_key = key()
    (ROOT / 'refs').mkdir(exist_ok=True)
    with cf.ThreadPoolExecutor(6) as pool:
        futs = {}
        for n in picks:
            if n == 'hero':
                out = ROOT / 'refs' / 'kimchi-hero.png'
                if not out.exists():
                    futs[pool.submit(lambda: ('hero', [call(HERO, STYLE_REF, out, api_key)]))] = n
            else:
                futs[pool.submit(make, n, cast[n], api_key)] = n
        for f in cf.as_completed(futs):
            try:
                name, made = f.result()
                print(f'{name}: {made or "already there"}', flush=True)
            except Exception as e:  # noqa: BLE001
                print(f'{futs[f]}: FAILED {e}', flush=True)


if __name__ == '__main__':
    main()
