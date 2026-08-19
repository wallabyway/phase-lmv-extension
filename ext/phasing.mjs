/* ============================================================================
 * Phasing engine — level detection, phase construction, visibility/theming,
 * and the fall-in animation (fragment transform manipulation; the 0..1000
 * slider drives the drop height directly — no tweening).
 * Pure logic + viewer API; no DOM. Driven by the UI extension (ui.mjs).
 * ========================================================================== */

export class PhasingEngine {
    constructor(viewer) {
        this.viewer = viewer;
        this._cfg = null;
        this._phases = [];          // {id, name, short, start, end, color}
        this._phaseById = new Map();
        this._catPhase = new Map(); // category -> static phase id (roof / finishes)
        this._entries = [];         // {model, category, dbid, level, z}
        this._buckets = new Map();  // phaseId -> Map(model -> [dbids])
        this._modelZ = new Map();   // model -> {min, max} (height guess baseline)
        this._trees = new Map();    // model -> object tree (fragment enumeration)
        this._pending = 0;
        this._pos = new THREE.Vector3();
        this.onFinalize = null;     // called once phases + buckets are built
    }

    get phases() { return this._phases; }
    get buckets() { return this._buckets; }

    setPhases(cfg) {
        this._cfg = cfg;
        this._catPhase.clear();
        for (const p of cfg.byCategory) {
            for (const c of p.categories) this._catPhase.set(c, p.id);
        }
    }

    reset() {
        this._statusKey = null;
        for (const p of this._phases) p._lastStatus = undefined;
    }

    /** Drop all per-model state (a model switch unloaded the previous model).
     *  Config (_cfg/_catPhase) survives — the schedule is model-independent. */
    clearModels() {
        this._phases = [];
        this._phaseById.clear();
        this._entries = [];
        this._buckets.clear();
        this._modelZ.clear();
        this._trees.clear();
        this._pending = 0;
        this._statusKey = null;
    }

    /* ---- analysis ---- */

    addModel(model, category) {
        this._pending++;
        this.analyze(model, category).finally(() => {
            if (--this._pending === 0) this.finalize();
        });
    }

    async analyze(model, category) {
        const tree = await new Promise((res, rej) => model.getObjectTree(res, rej));
        this._trees.set(model, tree);
        const dbids = [];
        tree.enumNodeChildren(tree.getRootId(), (d) => {
            if (tree.getChildCount(d) === 0) dbids.push(d);
        }, true);

        // per-element Revit category + level from constraints. With a combined
        // model (single {3D} view) the category can no longer be tagged per
        // model, so it comes from the element's 'Category' property; the model
        // tag is only a fallback when the property is missing.
        const props = await new Promise((res) => {
            const map = new Map();
            model.getBulkProperties(dbids, { propFilter: ['Category', ...this._cfg.levelProps] }, (r) => {
                for (const p of r) {
                    const m = new Map();
                    for (const pr of p.properties) {
                        const prev = m.get(pr.displayName);
                        m.set(pr.displayName, prev === undefined ? pr.displayValue : [].concat(prev, pr.displayValue));
                    }
                    map.set(p.dbId, m);
                }
                res(map);
            }, () => res(map));
        });

        // world Z per element (for the height-based level guess below)
        const box = new Array(6);
        tree.getNodeBox(tree.getRootId(), box);
        this._modelZ.set(model, isFinite(box[0]) ? { min: box[2], max: box[5] } : null);

        // First pass: classify every element's level name. Models name their
        // levels differently — Snowdon uses "Parking / L1 / L2 / R1", the
        // Office sample uses "Basement / Ground Floor / 1st Floor / Top of
        // Roof". Classification is ordinal; when the model has an explicit
        // ground level, ordinals shift up by one (ground=1, 1st floor=2, ...)
        // so the timeline stays in physical floor order.
        const rawLevels = dbids.map((d) => {
            const pr = props.get(d);
            return pr ? this.classifyLevel(pr) : null;
        });
        const hasGround = rawLevels.some((l) => l === 'ground');

        for (let i = 0; i < dbids.length; i++) {
            const d = dbids[i];
            tree.getNodeBox(d, box);
            const pr = props.get(d);
            let cat = pr ? [].concat(pr.get('Category')).find((v) => typeof v === 'string') : null;
            if (cat) {
                cat = cat.replace(/^Revit\s+/i, ''); // LMV prefixes category values with 'Revit '
                cat = (this._cfg.categoryMap && this._cfg.categoryMap[cat]) || cat;
            }
            const raw = rawLevels[i];
            let level = null;
            if (raw === 'roof') level = 'roof';
            else if (raw === 'ground') level = 1;
            // below-grade stays 0; ordinals >= 1 shift up past the ground level
            else if (typeof raw === 'number') level = raw === 0 ? 0 : hasGround ? raw + 1 : raw;
            this._entries.push({
                model, category: cat || category, dbid: d,
                level,
                z: isFinite(box[0]) ? (box[2] + box[5]) / 2 : null
            });
        }
        console.log(`[phasing] ${category || 'model'}: ${dbids.length} elements`);
    }

