#!/usr/bin/env python3
"""
Extract Stmdist_U30 / L30 / R30 + skew-normal params from
/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment/Stimuli/Stimulus_30.mat
and emit public/demo-exp/timeexp/stimulus_30.json.

Run from repo root:
    /tmp/timeexp_venv/bin/python3 scripts/timeexp/extract-stimulus-mat.py

The .json is consumed by main.js at runtime; regenerating is one-shot
(no need to re-run unless the lab regenerates the .mat).
"""

import json
import sys
from pathlib import Path

import numpy as np
import scipy.io

SRC = Path(
    "/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment/Stimuli/Stimulus_30.mat"
)
DST = Path("public/demo-exp/timeexp/stimulus_30.json")


def to_list(arr):
    """Force MATLAB column-vector cells/arrays into a flat float list."""
    a = np.asarray(arr).squeeze()
    return [float(v) for v in a.flatten().tolist()]


def main() -> int:
    if not SRC.exists():
        print(f"missing: {SRC}", file=sys.stderr)
        return 1

    raw = scipy.io.loadmat(str(SRC), squeeze_me=True, struct_as_record=False)
    keys = sorted(k for k in raw if not k.startswith("__"))
    print("keys in mat:", keys)

    # Three distributions, 30 samples each (skew-normal in [0.6, 1.6]).
    out = {
        "lo": 0.6,
        "hi": 1.6,
        "alpha": 3.3,
        "samples": {
            "U": to_list(raw["Stmdist_U30"]),
            "L": to_list(raw["Stmdist_L30"]),
            "R": to_list(raw["Stmdist_R30"]),
        },
    }

    # Skew-normal parameters block — needed by the distribution-guide PNG
    # renderer + by the documentation. Stored as a sub-object so the
    # runtime can ignore it.
    if "params" in raw:
        p = raw["params"]
        params: dict = {}
        for f in dir(p):
            if f.startswith("_"):
                continue
            try:
                v = getattr(p, f)
            except Exception:
                continue
            if callable(v):
                continue
            if isinstance(v, np.ndarray):
                if v.size == 1:
                    params[f] = float(v.item())
                else:
                    params[f] = [float(x) for x in v.flatten().tolist()]
            elif isinstance(v, (int, float, np.integer, np.floating)):
                params[f] = float(v)
            elif isinstance(v, str):
                params[f] = v
        out["params"] = params

    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(json.dumps(out, ensure_ascii=False, indent=2))

    n_per = {k: len(v) for k, v in out["samples"].items()}
    print(f"wrote {DST}  ({n_per})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
