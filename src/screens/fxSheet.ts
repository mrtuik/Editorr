import {
  BUILT_IN, FX_RANGE, cloneChain, defaultChain, eqResponse, getFx, loadCustom, mergeChain, saveCustom, sameSound,
  type FxChain, type FxTarget,
} from '../core/fx';
import type { Project } from '../core/types';
import { confirmDialog, h, icon, paintRange, promptDialog, toast } from '../ui';

export interface FxCtx {
  p: Project;
  /** Settings changed: update the live preview and save the project. */
  changed: () => void;
  /** Hear the original (A/B). Preview only. */
  setBypass: (on: boolean) => void;
  /** Noise reduction of a mic (the same value as the Denoise tool), 0..100. */
  getNoise: (role: 'host' | 'constant') => number;
  /** Set it (runs the denoise job, same as the Denoise tool). */
  setNoise: (role: 'host' | 'constant', strength: number) => void;
}

type BandKey = 'hpf' | 'chest' | 'mud' | 'presence' | 'crisp' | 'air';
const BANDS: { key: BandKey; label: string; short: string; color: string }[] = [
  { key: 'hpf', label: 'Low-cut', short: '1', color: '#64D2FF' },
  { key: 'chest', label: 'Chest / body', short: '2', color: '#FFD60A' },
  { key: 'mud', label: 'Boxiness', short: '3', color: '#FF9F0A' },
  { key: 'presence', label: 'Presence', short: '4', color: '#C6F277' },
  { key: 'crisp', label: 'Crispness', short: '5', color: '#BF5AF2' },
  { key: 'air', label: 'Air', short: '6', color: '#FF6B8A' },
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

/** A real on/off switch (iOS style). */
function switchEl(on: boolean, toggle: (v: boolean) => void, label: string): HTMLElement {
  return h('button', { class: 'fz-switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), 'aria-label': label, onclick: () => toggle(!on) }, h('i', {}));
}

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  const val = h('b', {}, fmt(value));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'at-range', 'aria-label': label }) as HTMLInputElement;
  paintRange(r);
  r.addEventListener('input', () => { const v = Number(r.value); val.textContent = fmt(v); paintRange(r); onInput(v); });
  return h('div', { class: 'fz-sl' }, h('div', { class: 'fz-sl-row' }, h('span', {}, label), val), r);
}

/** Section card with a title, an optional switch and a one-line hint. */
function card(title: string, hint?: string, sw?: HTMLElement, ...rows: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'fz-card' },
    h('div', { class: 'fz-card-head' }, h('div', { class: 'fz-card-title' }, title), sw ?? h('span', {})),
    hint ? h('div', { class: 'fz-hint' }, hint) : null,
    ...rows);
}

/** Scroll a horizontal row so the item is in the middle. Only moves the row itself, never the sheet. */
function centerIn(row: HTMLElement, item: HTMLElement | null): void {
  if (!item) return;
  const dx = item.getBoundingClientRect().left - row.getBoundingClientRect().left;
  row.scrollLeft += dx - (row.clientWidth - item.offsetWidth) / 2;
}

/** Small EQ curve drawn on a preset tile. */
function curve(src: FxChain): SVGElement {
  const NS = 'http://www.w3.org/2000/svg', N = 32, W = 64, H = 32, mid = H / 2, sc = (H / 2 - 3) / 9;
  const freqs = Array.from({ length: N + 1 }, (_, i) => 40 * Math.pow(400, i / N));
  const pts = eqResponse(src, freqs).map((db, i) => `${((i / N) * W).toFixed(1)},${(mid - clamp(db, -9, 9) * sc).toFixed(1)}`);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'fz-curve'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" class="z"/><path d="M${pts.join(' L')}" class="c"/>`;
  return svg;
}

