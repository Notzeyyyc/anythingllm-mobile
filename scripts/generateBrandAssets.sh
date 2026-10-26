#!/usr/bin/env bash
# Generate all AnythingPocket brand assets (Android mipmaps, iOS AppIcon set,
# README banner) from a single programmatic master: rounded square, dark neutral
# background, "AP" monogram. Reproducible — no hand-edited binaries.
#
# Requires: python3 + Pillow (system package; already present in the dev env).
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PYEOF'
import json, os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.getcwd()
MASTER = 1024
BG = (27, 28, 30, 255)        # #1B1C1E dark neutral
FG = (229, 229, 229, 255)     # #E5E5E5
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def rounded_square(size, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=BG)
    return img

def monogram(img, ratio=0.52, color=FG):
    """Draw 'AP' centered at `ratio` of the canvas height."""
    size = img.width
    d = ImageDraw.Draw(img)
    target = size * ratio
    font = ImageFont.truetype(FONT, 10)
    # binary-search font size so the text is `target` px tall
    lo, hi = 10, size
    while lo < hi:
        mid = (lo + hi + 1) // 2
        f = ImageFont.truetype(FONT, mid)
        if f.getbbox("AP")[3] <= target:
            lo = mid
        else:
            hi = mid - 1
    font = ImageFont.truetype(FONT, lo)
    l, t, r, b = font.getbbox("AP")
    d.text(((size - (r - l)) / 2 - l, (size - (b - t)) / 2 - t), "AP", font=font, fill=color)
    return img

# ---- Master (committed as the reference source) ----
os.makedirs("images/brand", exist_ok=True)
master = monogram(rounded_square(MASTER))
master.save("images/brand/icon-master.png")

# ---- Android mipmaps ----
res = "android/app/src/main/res"
densities = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for dpi, m in densities.items():
    d = os.path.join(res, f"mipmap-{dpi}")
    os.makedirs(d, exist_ok=True)
    # legacy launcher icon (48dp)
    master.resize((int(48 * m),) * 2, Image.LANCZOS).save(f"{d}/ic_launcher.png")
    # adaptive background: solid square, full bleed (108dp)
    Image.new("RGBA", (int(108 * m),) * 2, BG).save(f"{d}/ic_launcher_background.png")
    # adaptive foreground: monogram inside the 66% safe zone
    fg = monogram(rounded_square(int(108 * m), radius_ratio=0), ratio=0.40)
    fg.save(f"{d}/ic_launcher_foreground.png")
    # monochrome: white monogram on transparent
    mono = Image.new("RGBA", (int(108 * m),) * 2, (0, 0, 0, 0))
    monogram(mono, ratio=0.40, color=(255, 255, 255, 255)).save(f"{d}/ic_launcher_monochrome.png")

# ---- iOS AppIcon set (sizes come from Contents.json; entries without a filename are skipped) ----
ad = "ios/AnythingLLM/Images.xcassets/AppIcon.appiconset"
cj = json.load(open(os.path.join(ROOT, ad, "Contents.json")))
for entry in cj["images"]:
    fn = entry.get("filename")
    if not fn:
        continue
    w, h = (int(float(x)) for x in entry["size"].split("x"))
    scale = int(str(entry.get("scale", "1x")).rstrip("x"))
    px = (int(w * scale), int(h * scale))
    # iOS masks corners itself: full-bleed square, no rounded corners in the asset
    monogram(Image.new("RGBA", px, BG), ratio=0.52).convert("RGB").save(os.path.join(ROOT, ad, fn))

# ---- README banner ----
W, H = 1600, 400
banner = Image.new("RGBA", (W, H), BG)
d = ImageDraw.Draw(banner)
font = ImageFont.truetype(FONT, 150)
l, t, r, b = font.getbbox("AnythingPocket")
d.text(((W - (r - l)) / 2 - l, (H - (b - t)) / 2 - t), "AnythingPocket", font=font, fill=FG)
banner.convert("RGB").save("images/gh-header.png")

print("brand assets generated")
PYEOF
