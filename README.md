# Snowdon Tower — LMV Construction Phasing

A minimal Autodesk LMV viewer that loads **Snowdon-Tower-(Complete).rvt** and lets
you scrub a construction timeline: elements are hidden until their phase starts,
highlighted while in progress, and dimmed once finished.

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

Phases follow a **real build sequence**: Structure rises floor by floor
(framing, columns, foundations, rebar), then Floors, Walls, Envelope
(curtain walls, mullions, windows), Stairs, and Doors — each dropping
L0 → L5 — followed by whole-building bursts: Roof, MEP, Finishes & FF&E,
Site & Landscape, and an **Other** catch-all (lines, space separation, …).
Each element's level comes from its Revit constraints (`Base Constraint` /
`Base Level` / `Level`); elements without level info are placed by height,
assuming the levels are evenly spaced over the model. Roof-level elements
(R1/R2/Parapet/…) join the Roof phase. Revit sub-categories (Runs, Supports,
Curtain Wall Mullions, Slab Edges, …) are mapped onto their construction
parent, and empty phases are pruned so the belt has no dead slots.

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

## Known issue — everything visible at t=0

**Symptom:** with the bar open at t=0 (label "Structure L0"), furniture and
windows are still visible — elements that should stay hidden until their phase
on the belt.

**User screenshots (local):**

```
/Users/bealem/Documents/SCR-20260818-nims.jpeg
/Users/bealem/Documents/SCR-20260818-njux.jpeg
```

Tracked copies (so the issue is visible from the repo):

![t=0 furniture bug 1](docs/bug-t0-furniture-1.jpeg)
![t=0 furniture bug 2](docs/bug-t0-furniture-2.jpeg)

**Status:**

- **Fixed:** `render()` skipped hide/show while `model.isLoadDone()` returned
  `false` — SVF2 models can report `false` even when fully rendered. The guard
  was removed; the smoke test now asserts only the first phase is visible
  immediately after the bar opens.
- **Still tracking:** headless pixel analysis shows the building at ~67% pixel
  coverage even at t=0, while fragment-level `isFragVisible` (the renderer's own
  check) says the same fragments are *not* drawable. Suspicion: browser-side
  caching of the unversioned `ext/phasing.mjs` (cache-busted via `?v=` imports)
  and/or a render-path issue that appears only in real browsers. A
  renderer-truth scan (all fragments × all phases) is the next step.
