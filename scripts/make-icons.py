#!/usr/bin/env python3
"""Generate the PWA icons: a poker chip on a dark rounded square.

Written as a tiny hand-rolled PNG encoder so the build has no image
dependencies. Re-run with `python3 scripts/make-icons.py` after changing the
palette below.
"""

import math
import struct
import zlib
from pathlib import Path

BG = (13, 21, 18)
CHIP = (46, 204, 143)
CHIP_DARK = (16, 92, 66)
WHITE = (234, 242, 237)

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"


def blend(bottom, top, alpha):
    return tuple(round(b + (t - b) * alpha) for b, t in zip(bottom, top))


def coverage(dist, edge, feather=1.0):
    """Anti-aliased coverage for a point `dist` from the centre of a circle."""
    if dist <= edge - feather:
        return 1.0
    if dist >= edge + feather:
        return 0.0
    return (edge + feather - dist) / (2 * feather)


def rounded_square_alpha(x, y, size, radius):
    half = size / 2
    dx = abs(x - half + 0.5) - (half - radius)
    dy = abs(y - half + 0.5) - (half - radius)
    if dx <= 0 or dy <= 0:
        return 1.0
    return coverage(math.hypot(dx, dy), radius)


def render(size, padding_ratio=0.0):
    """Render one icon. `padding_ratio` insets the chip for maskable icons."""
    centre = size / 2
    inset = size * padding_ratio
    chip_r = (size / 2 - inset) * 0.92
    ring_outer = chip_r * 0.80
    ring_inner = chip_r * 0.68
    core_r = chip_r * 0.42

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px = BG
            dist = math.hypot(x + 0.5 - centre, y + 0.5 - centre)

            # Chip body.
            a = coverage(dist, chip_r)
            if a > 0:
                px = blend(px, CHIP, a)

                # Six white edge segments, the classic chip stripes.
                angle = math.atan2(y + 0.5 - centre, x + 0.5 - centre)
                segment = (angle % (math.pi / 3)) / (math.pi / 3)
                in_band = ring_inner <= dist <= chip_r
                if in_band and segment < 0.5:
                    edge_a = min(coverage(dist, chip_r), 1.0)
                    px = blend(px, WHITE, 0.95 * edge_a)

                # Inner ring and darker core.
                if dist <= ring_outer:
                    px = blend(px, WHITE, coverage(dist, ring_outer) * 0.9)
                if dist <= ring_inner:
                    px = blend(px, CHIP, coverage(dist, ring_inner))
                if dist <= core_r:
                    px = blend(px, CHIP_DARK, coverage(dist, core_r))

            # Rounded-square mask over the whole tile.
            mask = rounded_square_alpha(x, y, size, size * 0.22)
            if mask < 1.0 and padding_ratio == 0.0:
                px = blend((13, 21, 18), px, mask)

            row.extend(px)
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit truecolour
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"wrote {path.relative_to(OUT_DIR.parent)} ({len(png)} bytes)")


def main():
    OUT_DIR.mkdir(exist_ok=True)
    write_png(OUT_DIR / "icon-192.png", 192, render(192))
    write_png(OUT_DIR / "icon-512.png", 512, render(512))
    # Maskable icons get extra padding so the safe zone survives cropping.
    write_png(OUT_DIR / "icon-maskable-512.png", 512, render(512, padding_ratio=0.14))


if __name__ == "__main__":
    main()
