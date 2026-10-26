#!/usr/bin/env python3
"""Cut a character out of a green-screen picture into a transparent, cropped WebP.

Usage: python3 tools/cutout.py refs/kimchi-hero.png assets/kimchi-hero.webp [--height 900]
"""
import argparse, pathlib, sys
import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_char import green_mask, despill, ROOT  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--height', type=int, default=900)
    a = ap.parse_args()
    img = Image.open(ROOT / a.src).convert('RGB')
    fg = green_mask(img)
    img = despill(img, fg)
    alpha = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    rgba = img.copy()
    rgba.putalpha(alpha)
    ys, xs = np.nonzero(fg)
    rgba = rgba.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    if rgba.height > a.height:
        rgba = rgba.resize((round(rgba.width * a.height / rgba.height), a.height), Image.LANCZOS)
    rgba.save(ROOT / a.dst, quality=90, method=6)
    print('wrote', a.dst, rgba.size)


if __name__ == '__main__':
    main()
