/* ============================================================================
 * Phasing engine — level detection, phase construction, visibility/theming,
 * and the fall-in animation (fragment transform manipulation).
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

        // level from Revit constraints (only categories that are phased by level)
        const level = new Map();
        if (!this._catPhase.has(category)) {
            const props = await new Promise((res) => {
                const map = new Map();
                model.getBulkProperties(dbids, { propFilter: this._cfg.levelProps }, (r) => {
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
            for (const d of dbids) level.set(d, this.resolve(props.get(d)));
        }

        // world Z per element (for the height-based level guess below)
        const box = new Array(6);
        tree.getNodeBox(tree.getRootId(), box);
        this._modelZ.set(model, isFinite(box[0]) ? { min: box[2], max: box[5] } : null);
        for (const d of dbids) {
            tree.getNodeBox(d, box);
            this._entries.push({
                model, category, dbid: d,
                level: level.get(d) ?? null,
                z: isFinite(box[0]) ? (box[2] + box[5]) / 2 : null
            });
        }
        console.log(`[phasing] ${category}: ${dbids.length} elements`);
    }

    // Parking -> 0, "L1 - Block 35" -> 1, roof-level names -> 'roof', else null
    resolve(props) {
        if (!props) return null;
        for (const name of this._cfg.levelProps) {
            for (const v of [].concat(props.get(name))) {
                if (typeof v !== 'string') continue;
                if (/^parking/i.test(v)) return 0;
                const m = v.match(/^L(\d+)/i);
                if (m) return +m[1];
                if (this._cfg.roofLevels.some((r) => new RegExp('^' + r, 'i').test(v))) return 'roof';
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

        // phases: category-major (floors, then walls, then stairs), level-minor
        const cats = this._cfg.levelCategories;
        const all = [];
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
        const span = 100 / all.length;
        this._phases = all.map((p, i) => ({ ...p, start: i * span, end: (i + 1) * span }));
        this._phaseById = new Map(this._phases.map((p) => [p.id, p]));

        this._buckets = new Map();
        const push = (pid, model, dbid) => {
            if (!this._buckets.has(pid)) this._buckets.set(pid, new Map());
            const m = this._buckets.get(pid);
            if (!m.has(model)) m.set(model, []);
            m.get(model).push(dbid);
        };
        for (const e of this._entries) {
            const lv = e.level === 'roof' ? null : (e.level ?? band(e));
            const pid = this._catPhase.get(e.category) || (lv === null ? 'roof' : e.category.toLowerCase() + '-' + lv);
            push(pid, e.model, e.dbid);
        }
        console.log('[phasing]', this._phases.map((p) => p.short).join(' '));

        this._statusKey = null;
        if (this.onFinalize) this.onFinalize();
    }

    /* ---- state ---- */

    statusOf(p, t) { return t < p.start ? 0 : t >= p.end ? 2 : 1; }
    progress(p, t) { return Math.min(1, Math.max(0, (t - p.start) / (p.end - p.start))); }

    // Called on every slider input: render when the phase status set changes,
    // and keep the in-progress phase's drop height in sync with t.
    update(t) {
        const key = this._phases.map((p) => this.statusOf(p, t)).join('');
        if (key !== this._statusKey) {
            this._statusKey = key;
            this.render(t);
        }
        const cur = this._phases.find((p) => p.start <= t && t < p.end);
        if (cur) {
            const p = this.progress(cur, t);
            if (p !== cur._lastP) {
                cur._lastP = p;
                this.drop(cur, p);
                this.viewer.impl.invalidate(true);
            }
        }
    }

    render(t) {
        for (const [pid, byModel] of this._buckets) {
            const p = this._phaseById.get(pid);
            const s = this.statusOf(p, t);
            if (s === p._lastStatus) continue;
            p._lastStatus = s;
            for (const [model, dbids] of byModel) {
                if (model.isLoadDone && !model.isLoadDone()) continue;
                try {
                    if (s === 0) {
                        this.viewer.hide(dbids, model);
                    } else {
                        this.viewer.show(dbids, model);
                        const [r, g, b] = p.color;
                        const c = new THREE.Vector4(r / 255, g / 255, b / 255, s === 2 ? 0.35 : 1);
                        for (const d of dbids) model.setThemingColor(d, c);
                    }
                } catch (err) {
                    console.warn('[phasing]', pid, err.message);
                }
            }
            if (s === 1) this.drop(p, this.progress(p, t));
            else if (p._drop) this.drop(p, null);
        }
        this.viewer.impl.invalidate(true);
    }

    // lift (or reset) a phase's fragments; prog 0..1 -> lift = (1-prog) * dropHeight
    drop(p, prog) {
        const reset = prog == null;
        const byModel = this._buckets.get(p.id) || new Map();
        this._pos.set(0, 0, reset ? 0 : (1 - prog) * this._cfg.dropHeight);
        for (const [model, dbids] of byModel) {
            const fl = model.getFragmentList();
            const tree = this._trees.get(model);
            if (!fl || !fl.updateAnimTransform || !tree) continue;
            for (const d of dbids) {
                // NOTE: the SVF2 fragment list has no dbId2fragId map — enumerate
                // the node's fragments through the instance tree instead.
                tree.enumNodeFragments(d, (f) => {
                    reset ? fl.updateAnimTransform(f) : fl.updateAnimTransform(f, null, null, this._pos);
                });
            }
        }
        p._drop = !reset;
    }

    clearOverrides() {
        for (const p of this._phases) {
            p._lastStatus = undefined;
            p._lastP = undefined;
            if (p._drop) this.drop(p, null);
        }
        for (const byModel of this._buckets.values()) {
            for (const [model, dbids] of byModel) {
                this.viewer.clearThemingColors(model);
                this.viewer.show(dbids, model);
            }
        }
        this._statusKey = null;
    }
}
