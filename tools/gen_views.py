#!/usr/bin/env python3
"""Draw extra views (back, side) of a T-pose character through the Orbio gateway.

The game builds each 3D character from a front T-pose picture; a back view and a side view
make the back of the model and its depth match the character.

Key: ORBIO_API_KEY env var, or a line `ORBIO_API_KEY=...` in Kimchi/.env (same as kumichi/gen.py).

Usage:
  python3 tools/gen_views.py refs/kimchi-tpose.webp kimchi back side
  python3 tools/gen_views.py refs/kimchi-tpose.webp kimchi back --desc "a teenage boy"
Outputs refs/<name>-<view>.png
"""
import argparse, base64, concurrent.futures as cf, json, os, pathlib, sys, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = "https://api.orbio.so/api/v1/images/generations"
MODEL = os.environ.get("MODEL", "google/gemini-3-pro-image")

COMMON = (
    "The attached image is a 3D animated-film style render of {desc} standing in a T-pose on a flat pure green "
    "(#00FF00) screen. Render EXACTLY the same character: same face, hair, outfit, colors, proportions and size, "
    "same T-pose with both arms held straight out horizontally, same camera distance and height, full body from "
    "head to shoes with nothing cropped, centered, on the same flat pure green background with no floor shadow. "
    "No text, no labels, no extra objects. "
)
VIEWS = {
    "back": "Show him from directly BEHIND (back view, camera straight behind him at the same height): we see the "
            "back of his head and hair, the back of his clothes and the heels of his shoes. Because we look from "
            "behind, his left arm is now on the left side of the picture.",
    "side": "Show him from his LEFT side (a clean 90-degree profile, camera level with his chest): his face looks to "
            "the left edge of the picture, his arms still stretch straight out sideways in the T-pose so one arm "
            "points toward the camera and the other away from it. The feet and shoes are seen in profile.",
}


def key():
    k = os.environ.get("ORBIO_API_KEY")
    env = ROOT / ".env"
    if not k and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("ORBIO_API_KEY="):
                k = line.split("=", 1)[1].strip().strip("\"'")
    if not k:
        sys.exit("No key: set ORBIO_API_KEY or add ORBIO_API_KEY=... to Kimchi/.env")
    return k


def data_uri(path):
    mime = {".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(path.suffix.lower(), "image/png")
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def generate(ref, name, view, desc, api_key):
    body = {
        "model": MODEL,
        "prompt": COMMON.format(desc=desc) + VIEWS[view],
        "input_references": [{"type": "image_url", "image_url": {"url": data_uri(ref)}}],
        "aspect_ratio": "1:1",
    }
    req = urllib.request.Request(URL, json.dumps(body).encode(), {
        "Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            cost = r.headers.get("X-Orbio-Cost")
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{e.code}: {e.read().decode()[:400]}") from None
    imgs = data.get("data") or []
    if not imgs:
        raise RuntimeError("no image returned")
    out = ROOT / "refs" / f"{name}-{view}.png"
    out.write_bytes(base64.b64decode(imgs[0]["b64_json"]))
    return view, out.name, cost


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("name")
    ap.add_argument("views", nargs="+", choices=list(VIEWS))
    ap.add_argument("--desc", default="a MALE teenage boy (he/him)")
    a = ap.parse_args()
    ref = (ROOT / a.ref) if not os.path.isabs(a.ref) else pathlib.Path(a.ref)
    (ROOT / "refs").mkdir(exist_ok=True)
    api_key = key()
    with cf.ThreadPoolExecutor(4) as pool:
        futs = [pool.submit(generate, ref, a.name, v, a.desc, api_key) for v in a.views]
        for f in cf.as_completed(futs):
            try:
                view, fname, cost = f.result()
                print(f"{view}: refs/{fname}  cost={cost}")
            except Exception as e:
                print(f"FAILED: {e}")


if __name__ == "__main__":
    main()