    // Classify an element's level from its constraint properties. Returns:
    //   0        below grade (parking / basement / B1 / P1)
    //   'ground' explicit ground level ("Ground Floor")
    //   n        ordinal floor ("L1 - Block 35", "Level 1", "1st Floor")
    //   'roof'   roof-level names (R1 / Parapet / "Top of Roof" / "Roof Terrace")
    //   null     no recognizable level (height-band guess kicks in)
    classifyLevel(props) {
        if (!props) return null;
        for (const name of this._cfg.levelProps) {
            for (const v of [].concat(props.get(name))) {
                if (typeof v !== 'string') continue;
                if (this._cfg.roofLevels.some((r) => new RegExp('^' + r, 'i').test(v))) return 'roof';
                if (/^(?:roof|terrace|parapet|penthouse|top of core)/i.test(v)) return 'roof';
                if (/^(?:parking|basement|lower level|b\d|p\d)/i.test(v)) return 0;
                if (/^ground/i.test(v)) return 'ground';
                const m = v.match(/^L(\d+)/i);
                if (m) return +m[1];
                const m2 = v.match(/^level\s+(\d+)/i);
                if (m2) return +m2[1];
                const m3 = v.match(/^(\d+)(?:st|nd|rd|th)\s*(?:floor|level)?/i);
                if (m3) return +m3[1];
            }
        }
        return null;
    }

    /* ---- phases & buckets ---- */

