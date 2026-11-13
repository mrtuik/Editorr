/** One pure function per visual type: (data, theme, w, h, p) => inner HTML of the card. p (0..1) drives what moves inside (count-up, bars, typing). */
import type { VisualData, VisualTheme, VisualType } from '../types';
import { timed } from '../ease';
import { DELAY, animText, isTextAnim, timing } from '../textAnim';
import { Ctx, clamp01, col, easeOut, esc, fit, limitWords, makeCtx, rise, stg, txt } from './util';

export type Template = (d: VisualData, c: Ctx) => string;

/** Motion graphics follow open-motion: counter (scale .5 > 1.05 > 1, ease-out 1200), barGrow (700, 120 stagger), lineDraw (900 ease-in-out + end dot 'back'),
 *  pieSweep (1000 ease-out), trim path (an accent line that draws itself), kineticText for rows (600 snappy, 120 stagger). All driven by c.ms. */
const trimLine = (c: Ctx, wPx: number, hPx: number, delay: number, dur = 800) =>
  `<div style="height:${hPx}px;width:${wPx}px;background:${c.t.accent};border-radius:99px;transform-origin:left center;transform:scaleX(${timed(c.ms, delay, dur, 'ease-in-out').toFixed(3)});"></div>`;

const kinRow = (c: Ctx, i: number, inner: string, extra = '') => {
  const e = timed(c.ms, DELAY + i * 120, 600, 'snappy');
  return `<div style="opacity:${Math.min(1, e * 1.6).toFixed(3)};transform:translateY(${((1 - e) * c.body * 0.8).toFixed(1)}px);${extra}">${inner}</div>`;
};

const stat_counter: Template = (d, c) => {
  const big = d.big ?? d.title ?? '';
  const m = big.match(/-?\d[\d,]*\.?\d*/);
  let shown = big;
  if (m) {
    const raw = m[0], v = parseFloat(raw.replace(/,/g, '')), dec = (raw.split('.')[1] ?? '').length;
    const cur = v * timed(c.ms, 0, 1200, 'ease-out');
    const [ip, fp] = cur.toFixed(dec).split('.');
    const num = (raw.includes(',') ? ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ip) + (fp ? '.' + fp : '');
    shown = big.replace(raw, num);
  }
  const size = fit(big, c.cw - (d.trend && d.trend !== 'flat' ? c.body * 1.5 : 0), c.ch * 0.5, c.h * 0.11, c.min * 1.3);
  // open-motion counter keyframes: opacity 0 > .5 > .8 > 1, scale .5 > .8 > 1.05 > 1, translateY 20px > 0
  const k = timed(c.ms, 0, 1200, 'ease-out'), sc = k < 0.3 ? 0.5 + (k / 0.3) * 0.3 : k < 0.6 ? 0.8 + ((k - 0.3) / 0.3) * 0.25 : 1.05 - ((k - 0.6) / 0.4) * 0.05;
  const op = k < 0.3 ? (k / 0.3) * 0.5 : k < 0.6 ? 0.5 + ((k - 0.3) / 0.3) * 0.3 : 0.8 + ((k - 0.6) / 0.4) * 0.2;
  const pop = timed(c.ms, 500, 350, 'back');
  const tri = d.trend && d.trend !== 'flat'
    ? `<div style="width:0;height:0;transform:scale(${pop.toFixed(3)});border-left:${c.body * 0.5}px solid transparent;border-right:${c.body * 0.5}px solid transparent;${d.trend === 'up' ? `border-bottom:${c.body * 0.85}px solid ${c.t.accent}` : `border-top:${c.body * 0.85}px solid ${c.t.accent}`};"></div>` : '';
  const numEl = `<div style="font-size:${size}px;line-height:1.02;font-weight:900;color:${c.t.accent};font-family:${c.t.font};white-space:pre;opacity:${Math.min(1, op).toFixed(3)};transform:translateY(${((1 - k) * size * 0.4).toFixed(1)}px) scale(${sc.toFixed(3)});transform-origin:left center;">${esc(shown)}</div>`;
  return col(
    `<div style="display:flex;align-items:center;gap:${c.body * 0.5}px;">${tri}${numEl}</div>` + trimLine(c, c.cw * 0.22, Math.max(3, c.body * 0.12), 600) +
    (d.label ? animText(c, limitWords(d.label, 8), c.body, { color: c.t.muted, weight: 500, delay: 260 }) : ''), c.body * 0.5);
};

