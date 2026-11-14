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

const lum = (hex: string) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return 0; const n = parseInt(m[1]!, 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Words kinetic in, then a marker sweeps behind the key word (a drawn shape that wipes in, like a trim path). */
const highlight_card: Template = (d, c) => {
  const t = limitWords(d.text ?? d.title ?? d.quote ?? '', 10), ws = t.split(/\s+/).filter(Boolean), acc = key(d.accent ?? '');
  const size = fit(t, c.cw, c.ch, c.h * 0.09, c.head * 0.6), hit = ws.findIndex(w => key(w) === acc), mark = hit >= 0 ? hit : ws.length - 1;
  const ink = lum(c.t.accent) > 0.6 ? '#0b0b0b' : '#ffffff';
  const spans = ws.map((w, i) => {
    const e = timed(c.ms, DELAY + i * Math.min(120, 900 / Math.max(1, ws.length)), 600, 'snappy');
    const base = `display:inline-block;margin-right:0.28em;opacity:${Math.min(1, e * 1.6).toFixed(3)};transform:translateY(${((1 - e) * 0.7).toFixed(3)}em);`;
    if (i !== mark) return `<span style="${base}">${esc(w)}</span>`;
    const sw = timed(c.ms, DELAY + ws.length * 100 + 150, 600, 'ease-in-out');
    return `<span style="${base}position:relative;"><span style="position:absolute;left:-0.12em;right:-0.12em;top:8%;bottom:2%;border-radius:0.16em;background:${c.t.accent};transform-origin:left center;transform:scaleX(${sw.toFixed(3)});"></span><span style="position:relative;color:${sw > 0.5 ? ink : c.t.text};">${esc(w)}</span></span>`;
  }).join('');
  return col(`<div style="font-size:${size}px;line-height:1.3;font-weight:800;font-family:${c.t.font};">${spans}</div>`);
};

/** Short lines stacked big, each sliding in from alternate sides (kineticText with direction), last line in the accent, a line draws under. */
const stack_card: Template = (d, c) => {
  let lines = (d.items ?? []).map(s => limitWords(s, 3)).filter(Boolean);
  if (lines.length < 2) { const ws = (d.title ?? d.text ?? '').split(/\s+/).filter(Boolean).slice(0, 8); lines = []; for (let i = 0; i < ws.length; i += 2) lines.push(ws.slice(i, i + 2).join(' ')); }
  lines = lines.slice(0, 4); const n = Math.max(1, lines.length);
  const size = Math.max(c.min, Math.min(c.h * 0.1, Math.floor(c.ch / n / 1.35), ...lines.map(l => fit(l, c.cw, c.ch / n, c.h * 0.1, c.min))));
  const rows = lines.map((l, i) => {
    const e = timed(c.ms, DELAY + i * 140, 600, 'snappy'), dir = i % 2 ? 1 : -1;
    return `<div style="opacity:${Math.min(1, e * 1.6).toFixed(3)};transform:translateX(${(dir * (1 - e) * 1.2).toFixed(3)}em);font-size:${size}px;line-height:1.15;font-weight:900;font-family:${c.t.font};color:${i === n - 1 ? c.t.accent : c.t.text};">${esc(l)}</div>`;
  }).join('');
  return col(rows + trimLine(c, c.cw * 0.22, Math.max(4, c.body * 0.14), DELAY + n * 140 + 200, 700), c.body * 0.3);
};

/** A frame draws itself around the text (stroke trim path on a rectangle), corners first. */
const frame_card: Template = (d, c) => {
  const t = limitWords(d.title ?? d.text ?? d.quote ?? '', 6), size = fit(t, c.cw * 0.86, c.ch * 0.7, c.h * 0.1, c.head * 0.7, 1.15);
  const e = timed(c.ms, 0, 1000, 'ease-in-out'), W = 1000, H = 1000;
  return `<div style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;">` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="100%" style="position:absolute;inset:0;"><rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="0" fill="none" stroke="${c.t.accent}" stroke-width="10" vector-effect="non-scaling-stroke" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - e).toFixed(4)}"/></svg>` +
    `<div style="width:86%;">${animText(c, t, size, { weight: 900, align: 'center', lh: 1.15, accent: d.accent || 'last', delay: 250 })}</div></div>`;
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


