/**
 * The style controls shared by Text (Add text) and Captions (tap a word): Fonts, Styles (colour, stroke, glow,
 * background, shadow) and Effects (one-tap looks). Every control writes into an `Fx` through a small model, so the
 * same panels edit a whole text, one caption word or all caption words.
 */
import { DEFAULT_CAPTION_STYLE, drawCaption, FONTS, hexA, lookOf, resolveFx, type Fx, type FontId, type LookDef, type TextAnim } from '../core/captions';
import { h, slider as uiSlider, toggle } from '../ui';

export interface SliderSpec { label: string; min: number; max: number; step: number; get: () => number; set: (v: number) => void; fmt: (v: number) => string }

export interface FxModel {
  look: () => LookDef;
  /** colour of the plain text */
  color: () => string;
  setColor: (c: string) => void;
  /** the style this editor writes to */
  own: () => Fx;
  /** style layers underneath (a word sits on top of the style of all words) */
  below: () => Fx | undefined;
  /** change `own` and redraw the preview */
  patch: (f: (fx: Fx) => void) => void;
  size?: SliderSpec;
  opacity?: SliderSpec;
}

export const PALETTE = ['#FFFFFF', '#000000', '#F2C811', '#FF8A00', '#FF453A', '#FF2D9B', '#BF5AF2', '#0A84FF', '#19C3D8', '#30D158', '#B3B3B3', '#808080'];

/** #rrggbb or rgba(r,g,b,a) -> #RRGGBB (what <input type=color> needs). */
export function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (!m) return '#FFFFFF';
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function rgbaAlpha(c: string): number {
  const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(c);
  return m ? Number(m[1]) : 1;
}

export function slider(s: SliderSpec): HTMLElement {
  return uiSlider(s.label, s.min, s.max, s.step, s.get(), s.fmt, s.set);
}

export function colorRow(current: string, onPick: (hex: string) => void): HTMLElement {
  const cur = toHex(current).toLowerCase();
  const inp = h('input', { type: 'color', class: 'ts-colorpick', value: toHex(current) }) as HTMLInputElement;
  inp.addEventListener('change', () => onPick(inp.value.toUpperCase()));
  return h('div', { class: 'ts-colors' },
    h('label', { class: 'ts-circle wheel', 'aria-label': 'Custom colour' }, inp),
    h('span', { class: 'ts-sep' }),
    ...PALETTE.map((x) => h('button', { class: 'ts-circle' + (x.toLowerCase() === cur ? ' on' : ''), style: `background:${x}`, 'aria-label': x, onclick: () => onPick(x) })));
}

export function switchRow(label: string, on: boolean, onToggle: (next: boolean) => void): HTMLElement {
  return toggle(label, on, onToggle);
}

/** A small picture drawn by the real caption engine, so a tile shows exactly what you will get. */
export function tileCanvas(opts: { look?: LookDef['id']; color?: string; fx?: Fx; text?: string; font?: FontId; size?: number; anim?: TextAnim; ms?: number; end?: number }): HTMLCanvasElement {
  const cv = h('canvas', { width: '168', height: '100', class: 'fx-cv' }) as HTMLCanvasElement;
  paintTile(cv, opts);
  return cv;
}
export function paintTile(cv: HTMLCanvasElement, opts: { look?: LookDef['id']; color?: string; fx?: Fx; text?: string; font?: FontId; size?: number; anim?: TextAnim; ms?: number; end?: number }): void {
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#2c2c2f'; g.fillRect(0, 0, cv.width, cv.height);
  const fx: Fx = { ...(opts.fx ?? {}), ...(opts.font ? { font: opts.font } : {}) };
  const ms = opts.ms ?? 1000;
  drawCaption(g, cv.width, cv.height, { s: 0, e: opts.end ?? 100000, from: 0, to: 0, words: [{ t: opts.text ?? 'Aa', s: 0, e: opts.end ?? 100000 }] }, ms,
    { ...DEFAULT_CAPTION_STYLE, look: opts.look ?? 'minimal', size: opts.size ?? 0.38, y: 0.54, color: opts.color ?? '#FFFFFF', wordsPerLine: 99, roman: false },
    { fx, anim: opts.anim });
}

const eff = (m: FxModel): Fx => ({ ...(m.below() ?? {}), ...m.own() });
const resolved = (m: FxModel) => resolveFx(m.look(), m.color(), m.below(), m.own());

// ---------------------------------------------------------------------------------------------- Styles
type Sub = 'Text' | 'Stroke' | 'Glow' | 'Background' | 'Shadow';
const SUBS: Sub[] = ['Text', 'Stroke', 'Glow', 'Background', 'Shadow'];