const quote_card: Template = (d, c) => {
  const q = limitWords(d.quote ?? d.title ?? '', 12);
  const size = fit(q, c.cw - c.body, c.ch, c.h * 0.085, c.head * 0.6);
  const bar = timed(c.ms, 0, 700, 'ease-out');
  return col(`<div style="display:flex;gap:${c.body * 0.6}px;align-items:stretch;"><div style="flex:none;width:${Math.max(4, c.body * 0.14)}px;border-radius:99px;background:${c.t.accent};transform-origin:top;transform:scaleY(${bar.toFixed(3)});"></div>` +
    `<div style="flex:1;">${animText(c, q, size, { font: c.t.serif, lh: 1.2, accent: d.accent })}</div></div>`);
};

const definition_card: Template = (d, c) => {
  const term = limitWords(d.term ?? d.title, 4), mean = limitWords(d.meaning ?? d.label, 9);
  const ts = fit(term, c.cw, c.ch * 0.35, c.h * 0.1, c.head * 0.8), ms = fit(mean, c.cw, c.ch * 0.4, c.body * 1.3, c.min);
  return col(animText(c, term, ts, { color: c.t.accent, weight: 900 }) + trimLine(c, c.cw * 0.18, Math.max(3, c.body * 0.2), 300, 900) +
    animText(c, mean, ms, { weight: 500, delay: 380, anim: 'blur' }), c.body * 0.55);
};

const list_card: Template = (d, c) => {
  const items = (d.items ?? []).slice(0, 5).map(s => limitWords(s, 5)), n = items.length;
  const title = limitWords(d.title, 5);
  const size = Math.max(c.min, Math.min(c.body * 1.25, Math.floor((c.ch * 0.8) / Math.max(1, n) / 1.5)));
  const rows = items.map((s, i) => {
    const dot = timed(c.ms, DELAY + i * 120 + 120, 350, 'back');
    return kinRow(c, i + 1, `<div style="display:flex;align-items:center;gap:${size * 0.5}px;"><div style="flex:none;width:${size * 0.5}px;height:${size * 0.5}px;border-radius:99px;background:${c.t.accent};transform:scale(${dot.toFixed(3)});"></div>${txt(c, s, size, { weight: 600 })}</div>`);
  }).join('');
  return col((title ? kinRow(c, 0, txt(c, title, c.body, { color: c.t.muted, weight: 500 })) : '') + rows, size * 0.45);
};

const versus_card: Template = (d, c) => {
  const row = c.w > c.h, l = limitWords(d.left, 4), r = limitWords(d.right, 4);
  const side = (s: string, dir: number, color: string, delay: number) => {
    const sz = fit(s, row ? c.cw * 0.42 : c.cw, row ? c.ch : c.ch * 0.38, c.h * 0.085, c.body), e = timed(c.ms, delay, 600, 'snappy');
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;opacity:${Math.min(1, e * 1.6).toFixed(3)};transform:translate${row ? 'X' : 'Y'}(${((1 - e) * dir * c.body * 2).toFixed(1)}px);">${txt(c, s, sz, { color, align: 'center', weight: 800 })}</div>`;
  };
  const e = timed(c.ms, 150, 800, 'ease-in-out');
  const line = `<div style="${row ? `width:${c.body * 0.1}px;height:${(e * 100).toFixed(1)}%` : `height:${c.body * 0.1}px;width:${(e * 100).toFixed(1)}%`};background:${c.t.accent};border-radius:99px;align-self:center;"></div>`;
  return `<div style="display:flex;flex-direction:${row ? 'row' : 'column'};width:100%;height:100%;">${side(l, -1, c.t.text, DELAY)}${line}${side(r, 1, c.t.accent, DELAY + 120)}</div>`;
};