/* ---- reel graphics: shapes, pills, arrows, windows, flows (the look of short-form talking-head edits) ---- */
const ink = (c: Ctx) => (lum(c.t.accent) > 0.6 ? '#0b0b0b' : '#ffffff');
const hash2 = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
/** a word on a solid accent box that wipes in from the left */
const boxWord = (c: Ctx, w: string, size: number, at: number) => {
  const sw = timed(c.ms, at, 500, 'ease-in-out'), e = timed(c.ms, at, 600, 'snappy');
  return `<span style="display:inline-block;position:relative;padding:0 0.28em;margin:0 0.08em;font-size:${size}px;font-weight:900;font-family:${c.t.font};opacity:${Math.min(1, e * 2).toFixed(3)};transform:translateY(${((1 - e) * 0.6).toFixed(3)}em);">` +
    `<span style="position:absolute;left:0;right:0;top:6%;bottom:2%;border-radius:0.12em;background:${c.t.accent};transform-origin:left center;transform:scaleX(${sw.toFixed(3)});"></span><span style="position:relative;color:${sw > 0.5 ? ink(c) : c.t.text};">${esc(w)}</span></span>`;
};

/** line 1 bold, a serif italic line, then the key word on a box */
const title_stack: Template = (d, c) => {
  const l1 = limitWords(d.title, 4), it = limitWords(d.label, 4), hi = limitWords(d.accent, 2);
  const size = fit(`${l1} ${hi}`, c.cw, c.ch * 0.5, c.h * 0.1, c.head * 0.7, 1.15), n1 = timing(isTextAnim(c.anim) ? c.anim : 'kinetic', l1).total;
  return col((l1 ? animText(c, l1, size, { weight: 900, align: 'center', lh: 1.1 }) : '') +
    (it ? animText(c, it, size * 0.95, { font: c.t.serif, italic: true, weight: 500, align: 'center', lh: 1.1, delay: 150, color: c.t.text }) : '') +
    (hi ? `<div style="text-align:center;line-height:1.2;">${boxWord(c, hi, size, DELAY + n1 * 0.7 + 200)}</div>` : ''), c.body * 0.2);
};

const iconShape = (c: Ctx, i: number, sz: number, color: string) => {
  const k = i % 3;
  if (k === 0) return `<div style="width:0;height:0;border-top:${sz * 0.5}px solid transparent;border-bottom:${sz * 0.5}px solid transparent;border-left:${sz * 0.85}px solid ${color};"></div>`;
  if (k === 1) return `<div style="width:${sz}px;height:${sz}px;border-radius:99px;background:${color};"></div>`;
  return `<div style="display:flex;flex-direction:column;gap:${sz * 0.18}px;width:${sz}px;">${[1, 0.75, 1].map(w => `<div style="height:${sz * 0.2}px;width:${w * 100}%;background:${color};border-radius:2px;"></div>`).join('')}</div>`;
};
/** tags that light up one after another */
const pill_row: Template = (d, c) => {
  const items = (d.items ?? []).slice(0, 4).map(x => limitWords(x, 2)), n = items.length, size = Math.min(c.body * 1.3, Math.floor(c.cw / Math.max(2, n) / 4.2));
  const pills = items.map((s, i) => {
    const at = DELAY + 500 + i * 450, on = timed(c.ms, at, 350, 'back'), act = c.ms >= at, appear = timed(c.ms, DELAY + i * 120, 500, 'snappy');
    return `<div style="display:flex;align-items:center;gap:${size * 0.35}px;padding:${size * 0.4}px ${size * 0.7}px;border-radius:99px;font-family:${c.t.font};font-size:${size}px;font-weight:800;white-space:nowrap;` +
      `color:${act ? ink(c) : c.t.muted};background:${act ? c.t.accent : 'rgba(127,127,127,0.18)'};transform:scale(${(act ? 0.9 + 0.1 * on : 1).toFixed(3)}) translateY(${((1 - appear) * size).toFixed(1)}px);opacity:${Math.min(1, appear * 2).toFixed(3)};">${iconShape(c, i, size * 0.7, act ? ink(c) : c.t.muted)}${esc(s)}</div>`;
  }).join('');
  return col((d.title ? animText(c, limitWords(d.title, 5), c.head * 0.8, { weight: 900, align: 'center' }) : '') + `<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:${size * 0.5}px;">${pills}</div>`, c.body * 0.9);
};