    finalize() {
        const levels = [...new Set(this._entries.map((e) => e.level).filter((l) => typeof l === 'number'))].sort((a, b) => a - b);
        if (!levels.length) levels.push(1);

        // guess levels for elements without level props: assume the levels are
        // evenly spaced over the model's height (no per-level bounds analysis)
        const band = (e) => {
            const r = this._modelZ.get(e.model);
            if (!r || r.max <= r.min || e.z == null) return levels[0];
            const i = Math.min(levels.length - 1, Math.max(0, Math.floor(((e.z - r.min) / (r.max - r.min)) * levels.length)));
            return levels[i];
        };

        // phases: category-major (structure, floors, walls, envelope, stairs, doors), level-minor
        const cats = this._cfg.levelCategories;
        let all = [];
        for (let ci = 0; ci < cats.length; ci++) {
            for (const lv of levels) {
                all.push({
                    id: cats[ci].toLowerCase() + '-' + lv,
                    name: cats[ci] + ' L' + lv,
                    short: cats[ci] + ' L' + lv,
                    color: this._cfg.colors[ci % this._cfg.colors.length]
                });
            }
        }
        for (const p of this._cfg.byCategory) all.push(p);

        // bucket by per-element category: level categories drop level by level,
        // roof/finishes via their static phase, everything else goes to 'other'
        // (appended at the end of the belt only if it has any elements)
        this._buckets = new Map();
        const push = (pid, model, dbid) => {
            if (!this._buckets.has(pid)) this._buckets.set(pid, new Map());
            const m = this._buckets.get(pid);
            if (!m.has(model)) m.set(model, []);
            m.get(model).push(dbid);
        };
        let sawOther = false;
        for (const e of this._entries) {
            const cat = e.category;
            const lv = e.level === 'roof' ? null : (e.level ?? band(e));
            let pid;
            if (this._catPhase.has(cat)) pid = this._catPhase.get(cat);
            else if (lv === null) pid = 'roof';
            else if (cats.includes(cat)) pid = cat.toLowerCase() + '-' + lv;
            else { pid = 'other'; sawOther = true; }
            push(pid, e.model, e.dbid);
        }
        if (sawOther) {
            all.push({ id: 'other', name: 'Other', short: 'Other', color: [110, 110, 110] });
        }
        // drop phases that ended up with no elements — no dead slots on the belt
        all = all.filter((p) => this._buckets.has(p.id));

        // Conveyor-belt timeline: a new part appears every `step` units, but each
        // part stays in flight for `overlap` steps, so several parts hang and fall
        // simultaneously (exactly `overlap` of them at any interior time). The
        // last part lands exactly at t=100.
        const overlap = this._cfg.overlap ?? 2;
        const step = 100 / (all.length - 1 + overlap);
        this._phases = all.map((p, i) => ({
            ...p,
            start: i * step,
            end: i * step + overlap * step,
            _lift: 0 // current visual lift (last applied drop height)
        }));
        this._phaseById = new Map(this._phases.map((p) => [p.id, p]));
        console.log('[phasing]', this._phases.map((p) => p.short).join(' '));

        this._statusKey = null;
        if (this.onFinalize) this.onFinalize();
    }

    /* ---- state ---- */

    statusOf(p, t) { return t < p.start ? 0 : t >= p.end ? 2 : 1; }
    progress(p, t) { return Math.min(1, Math.max(0, (t - p.start) / (p.end - p.start))); }
    // ease-out (cubic): parts drop quickly at first, then settle gently into place
    easeOut(u) { return 1 - Math.pow(1 - u, 3); }
    // Target lift (hanging height) of a phase at time t; 0 = settled on the floor.
    liftTarget(p, t) {
        return this.statusOf(p, t) === 1 ? (1 - this.easeOut(this.progress(p, t))) * this._cfg.dropHeight : 0;
    }

    // Called on every slider input: rebuild the isolated visible set and reapply
    // theming when the phase status set changes, then move every in-flight phase's
    // lift exactly where t puts it. The 0..1000 slider stepping makes the fall
    // smooth — no tweening.
    update(t) {
        const key = this._phases.map((p) => this.statusOf(p, t)).join('');
        const keyChanged = key !== this._statusKey;
        if (keyChanged) this._statusKey = key;
        // Always re-apply visibility via isolate(); LMV state can drift while
        // scrubbing (new fragments stream, isolation state is shared, etc.), so
        // relying only on the status key lets geometry leak when scrubbing back
        // to an earlier slider position.
        this.render(t, keyChanged);
        for (const p of this._phases) {
            const target = this.liftTarget(p, t);
            if (p._lift === target) continue;
            // skip sub-step jitter mid-curve, but NEVER when settling: the eased
            // tail moves < 0.5 units per step, so target 0 must always land exactly
            if (target !== 0 && Math.abs(p._lift - target) < 0.5) continue;
            p._lift = target;
            this._applyLift(p, target);
        }
    }