const bar_chart: Template = (d, c) => {
  const vals = (d.values ?? []).slice(0, 5), labs = d.labels ?? [], n = vals.length, mx = Math.max(1e-9, ...vals);
  const size = Math.max(c.min, Math.min(c.body, Math.floor((c.ch * 0.8) / Math.max(1, n) / 2)));
  const top = vals.indexOf(Math.max(...vals));
  const rows = vals.map((v, i) => {
    const e = timed(c.ms, i * 120, 700, 'ease-out'), hi = i === top;
    return `<div style="display:flex;flex-direction:column;gap:${size * 0.15}px;">` +
      `<div style="display:flex;justify-content:space-between;opacity:${Math.min(1, e * 2).toFixed(3)};">${txt(c, limitWords(labs[i] ?? '', 3), size, { weight: 600, color: c.t.muted })}${txt(c, String(Math.round(v * e * 100) / 100), size, { weight: 800, color: hi ? c.t.accent : c.t.text })}</div>` +
      `<div style="height:${size * 0.45}px;border-radius:99px;background:rgba(127,127,127,0.18);"><div style="height:100%;width:${((v / mx) * 100).toFixed(1)}%;transform-origin:left center;transform:scaleX(${e.toFixed(3)});opacity:${Math.min(1, e * 3).toFixed(3)};border-radius:99px;background:${hi ? c.t.accent : (c.t.dot ?? c.t.muted)};"></div></div></div>`;
  }).join('');
  return col((d.title ? kinRow(c, 0, txt(c, limitWords(d.title, 5), c.body, { color: c.t.muted, weight: 500 })) : '') + rows, size * 0.6);
};

const line_chart: Template = (d, c) => {
  const v = (d.values ?? []).slice(0, 12); if (v.length < 2) return col(animText(c, limitWords(d.title, 6), c.head));
  const mn = Math.min(...v), mx = Math.max(...v), rg = Math.max(1e-9, mx - mn), W = 1000, H = 500, pd = 30;
  const pts = v.map((y, i) => [pd + (i / (v.length - 1)) * (W - 2 * pd), H - pd - ((y - mn) / rg) * (H - 2 * pd)]);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' '), e = timed(c.ms, 100, 900, 'ease-in-out'), last = pts[pts.length - 1];
  const dot = timed(c.ms, 850, 350, 'back');
  return col((d.title ? kinRow(c, 0, txt(c, limitWords(d.title, 5), c.body, { color: c.t.muted, weight: 500 })) : '') +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="flex:none;max-height:${c.ch * 0.75}px;"><path d="${path}" pathLength="1" fill="none" stroke="${c.t.accent}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1" stroke-dashoffset="${(1 - e).toFixed(4)}"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="${(14 * Math.max(0, dot)).toFixed(2)}" fill="${c.t.accent}"/></svg>`, c.body * 0.5);
};

const progress_ring: Template = (d, c) => {
  const pc = Math.max(0, Math.min(100, d.percent ?? 0)), e = timed(c.ms, 0, 1000, 'ease-out'), sz = Math.min(c.cw, c.ch * 0.7);
  const track = timed(c.ms, 0, 400, 'ease-out'), lab = timed(c.ms, 200, 900, 'ease-out');
  return col(`<div style="position:relative;width:${sz}px;height:${sz}px;align-self:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${sz}" height="${sz}" style="transform:rotate(-90deg)">` +
    `<circle cx="50" cy="50" r="42" fill="none" stroke="rgba(127,127,127,${(0.2 * track).toFixed(3)})" stroke-width="8"/><circle cx="50" cy="50" r="42" fill="none" stroke="${c.t.accent}" stroke-width="8" stroke-linecap="round" pathLength="100" stroke-dasharray="${(pc * e).toFixed(2)} 100"/></svg>` +
    `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:${Math.min(1, lab * 1.5).toFixed(3)};transform:scale(${(0.6 + 0.4 * lab).toFixed(3)});">${txt(c, `${Math.round(pc * e)}%`, sz * 0.24, { weight: 900, color: c.t.text })}</div></div>` +
    (d.label ? animText(c, limitWords(d.label, 6), c.body, { color: c.t.muted, weight: 500, align: 'center', delay: 500 }) : ''), c.body * 0.4);
};

