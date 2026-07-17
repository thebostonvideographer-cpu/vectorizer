#!/usr/bin/env python3
"""Tight logo cutout: clear outer bg + small letter holes, keep face whites, kill pale halos."""

from __future__ import annotations

import math
import sys
from collections import deque
from pathlib import Path

from PIL import Image


def color_dist(c1, c2) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1[:3], c2[:3])))


def cutout(
    src: Path,
    dst: Path,
    tolerance: float = 40,
    max_hole_frac: float = 0.012,
    choke_passes: int = 3,
) -> None:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    px = im.load()
    total = w * h
    max_hole = int(total * max_hole_frac)

    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    br = sum(c[0] for c in corners) / 4
    bg = sum(c[1] for c in corners) / 4
    bb = sum(c[2] for c in corners) / 4
    bc = (br, bg, bb)

    def matches(x: int, y: int, tol: float = tolerance) -> bool:
        return color_dist(px[x, y], bc) <= tol

    # --- 1) outer background from edges ---
    outer = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if matches(x, y):
                outer[y][x] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not outer[y][x] and matches(x, y):
                outer[y][x] = True
                q.append((x, y))

    while q:
        x, y = q.popleft()
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not outer[ny][nx] and matches(nx, ny):
                outer[ny][nx] = True
                q.append((nx, ny))

    # --- 2) small enclosed white holes only (letter counters); keep large face whites ---
    seen = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if seen[y][x] or outer[y][x]:
                continue
            if px[x, y][3] == 0 or not matches(x, y):
                continue

            comp: list[tuple[int, int]] = []
            qq: deque[tuple[int, int]] = deque([(x, y)])
            seen[y][x] = True
            touches_edge = False
            while qq:
                cx, cy = qq.popleft()
                comp.append((cx, cy))
                if cx in (0, w - 1) or cy in (0, h - 1):
                    touches_edge = True
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if not (0 <= nx < w and 0 <= ny < h) or seen[ny][nx] or outer[ny][nx]:
                        continue
                    if px[nx, ny][3] == 0 or not matches(nx, ny):
                        continue
                    seen[ny][nx] = True
                    qq.append((nx, ny))

            # clear only small interior islands (letters), never big face fills
            if (not touches_edge) and len(comp) <= max_hole:
                for cx, cy in comp:
                    r, g, b, _ = px[cx, cy]
                    px[cx, cy] = (r, g, b, 0)

    # --- 3) choke pale fringe only (repeat) — kills jagged white halo without eating ink ---
    for _ in range(choke_passes):
        doomed: list[tuple[int, int]] = []
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a == 0:
                    continue
                # only strip near-background / pale anti-alias
                lum = (r + g + b) / 3
                near_bg = color_dist((r, g, b), bc) <= tolerance * 1.35 or lum >= 205
                if not near_bg:
                    continue
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                        doomed.append((x, y))
                        break
        for x, y in doomed:
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 0)

    # harden remaining alpha
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255 if a else 0)

    im.save(dst, "PNG")
    print(f"wrote {dst} ({w}x{h})")


if __name__ == "__main__":
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/ericslaptop/Downloads/IMG_9293.jpg")
    dst = Path(sys.argv[2] if len(sys.argv) > 2 else "/Users/ericslaptop/Downloads/IMG_9293-transparent.png")
    cutout(src, dst)