/** nodes (circle, square, diamond) joined by lines that draw themselves, with a dot travelling along */
const flow_diagram: Template = (d, c) => {
  const items = (d.items ?? []).slice(0, 3).map(x => limitWords(x, 2)), n = Math.max(2, items.length), ns = Math.min(c.cw / (n * 1.9), c.ch * 0.28), lab = Math.max(c.min * 0.9, ns * 0.3);
  const shapes = ['border-radius:50%', `border-radius:${ns * 0.22}px`, `border-radius:${ns * 0.12}px;transform-origin:center`];
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = DELAY + i * 500, pop = timed(c.ms, at, 450, 'back'), rot = i % 3 === 2 ? 45 : 0;
    parts.push(`<div style="display:flex;flex-direction:column;align-items:center;gap:${lab * 0.5}px;flex:none;width:${ns}px;"><div style="width:${ns}px;height:${ns}px;${shapes[i % 3]};background:${i === n - 1 ? c.t.accent : 'rgba(127,127,127,0.22)'};border:3px solid ${c.t.accent};display:flex;align-items:center;justify-content:center;transform:scale(${pop.toFixed(3)}) rotate(${rot}deg);">` +
      `<div style="font-size:${ns * 0.4}px;font-weight:900;font-family:${c.t.font};color:${i === n - 1 ? ink(c) : c.t.text};transform:rotate(${-rot}deg);">${esc((items[i] ?? String(i + 1)).charAt(0).toUpperCase())}</div></div>` +
      `<div style="font-size:${lab}px;font-weight:700;font-family:${c.t.font};color:${c.t.text};text-align:center;opacity:${Math.min(1, pop * 1.4).toFixed(3)};">${esc(items[i] ?? '')}</div></div>`);
    if (i < n - 1) {
      const ln = timed(c.ms, at + 350, 500, 'ease-in-out'), dot = timed(c.ms, at + 400, 700, 'ease-in-out');
      parts.push(`<div style="flex:1;position:relative;height:${ns}px;"><div style="position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;background:${c.t.accent};border-radius:99px;transform-origin:left center;transform:scaleX(${ln.toFixed(3)});"></div>` +
        `<div style="position:absolute;top:50%;left:${(dot * 90).toFixed(1)}%;width:${ns * 0.16}px;height:${ns * 0.16}px;margin-top:-${ns * 0.08}px;border-radius:50%;background:${c.t.text};opacity:${ln > 0.05 && dot < 1 ? 1 : 0};"></div></div>`);
    }
  }
  return col((d.title ? animText(c, limitWords(d.title, 5), c.head * 0.8, { weight: 900, align: 'center' }) : '') + `<div style="display:flex;align-items:flex-start;width:100%;">${parts.join('')}</div>`, c.body * 1.2);
};