const timeline: Template = (d, c) => {
  const items = (d.items ?? []).slice(0, 5).map(s => limitWords(s, 5)), n = items.length;
  const size = Math.max(c.min, Math.min(c.body * 1.2, Math.floor((c.ch * 0.8) / Math.max(1, n) / 1.7))), dot = size * 0.6;
  const rows = items.map((s, i) => {
    const at = DELAY + i * 160, e = timed(c.ms, at, 600, 'snappy'), pop = timed(c.ms, at, 350, 'back'), le = timed(c.ms, at + 200, 450, 'ease-in-out');
    return `<div style="display:flex;gap:${size * 0.6}px;flex:1;opacity:${Math.min(1, 0.25 + e).toFixed(3)};">` +
      `<div style="display:flex;flex-direction:column;align-items:center;"><div style="flex:none;width:${dot}px;height:${dot}px;border-radius:99px;background:${c.t.accent};transform:scale(${pop.toFixed(3)});"></div>` +
      (i < n - 1 ? `<div style="flex:1;width:${size * 0.1}px;background:${c.t.accent};opacity:0.5;transform-origin:top;transform:scaleY(${le.toFixed(3)});"></div>` : '') + `</div>` +
      `<div style="padding-top:${(dot - size) / 2}px;transform:translateY(${((1 - e) * size * 0.8).toFixed(1)}px);">${txt(c, s, size, { weight: 600 })}</div></div>`;
  }).join('');
  return `<div style="display:flex;flex-direction:column;width:100%;height:100%;">${d.title ? txt(c, limitWords(d.title, 5), c.body, { color: c.t.muted, weight: 500 }) : ''}${rows}</div>`;
};

const keyword_title: Template = (d, c) => {
  const s = limitWords(d.title ?? d.big ?? d.quote ?? '', 4);
  const size = fit(s, c.cw, c.ch, c.h * 0.11, c.head * 0.8, 1.1);
  return col(animText(c, s, size, { weight: 900, align: 'center', lh: 1.1, accent: 'last' }) +
    `<div style="align-self:center;">${trimLine(c, c.cw * 0.3, Math.max(4, c.body * 0.14), DELAY + timing(isTextAnim(c.anim) ? c.anim : 'kinetic', s).total * 0.6, 800)}</div>`, c.body * 0.5);
};

const windowBar = (c: Ctx, title: string) => `<div style="display:flex;align-items:center;gap:${c.body * 0.3}px;margin-bottom:${c.body * 0.5}px;">` +
  ['#ff5f57', '#febc2e', '#28c840'].map(k => `<div style="width:${c.body * 0.35}px;height:${c.body * 0.35}px;border-radius:99px;background:${k};"></div>`).join('') + txt(c, title, c.min, { color: c.t.muted, font: c.t.mono, weight: 500 }) + `</div>`;

const typed = (lines: string[], p: number) => {  // open-motion typewriter: linear
  const total = lines.reduce((a, l) => a + l.length + 1, 0); let left = Math.floor(total * clamp01(p * 1.15)); const out: string[] = [];
  for (const l of lines) { out.push(l.slice(0, Math.max(0, left))); left -= l.length + 1; }
  return out;
};

const monoSize = (c: Ctx, lines: string[], reserve = 0) => {
  const mx = Math.max(1, ...lines.map(l => l.length));
  return Math.max(c.min, Math.min(c.body, Math.floor((c.ch * 0.8) / Math.max(1, lines.length) / 1.45), Math.floor((c.cw - reserve) / (mx * 0.62))));
};
const maxChars = (c: Ctx, reserve = 0) => Math.max(8, Math.floor((c.cw - reserve) / (c.min * 0.62)));

