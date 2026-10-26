#!/usr/bin/env python3
"""Picture -> textured 3D model (.glb) through the free microsoft/TRELLIS.2 Space on Hugging Face.

Needs Python 3.10+ with gradio_client (Blender's bundled Python works:
  ~/Applications/Blender.app/Contents/Resources/4.2/python/bin/python3.11 -m venv /tmp/hfenv && /tmp/hfenv/bin/pip install gradio_client)
and HF_TOKEN in .env (a free account gets a few models a day; the quota resets daily).

Usage: python tools/hf3d.py IMAGE OUTDIR [faces>=100000] [texture] [seed]
Then rig it for the game: Blender -b -P tools/blender/rig_ai_char.py -- OUTDIR/<file>.glb <name>_ai
A T-pose picture on a plain background works best (refs/<name>-tpose.png with the green made white).
"""
import os, sys, time
from gradio_client import Client, handle_file

img, outdir = sys.argv[1], sys.argv[2]
faces = int(sys.argv[3]) if len(sys.argv) > 3 else 100000
tex = int(sys.argv[4]) if len(sys.argv) > 4 else 2048
seed = int(sys.argv[5]) if len(sys.argv) > 5 else 7
os.makedirs(outdir, exist_ok=True)
tok = None
env = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
for line in open(env):
    if line.startswith('HF_TOKEN='): tok = line.split('=', 1)[1].strip()
t0 = time.time()
c = Client('microsoft/TRELLIS.2', verbose=False, download_files=outdir, token=tok)
c.predict(api_name='/start_session')
pre = c.predict(handle_file(img), api_name='/preprocess_image')
c.predict(handle_file(pre), seed, os.environ.get('RES', '1024'), api_name='/image_to_3d')
glb, _ = c.predict(faces, tex, api_name='/extract_glb')
print('glb', glb, round(time.time() - t0), 's', flush=True)
