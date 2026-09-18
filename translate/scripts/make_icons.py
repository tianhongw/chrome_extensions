#!/usr/bin/env python3
"""Generate the extension icons (16/48/128).

A rounded-square indigo→blue gradient tile with a white "译" glyph — matching
the in-page "译" trigger button for a consistent identity. Rendered at high
resolution and downscaled with LANCZOS for crisp anti-aliasing.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
FONT_PATH = "/System/Library/Fonts/STHeiti Medium.ttc"

S = 1024                      # supersample canvas
RADIUS = int(S * 0.235)       # rounded-corner radius
TOP = (99, 102, 241)          # indigo  #6366F1
BOTTOM = (37, 99, 235)        # blue    #2563EB
GLYPH = "译"


def vertical_gradient(size, top, bottom):
    base = Image.new("RGB", (1, size))
    px = base.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return base.resize((size, size))


def build_master():
    grad = vertical_gradient(S, TOP, BOTTOM).convert("RGBA")

    # Rounded-square alpha mask.
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], RADIUS, fill=255)

    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)

    # Soft diagonal top-left sheen for a little depth (heavily blurred so there
    # is no visible band edge).
    hi = Image.new("L", (S, S), 0)
    ImageDraw.Draw(hi).ellipse(
        [int(-S * 0.25), int(-S * 0.45), int(S * 0.95), int(S * 0.55)], fill=46,
    )
    hi = hi.filter(ImageFilter.GaussianBlur(S * 0.10))
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    tile = Image.composite(white, tile, hi).convert("RGBA")
    tile.putalpha(mask)

    # Glyph.
    draw = ImageDraw.Draw(tile)
    font = ImageFont.truetype(FONT_PATH, int(S * 0.56))
    l, t, r, b = draw.textbbox((0, 0), GLYPH, font=font)
    gx = (S - (r - l)) / 2 - l
    gy = (S - (b - t)) / 2 - t
    # subtle shadow
    draw.text((gx, gy + S * 0.012), GLYPH, font=font, fill=(20, 40, 110, 90))
    draw.text((gx, gy), GLYPH, font=font, fill=(255, 255, 255, 255))
    return tile


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    master = build_master()
    for sz in (16, 48, 128):
        img = master.resize((sz, sz), Image.LANCZOS)
        img.save(os.path.join(OUT_DIR, f"icon{sz}.png"))
        print("wrote", f"icon{sz}.png")


if __name__ == "__main__":
    main()