const code_window: Template = (d, c) => {
  const lines = (d.code ?? '').split('\n').slice(0, 7).map(l => l.slice(0, maxChars(c))), shown = typed(lines, timed(c.ms, DELAY, 1300, 'linear') * 0.87);
  const size = monoSize(c, lines);
  return col(windowBar(c, d.lang ?? 'code') + shown.map(l => txt(c, l || '\u00a0', size, { font: c.t.mono, weight: 700, color: c.t.text, lh: 1.4, nowrap: true })).join(''));
};

const terminal: Template = (d, c) => {
  const lines = (d.lines ?? []).slice(0, 6).map(l => l.slice(0, maxChars(c, c.min * 1.4))), shown = typed(lines, timed(c.ms, DELAY, 1300, 'linear') * 0.87);
  const size = monoSize(c, lines, c.min * 1.4);
  return col(windowBar(c, 'terminal') + shown.map(l => `<div style="display:flex;gap:${size * 0.4}px;">${txt(c, '>', size, { font: c.t.mono, color: c.t.accent })}${txt(c, l || '\u00a0', size, { font: c.t.mono, color: c.t.text, lh: 1.4, nowrap: true })}</div>`).join(''));
};

const post_card: Template = (d, c) => {
  const text = limitWords(d.text ?? d.quote ?? d.title, 12), size = fit(text, c.cw, c.ch * 0.65, c.body * 1.5, c.min);
  const nm = d.name ?? '', e = timed(c.ms, 0, 500, 'ease-out');
  return col(`<div style="display:flex;align-items:center;gap:${c.body * 0.5}px;opacity:${e.toFixed(3)};"><div style="width:${c.body * 1.2}px;height:${c.body * 1.2}px;border-radius:99px;background:${c.t.accent};opacity:0.9;"></div>` +
    `<div>${nm ? txt(c, nm, c.min, { weight: 800 }) : ''}${d.handle ? txt(c, d.handle, c.min, { color: c.t.muted, weight: 500 }) : ''}</div></div>` +
    animText(c, text, size, { weight: 600, delay: 200 }), c.body * 0.7);
};

const receipt_card: Template = (d, c) => {
  const lines = (d.lines ?? []).slice(0, 5), n = lines.length + 1;
  const size = Math.max(c.min, Math.min(c.body, Math.floor((c.ch * 0.8) / (n + 2) / 1.5)));
  const row = (s: string, i: number, bold = false) => {
    const [a, b = ''] = s.split('|').map(x => x.trim()), e = timed(c.ms, DELAY + i * 120, 600, 'snappy');
    return `<div style="display:flex;justify-content:space-between;opacity:${Math.min(1, e * 1.6).toFixed(3)};transform:translateY(${((1 - e) * size * 0.8).toFixed(1)}px);">${txt(c, a, size, { font: c.t.mono, weight: bold ? 900 : 700 })}${txt(c, b, size, { font: c.t.mono, weight: bold ? 900 : 700, color: bold ? c.t.accent : c.t.text })}</div>`;
  };
  return col((d.shop ? txt(c, limitWords(d.shop, 3), size * 1.2, { font: c.t.mono, align: 'center', weight: 900 }) : '') +
    lines.map((l, i) => row(l, i)).join('') + `<div style="border-top:3px dashed ${c.t.muted};opacity:${timed(c.ms, 300, 600, 'ease-out').toFixed(2)};"></div>` + row(`TOTAL | ${d.total ?? ''}`, n - 1, true), size * 0.4);
};

export const TEMPLATES: Record<VisualType, Template> = {
  stat_counter, quote_card, definition_card, list_card, versus_card, bar_chart, line_chart, progress_ring,
  timeline, keyword_title, code_window, terminal, post_card, receipt_card,
};

export function templateHtml(type: VisualType, d: VisualData, theme: VisualTheme, w: number, h: number, p = 1, ms = 99999, anim = 'kinetic'): string {
  return (TEMPLATES[type] ?? keyword_title)(d, makeCtx(theme, w, h, clamp01(p), ms, anim));
}
