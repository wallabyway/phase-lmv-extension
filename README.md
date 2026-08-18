# Snowdon Tower — LMV Construction Phasing

A minimal Autodesk LMV viewer that loads the **Snowdon Towers Sample Architectural.rvt**
model and lets you scrub a construction timeline: elements are hidden until their
phase starts, highlighted while in progress, and dimmed once finished.

![phasing](tests/smoke-t62.png)

## Run

Serve the folder (the viewer SDK needs http):

```bash
cd phase-lmv-ext
python3 -m http.server 8000
# open http://localhost:8000
```

Click the **phasing toolbar button** (timeline icon) to reveal the slider, then drag.
The bar sits on a single line above the viewer's bottom navigation toolbar.

## Files

| File | Purpose |
|---|---|
| `index.html` | Viewer container + phasing bar UI + inline LMV bootstrap (model URN, viewer startup) |
| `ext/ui.mjs` | `PhasingExtension`: toolbar button, slider bar, tooltip chip, embedded phase data (ES module) |
| `ext/phasing.mjs` | `PhasingEngine`: level detection, phase construction, hide/theming, fall-in animation via `fragList.updateAnimTransform` (ES module) |
| `tests/smoke-test.js` | Headless (Puppeteer) end-to-end test — load, toggle bar, scrub slider, probe visibility + theming (screenshots land in `tests/`) |
| `tests/plan.md` | Build plan / source materials |

## How it works

The app loads **Snowdon-Tower-(Complete).rvt** — a single combined `{3D}` view
containing every Revit category. Each element is bucketed by its per-element
**Category** property; categories that aren't Floors/Walls/Stairs/Roofs/
Lighting Fixtures (doors, furniture, MEP, …) join an **Other** phase at the end
of the timeline.

Phases are **category-major, level-minor**: Floors drop in level by level
(L0 → L5), then Walls, then Stairs, then Roof, then MEP, then Other. Each
element's level comes from its Revit constraints (`Base Constraint` /
`Base Level` / `Level`); elements without level info are placed by height,
assuming the levels are evenly spaced over the model. Roof-level elements
(R1/R2/Parapet/…) join the Roof phase.

The timeline is a **conveyor belt**: a new part appears every `step` units
and stays in flight for `overlap` steps (default 2), so two parts hang and
fall at the same time while earlier parts rest dimmed on the floor. The last
part lands exactly at `t = 100`.

For a slider position `t`:

- `t < phase.start` → hidden
- `phase.start <= t < phase.end` → visible, phase color, **hanging above and
  falling into place** as t grows (fragment transform via
  `fragList.updateAnimTransform`; the 0..1000 slider drives the drop height
  directly along an **ease-out (cubic)** curve — no tweening)
- `t >= phase.end` → visible, dimmed phase color

A tooltip chip above the slider thumb follows the dragger and shows the
newest part to appear on the belt. The schedule (`DEFAULT_PHASES` in
`ext/ui.mjs`) is embedded in the app, so no external config fetch is needed.

## Smoke test

```bash
cd phase-lmv-ext
NODE_PATH=$(npm root -g) node tests/smoke-test.js   # needs puppeteer + Chromium
```

Loads the app headless, waits for phase analysis on the combined model, toggles
the bar, scrubs the slider through every phase, probes `isNodeVisible` + stored
theming colors per category, and screenshots each timeline position.
