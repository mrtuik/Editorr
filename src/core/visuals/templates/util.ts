import type { VisualTheme } from '../types';

export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
/** Progress of item i of n inside p (0..1), each item running for `span` of the whole, evenly staggered. */
export const stg = (p: number, i: number, n: number, span = 0.5) => clamp01((p - (n <= 1 ? 0 : (i / n) * (1 - span))) / span);
export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
export const limitWords = (s: string | undefined, n: number) => (s ? words(s).slice(0, n).join(' ') : '');

export interface Ctx {
  t: VisualTheme; w: number; h: number; p: number;
  /** padding inside the card, and the card's own size */
  pad: number; cw: number; ch: number;
  /** smallest allowed text = 4.5% of frame height; body and headline sizes */
  min: number; body: number; head: number;
}

/** The card sits in the zone above the captions. Portrait keeps the bottom 30% free, landscape the bottom 24%. */
export function cardBox(w: number, h: number) {
  const short = Math.min(w, h), m = Math.round(short * 0.08);
  const free = h > w ? 0.3 : 0.24;
  return { x: m, y: m, w: w - 2 * m, h: Math.round(h * (1 - free)) - m };
}

export function makeCtx(t: VisualTheme, w: number, h: number, p: number): Ctx {
  const box = cardBox(w, h), pad = Math.round(Math.min(w, h) * 0.06);
  return { t, w, h, p, pad, cw: box.w - 2 * pad, ch: box.h - 2 * pad, min: Math.round(h * 0.045), body: Math.round(h * 0.05), head: Math.round(h * 0.085) };
}

const isWide = (s: string) => /[\u0900-\u0DFF\u3040-\u9FFF]/.test(s);
/** Biggest font size (px, between ctx.min and `max`) at which `text` wraps inside boxW x boxH. */
export function fit(text: string, boxW: number, boxH: number, max: number, min: number, lh = 1.18): number {
  const ws = words(text), k = isWide(text) ? 0.74 : 0.66;
  for (let s = Math.round(max); s > min; s -= 4) {
    let lines = 1, x = 0;
    for (const wd of ws) {
      const wl = wd.length * k * s, sp = 0.3 * s;
      if (x > 0 && x + sp + wl > boxW) { lines++; x = wl; } else x += (x ? sp : 0) + wl;
      if (wl > boxW) { lines += 99; break; }
    }
    if (lines * s * lh <= boxH) return s;
  }
  return Math.round(min);
}

export const col = (inner: string, gap = 0, extra = '') =>
  `<div style="display:flex;flex-direction:column;justify-content:center;gap:${gap}px;width:100%;height:100%;${extra}">${inner}</div>`;

export const txt = (c: Ctx, s: string, size: number, o: { color?: string; weight?: number; font?: string; align?: string; op?: number; dy?: number; lh?: number; ls?: string; nowrap?: boolean } = {}) =>
  `<div style="font-size:${size}px;line-height:${o.lh ?? 1.18};color:${o.color ?? c.t.text};font-weight:${o.weight ?? 700};font-family:${o.font ?? c.t.font};text-align:${o.align ?? 'left'};` +
  `opacity:${(o.op ?? 1).toFixed(3)};transform:translateY(${(o.dy ?? 0).toFixed(1)}px);letter-spacing:${o.ls ?? '0'};${o.nowrap ? 'white-space:pre;' : 'overflow-wrap:anywhere;'}">${esc(s)}</div>`;

/** Fade + rise for item i of n. */
export const rise = (c: Ctx, i: number, n: number, span = 0.5) => { const e = easeOut(stg(c.p, i, n, span)); return { op: e, dy: (1 - e) * c.body * 0.5 }; };