export function stylePanel(m: FxModel, keep?: { sub: Sub }): HTMLElement {
  const state = keep ?? { sub: 'Text' as Sub };
  const root = h('div', { class: 'fx-style' });
  const subs = h('div', { class: 'ts-subtabs' });
  const area = h('div', { class: 'fx-area' });
  root.append(subs, area);

  const bgNow = (): { c: string; o: number; r: number } | null => {
    const f = eff(m);
    if (f.bg !== undefined) return f.bg;
    const b = m.look().box;
    return b ? { c: toHex(b), o: rgbaAlpha(b), r: 0.3 } : null;
  };

  function draw() {
    subs.replaceChildren(...SUBS.map((t) => h('button', { class: 'ts-sub' + (t === state.sub ? ' on' : ''), onclick: () => { state.sub = t; draw(); } }, t)));
    const r = resolved(m);
    const out: Node[] = [];
    if (state.sub === 'Text') {
      out.push(colorRow(m.color(), (c) => { m.setColor(c); draw(); }));
      if (m.size) out.push(slider(m.size));
      if (m.opacity) out.push(slider(m.opacity));
    } else if (state.sub === 'Stroke') {
      const st = r.stroke;
      out.push(
        switchRow('Stroke', !!st, (on) => { m.patch((fx) => { fx.stroke = on ? { c: '#000000', w: 0.14 } : null; }); draw(); }),
        ...(st ? [
          colorRow(st.c, (c) => { m.patch((fx) => { fx.stroke = { c, w: resolved(m).stroke?.w ?? 0.14 }; }); draw(); }),
          slider({ label: 'Width', min: 0.03, max: 0.4, step: 0.01, get: () => st.w, set: (v) => m.patch((fx) => { fx.stroke = { c: resolved(m).stroke?.c ?? '#000000', w: v }; }), fmt: (v) => String(Math.round(v * 100)) }),
        ] : []));
    } else if (state.sub === 'Glow') {
      const gl = r.glow;
      out.push(
        switchRow('Glow', !!gl, (on) => { m.patch((fx) => { fx.glow = on ? { c: '#19C3D8', b: 0.4 } : null; }); draw(); }),
        ...(gl ? [
          colorRow(gl.c, (c) => { m.patch((fx) => { fx.glow = { c, b: resolved(m).glow?.b ?? 0.4 }; }); draw(); }),
          slider({ label: 'Intensity', min: 0.1, max: 1, step: 0.05, get: () => gl.b, set: (v) => m.patch((fx) => { fx.glow = { c: resolved(m).glow?.c ?? '#19C3D8', b: v }; }), fmt: (v) => String(Math.round(v * 100)) }),
        ] : []));
    } else if (state.sub === 'Background') {
      const bg = bgNow();
      out.push(
        switchRow('Background', !!bg, (on) => { m.patch((fx) => { fx.bg = on ? { c: '#000000', o: 0.7, r: 0.3 } : null; }); draw(); }),
        ...(bg ? [
          colorRow(bg.c, (c) => { m.patch((fx) => { const b = bgNow() ?? { c, o: 0.7, r: 0.3 }; fx.bg = { ...b, c }; }); draw(); }),
          slider({ label: 'Opacity', min: 0.1, max: 1, step: 0.05, get: () => bg.o, set: (v) => m.patch((fx) => { const b = bgNow() ?? { c: '#000000', o: v, r: 0.3 }; fx.bg = { ...b, o: v }; }), fmt: (v) => `${Math.round(v * 100)}%` }),
          slider({ label: 'Corners', min: 0, max: 0.6, step: 0.02, get: () => bg.r, set: (v) => m.patch((fx) => { const b = bgNow() ?? { c: '#000000', o: 0.7, r: v }; fx.bg = { ...b, r: v }; }), fmt: (v) => String(Math.round(v * 100)) }),
        ] : []));
    } else {
      const sh = r.shadow;
      const dist = sh ? Math.hypot(sh.dx, sh.dy) : 0.06;
      const ang = sh ? (((Math.atan2(sh.dy, sh.dx) * 180) / Math.PI) + 360) % 360 : 90;
      const put = (patch: Partial<{ c: string; b: number; d: number; a: number }>) => m.patch((fx) => {
        const cur = resolved(m).shadow;
        const d = cur ? Math.hypot(cur.dx, cur.dy) : 0.06;
        const a = cur ? (((Math.atan2(cur.dy, cur.dx) * 180) / Math.PI) + 360) % 360 : 90;
        fx.shadow = { c: cur?.c ?? 'rgba(0,0,0,0.8)', b: cur?.b ?? 0.25, d, a, ...patch };
      });
      out.push(
        switchRow('Shadow', !!sh, (on) => { m.patch((fx) => { fx.shadow = on ? { c: 'rgba(0,0,0,0.8)', b: 0.25, d: 0.06, a: 90 } : null; }); draw(); }),
        ...(sh ? [
          colorRow(sh.c, (c) => { put({ c: hexA(c, 0.85) }); draw(); }),
          slider({ label: 'Blur', min: 0, max: 0.8, step: 0.02, get: () => sh.b, set: (v) => put({ b: v }), fmt: (v) => String(Math.round(v * 100)) }),
          slider({ label: 'Distance', min: 0, max: 0.3, step: 0.01, get: () => dist, set: (v) => put({ d: v }), fmt: (v) => String(Math.round(v * 100)) }),
          slider({ label: 'Angle', min: 0, max: 360, step: 5, get: () => ang, set: (v) => put({ a: v }), fmt: (v) => `${Math.round(v)}°` }),
        ] : []));
    }
    area.replaceChildren(...out);
  }
  draw();
  return root;
}