    render(t, applyTheming) {
        // Build the set of dbIds that should be visible at this t, per model.
        // viewer.isolate() is the renderer's own "source of truth" visibility call:
        // it hides every fragment except the isolated set in one shot. This avoids
        // the SVF2 visibility-manager race that could leave furniture/windows/etc.
        // drawn at t=0 when viewer.hide() was issued before all fragments streamed.
        const visibleByModel = new Map();
        for (const [pid, byModel] of this._buckets) {
            const p = this._phaseById.get(pid);
            const s = this.statusOf(p, t);
            const statusChanged = s !== p._lastStatus;
            if (statusChanged) p._lastStatus = s;
            const [r, g, b] = p.color;
            const c = s === 0 ? null : new THREE.Vector4(r / 255, g / 255, b / 255, s === 2 ? 0.35 : 1);
            for (const [model, dbids] of byModel) {
                if (!visibleByModel.has(model)) visibleByModel.set(model, new Set());
                if (s !== 0) {
                    const visible = visibleByModel.get(model);
                    for (const d of dbids) visible.add(d);
                }
                if (applyTheming && statusChanged) {
                    try {
                        for (const d of dbids) model.setThemingColor(d, c);
                    } catch (err) {
                        console.warn('[phasing] theming', pid, err.message);
                    }
                }
            }
        }
        for (const [model, visible] of visibleByModel) {
            try {
                this.viewer.isolate([...visible], model);
            } catch (err) {
                console.warn('[phasing] isolate', err.message);
            }
        }
        this.viewer.impl.invalidate(true);
    }

    /* ---- fall-in animation ----
     * The slider drives the drop height directly (0..1000 steps = ~1% of
     * dropHeight per step, so the fall is smooth without tweening). */

    // Set a phase's fragments to the given lift (z offset above their resting place).
    _applyLift(p, z) {
        this._pos.set(0, 0, z);
        const byModel = this._buckets.get(p.id) || new Map();
        for (const [model, dbids] of byModel) {
            // NOTE: no isLoadDone() guard here — SVF2 models can report false
            // even when fully rendered, and the transform is harmless to apply.
            const fl = model.getFragmentList();
            const tree = this._trees.get(model);
            if (!fl || !fl.updateAnimTransform || !tree) continue;
            for (const d of dbids) {
                // NOTE: the SVF2 fragment list has no dbId2fragId map — enumerate
                // the node's fragments through the instance tree instead.
                tree.enumNodeFragments(d, (f) => fl.updateAnimTransform(f, null, null, this._pos));
            }
        }
        this.viewer.impl.invalidate(true);
    }

    // Remove the anim transform entirely (original position).
    _resetLift(p) {
        const byModel = this._buckets.get(p.id) || new Map();
        for (const [model, dbids] of byModel) {
            const fl = model.getFragmentList();
            const tree = this._trees.get(model);
            if (!fl || !fl.updateAnimTransform || !tree) continue;
            for (const d of dbids) tree.enumNodeFragments(d, (f) => fl.updateAnimTransform(f));
        }
        this.viewer.impl.invalidate(true);
    }

    clearOverrides() {
        for (const p of this._phases) {
            p._lastStatus = undefined;
            p._lift = 0;
            this._resetLift(p); // restore fragment transforms
        }
        // On a model switch the old model may already be unloaded — skip it,
        // or clearThemingColors/show throw on the dead model object.
        const live = new Set(this.viewer.impl?.modelQueue?.()?.getModels?.() ?? []);
        for (const byModel of this._buckets.values()) {
            for (const [model, dbids] of byModel) {
                if (!live.has(model)) continue;
                try {
                    this.viewer.clearThemingColors(model);
                    this.viewer.show(dbids, model);
                } catch (err) {
                    console.warn('[phasing] clearOverrides', err.message);
                }
            }
        }
        // Fully exit isolation mode so the next bar activation starts from a
        // clean "everything visible" state.
        try {
            if (live.size && this.viewer.showAll) this.viewer.showAll();
        } catch (err) {
            console.warn('[phasing] clearOverrides showAll', err.message);
        }
        this._statusKey = null;
        this.viewer.impl.invalidate(true);
    }
}
