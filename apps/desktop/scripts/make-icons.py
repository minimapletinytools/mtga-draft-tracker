#!/usr/bin/env python3
"""
Generates the app icons from scratch — no image libraries, just zlib and math.

    python3 apps/desktop/scripts/make-icons.py

Writes apps/desktop/assets/{icon.png,icon-mac.png,icon.ico} and icon.icns.
Everything is drawn at 4x and box-filtered down, which is all the anti-aliasing
a flat geometric mark needs.

The mark: three staggered cards, the middle one lifted and gold — the pick.
"""

import os
import struct
import subprocess
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, "..", "assets"))

SS = 4  # supersampling factor

# Palette
BG_TOP = (0x1C, 0x22, 0x33)
BG_BOTTOM = (0x0B, 0x0D, 0x13)
GOLD = (0xE0, 0xA3, 0x3E)
GOLD_DARK = (0x8A, 0x5A, 0x1C)
CARD_FACE = (0xE9, 0xEC, 0xF5)
CARD_FACE_DIM = (0x9A, 0xA3, 0xB8)
CARD_BACK = (0x2A, 0x31, 0x45)
SLATE = (0x39, 0x42, 0x5C)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """True when (x, y) is inside a rounded rectangle."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size):
    """Renders the mark at `size` px, supersampled."""
    w = size * SS
    px = [[(0, 0, 0, 0)] * w for _ in range(w)]

    margin = w * 0.055
    radius = w * 0.225
    x0, y0, x1, y1 = margin, margin, w - margin, w - margin

    # --- background tile
    for y in range(w):
        t = (y - y0) / max(1.0, (y1 - y0))
        base = mix(BG_TOP, BG_BOTTOM, max(0.0, min(1.0, t)))
        for x in range(w):
            if rounded_rect(x + 0.5, y + 0.5, x0, y0, x1, y1, radius):
                px[y][x] = (*base, 255)

    # --- three cards fanned across the tile
    # Sized so the fanned cards stay inside the rounded tile with a margin.
    card_w = w * 0.248
    card_h = w * 0.400
    card_r = w * 0.026
    gap = w * 0.030
    total = card_w * 3 + gap * 2
    left = (w - total) / 2
    mid_y = (w - card_h) / 2

    # Outer cards sit lower; the middle one is lifted and gold.
    layout = [
        (left, mid_y + w * 0.062, CARD_BACK, SLATE, CARD_FACE_DIM),
        (left + card_w + gap, mid_y - w * 0.028, (0x24, 0x1B, 0x0C), GOLD, GOLD),
        (left + (card_w + gap) * 2, mid_y + w * 0.062, CARD_BACK, SLATE, CARD_FACE_DIM),
    ]

    for cx, cy, face, edge, bar in layout:
        for y in range(int(cy) - 2, int(cy + card_h) + 3):
            if y < 0 or y >= w:
                continue
            for x in range(int(cx) - 2, int(cx + card_w) + 3):
                if x < 0 or x >= w:
                    continue
                fx, fy = x + 0.5, y + 0.5
                if rounded_rect(fx, fy, cx, cy, cx + card_w, cy + card_h, card_r):
                    # 2px-scaled edge treatment, then the face.
                    inset = w * 0.008
                    if not rounded_rect(
                        fx, fy, cx + inset, cy + inset, cx + card_w - inset, cy + card_h - inset,
                        card_r * 0.8,
                    ):
                        px[y][x] = (*edge, 255)
                    else:
                        px[y][x] = (*face, 255)

    # --- mana-bar stripes near the top of each card, a nod to a card frame
    for cx, cy, _face, _edge, bar in layout:
        bx0 = cx + card_w * 0.20
        bx1 = cx + card_w * 0.80
        by0 = cy + card_h * 0.16
        by1 = by0 + card_h * 0.11
        for y in range(int(by0), int(by1) + 1):
            for x in range(int(bx0), int(bx1) + 1):
                if 0 <= x < w and 0 <= y < w and rounded_rect(x + 0.5, y + 0.5, bx0, by0, bx1, by1, (by1 - by0) / 2):
                    px[y][x] = (*bar, 255)

        # A couple of text lines under the bar.
        for row in range(2):
            ly = cy + card_h * (0.42 + row * 0.14)
            lx0 = cx + card_w * 0.20
            lx1 = cx + card_w * (0.80 if row == 0 else 0.62)
            for y in range(int(ly), int(ly + card_h * 0.055) + 1):
                for x in range(int(lx0), int(lx1) + 1):
                    if 0 <= x < w and 0 <= y < w:
                        px[y][x] = (*bar, 255)

    # --- box filter down
    out = []
    for oy in range(size):
        row = []
        for ox in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    p = px[oy * SS + sy][ox * SS + sx]
                    # Premultiply so transparent corners don't darken the edges.
                    r += p[0] * p[3]
                    g += p[1] * p[3]
                    b += p[2] * p[3]
                    a += p[3]
            n = SS * SS
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((r // a, g // a, b // a, a // n))
        out.append(row)
    return out


def write_png(path, pixels):
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type: none
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def write_ico(path, png_paths):
    """An ICO whose entries are PNG payloads — supported since Vista."""
    images = []
    for p in png_paths:
        # ".ico-256.png" -> 256
        size = int(os.path.basename(p).split(".")[1].split("-")[1])
        with open(p, "rb") as f:
            images.append((size, f.read()))

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries = b""
    payload = b""
    for size, data in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)

    with open(path, "wb") as f:
        f.write(header + entries + payload)


def main():
    os.makedirs(ASSETS, exist_ok=True)

    print("rendering 1024px master…")
    master = render(1024)

    # macOS shows the icon as-is, so it keeps its own rounded tile. Windows and
    # Linux want a full-bleed square, which this design already is.
    write_png(os.path.join(ASSETS, "icon-mac.png"), master)

    sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    rendered = {512: master}
    for size in sizes:
        if size not in rendered:
            rendered[size] = render(size)

    write_png(os.path.join(ASSETS, "icon.png"), rendered[512])

    # .ico entries are PNG payloads, so they need to exist on disk first.
    ico_tmp = []
    for size in (16, 32, 48, 256):
        p = os.path.join(ASSETS, f".ico-{size}.png")
        write_png(p, rendered[size])
        ico_tmp.append(p)
    write_ico(os.path.join(ASSETS, "icon.ico"), ico_tmp)
    for p in ico_tmp:
        os.remove(p)

    if sys.platform == "darwin":
        iconset = os.path.join(ASSETS, "icon.iconset")
        os.makedirs(iconset, exist_ok=True)
        for size in (16, 32, 128, 256, 512):
            write_png(os.path.join(iconset, f"icon_{size}x{size}.png"), rendered[size])
            write_png(os.path.join(iconset, f"icon_{size}x{size}@2x.png"), rendered[min(size * 2, 512)])
        try:
            subprocess.run(
                ["iconutil", "-c", "icns", iconset, "-o", os.path.join(ASSETS, "icon.icns")],
                check=True,
            )
            print("wrote icon.icns")
        except (subprocess.CalledProcessError, FileNotFoundError) as err:
            print(f"iconutil failed ({err}); icon.icns not written", file=sys.stderr)
        finally:
            for name in os.listdir(iconset):
                os.remove(os.path.join(iconset, name))
            os.rmdir(iconset)

    for name in ("icon.png", "icon-mac.png", "icon.ico", "icon.icns"):
        p = os.path.join(ASSETS, name)
        if os.path.exists(p):
            print(f"  {name}: {os.path.getsize(p)} bytes")


if __name__ == "__main__":
    main()
