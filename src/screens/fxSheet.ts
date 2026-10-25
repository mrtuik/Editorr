import {
  BUILT_IN, FX_RANGE, FX_TARGETS, cloneChain, defaultChain, eqResponse, getFx, loadCustom, mergeChain, saveCustom, sameSound,
  type FxChain, type FxTarget,
} from '../core/fx';
import type { Project } from '../core/types';
import { confirmDialog, h, icon, promptDialog, toast } from '../ui';

export interface FxCtx {
  p: Project;
  /** Settings changed: update the live preview and save the project. */
  changed: () => void;
  /** Hear the original (A/B). Preview only. */
  setBypass: (on: boolean) => void;
}

type BandKey = 'hpf' | 'mud' | 'presence' | 'crisp' | 'air';
const BANDS: { key: BandKey; label: string; short: string; color: string }[] = [
  { key: 'hpf', label: 'Low-cut', short: '1', color: '#64D2FF' },
  { key: 'mud', label: 'Warmth / mud', short: '2', color: '#FF9F0A' },
  { key: 'presence', label: 'Presence', short: '3', color: '#C6F277' },
  { key: 'crisp', label: 'Crispness', short: '4', color: '#BF5AF2' },
  { key: 'air', label: 'Air', short: '5', color: '#FF6B8A' },
];