/** a keyword inside drawing rings, a turning square, orbiting dots and flickering pixel blocks */
const geo_title: Template = (d, c) => {
  const t = limitWords(d.title ?? d.big ?? d.quote ?? '', 3), S = Math.min(c.cw, c.ch) * 0.98;
  const ring = timed(c.ms, 0, 900, 'ease-in-out'), sq = timed(c.ms, 150, 800, 'ease-out'), a = c.ms * 0.02;
  const blocks = [[8, 12, 6], [86, 20, 5], [14, 82, 5], [80, 78, 7], [50, 4, 4]].map(([x, y, z], i) => {
    const on = hash2(i, Math.floor(c.ms / 110)) > 0.35 ? 1 : 0.15, vis = timed(c.ms, 200 + i * 90, 200, 'ease-out');
    return `<rect x="${x}" y="${y}" width="${z}" height="${z}" fill="${c.t.accent}" opacity="${(on * vis).toFixed(2)}"/>`;
  }).join('');
  const orbit = [0, 1, 2].map(k => { const ang = c.ms * 0.0022 + k * 2.094, r = 46; return `<circle cx="${(50 + r * Math.cos(ang)).toFixed(2)}" cy="${(50 + r * Math.sin(ang)).toFixed(2)}" r="${(1.6 + k * 0.5) * timed(c.ms, 300, 300, 'back')}" fill="${k === 0 ? c.t.accent : c.t.text}"/>`; }).join('');
  const size = fit(t, S * 0.62, S * 0.3, c.h * 0.1, c.head * 0.6, 1.1);
  return `<div style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${S}" height="${S}" style="position:absolute;">` +
    `<circle cx="50" cy="50" r="38" fill="none" stroke="${c.t.accent}" stroke-width="1.6" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - ring).toFixed(4)}" transform="rotate(-90 50 50)"/>` +
    `<circle cx="50" cy="50" r="44" fill="none" stroke="${c.t.muted}" stroke-width="0.5" stroke-dasharray="1.2 2.2" transform="rotate(${a.toFixed(1)} 50 50)"/>` +
    `<rect x="26" y="26" width="48" height="48" fill="none" stroke="${c.t.text}" stroke-width="0.7" opacity="${(0.5 * sq).toFixed(2)}" transform="rotate(${(45 * sq + a * 0.6).toFixed(1)} 50 50) scale(${(0.6 + 0.4 * sq).toFixed(3)})" style="transform-origin:50% 50%"/>${blocks}${orbit}</svg>` +
    `<div style="width:62%;position:relative;">${animText(c, t, size, { weight: 900, align: 'center', lh: 1.1, accent: 'last', delay: 200 })}</div></div>`;
};

/** speech bubble with typing dots, then the call to action on a box */
const cta_card: Template = (d, c) => {
  const pop = timed(c.ms, 0, 500, 'back'), size = fit(`${d.title ?? ''} ${d.accent ?? ''}`, c.cw, c.ch * 0.3, c.h * 0.09, c.head * 0.6, 1.15), bs = c.body * 2.6;
  const dots = [0, 1, 2].map(i => `<div style="width:${bs * 0.14}px;height:${bs * 0.14}px;border-radius:50%;background:${ink(c)};opacity:${(0.45 + 0.55 * Math.max(0, Math.sin(c.ms * 0.012 - i * 0.9))).toFixed(2)};"></div>`).join('');
  return col(`<div style="align-self:center;position:relative;width:${bs}px;height:${bs * 0.78}px;border-radius:${bs * 0.22}px;background:${c.t.accent};display:flex;align-items:center;justify-content:center;gap:${bs * 0.08}px;transform:scale(${pop.toFixed(3)});">${dots}` +
    `<div style="position:absolute;left:${bs * 0.2}px;bottom:-${bs * 0.12}px;width:0;height:0;border-left:${bs * 0.12}px solid transparent;border-right:${bs * 0.12}px solid transparent;border-top:${bs * 0.16}px solid ${c.t.accent};"></div></div>` +
    animText(c, limitWords(d.title ?? 'Comment', 3), size, { weight: 900, align: 'center', delay: 200 }) +
    (d.accent ? `<div style="text-align:center;line-height:1.2;">${boxWord(c, `“${limitWords(d.accent, 2)}”`, size, DELAY + 600)}</div>` : '') +
    (d.label ? animText(c, limitWords(d.label, 6), size * 0.8, { font: c.t.serif, italic: true, weight: 500, align: 'center', delay: 700, color: c.t.muted }) : ''), c.body * 0.5);
};

