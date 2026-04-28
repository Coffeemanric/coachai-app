#!/usr/bin/env python3
"""
CoachAI Icon Generator
──────────────────────
Generates all required iOS and Android icon sizes from a single 1024×1024 source image.

Usage:
    pip install Pillow
    python scripts/generate_icons.py path/to/icon-1024.png

The source image must be:
  • 1024 × 1024 pixels, square
  • PNG format
  • No transparent background (use a solid dark background #0a0c10)
  • No rounded corners (iOS adds them automatically)
"""

import sys, os
from pathlib import Path
try:
    from PIL import Image
except ImportError:
    print("Install Pillow first:  pip install Pillow")
    sys.exit(1)

if len(sys.argv) < 2:
    print("Usage: python generate_icons.py path/to/icon-1024.png")
    sys.exit(1)

src_path = Path(sys.argv[1])
if not src_path.exists():
    print(f"File not found: {src_path}")
    sys.exit(1)

src = Image.open(src_path).convert("RGBA")
base = Path(__file__).parent.parent

# ── iOS sizes ─────────────────────────────────────────────────────────────────
ios_sizes = [
    # (filename, size_px)
    ("Icon-20@1x.png",    20),
    ("Icon-20@2x.png",    40),
    ("Icon-20@3x.png",    60),
    ("Icon-29@1x.png",    29),
    ("Icon-29@2x.png",    58),
    ("Icon-29@3x.png",    87),
    ("Icon-40@1x.png",    40),
    ("Icon-40@2x.png",    80),
    ("Icon-40@3x.png",   120),
    ("Icon-60@2x.png",   120),
    ("Icon-60@3x.png",   180),
    ("Icon-76@1x.png",    76),
    ("Icon-76@2x.png",   152),
    ("Icon-83.5@2x.png", 167),
    ("Icon-1024.png",   1024),   # App Store
]

ios_out = base / "ios/App/App/Assets.xcassets/AppIcon.appiconset"
ios_out.mkdir(parents=True, exist_ok=True)

for fname, size in ios_sizes:
    resized = src.resize((size, size), Image.LANCZOS)
    # iOS icons must not have alpha — flatten onto dark background
    bg = Image.new("RGB", (size, size), (10, 12, 16))
    bg.paste(resized, mask=resized.split()[3])
    bg.save(ios_out / fname, "PNG", optimize=True)
    print(f"  iOS  {size:>4}px  →  {fname}")

# Write Contents.json for Xcode
contents = '''{
  "images": [
    {"filename":"Icon-20@1x.png","idiom":"iphone","scale":"1x","size":"20x20"},
    {"filename":"Icon-20@2x.png","idiom":"iphone","scale":"2x","size":"20x20"},
    {"filename":"Icon-20@3x.png","idiom":"iphone","scale":"3x","size":"20x20"},
    {"filename":"Icon-29@1x.png","idiom":"iphone","scale":"1x","size":"29x29"},
    {"filename":"Icon-29@2x.png","idiom":"iphone","scale":"2x","size":"29x29"},
    {"filename":"Icon-29@3x.png","idiom":"iphone","scale":"3x","size":"29x29"},
    {"filename":"Icon-40@1x.png","idiom":"iphone","scale":"1x","size":"40x40"},
    {"filename":"Icon-40@2x.png","idiom":"iphone","scale":"2x","size":"40x40"},
    {"filename":"Icon-40@3x.png","idiom":"iphone","scale":"3x","size":"40x40"},
    {"filename":"Icon-60@2x.png","idiom":"iphone","scale":"2x","size":"60x60"},
    {"filename":"Icon-60@3x.png","idiom":"iphone","scale":"3x","size":"60x60"},
    {"filename":"Icon-76@1x.png","idiom":"ipad",  "scale":"1x","size":"76x76"},
    {"filename":"Icon-76@2x.png","idiom":"ipad",  "scale":"2x","size":"76x76"},
    {"filename":"Icon-83.5@2x.png","idiom":"ipad","scale":"2x","size":"83.5x83.5"},
    {"filename":"Icon-1024.png","idiom":"ios-marketing","scale":"1x","size":"1024x1024"}
  ],
  "info": {"author":"xcode","version":1}
}'''
(ios_out / "Contents.json").write_text(contents)
print(f"\n✅ iOS icons → {ios_out}")

# ── Android sizes ─────────────────────────────────────────────────────────────
android_sizes = [
    ("mipmap-mdpi",    48),
    ("mipmap-hdpi",    72),
    ("mipmap-xhdpi",   96),
    ("mipmap-xxhdpi", 144),
    ("mipmap-xxxhdpi",192),
]

android_res = base / "android/app/src/main/res"
for folder, size in android_sizes:
    out_dir = android_res / folder
    out_dir.mkdir(parents=True, exist_ok=True)
    resized = src.resize((size, size), Image.LANCZOS)
    # ic_launcher (square)
    bg = Image.new("RGB", (size, size), (10, 12, 16))
    bg.paste(resized, mask=resized.split()[3])
    bg.save(out_dir / "ic_launcher.png", "PNG")
    # ic_launcher_round (same source — Android applies the circle mask)
    bg.save(out_dir / "ic_launcher_round.png", "PNG")
    print(f"  Android {size:>3}px  →  {folder}/ic_launcher.png")

print(f"\n✅ Android icons → {android_res}")
print("\nAll icons generated. Run 'npx cap sync' to apply, then rebuild.")
