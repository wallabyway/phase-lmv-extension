/* ============================================================================
 * Phasing UI — toolbar button, the slider bar, the tooltip chip, and the
 * extension wiring. Phase data (DEFAULT_PHASES) lives here too; all phasing
 * calculations and fragment manipulation live in phasing.mjs.
 * ========================================================================== */

import { PhasingEngine } from './phasing.mjs';

// Synthetic construction schedule (former phases.json, now embedded).
// Level phases are generated at runtime as category-major / level-minor:
// Floors L0..L5, then Walls L0..L5, then Stairs L0..L5, then 'byCategory'.
export const DEFAULT_PHASES = {
    dropHeight: 150, // how far elements hang above their resting place at phase start
    overlap: 2,      // conveyor-belt: parts in flight at once (2 or 3)
    levelCategories: ['Floors', 'Walls', 'Stairs'], // drop order (category-major)
    levelProps: ['Base Constraint', 'Base Level', 'Level'],
    roofLevels: ['R1', 'R2', 'M1', 'Parapet', 'Block', 'Green Roof'],
    colors: [
        [91, 155, 213], // Floors
        [198, 90, 17],  // Walls
        [112, 173, 71]  // Stairs
    ],
    byCategory: [
        { id: 'roof', name: 'Roof', short: 'Roof', color: [164, 38, 44], categories: ['Roofs'] },
        { id: 'finishes', name: 'Finishes & MEP', short: 'MEP', color: [176, 122, 10], categories: ['Lighting Fixtures'] }
    ]
};

const ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M3 6h18M3 12h12M3 18h15"/>
        </g>
        <circle cx="18.5" cy="12" r="3.2" fill="#4aa8ff"/>
    </svg>`);

export class PhasingExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
        super(viewer, options);
        this._button = null;
        this._t = 0;
        this._enabled = false;
        this._active = null;
        this._ghost = true;          // auto-ghost 1s after the slider stops
        this._ghostTimer = null;
        this._ghostingActive = false;
        this.engine = new PhasingEngine(viewer);
        this.engine.onFinalize = () => {
            this.buildTooltip();
            this._active = null; // force label refresh
            if (this._enabled) this.update();
        };
    }

    load() {
        this._onLoaded = () => {
            if (!this._enabled) return;
            this.engine.reset(); // re-apply for newly streamed fragments
            this.update();
        };
        this.viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, this._onLoaded);
        return true;
    }

    unload() {
        this.viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, this._onLoaded);
        if (this._button) {
            const g = this.viewer.toolbar.getControl('phasing-toolbar-group');
            if (g) g.removeControl(this._button);
        }
        document.getElementById('phasing-bar').classList.add('hidden');
        this.clearGhost();
        this.engine.clearOverrides();
        return true;
    }

    onToolbarCreated() {
        let group = this.viewer.toolbar.getControl('phasing-toolbar-group');
        if (!group) {
            group = new Autodesk.Viewing.UI.ControlGroup('phasing-toolbar-group');
            this.viewer.toolbar.addControl(group);
        }
        const b = new Autodesk.Viewing.UI.Button('phasing-toolbar-button');
        b.setToolTip('Construction Phasing');
        group.addControl(b);
        const icon = b.container.querySelector('.adsk-button-icon');
        if (icon) {
            icon.style.backgroundImage = `url("${ICON}")`;
            icon.style.backgroundSize = '24px';
            icon.style.backgroundPosition = 'center';
        }
        b.onClick = () => this.toggleBar(b);
        this._button = b;

        document.getElementById('phasing-slider').addEventListener('input', (e) => {
            this._t = +e.target.value;
            this.clearGhost();
            this.scheduleGhost();
            this.update();
        });
        document.getElementById('phasing-reset').addEventListener('click', () => {
            document.getElementById('phasing-slider').value = 0;
            this._t = 0;
            this.clearGhost();
            this.scheduleGhost();
            this.engine.reset();
            this.update();
        });
        document.getElementById('phasing-ghost').addEventListener('change', (e) => {
            this._ghost = e.target.checked;
            if (this._ghost) this.scheduleGhost();
            else this.clearGhost();
        });
    }

    /* ---- idle ghosting ----
     * While the slider sits still, ghost the model and isolate the in-flight
     * parts (everything else dims). Any slider movement cancels it immediately. */

    scheduleGhost() {
        clearTimeout(this._ghostTimer);
        if (!this._ghost || !this._enabled) return;
        this._ghostTimer = setTimeout(() => this.applyGhost(), 1000);
    }

    clearGhost() {
        clearTimeout(this._ghostTimer);
        this._ghostTimer = null;
        if (this._ghostingActive) {
            this._ghostingActive = false;
            this.viewer.isolate([]);
            this.viewer.clearSelection();
            this.viewer.setGhosting(false);
            // isolate() rewrote the visibility flags the engine manages —
            // re-apply the engine's full hide/show/theming truth for every phase.
            this.engine.reset();
            this.update();
        }
    }

    applyGhost() {
        if (!this._ghost || !this._enabled || this._ghostingActive) return;
        const t = this._t / 10;
        const byModel = new Map(); // model -> [dbids] of the in-flight parts
        for (const p of this.engine.phases) {
            if (this.engine.statusOf(p, t) !== 1) continue;
            for (const [model, dbids] of this.engine.buckets.get(p.id) || new Map()) {
                if (!byModel.has(model)) byModel.set(model, []);
                byModel.get(model).push(...dbids);
            }
        }
        if (!byModel.size) return;
        this._ghostingActive = true;
        this.viewer.setGhosting(true);
        for (const [model, dbids] of byModel) this.viewer.isolate(dbids, model);
    }

    toggleBar(button) {
        const bar = document.getElementById('phasing-bar');
        // toggle() returns true when the class was ADDED, i.e. the bar is now hidden
        const show = !bar.classList.toggle('hidden');
        button.setState(show ? Autodesk.Viewing.UI.Button.State.ACTIVE : Autodesk.Viewing.UI.Button.State.INACTIVE);
        this._enabled = show;
        if (show) {
            this.engine.reset();
            this.scheduleGhost();
            this.update();
        } else {
            this.clearGhost();
            this.engine.clearOverrides(); // restore visibility, colors, and drop transforms
        }
    }

    setPhases(cfg) {
        this.engine.setPhases({ ...DEFAULT_PHASES, ...cfg });
    }

    addModel(model, category) {
        this.engine.addModel(model, category);
    }

    update() {
        const t = this._t / 10; // slider spans 0..1000; the phase timeline is 0..100
        // With the conveyor-belt schedule several phases are in flight at once —
        // the label/tooltip track the NEWEST part to appear (last phase with
        // start <= t still airborne).
        let cur = null;
        for (const p of this.engine.phases) {
            if (p.start > t) break;
            if (t < p.end) cur = p;
        }
        const id = t >= 100 ? 'done' : cur ? cur.id : null;
        // tooltip chip follows the thumb
        if (this._tooltip) {
            this._tooltip.style.left = `calc(${t}% + ${(8 - 0.16 * t).toFixed(2)}px)`;
        }
        if (id !== this._active) {
            this._active = id;
            const label = document.getElementById('phasing-current');
            if (id === 'done') {
                label.textContent = 'Complete';
                label.classList.add('dim');
                if (this._tooltip) this._tooltip.textContent = 'Complete';
            } else if (cur) {
                label.textContent = cur.name.length > 12 ? cur.short : cur.name;
                label.classList.remove('dim');
                if (this._tooltip) {
                    const [r, g, b] = cur.color;
                    this._tooltip.innerHTML = `<span class="dot" style="background:rgb(${r},${g},${b})"></span>${cur.short}`;
                }
            } else {
                label.textContent = '—';
            }
        }
        this.engine.update(t);
    }

    // single tooltip chip that follows the thumb and shows the active phase
    buildTooltip() {
        const legend = document.getElementById('phasing-legend');
        legend.innerHTML = '<span class="phasing-chip" id="phasing-tooltip"></span>';
        this._tooltip = document.getElementById('phasing-tooltip');
    }
}

Autodesk.Viewing.theExtensionManager.registerExtension('PhasingExtension', PhasingExtension);