/** two phone-shaped frames, the second one lit, an arrow drawing between them */
const before_after: Template = (d, c) => {
  const fw = Math.min(c.cw * 0.4, c.ch * 0.34), fh = fw * 1.55, lab = Math.max(c.min * 0.8, fw * 0.12);
  const frame = (txt2: string, tag: string, on: boolean, at: number) => {
    const e = timed(c.ms, at, 600, 'snappy'), glow = on ? timed(c.ms, at + 500, 500, 'ease-out') : 0;
    return `<div style="flex:none;width:${fw}px;height:${fh}px;border-radius:${fw * 0.14}px;border:3px solid ${on ? c.t.accent : c.t.muted};background:${on ? 'rgba(127,127,127,0.18)' : 'rgba(127,127,127,0.1)'};position:relative;display:flex;align-items:center;justify-content:center;padding:${fw * 0.08}px;box-sizing:border-box;` +
      `opacity:${Math.min(1, e * 1.6).toFixed(3)};transform:translateY(${((1 - e) * fw * 0.3).toFixed(1)}px) scale(${(1 + 0.05 * glow).toFixed(3)});${on ? `box-shadow:0 0 ${(fw * 0.25 * glow).toFixed(0)}px ${c.t.accent};` : ''}">` +
      `<div style="position:absolute;top:-${lab * 0.9}px;left:${fw * 0.1}px;padding:${lab * 0.2}px ${lab * 0.7}px;border-radius:99px;font:800 ${lab}px ${c.t.font};background:${on ? c.t.accent : 'rgba(127,127,127,0.35)'};color:${on ? ink(c) : c.t.text};">${tag}</div>` +
      `<div style="font:800 ${lab * 1.5}px ${c.t.font};text-align:center;color:${c.t.text};overflow-wrap:anywhere;">${esc(txt2)}</div></div>`;
  };
  const ar = timed(c.ms, DELAY + 350, 500, 'ease-in-out');
  return `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;gap:${fw * 0.12}px;">${frame(limitWords(d.left, 3), 'BEFORE', false, DELAY)}` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="${fw * 0.4}" height="${fw * 0.2}" style="flex:none;"><path d="M2 10 H34 M27 3 L35 10 L27 17" fill="none" stroke="${c.t.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - ar).toFixed(4)}"/></svg>` +
    `${frame(limitWords(d.right, 3), 'AFTER', true, DELAY + 450)}</div>`;
};

/** a big arrow that draws itself, then bobs, with the line beside it */
const arrow_callout: Template = (d, c) => {
  const dir = d.trend === 'down' ? 180 : d.trend === 'flat' ? 90 : 0, S = Math.min(c.cw * 0.42, c.ch * 0.4), t = limitWords(d.title ?? d.label ?? '', 4);
  const dr = timed(c.ms, 100, 700, 'ease-in-out'), head = timed(c.ms, 650, 300, 'back'), bob = c.ms > 1000 ? Math.sin((c.ms - 1000) * 0.006) * 3 : 0;
  const size = fit(t, c.cw * 0.9, c.ch * 0.3, c.h * 0.09, c.head * 0.6, 1.15);
  return col(`<div style="align-self:center;transform:rotate(${dir}deg) translateY(${bob.toFixed(1)}px);"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80" width="${S * 0.75}" height="${S}">` +
    `<path d="M30 76 V8" fill="none" stroke="${c.t.accent}" stroke-width="6" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - dr).toFixed(4)}"/>` +
    `<path d="M10 28 L30 6 L50 28" fill="none" stroke="${c.t.accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - head).toFixed(4)}"/></svg></div>` +
    animText(c, t, size, { weight: 900, align: 'center', accent: 'last', delay: 250 }), c.body * 0.6);
};