/** Enhanced Audio studio: a preset, the 6-band EQ on the graph, then noise, compressor, de-esser and limiter. The mic is the audio source already chosen in the editor. */
export function openFxSheet(ctx: FxCtx): void {
  const { p } = ctx;
  const state = getFx(p);
  const voiceRole: 'host' | 'constant' = p.mainAudio === 'constant' ? 'constant' : 'host';
  let scope: 'voice' | 'master' = 'voice';
  let target: FxTarget = voiceRole;
  let band: BandKey = 'presence';
  let custom = loadCustom();
  let bypass = false;
  const chain = () => state[target];

  const close = () => { ctx.setBypass(false); sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const abBtn = h('button', { class: 'fz-ab', 'aria-label': 'Hear the original', onclick: () => { bypass = !bypass; ctx.setBypass(bypass); paintAb(); } }, 'A/B');
  const paintAb = () => { abBtn.classList.toggle('on', bypass); abBtn.textContent = bypass ? 'Original' : 'A/B'; };

  const subtitle = h('div', { class: 'fz-sub' });
  const seg = h('div', { class: 'fz-seg' });
  const top = h('div', {});
  const cv = h('canvas', { class: 'fx-cv', width: String(W), height: String(H) }) as HTMLCanvasElement;
  const bandRow = h('div', { class: 'fz-bands' });
  const ctrl = h('div', {});
  const dyn = h('div', {});
  const body = h('div', { class: 'at-body fz-body' }, seg, top,
    h('div', { class: 'fz-card fz-graph' }, cv, bandRow, ctrl), dyn);
  const sheet = h('div', { class: 'at-sheet fx fz', role: 'dialog' },
    h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' },
      h('button', { class: 'at-back', 'aria-label': 'Close', onclick: close }, icon('back', 20)),
      h('div', { class: 'fz-titles' }, h('div', { class: 'at-title' }, 'Enhanced Audio'), subtitle),
      abBtn),
    body);
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  /** Something changed: the preview, the save and the graph. */
  const touch = () => { ctx.changed(); draw(); };

  // ------------------------------------------------------------ scope: the voice (already chosen in the editor) or the whole mix
  function renderSeg() {
    subtitle.textContent = scope === 'master' ? 'Whole mix: voice and music' : `${voiceRole === 'host' ? 'Host' : 'Guest'} voice`;
    seg.replaceChildren(...([['voice', 'Voice'], ['master', 'Whole mix']] as ['voice' | 'master', string][]).map(([k, l]) => h('button', {
      class: 'fz-seg-b' + (scope === k ? ' on' : ''),
      onclick: () => { scope = k; target = k === 'master' ? 'master' : voiceRole; renderAll(); },
    }, l + (state[k === 'master' ? 'master' : voiceRole].on ? ' •' : ''))));
  }

  // ------------------------------------------------------------ switch + presets
  const isBuiltIn = (name?: string) => BUILT_IN.some((b) => b.name === name);
  function applyPreset(src: FxChain, name: string) {
    const c = cloneChain(src); c.on = true; c.preset = name;
    state[target] = c; touch(); renderAll();
    if (c.noise != null && target !== 'master') ctx.setNoise(target, c.noise);
  }
  function renderTop() {
    const c = chain();
    const cur = c.preset ? [...BUILT_IN, ...custom].find((x) => x.name === c.preset) : undefined;
    const edited = !!cur && !sameSound(c, cur.chain);
    const sub = cur ? `${c.preset}${edited ? ' · edited' : ''}` : 'Pick a preset or shape the sound yourself';
    const mainCard = h('div', { class: 'fz-card fz-main' },
      h('div', { class: 'fz-main-text' },
        h('div', { class: 'fz-card-title' }, target === 'master' ? 'Whole mix enhancement' : 'Voice enhancement'),
        h('div', { class: 'fz-hint' }, sub)),
      switchEl(c.on, (v) => { c.on = v; touch(); renderAll(); }, 'Enhanced audio on or off'));

    const tile = (name: string, src: FxChain, mine: boolean, hint?: string) => h('button', {
      class: 'fz-tile' + (c.preset === name ? ' on' : ''), title: hint, 'aria-label': name, onclick: () => applyPreset(src, name),
    }, curve(src), h('span', { class: 'fz-tile-name' }, (mine ? '★ ' : '') + name));
    const tiles = h('div', { class: 'fz-tiles' },
      ...BUILT_IN.map((b) => tile(b.name, b.chain, false, b.hint)),
      ...custom.map((u) => tile(u.name, u.chain, true)),
      h('button', { class: 'fz-tile add', 'aria-label': 'Save as preset', onclick: () => void saveNew() }, icon('plus', 22), h('span', { class: 'fz-tile-name' }, 'Save')));

    const acts: HTMLElement[] = [];
    if (cur && !isBuiltIn(c.preset)) {
      acts.push(h('button', { class: 'fz-link', onclick: () => overwrite() }, 'Overwrite'),
        h('button', { class: 'fz-link', onclick: () => void rename() }, 'Rename'),
        h('button', { class: 'fz-link danger', onclick: () => void remove() }, 'Delete'));
    }
    top.replaceChildren(mainCard,
      h('div', { class: 'fz-sec-head' }, h('span', {}, 'Presets'),
        h('button', { class: 'fz-link', onclick: () => resetToDefault() }, icon('undo', 14), 'Reset')),
      tiles,
      ...(acts.length ? [h('div', { class: 'fz-acts' }, ...acts)] : []));
    // keep the chosen preset in view
    requestAnimationFrame(() => centerIn(tiles, tiles.querySelector('.fz-tile.on') as HTMLElement | null));
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
    if (b && fresh.noise != null && target !== 'master') ctx.setNoise(target, fresh.noise);
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
  const endDrag = () => { if (drag) { drag = null; renderSeg(); renderTop(); } };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ band picker + sliders
  function renderBands() {
    bandRow.replaceChildren(...BANDS.map((b) => h('button', {
      class: 'fz-band' + (b.key === band ? ' on' : ''), onclick: () => { band = b.key; renderBands(); renderCtrl(); draw(); },
    }, h('i', { class: 'fx-dot', style: `background:${b.color}` }), `${b.short} ${b.label}`)));
    requestAnimationFrame(() => centerIn(bandRow, bandRow.querySelector('.fz-band.on') as HTMLElement | null));
  }
  let sliders: { f?: HTMLInputElement; g?: HTMLInputElement; q?: HTMLInputElement; fv?: HTMLElement; gv?: HTMLElement; qv?: HTMLElement } = {};
  /** After a drag on the graph, move the sliders to match. */
  function syncSliders() {
    const c = chain();
    const s = sliders;
    const set = (el: HTMLInputElement | undefined, v: number) => { if (el) { el.value = String(v); paintRange(el); } };
    if (band === 'hpf') { set(s.f, c.hpf.f); if (s.fv) s.fv.textContent = fmtHz(c.hpf.f); return; }
    const b = c[band];
    set(s.f, b.f); if (s.fv) s.fv.textContent = fmtHz(b.f);
    set(s.g, b.g); if (s.gv) s.gv.textContent = fmtDb(b.g);
  }
  function renderCtrl() {
    const c = chain();
    const parts: HTMLElement[] = [];
    const grab = (el: HTMLElement, key: 'f' | 'g' | 'q') => {
      const inp = el.querySelector('input') as HTMLInputElement, val = el.querySelector('b') as HTMLElement;
      sliders[key] = inp; (sliders as Record<string, HTMLElement>)[`${key}v`] = val; return el;
    };
    sliders = {};
    const touchOn = () => { if (!c.on) c.on = true; touch(); };
    if (band === 'hpf') {
      parts.push(h('div', { class: 'fz-band-head' }, h('div', {}, h('div', { class: 'fz-card-title' }, 'Low-cut'), h('div', { class: 'fz-hint' }, 'Removes rumble, fan and AC hum')),
        switchEl(c.hpf.on, (v) => { c.hpf.on = v; touchOn(); renderCtrl(); }, 'Low-cut on or off')));
      if (c.hpf.on) parts.push(grab(slider('Frequency', FX_RANGE.hpf.f[0], FX_RANGE.hpf.f[1], 1, c.hpf.f, fmtHz, (v) => { c.hpf.f = v; touchOn(); }), 'f'));
    } else {
      const r = FX_RANGE[band];
      const lbl = BANDS.find((b) => b.key === band)!.label;
      parts.push(h('div', { class: 'fz-band-head' }, h('div', { class: 'fz-card-title' }, lbl)));
      const b = c[band];
      parts.push(grab(slider('Frequency', r.f[0], r.f[1], 1, b.f, fmtHz, (v) => { b.f = v; touchOn(); }), 'f'));
      parts.push(grab(slider('Gain', -12, 12, 0.1, b.g, fmtDb, (v) => { b.g = v; touchOn(); }), 'g'));
      if (band !== 'air') parts.push(grab(slider('Q (width)', 0.3, 4, 0.05, c[band as 'mud'].q, (v) => v.toFixed(2), (v) => { c[band as 'mud'].q = v; touchOn(); }), 'q'));
    }
    ctrl.replaceChildren(...parts);
  }

  // ------------------------------------------------------------ noise, dynamics, output
  function renderDyn() {
    const c = chain();
    const on = () => { if (!c.on) c.on = true; };
    const noiseCard = target === 'master' ? null : card('De-noise', 'Reduces fan and room hiss. Same as the Denoise tool. A light 5-15% keeps the voice natural.', undefined,
      (() => {
        const role = target as 'host' | 'constant';
        const el = slider('Strength', 0, 100, 1, ctx.getNoise(role), (v) => `${v}%`, () => {});
        const inp = el.querySelector('input') as HTMLInputElement;
        inp.addEventListener('change', () => { chain().noise = Number(inp.value); ctx.setNoise(role, Number(inp.value)); ctx.changed(); });
        return el;
      })());
    dyn.replaceChildren(
      ...(noiseCard ? [noiseCard] : []),
      card('Compressor', 'Loud words come down, quiet words come up, so the voice stays even.',
        switchEl(c.comp.on, (v) => { c.comp.on = v; on(); touch(); renderDyn(); }, 'Compressor on or off'),
        ...(c.comp.on ? [
          slider('Threshold', -50, 0, 1, c.comp.thr, (v) => `${v} dB`, (v) => { c.comp.thr = v; on(); touch(); }),
          slider('Ratio', 1, 12, 0.5, c.comp.ratio, (v) => `${v}:1`, (v) => { c.comp.ratio = v; on(); touch(); }),
          slider('Attack', 1, 100, 1, c.comp.attack, (v) => `${v} ms`, (v) => { c.comp.attack = v; on(); touch(); }),
          slider('Release', 20, 500, 5, c.comp.release, (v) => `${v} ms`, (v) => { c.comp.release = v; on(); touch(); }),
          slider('Make-up gain', 0, 12, 0.5, c.comp.makeup, (v) => `+${v} dB`, (v) => { c.comp.makeup = v; on(); touch(); }),
        ] : [])),
      card('De-esser', 'Softens sharp "s" and "sh" sounds.',
        switchEl(c.deess.on, (v) => { c.deess.on = v; on(); touch(); renderDyn(); }, 'De-esser on or off'),
        ...(c.deess.on ? [
          slider('Amount', 0, 100, 1, c.deess.amount, (v) => `${v}%`, (v) => { c.deess.amount = v; on(); touch(); }),
          slider('Frequency', 4000, 9000, 100, c.deess.f, fmtHz, (v) => { c.deess.f = v; on(); touch(); }),
        ] : [])),
      card('Output & limiter', 'The limiter holds the sound under the ceiling so it never cracks or distorts.', undefined,
        slider('Output gain', -12, 12, 0.5, c.out.gain, fmtDb, (v) => { c.out.gain = v; on(); touch(); }),
        slider('Limiter ceiling', -6, 0, 0.5, c.out.ceiling, (v) => `${v} dBFS`, (v) => { c.out.ceiling = v; on(); touch(); })),
      h('div', { class: 'fz-foot' }, 'Preview and export use the same settings. A/B only changes what you hear now; the export always has the effect on.'));
  }

  function renderAll() { renderSeg(); renderTop(); renderBands(); renderCtrl(); renderDyn(); draw(); }
  renderAll();
}