// ---------------------------------------------------------------------------------------------- Fonts
export function fontsPanel(m: FxModel, redraw: () => void): HTMLElement {
  const f = eff(m);
  const cur = f.font ?? 'sans';
  return h('div', { class: 'fx-fonts' },
    h('div', { class: 'fx-grid' }, ...FONTS.map((ft) => h('button', { class: 'fx-tile fx-font' + (ft.id === cur ? ' on' : ''), 'aria-label': ft.name, onclick: () => { m.patch((fx) => { fx.font = ft.id; }); redraw(); } },
      tileCanvas({ look: 'classic', color: m.color(), font: ft.id, text: ft.name, size: 0.3, fx: { stroke: null, shadow: null, glow: null, bg: null } }),
      h('span', {}, ft.name)))),
    switchRow('Italic', !!f.italic, (on) => { m.patch((fx) => { fx.italic = on; }); redraw(); }));
}

// ---------------------------------------------------------------------------------------------- Effects
interface Preset { name: string; color?: string; fx: Fx }
const none = { stroke: null, glow: null, shadow: null, bg: null } as const;
export const EFFECTS: Preset[] = [
  { name: 'None', fx: { ...none } },
  { name: 'Outline', fx: { ...none, stroke: { c: '#000000', w: 0.16 } } },
  { name: 'Soft shadow', fx: { ...none, shadow: { c: 'rgba(0,0,0,0.85)', b: 0.4, d: 0.07, a: 90 } } },
  { name: 'Hard shadow', fx: { ...none, shadow: { c: '#000000', b: 0, d: 0.08, a: 45 } } },
  { name: 'Neon', fx: { ...none, glow: { c: '#19C3D8', b: 0.55 } } },
  { name: 'Pink neon', color: '#FFFFFF', fx: { ...none, glow: { c: '#FF2D9B', b: 0.55 } } },
  { name: 'Fire', color: '#FFD60A', fx: { ...none, glow: { c: '#FF6A00', b: 0.6 }, shadow: { c: 'rgba(120,0,0,0.8)', b: 0.1, d: 0.05, a: 90 } } },
  { name: 'Ice', color: '#D7F4FF', fx: { ...none, glow: { c: '#19C3D8', b: 0.5 } } },
  { name: 'Retro', color: '#FFD60A', fx: { ...none, stroke: { c: '#7A1F00', w: 0.12 }, shadow: { c: '#FF3B30', b: 0, d: 0.09, a: 45 } } },
  { name: 'Label', color: '#FFFFFF', fx: { ...none, bg: { c: '#000000', o: 0.7, r: 0.3 } } },
  { name: 'Marker', color: '#000000', fx: { ...none, bg: { c: '#FFD60A', o: 1, r: 0.12 } } },
  { name: 'Gold', color: '#F2C811', fx: { ...none, stroke: { c: '#5A3E00', w: 0.1 }, shadow: { c: 'rgba(0,0,0,0.8)', b: 0.3, d: 0.06, a: 90 } } },
];

export function effectsPanel(m: FxModel, redraw: () => void): HTMLElement {
  return h('div', { class: 'fx-effects' },
    h('div', { class: 'fx-grid' }, ...EFFECTS.map((e) => h('button', { class: 'fx-tile', 'aria-label': e.name,
      onclick: () => { m.patch((fx) => { Object.assign(fx, JSON.parse(JSON.stringify(e.fx))); }); if (e.color) m.setColor(e.color); redraw(); } },
      tileCanvas({ look: 'minimal', color: e.color ?? m.color(), fx: { ...e.fx, ...(eff(m).font ? { font: eff(m).font } : {}) }, text: 'Aa' }),
      h('span', {}, e.name)))),
    h('button', { class: 'btn fx-reset', onclick: () => { m.patch((fx) => { delete fx.stroke; delete fx.glow; delete fx.shadow; delete fx.bg; }); redraw(); } }, 'Back to the style\'s own look'));
}
