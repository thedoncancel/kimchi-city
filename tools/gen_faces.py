#!/usr/bin/env python3
"""Paint a crisp face for a character through the Orbio gateway (Gemini 3 Pro Image), from its T-pose picture.

AI-made 3D models (tools/hf3d.py) come out with soft, smeared faces. The game lays a painted face over the
front of the head instead (src/3d/face.js): a straight-on portrait, plus the same portrait with the eyes
closed for blinking. tools/blender/build_face.py lines it up with the model and packs it.

Outputs refs/faces/<name>-face.png and <name>-blink.png. About $0.15 a picture; existing ones are skipped.
Usage: python3 tools/gen_faces.py kimchi [--desc "a young MAN (he/him) with messy black hair"]
(for the cast, use the character's line from tools/cast.json as the description)
"""
import argparse, base64, io, json, pathlib, sys, urllib.error, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from gen_views import URL, MODEL, ROOT, key  # noqa: E402
from PIL import Image

OUT = ROOT / 'refs' / 'faces'
FACE = ("The attached image is a 3D animated-film style render of {desc}. Render a close-up portrait of EXACTLY this "
        "character: the same face, eyes, eyebrows, nose, mouth, skin tone and hair. Perfectly straight-on front view, "
        "the camera level with the eyes, head perfectly upright and not turned or tilted, the face centred and symmetric. "
        "Frame it from just above the top of the hair to just below the chin, the face filling most of the picture. "
        "The character looks straight into the camera with a relaxed, friendly closed-mouth smile. Soft, even studio light from "
        "the front, no strong shadows on the face. Flat pure green (#00FF00) background. No text, no hands, no props.")
BLINK = ("Render EXACTLY the same image as the attached one, identical in framing, head position and size, lighting, "
         "colours, hair and background, with one change only: the eyes are gently closed, as in the middle of a "
         "natural blink (upper eyelids down, lashes along the lower edge). Nothing else changes.")


def jpeg_uri(path, size=1024):
    im = Image.open(path).convert('RGB')
    im.thumbnail((size, size))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=90)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def generate(prompt, ref, out, api_key):
    body = {'model': MODEL, 'prompt': prompt, 'aspect_ratio': '1:1',
            'input_references': [{'type': 'image_url', 'image_url': {'url': jpeg_uri(ref)}}]}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            cost = r.headers.get('X-Orbio-Cost')
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{e.code}: {e.read().decode()[:300]}') from None
    imgs = data.get('data') or []
    if not imgs: raise RuntimeError('no image returned')
    out.write_bytes(base64.b64decode(imgs[0]['b64_json']))
    print(f'{out.relative_to(ROOT)}  cost={cost}', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name')
    ap.add_argument('--desc', default='a young MAN (he/him)')
    ap.add_argument('--redo', action='store_true', help='paint again even if the pictures exist')
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    ref = next((p for p in (ROOT / 'refs').glob(f'{a.name}-tpose.*')), None)
    if not ref: sys.exit(f'no refs/{a.name}-tpose.* picture')
    api_key = key()
    face, blink = OUT / f'{a.name}-face.png', OUT / f'{a.name}-blink.png'
    if a.redo or not face.exists(): generate(FACE.format(desc=a.desc), ref, face, api_key)
    if a.redo or not blink.exists(): generate(BLINK, face, blink, api_key)


if __name__ == '__main__':
    main()