/** a browser window: bar, address, rows sliding in, a cursor that clicks the button */
const window_card: Template = (d, c) => {
  const W = Math.min(c.cw, c.ch * 0.95), H = W * 0.62, u = W / 100, btn = limitWords(d.items?.[0] ?? 'Go', 2), pop = timed(c.ms, 0, 600, 'snappy');
  const click = timed(c.ms, 1250, 160, 'ease-out'), cur = timed(c.ms, 700, 600, 'ease-in-out');
  const rows = [78, 62, 70].map((w, i) => { const e = timed(c.ms, 350 + i * 130, 500, 'snappy'); return `<div style="height:${u * 4.5}px;width:${(w * e).toFixed(1)}%;border-radius:99px;background:rgba(127,127,127,0.28);opacity:${Math.min(1, e * 2).toFixed(2)};"></div>`; }).join('');
  const win = `<div style="align-self:center;width:${W}px;height:${H}px;border-radius:${u * 3.5}px;overflow:hidden;border:2px solid rgba(127,127,127,0.4);background:rgba(127,127,127,0.12);opacity:${Math.min(1, pop * 1.6).toFixed(3)};transform:translateY(${((1 - pop) * u * 6).toFixed(1)}px);position:relative;">` +
    `<div style="display:flex;align-items:center;gap:${u * 1.6}px;padding:${u * 2.4}px ${u * 3}px;background:rgba(127,127,127,0.18);">${['#ff5f57', '#febc2e', '#28c840'].map(k => `<div style="width:${u * 2.4}px;height:${u * 2.4}px;border-radius:50%;background:${k};"></div>`).join('')}` +
    `<div style="flex:1;margin-left:${u * 2}px;height:${u * 5.4}px;border-radius:99px;background:rgba(127,127,127,0.25);font:600 ${u * 3.4}px ${c.t.mono};color:${c.t.muted};display:flex;align-items:center;padding-left:${u * 2.4}px;">${esc(limitWords(d.label ?? 'link', 2))}</div></div>` +
    `<div style="padding:${u * 5}px ${u * 6}px;display:flex;flex-direction:column;gap:${u * 3}px;">${rows}<div style="align-self:flex-start;margin-top:${u * 2}px;padding:${u * 2.6}px ${u * 6}px;border-radius:99px;background:${c.t.accent};color:${ink(c)};font:800 ${u * 4.4}px ${c.t.font};transform:scale(${(1 - 0.08 * click * (1 - click) * 4).toFixed(3)});box-shadow:0 0 ${(u * 8 * click).toFixed(0)}px ${c.t.accent};">${esc(btn)}</div></div>` +
    `<div style="position:absolute;left:${(70 - 40 * cur + 22).toFixed(1)}%;top:${(88 - 30 * cur).toFixed(1)}%;width:0;height:0;border-left:${u * 2.6}px solid transparent;border-right:${u * 2.6}px solid transparent;border-bottom:${u * 6}px solid ${c.t.text};transform:rotate(-20deg);opacity:${cur > 0.02 ? 1 : 0};"></div></div>`;
  return col((d.title ? animText(c, limitWords(d.title, 5), c.head * 0.8, { weight: 900, align: 'center', accent: 'last' }) : '') + win, c.body * 0.9);
};

/** a rounded frame in front of a pulsing halftone circle, heavy words over its edge */
const halftone_frame: Template = (d, c) => {
  const t = limitWords(d.title ?? d.text ?? '', 4), S = Math.min(c.cw * 0.9, c.ch * 0.62), e = timed(c.ms, 0, 800, 'ease-out'), pulse = 1 + 0.03 * Math.sin(c.ms * 0.006), size = fit(t, c.cw, c.ch * 0.3, c.h * 0.1, c.head * 0.6, 1.1);
  const fr = timed(c.ms, 150, 700, 'snappy');
  return col(`<div style="position:relative;align-self:center;width:${S}px;height:${S * 0.85}px;">` +
    `<div style="position:absolute;left:50%;top:50%;width:${S * 1.1}px;height:${S * 1.1}px;margin:-${S * 0.55}px 0 0 -${S * 0.55}px;background-image:radial-gradient(${c.t.accent} 32%, transparent 36%);background-size:${S * 0.045}px ${S * 0.045}px;` +
    `-webkit-mask-image:radial-gradient(circle, #000 25%, transparent 68%);mask-image:radial-gradient(circle, #000 25%, transparent 68%);opacity:${(0.9 * e).toFixed(3)};transform:scale(${((0.6 + 0.4 * e) * pulse).toFixed(3)});"></div>` +
    `<div style="position:absolute;left:22%;right:22%;top:6%;bottom:6%;border-radius:${S * 0.08}px;border:4px solid ${c.t.accent};background:rgba(127,127,127,0.16);opacity:${Math.min(1, fr * 1.6).toFixed(3)};transform:translateY(${((1 - fr) * S * 0.12).toFixed(1)}px) scale(${(0.9 + 0.1 * fr).toFixed(3)});"></div></div>` +
    `<div style="margin-top:-${S * 0.16}px;">${animText(c, t, size, { weight: 900, align: 'center', lh: 1.1, accent: 'last', delay: 250 })}</div>`, 0);
};