// graph geometry: 20 Hz .. 20 kHz on a log axis, +-15 dB
const W = 640, H = 300, PL = 34, PR = 14, PT = 14, PB = 26, DB = 15;
const fx = (f: number) => PL + (Math.log(f / 20) / Math.log(1000)) * (W - PL - PR);
const fy = (db: number) => PT + ((DB - db) / (2 * DB)) * (H - PT - PB);
const unF = (X: number) => 20 * Math.pow(1000, Math.max(0, Math.min(1, (X - PL) / (W - PL - PR))));
const unDb = (Y: number) => DB - ((Y - PT) / (H - PT - PB)) * 2 * DB;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz` : `${Math.round(f)} Hz`);
const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  const val = h('b', {}, fmt(value));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'at-range', 'aria-label': label }) as HTMLInputElement;
  r.addEventListener('input', () => { const v = Number(r.value); val.textContent = fmt(v); onInput(v); });
  return h('div', { class: 'at-sec fx-sl' }, h('div', { class: 'at-label-row' }, h('div', { class: 'at-label' }, label), val), r);
}

function head(title: string, on: boolean, toggle?: (v: boolean) => void): HTMLElement {
  return h('div', { class: 'at-label-row fx-head' }, h('div', { class: 'fx-sec-title' }, title),
    toggle ? h('button', { class: 'chip fx-sw' + (on ? ' on' : ''), onclick: () => toggle(!on) }, on ? 'On' : 'Off') : h('span', {}));
}

/** Enhanced Audio studio: pick Host / Guest / Master, a preset, shape the 5-band EQ on the graph, then dynamics. */
export function openFxSheet(ctx: FxCtx): void {
  const { p } = ctx;
  const state = getFx(p);
  let target: FxTarget = p.mainAudio === 'constant' ? 'constant' : 'host';
  let band: BandKey = 'presence';
  let custom = loadCustom();
  let bypass = false;
  const chain = () => state[target];

  const close = () => { ctx.setBypass(false); sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const abBtn = h('button', { class: 'chip fx-ab', 'aria-label': 'Hear the original', onclick: () => { bypass = !bypass; ctx.setBypass(bypass); paintAb(); } }, 'A/B');
  const paintAb = () => { abBtn.classList.toggle('on', bypass); abBtn.textContent = bypass ? 'Original' : 'A/B'; };

  const tabs = h('div', { class: 'schips fx-tabs' });
  const top = h('div', {});
  const cv = h('canvas', { class: 'fx-cv', width: String(W), height: String(H) }) as HTMLCanvasElement;
  const bandRow = h('div', { class: 'schips fx-bands' });
  const ctrl = h('div', {});
  const dyn = h('div', {});
  const body = h('div', { class: 'at-body' }, tabs, top, h('div', { class: 'at-sec' }, cv), bandRow, ctrl, dyn);
  const sheet = h('div', { class: 'at-sheet fx', role: 'dialog' },
    h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Close', onclick: close }, icon('back', 20)), h('div', { class: 'at-title' }, 'Enhanced Audio'), abBtn),
    body);
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  /** Something changed: the preview, the save and the graph. */
  const touch = () => { ctx.changed(); draw(); };

  // ------------------------------------------------------------ target tabs
  function renderTabs() {
    tabs.replaceChildren(...FX_TARGETS.map(([t, l]) => h('button', {
      class: 'chip' + (t === target ? ' on' : ''),
      onclick: () => { target = t; renderAll(); },
    }, l + (state[t].on ? ' •' : ''))));
  }

  // ------------------------------------------------------------ presets
  const isBuiltIn = (name?: string) => BUILT_IN.some((b) => b.name === name);
  function applyPreset(src: FxChain, name: string) {
    const c = cloneChain(src); c.on = true; c.preset = name;
    state[target] = c; touch(); renderAll();
  }
  function renderTop() {
    const c = chain();
    const cur = c.preset ? [...BUILT_IN, ...custom].find((x) => x.name === c.preset) : undefined;
    const edited = !!cur && !sameSound(c, cur.chain);
    const chipsRow = h('div', { class: 'chips fx-presets' },
      ...BUILT_IN.map((b) => h('button', { class: 'chip' + (c.preset === b.name ? ' on' : ''), title: b.hint, onclick: () => applyPreset(b.chain, b.name) }, b.name)),
      ...custom.map((u) => h('button', { class: 'chip' + (c.preset === u.name ? ' on' : ''), onclick: () => applyPreset(u.chain, u.name) }, '★ ' + u.name)));
    const acts: HTMLElement[] = [h('button', { class: 'chip', onclick: () => void saveNew() }, icon('plus', 16), 'Save as preset')];
    if (cur && !isBuiltIn(c.preset)) {
      acts.push(h('button', { class: 'chip', onclick: () => overwrite() }, 'Overwrite'),
        h('button', { class: 'chip', onclick: () => void rename() }, 'Rename'),
        h('button', { class: 'chip', onclick: () => void remove() }, icon('trash', 16), 'Delete'));
    }
    acts.push(h('button', { class: 'chip', onclick: () => resetToDefault() }, icon('undo', 16), 'Reset'));
    const note = p.mainAudio !== target && target !== 'master'
      ? h('div', { class: 'at-hint' }, `${target === 'host' ? 'Host' : 'Guest'} mic is not the audio source right now, so you will not hear or export it. Change the audio source in Audio.`)
      : h('div', { class: 'at-hint' }, target === 'master' ? 'Master works on the whole mix: voice and music together.' : (cur ? `${c.preset}${edited ? ' (edited)' : ''}: ${'hint' in cur ? cur.hint : 'your own preset'}` : 'Pick a preset or shape the sound yourself.'));
    top.replaceChildren(
      head(target === 'master' ? 'Master' : target === 'host' ? 'Host mic' : 'Guest mic', c.on, (v) => { c.on = v; touch(); renderAll(); }),
      note, chipsRow, h('div', { class: 'schips fx-acts' }, ...acts));
  }
  async function saveNew() {
    const c = chain();
    const base = c.preset && !isBuiltIn(c.preset) ? c.preset : 'My preset';
    const raw = await promptDialog('Preset name', base);
    if (raw == null) return;
    let name = raw.trim().slice(0, 28) || 'My preset';
    if (isBuiltIn(name)) name += ' (mine)';
    const saved = cloneChain(c); saved.on = true; delete saved.preset;
    custom = [...custom.filter((x) => x.name !== name), { name, chain: saved }];
    saveCustom(custom);
    c.preset = name; ctx.changed(); renderAll(); toast(`Saved "${name}".`);
  }
  function overwrite() {
    const c = chain(); const i = custom.findIndex((x) => x.name === c.preset);
    if (i < 0) return;
    const saved = cloneChain(c); saved.on = true; delete saved.preset;
    custom[i] = { name: custom[i].name, chain: saved }; saveCustom(custom); renderAll(); toast(`Updated "${custom[i].name}".`);
  }
  async function rename() {
    const c = chain(); const i = custom.findIndex((x) => x.name === c.preset);
    if (i < 0) return;
    const raw = await promptDialog('Preset name', custom[i].name);
    const name = raw?.trim().slice(0, 28);
    if (!name || isBuiltIn(name) || custom.some((x, j) => j !== i && x.name === name)) { if (raw != null) toast('That name is already used.'); return; }
    const oldName = custom[i].name;
    custom[i] = { name, chain: custom[i].chain }; saveCustom(custom);
    for (const t of Object.keys(state) as FxTarget[]) if (state[t].preset === oldName) state[t].preset = name;
    ctx.changed(); renderAll();
  }
  async function remove() {
    const c = chain(); const i = custom.findIndex((x) => x.name === c.preset);
    if (i < 0) return;
    if (!(await confirmDialog(`Delete "${custom[i].name}"?`, 'The sound in this video stays as it is.', 'Delete'))) return;
    custom.splice(i, 1); saveCustom(custom); delete c.preset; ctx.changed(); renderAll();
  }
  function resetToDefault() {
    const c = chain();
    const b = BUILT_IN.find((x) => x.name === c.preset);
    const fresh = b ? cloneChain(b.chain) : (() => { const d = defaultChain(); d.on = c.on; return d; })();
    if (b) fresh.on = c.on;
    state[target] = mergeChain(fresh); touch(); renderAll();
  }

  // ------------------------------------------------------------ EQ graph
  function pointOf(k: BandKey): { x: number; y: number } {
    const c = chain();
    if (k === 'hpf') return { x: fx(c.hpf.f), y: fy(eqResponse(c, [c.hpf.f])[0]) };
    return { x: fx(c[k].f), y: fy(c[k].g) };
  }
  function draw() {
    const g = cv.getContext('2d')!, c = chain();
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#141416'; g.fillRect(0, 0, W, H);
    g.font = '18px Roboto, sans-serif'; g.textBaseline = 'middle';
    // grid
    g.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) {
      g.strokeStyle = db === 0 ? '#3a3a3c' : '#222224';
      g.beginPath(); g.moveTo(PL, fy(db)); g.lineTo(W - PR, fy(db)); g.stroke();
      g.fillStyle = '#6a6a6c'; g.textAlign = 'right'; g.fillText(String(db), PL - 6, fy(db));
    }
    g.textAlign = 'center';
    for (const [f, l] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [20000, '20k']] as [number, string][]) {
      g.strokeStyle = '#222224'; g.beginPath(); g.moveTo(fx(f), PT); g.lineTo(fx(f), H - PB); g.stroke();
      g.fillStyle = '#6a6a6c'; g.fillText(l, fx(f), H - 11);
    }
    // curve
    const N = 160, freqs = Array.from({ length: N + 1 }, (_, i) => 20 * Math.pow(1000, i / N));
    const resp = eqResponse(c, freqs);
    const live = c.on;
    g.beginPath();
    resp.forEach((db, i) => { const X = fx(freqs[i]), Y = fy(clamp(db, -DB, DB)); if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y); });
    g.strokeStyle = live ? '#C6F277' : '#6a6a6c'; g.lineWidth = 4; g.lineJoin = 'round'; g.stroke();
    g.lineTo(fx(20000), fy(0)); g.lineTo(fx(20), fy(0)); g.closePath();
    g.fillStyle = live ? 'rgba(198,242,119,.13)' : 'rgba(120,120,122,.10)'; g.fill();
    // nodes
    for (const b of BANDS) {
      if (b.key === 'hpf' && !c.hpf.on) continue;
      const { x, y } = pointOf(b.key), sel = b.key === band;
      g.beginPath(); g.arc(x, y, sel ? 16 : 12, 0, 6.3);
      g.fillStyle = b.color; g.globalAlpha = sel ? 1 : 0.8; g.fill(); g.globalAlpha = 1;
      if (sel) { g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); }
      g.fillStyle = '#000'; g.font = 'bold 15px Roboto, sans-serif'; g.fillText(b.short, x, y + 1); g.font = '18px Roboto, sans-serif';
    }
  }
  let drag: BandKey | null = null;
  const pos = (ev: PointerEvent) => { const r = cv.getBoundingClientRect(); return { X: ((ev.clientX - r.left) / r.width) * W, Y: ((ev.clientY - r.top) / r.height) * H }; };
  cv.addEventListener('pointerdown', (ev) => {
    const { X, Y } = pos(ev), c = chain();
    let best: BandKey | null = null, bd = 60;
    for (const b of BANDS) {
      if (b.key === 'hpf' && !c.hpf.on) continue;
      const q = pointOf(b.key), d = Math.hypot(X - q.x, Y - q.y);
      if (d < bd) { bd = d; best = b.key; }
    }
    if (!best) return;
    drag = best; band = best; cv.setPointerCapture(ev.pointerId); renderBands(); renderCtrl(); draw();
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const { X, Y } = pos(ev), c = chain();
    if (drag === 'hpf') c.hpf.f = Math.round(clamp(unF(X), FX_RANGE.hpf.f[0], FX_RANGE.hpf.f[1]));
    else {
      const r = FX_RANGE[drag];
      c[drag].f = Math.round(clamp(unF(X), r.f[0], r.f[1]));
      c[drag].g = Math.round(clamp(unDb(Y), -12, 12) * 10) / 10;
    }
    if (!c.on) c.on = true;
    syncSliders(); touch();
  });
  const endDrag = () => { if (drag) { drag = null; renderTabs(); renderTop(); } };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ band picker + sliders
  function renderBands() {
    bandRow.replaceChildren(...BANDS.map((b) => h('button', {
      class: 'chip fx-band' + (b.key === band ? ' on' : ''), onclick: () => { band = b.key; renderBands(); renderCtrl(); draw(); },
    }, h('i', { class: 'fx-dot', style: `background:${b.color}` }), `${b.short} ${b.label}`)));
  }
  let sliders: { f?: HTMLInputElement; g?: HTMLInputElement; q?: HTMLInputElement; fv?: HTMLElement; gv?: HTMLElement; qv?: HTMLElement } = {};
  /** After a drag on the graph, move the sliders to match. */
  function syncSliders() {
    const c = chain();
    const s = sliders;
    if (band === 'hpf') { if (s.f) s.f.value = String(c.hpf.f); if (s.fv) s.fv.textContent = fmtHz(c.hpf.f); return; }
    const b = c[band];
    if (s.f) s.f.value = String(b.f); if (s.fv) s.fv.textContent = fmtHz(b.f);
    if (s.g) s.g.value = String(b.g); if (s.gv) s.gv.textContent = fmtDb(b.g);
  }
  function renderCtrl() {
    const c = chain();
    const parts: HTMLElement[] = [];
    const grab = (el: HTMLElement, key: 'f' | 'g' | 'q') => {
      const inp = el.querySelector('input') as HTMLInputElement, val = el.querySelector('b') as HTMLElement;
      sliders[key] = inp; (sliders as Record<string, HTMLElement>)[`${key}v`] = val; return el;
    };
    sliders = {};
    if (band === 'hpf') {
      parts.push(head('Low-cut (removes rumble, fan, AC hum)', c.hpf.on, (v) => { c.hpf.on = v; touch(); renderCtrl(); }));
      if (c.hpf.on) parts.push(grab(slider('Frequency', FX_RANGE.hpf.f[0], FX_RANGE.hpf.f[1], 1, c.hpf.f, fmtHz, (v) => { c.hpf.f = v; if (!c.on) c.on = true; touch(); }), 'f'));
    } else {
      const r = FX_RANGE[band];
      const lbl = BANDS.find((b) => b.key === band)!.label;
      parts.push(h('div', { class: 'fx-sec-title', style: 'margin-top:16px' }, lbl));
      const b = c[band];
      parts.push(grab(slider('Frequency', r.f[0], r.f[1], 1, b.f, fmtHz, (v) => { b.f = v; if (!c.on) c.on = true; touch(); }), 'f'));
      parts.push(grab(slider('Gain', -12, 12, 0.1, b.g, fmtDb, (v) => { b.g = v; if (!c.on) c.on = true; touch(); }), 'g'));
      if (band !== 'air') parts.push(grab(slider('Q (width)', 0.3, 4, 0.05, c[band as 'mud'].q, (v) => v.toFixed(2), (v) => { c[band as 'mud'].q = v; if (!c.on) c.on = true; touch(); }), 'q'));
    }
    ctrl.replaceChildren(...parts);
  }

  // ------------------------------------------------------------ dynamics + output
  function renderDyn() {
    const c = chain();
    const on = () => { if (!c.on) c.on = true; };
    dyn.replaceChildren(
      h('div', { class: 'at-sec' }, head('Vocal compressor', c.comp.on, (v) => { c.comp.on = v; on(); touch(); renderDyn(); }),
        h('div', { class: 'at-hint' }, 'Loud words come down, quiet words come up, so the voice stays even.'),
        ...(c.comp.on ? [
          slider('Threshold', -50, 0, 1, c.comp.thr, (v) => `${v} dB`, (v) => { c.comp.thr = v; on(); touch(); }),
          slider('Ratio', 1, 12, 0.5, c.comp.ratio, (v) => `${v}:1`, (v) => { c.comp.ratio = v; on(); touch(); }),
          slider('Attack', 1, 100, 1, c.comp.attack, (v) => `${v} ms`, (v) => { c.comp.attack = v; on(); touch(); }),
          slider('Release', 20, 500, 5, c.comp.release, (v) => `${v} ms`, (v) => { c.comp.release = v; on(); touch(); }),
          slider('Make-up gain', 0, 12, 0.5, c.comp.makeup, (v) => `+${v} dB`, (v) => { c.comp.makeup = v; on(); touch(); }),
        ] : [])),
      h('div', { class: 'at-sec' }, head('De-esser', c.deess.on, (v) => { c.deess.on = v; on(); touch(); renderDyn(); }),
        h('div', { class: 'at-hint' }, 'Softens sharp "s" and "sh" sounds.'),
        ...(c.deess.on ? [
          slider('Amount', 0, 100, 1, c.deess.amount, (v) => `${v}%`, (v) => { c.deess.amount = v; on(); touch(); }),
          slider('Frequency', 4000, 9000, 100, c.deess.f, fmtHz, (v) => { c.deess.f = v; on(); touch(); }),
        ] : [])),
      h('div', { class: 'at-sec' }, h('div', { class: 'fx-sec-title' }, 'Output & limiter'),
        h('div', { class: 'at-hint' }, 'The limiter holds the sound under the ceiling so it never cracks or distorts.'),
        slider('Output gain', -12, 12, 0.5, c.out.gain, fmtDb, (v) => { c.out.gain = v; on(); touch(); }),
        slider('Limiter ceiling', -6, 0, 0.5, c.out.ceiling, (v) => `${v} dBFS`, (v) => { c.out.ceiling = v; on(); touch(); })),
      h('div', { class: 'at-hint', style: 'margin-top:14px' }, 'Preview and export use the same settings. A/B only changes what you hear now; the export always has the effect on.'));
  }

  function renderAll() { renderTabs(); renderTop(); renderBands(); renderCtrl(); renderDyn(); draw(); }
  renderAll();
}
