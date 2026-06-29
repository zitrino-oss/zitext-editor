#!/usr/bin/env python3
"""
Regenerate ZITEXT Editor icons with the white background replaced by transparency.

The source PNGs ship with a solid white canvas behind the rounded-square artwork,
which shows up as a white border/halo wherever the host (taskbar, tray, dock,
Linux panel) paints the icon onto a non-white surface.

This script:
  1. Loads app-icon.png (1024x1024, RGB, white-background source)
  2. Flood-fills the background from the four corners with moderate tolerance
     to identify "outside" pixels
  3. Converts those pixels to alpha based on their whiteness, so the anti-aliased
     edge of the rounded square fades smoothly into transparency (no jagged edge)
  4. Saves the cleaned source back
  5. Resamples the cleaned source to every size Tauri's bundle config needs
  6. Rebuilds icon.ico (multi-res Windows) and icon.icns (multi-res macOS)

Run:  python3 scripts/regenerate_icons.py
"""

from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "app-icon.png"
ICONS_DIR = ROOT / "src-tauri" / "icons"

# A pixel is "background-passable" if every channel sits at or above this value.
# The original source has a baked drop shadow whose darkest pixel is at min RGB
# ≈ 180, so this threshold must be below that to let the flood traverse the
# full shadow ring. The rounded-square artwork's lightest on-shape pixel has
# min RGB ≈ 142 — safely below 159, so the shape stops the flood cold.
# Inside the artwork the paper (min ≈ 243) and sparkle highlights (min ≈ 229)
# are enclosed by the blue field, so they remain unreachable from the corners.
BG_PASSABLE_MIN = 159

# Any pixel this close to pure white is treated as pure background and snaps
# to alpha 0, so "almost white" (254,254,254) doesn't leave a faint alpha≈6.
WHITE_FLOOR = 4


def _bfs_outside_mask(min_rgb: np.ndarray) -> np.ndarray:
    """Return a boolean mask of pixels reachable from the four corners via
    pixels whose min(RGB) ≥ BG_PASSABLE_MIN (4-connectivity)."""
    h, w = min_rgb.shape
    passable = min_rgb >= BG_PASSABLE_MIN
    visited = np.zeros_like(passable)
    q: deque[tuple[int, int]] = deque()
    for y, x in [(0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1)]:
        if passable[y, x]:
            visited[y, x] = True
            q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and passable[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))
    return visited


def clean_background(src_path: Path) -> Image.Image:
    """Return an RGBA image of `src_path` with the outer white canvas
    (and baked drop shadow below it) made transparent."""
    rgba = Image.open(src_path).convert("RGBA")
    src_arr = np.array(rgba)
    rgb = src_arr[:, :, :3]
    min_rgb = rgb.min(axis=2)

    outside_mask = _bfs_outside_mask(min_rgb)

    # Outside pixels fall into two categories:
    #   (a) the baked grey drop shadow below and around the rounded square —
    #       these must go to alpha 0 or they composite as a white/grey haze
    #       on any non-white panel background;
    #   (b) a thin blue-tinted anti-alias edge between shape and shadow —
    #       preserve partial opacity here so the silhouette stays smooth.
    # A pixel is "true shape-edge anti-alias" iff its blue channel is
    # meaningfully higher than red (strong blue cast) AND it sits close to
    # the shape (darkness ≥ BLUE_EDGE_MIN_DARKNESS). Everything else goes to 0.
    BLUE_CAST_MIN = 40          # B - R required to count as blue anti-alias
    BLUE_EDGE_MIN_DARKNESS = 60  # minimum darkness to qualify as on-edge

    r = rgb[:, :, 0].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    darkness = (255 - min_rgb).astype(np.float32)
    blue_cast = b - r

    is_edge_aa = (blue_cast >= BLUE_CAST_MIN) & (darkness >= BLUE_EDGE_MIN_DARKNESS)

    # Alpha gradient for the surviving blue anti-alias pixels only.
    shifted = np.maximum(darkness - WHITE_FLOOR, 0.0)
    span = max(1, 255 - BG_PASSABLE_MIN - WHITE_FLOOR)
    edge_alpha = np.clip(shifted * (255.0 / span), 0, 255).astype(np.uint8)

    # Outside-mask pixels: edge_alpha if they're true blue anti-alias, else 0.
    new_outside_alpha = np.where(is_edge_aa, edge_alpha, 0).astype(np.uint8)

    src_arr[:, :, 3] = np.where(outside_mask, new_outside_alpha, src_arr[:, :, 3])
    return Image.fromarray(src_arr, "RGBA")


def resample(src: Image.Image, size: int) -> Image.Image:
    return src.resize((size, size), Image.LANCZOS)


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(ROOT)}  ({img.size[0]}x{img.size[1]})")


def build_ico(src: Image.Image, path: Path) -> None:
    """Multi-resolution .ico for Windows."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [resample(src, s) for s in sizes]
    imgs[0].save(
        path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=imgs[1:],
    )
    print(f"  wrote {path.relative_to(ROOT)}  (multi-res .ico)")


def build_icns(src: Image.Image, path: Path) -> None:
    """Multi-resolution .icns for macOS. Pillow requires specific sizes."""
    # Pillow's ICNS writer supports these canonical sizes.
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    imgs = [resample(src, s) for s in sizes]
    imgs[0].save(
        path,
        format="ICNS",
        sizes=[(s, s) for s in sizes],
        append_images=imgs[1:],
    )
    print(f"  wrote {path.relative_to(ROOT)}  (multi-res .icns)")


def main() -> int:
    if not SRC.exists():
        print(f"Source not found: {SRC}", file=sys.stderr)
        return 1

    print(f"Cleaning source: {SRC.relative_to(ROOT)}")
    cleaned = clean_background(SRC)

    # Persist the cleaned master so the source of truth has a transparent background.
    save_png(cleaned, SRC)
    save_png(cleaned, ROOT / "app-icon.png")
    save_png(cleaned, ROOT / "public" / "app-icon.png")

    print("\nRegenerating src-tauri/icons/ …")
    # Tauri-referenced icons
    save_png(resample(cleaned, 32),  ICONS_DIR / "32x32.png")
    save_png(resample(cleaned, 64),  ICONS_DIR / "64x64.png")
    save_png(resample(cleaned, 128), ICONS_DIR / "128x128.png")
    save_png(resample(cleaned, 256), ICONS_DIR / "128x128@2x.png")
    save_png(resample(cleaned, 512), ICONS_DIR / "icon.png")

    # Windows Store / MS Store square logos
    for px, name in [
        (30,  "Square30x30Logo.png"),
        (44,  "Square44x44Logo.png"),
        (71,  "Square71x71Logo.png"),
        (89,  "Square89x89Logo.png"),
        (107, "Square107x107Logo.png"),
        (142, "Square142x142Logo.png"),
        (150, "Square150x150Logo.png"),
        (284, "Square284x284Logo.png"),
        (310, "Square310x310Logo.png"),
        (50,  "StoreLogo.png"),
    ]:
        save_png(resample(cleaned, px), ICONS_DIR / name)

    # Multi-res platform containers
    build_ico(cleaned,  ICONS_DIR / "icon.ico")
    build_icns(cleaned, ICONS_DIR / "icon.icns")

    print("\nDone. Rebuild the app (npm run tauri build) to embed the new icons.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