/* ---- motion graphics: radial / circular geometry and camera-focus brackets (CREA MOTION look) ---- */
const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number) =>
  `M${(cx + r * Math.cos(a0)).toFixed(3)} ${(cy + r * Math.sin(a0)).toFixed(3)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${(cx + r * Math.cos(a1)).toFixed(3)} ${(cy + r * Math.sin(a1)).toFixed(3)}`;

/** a keyword in the centre; thin radial lines and circles draw outward (open-motion lineDraw: 900 ms ease-in-out), a segmented ring fills, dots orbit */
const radial_burst: Template = (d, c) => {
  const t = limitWords(d.title ?? d.big ?? d.quote ?? '', 3), S = Math.min(c.cw, c.ch) * 0.98, N = 24;
  const trim = (e: number) => `pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - e).toFixed(4)}"`;
  const rays = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2, long = i % 3 === 0, r0 = 17, r1 = long ? 47 : 40, e = timed(c.ms, i * 22, 900, 'ease-in-out');
    return `<line x1="${(50 + r0 * Math.cos(a)).toFixed(3)}" y1="${(50 + r0 * Math.sin(a)).toFixed(3)}" x2="${(50 + r1 * Math.cos(a)).toFixed(3)}" y2="${(50 + r1 * Math.sin(a)).toFixed(3)}" stroke="${long ? c.t.accent : c.t.muted}" stroke-width="${long ? 0.9 : 0.45}" stroke-linecap="round" ${trim(e)}/>`;
  }).join('');
  const rings = [22, 31, 41].map((r, i) =>
    `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${i === 1 ? c.t.accent : c.t.text}" stroke-width="${i === 1 ? 0.9 : 0.5}" opacity="${i === 1 ? 1 : 0.55}" transform="rotate(-90 50 50)" ${trim(timed(c.ms, i * 150, 900, 'ease-in-out'))}/>`).join('');
  const segs = Array.from({ length: 12 }, (_, i) => {
    const a0 = (i / 12) * Math.PI * 2 - Math.PI / 2, a1 = a0 + (Math.PI * 2 / 12) * 0.78, on = timed(c.ms, 350 + i * 70, 220, 'ease-out');
    return `<path d="${arcPath(50, 50, 35.5, a0, a1)}" fill="none" stroke="${c.t.accent}" stroke-width="2.2" opacity="${on.toFixed(3)}"/>`;
  }).join('');
  const dots = [0, 1, 2].map(k => { const ang = c.ms * 0.0025 + k * 2.094; return `<circle cx="${(50 + 44 * Math.cos(ang)).toFixed(3)}" cy="${(50 + 44 * Math.sin(ang)).toFixed(3)}" r="${((1.3 + k * 0.4) * timed(c.ms, 400, 300, 'back')).toFixed(3)}" fill="${k === 0 ? c.t.accent : c.t.text}"/>`; }).join('');
  const size = fit(t, S * 0.5, S * 0.26, c.h * 0.1, c.head * 0.6, 1.1);
  return `<div style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${S}" height="${S}" style="position:absolute;">${rays}${rings}${segs}${dots}</svg>` +
    `<div style="width:${(S * 0.5).toFixed(0)}px;position:relative;">${animText(c, t, size, { weight: 900, align: 'center', lh: 1.1, accent: 'last', delay: 250 })}</div></div>`;
};

