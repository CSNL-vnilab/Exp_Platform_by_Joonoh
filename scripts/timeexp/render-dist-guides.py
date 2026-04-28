#!/usr/bin/env python3
"""
Render the three distribution-guide PNGs (U/A/B) used by main.js to
show participants the day's stimulus-distribution shape, replicating
`tex_template_Duration.m:make_dist_guide_texture` output but at high
resolution for crisp scaling on any participant display.

Output:
    public/demo-exp/timeexp/dist_guide_U.png
    public/demo-exp/timeexp/dist_guide_A.png  (= L-skew, dist=2)
    public/demo-exp/timeexp/dist_guide_B.png  (= R-skew, dist=3)

Run from repo root:
    /tmp/timeexp_venv/bin/python3 scripts/timeexp/render-dist-guides.py
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.stats import norm

JSON_SRC = Path("public/demo-exp/timeexp/stimulus_30.json")
OUT_DIR = Path("public/demo-exp/timeexp")

# High-res canvas. Original PTB texture was display-pixel sized
# (e.g. 1920×1080); we go 2400×1500 so participants on Retina/4K
# screens still get crisp curves after CSS scaling.
W, H = 2400, 1500

# Same proportional layout as tex_template_Duration.m
# (x0=0.22, x1=0.84, y0=0.74, y1=0.30 of canvas).
L = {
    "x0": int(W * 0.22),
    "x1": int(W * 0.84),
    "y0": int(H * 0.74),
    "y1": int(H * 0.30),
}

FILL_COLORS = {
    "U": (90, 130, 200),
    "A": (80, 150, 120),
    "B": (170, 110, 120),
}
LINE_COLOR = (20, 20, 20)
AXIS_COLOR = (0, 0, 0)
BG = (179, 179, 179)  # ≈ par.grey at lum 0.03 → output appears grey-ish


def skewnorm_curve(x: np.ndarray, mu: float, sigma: float, alpha_signed: float) -> np.ndarray:
    """Same shape as MATLAB's `2/sigma * normpdf(z) * normcdf(±alpha*z)`."""
    z = (x - mu) / sigma
    return 2.0 / sigma * norm.pdf(z) * norm.cdf(alpha_signed * z)


def render(dist_key: str, params: dict) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    lo, hi = params["lo"], params["hi"]
    mu_L, sig_L = params["muL"], params["sigmaL"]
    mu_R, sig_R = params["muR"], params["sigmaR"]
    alpha = params["selectedAlpha"]

    n_x = L["x1"] - L["x0"] + 1
    x = np.linspace(lo, hi, n_x)

    if dist_key == "U":
        y = np.full_like(x, 1.0 / (hi - lo))
    elif dist_key == "A":  # L-skewed
        y = skewnorm_curve(x, mu_L, sig_L, -alpha)
    else:  # B → R-skewed
        y = skewnorm_curve(x, mu_R, sig_R, +alpha)

    y_norm = y / y.max()
    yp = L["y0"] - y_norm * (L["y0"] - L["y1"])

    fill = FILL_COLORS[dist_key]

    # Fill under curve column-by-column, clipped to plot rect.
    pixels = img.load()
    for i in range(n_x):
        xi = L["x0"] + i
        yi = int(round(max(L["y1"], min(L["y0"], yp[i]))))
        for yy in range(yi, L["y0"] + 1):
            pixels[xi, yy] = fill

    # Curve outline.
    pts = [(L["x0"] + i, int(round(yp[i]))) for i in range(n_x)]
    draw.line(pts, fill=LINE_COLOR, width=4)

    # Axes (bottom + left).
    draw.line([(L["x0"], L["y0"]), (L["x1"], L["y0"])], fill=AXIS_COLOR, width=4)
    draw.line([(L["x0"], L["y1"]), (L["x0"], L["y0"])], fill=AXIS_COLOR, width=4)

    # Y-axis label "Frequency" — positioned over y-axis top.
    # X-axis labels "Shorter duration" / "Longer duration" — flank y-axis-bottom.
    # All in Korean optionally; English mirrors the MATLAB version.
    try:
        f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 56)
        f_small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 44)
    except OSError:
        f = ImageFont.load_default()
        f_small = ImageFont.load_default()

    # "Frequency" — anchored just above the y-axis top, centered on x = L.x0.
    txt = "Frequency"
    bbox = draw.textbbox((0, 0), txt, font=f)
    tw = bbox[2] - bbox[0]
    draw.text(
        (L["x0"] - tw // 2, L["y1"] - 90),
        txt,
        fill=AXIS_COLOR,
        font=f,
    )

    # X-axis end labels.
    label_y = L["y0"] + 18
    draw.text(
        (L["x0"] - 110, label_y),
        "Shorter\nduration",
        fill=AXIS_COLOR,
        font=f_small,
    )
    bbox_r = draw.textbbox((0, 0), "Longer\nduration", font=f_small)
    rw = bbox_r[2] - bbox_r[0]
    draw.text(
        (L["x1"] - rw + 110, label_y),
        "Longer\nduration",
        fill=AXIS_COLOR,
        font=f_small,
    )

    return img


def main() -> int:
    data = json.loads(JSON_SRC.read_text())
    params = data["params"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for key in ("U", "A", "B"):
        img = render(key, params)
        out = OUT_DIR / f"dist_guide_{key}.png"
        img.save(out, optimize=True)
        print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