/** four corner brackets draw in around a headline (camera focus frame), a pill tag pops with the back easing, optional round download badge (items[0] = its label) */
const bracket_focus: Template = (d, c) => {
  const t = limitWords(d.title ?? d.big ?? d.quote ?? '', 4), tag = limitWords(d.label ?? '', 3), badge = limitWords(d.items?.[0] ?? '', 2);
  const W = Math.round(c.cw * 0.96), H = Math.round(Math.min(c.ch * (badge ? 0.42 : 0.5), W * 0.62)), a = Math.round(Math.min(W, H) * 0.2), sw = Math.max(6, Math.round(c.min * 0.18)), i = sw / 2;
  const corner = (dd: string, k: number) => `<path d="${dd}" fill="none" stroke="${c.t.accent}" stroke-width="${sw}" stroke-linecap="square" stroke-linejoin="miter" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - timed(c.ms, k * 90, 700, 'ease-in-out')).toFixed(4)}"/>`;
  const brackets = [
    corner(`M${i} ${a + i} L${i} ${i} L${a + i} ${i}`, 0), corner(`M${W - a - i} ${i} L${W - i} ${i} L${W - i} ${a + i}`, 1),
    corner(`M${W - i} ${H - a - i} L${W - i} ${H - i} L${W - a - i} ${H - i}`, 2), corner(`M${a + i} ${H - i} L${i} ${H - i} L${i} ${H - a - i}`, 3)].join('');
  const size = fit(t, W * 0.78, H * 0.7, c.h * 0.1, c.head * 0.7, 1.1), pop = timed(c.ms, DELAY + 650, 450, 'back');
  const pill = tag ? `<div style="align-self:center;padding:${c.body * 0.28}px ${c.body * 0.8}px;border-radius:99px;background:${c.t.accent};color:${ink(c)};font-family:${c.t.font};font-weight:800;font-size:${Math.round(c.body * 0.85)}px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;` +
    `box-shadow:0 0 ${Math.round(c.body * 0.9 * pop)}px ${c.t.accent}88;transform:scale(${pop.toFixed(3)});opacity:${Math.min(1, pop * 2).toFixed(3)};">${esc(tag)}</div>` : '';
  const bs = Math.round(c.body * 2.1), bp = timed(c.ms, DELAY + 1000, 450, 'back');
  const badgeRow = badge ? `<div style="align-self:center;display:flex;align-items:center;gap:${c.body * 0.4}px;transform:scale(${bp.toFixed(3)});opacity:${Math.min(1, bp * 2).toFixed(3)};">` +
    `<div style="width:${bs}px;height:${bs}px;border-radius:50%;background:${c.t.accent};display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${bs * 0.55}" height="${bs * 0.55}"><path d="M12 4 V15 M6.5 10 L12 15.5 L17.5 10 M5 20 H19" fill="none" stroke="${ink(c)}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` +
    `<div style="font-family:${c.t.font};font-weight:800;font-size:${c.body}px;color:${c.t.text};">${esc(badge)}</div></div>` : '';
  return col(pill + `<div style="position:relative;align-self:center;width:${W}px;height:${H}px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="position:absolute;left:0;top:0;">${brackets}</svg>` +
    `<div style="position:absolute;left:${W * 0.11}px;right:${W * 0.11}px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;">${animText(c, t, size, { weight: 900, align: 'center', lh: 1.1, accent: 'last', delay: 200 })}</div></div>` + badgeRow, c.body * 0.7);
};

export const TEMPLATES: Record<VisualType, Template> = {
  stat_counter, quote_card, definition_card, list_card, versus_card, bar_chart, line_chart, progress_ring,
  timeline, keyword_title, code_window, terminal, post_card, receipt_card, highlight_card, stack_card, frame_card,
  title_stack, pill_row, flow_diagram, geo_title, cta_card, before_after, arrow_callout, window_card, halftone_frame,
  radial_burst, bracket_focus,
};

export function templateHtml(type: VisualType, d: VisualData, theme: VisualTheme, w: number, h: number, p = 1, ms = 99999, anim = 'kinetic', full = false): string {
  return (TEMPLATES[type] ?? keyword_title)(d, makeCtx(theme, w, h, clamp01(p), ms, anim, full));
}
