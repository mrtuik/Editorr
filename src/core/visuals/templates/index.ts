/** One pure function per visual type: (data, theme, w, h, p) => inner HTML of the card. p (0..1) drives what moves inside (count-up, bars, typing). */
import type { VisualData, VisualTheme, VisualType } from '../types';
import { Ctx, clamp01, col, easeOut, esc, fit, limitWords, makeCtx, rise, stg, txt, words } from './util';

export type Template = (d: VisualData, c: Ctx) => string;

const stat_counter: Template = (d, c) => {
  const big = d.big ?? d.title ?? '';
  const m = big.match(/-?\d[\d,]*\.?\d*/);
  let shown = big;
  if (m) {
    const raw = m[0], v = parseFloat(raw.replace(/,/g, '')), dec = (raw.split('.')[1] ?? '').length;
    const cur = v * easeOut(c.p);
    const [ip, fp] = cur.toFixed(dec).split('.');
    const num = (raw.includes(',') ? ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ip) + (fp ? '.' + fp : '');
    shown = big.replace(raw, num);
  }
  const size = fit(shown, c.cw - (d.trend && d.trend !== 'flat' ? c.body * 1.5 : 0), c.ch * 0.5, c.h * 0.11, c.min * 1.3);
  const tri = d.trend && d.trend !== 'flat'
    ? `<div style="width:0;height:0;border-left:${c.body * 0.5}px solid transparent;border-right:${c.body * 0.5}px solid transparent;${d.trend === 'up' ? `border-bottom:${c.body * 0.85}px solid ${c.t.accent}` : `border-top:${c.body * 0.85}px solid ${c.t.accent}`};"></div>` : '';
  return col(
    `<div style="display:flex;align-items:center;gap:${c.body * 0.5}px;">${tri}${txt(c, shown, size, { color: c.t.accent, weight: 900, lh: 1.02, op: easeOut(c.p * 3), nowrap: true })}</div>` +
    (d.label ? txt(c, limitWords(d.label, 8), c.body, { color: c.t.muted, weight: 500, ...rise(c, 1, 2, 0.6) }) : ''), c.body * 0.5);
};

const quote_card: Template = (d, c) => {
  const q = limitWords(d.quote ?? d.title ?? '', 12), ws = words(q);
  const acc = (d.accent ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const size = fit(q, c.cw, c.ch, c.h * 0.085, c.head * 0.6);
  const spans = ws.map((w, i) => {
    const e = easeOut(stg(c.p, i, ws.length, 0.45)), hit = acc && w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === acc;
    return `<span style="display:inline-block;margin-right:0.28em;opacity:${e.toFixed(3)};transform:translateY(${((1 - e) * size * 0.4).toFixed(1)}px);color:${hit ? c.t.accent : c.t.text};">${esc(w)}</span>`;
  }).join('');
  return col(`<div style="font-size:${size}px;line-height:1.2;font-weight:700;font-family:${c.t.serif};">${spans}</div>`);
};

const definition_card: Template = (d, c) => {
  const term = limitWords(d.term ?? d.title, 4), mean = limitWords(d.meaning ?? d.label, 9);
  const ts = fit(term, c.cw, c.ch * 0.35, c.h * 0.1, c.head * 0.8), ms = fit(mean, c.cw, c.ch * 0.4, c.body * 1.3, c.min);
  const e1 = easeOut(stg(c.p, 0, 2, 0.5)), e2 = easeOut(stg(c.p, 1, 2, 0.5));
  return col(txt(c, term, ts, { color: c.t.accent, weight: 900, op: e1, dy: (1 - e1) * ts * 0.3 }) +
    `<div style="height:${c.body * 0.2}px;width:${(c.cw * 0.18 * e1).toFixed(1)}px;background:${c.t.accent};border-radius:99px;"></div>` +
    txt(c, mean, ms, { color: c.t.text, weight: 500, op: e2, dy: (1 - e2) * ms * 0.3 }), c.body * 0.55);
};

const list_card: Template = (d, c) => {
  const items = (d.items ?? []).slice(0, 5).map(s => limitWords(s, 5)), n = items.length;
  const title = limitWords(d.title, 5);
  const size = Math.max(c.min, Math.min(c.body * 1.25, Math.floor((c.ch * 0.8) / Math.max(1, n) / 1.5)));
  const rows = items.map((s, i) => {
    const r = rise(c, i, n);
    return `<div style="display:flex;align-items:center;gap:${size * 0.5}px;opacity:${r.op.toFixed(3)};transform:translateY(${r.dy.toFixed(1)}px);">` +
      `<div style="flex:none;width:${size * 0.5}px;height:${size * 0.5}px;border-radius:99px;background:${c.t.accent};"></div>${txt(c, s, size, { weight: 600 })}</div>`;
  }).join('');
  return col((title ? txt(c, title, c.body, { color: c.t.muted, weight: 500 }) : '') + rows, size * 0.45);
};

const versus_card: Template = (d, c) => {
  const row = c.w > c.h, l = limitWords(d.left, 4), r = limitWords(d.right, 4), e = easeOut(c.p);
  const side = (s: string, dir: number, color: string) => {
    const sz = fit(s, row ? c.cw * 0.42 : c.cw, row ? c.ch : c.ch * 0.38, c.h * 0.085, c.body);
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;opacity:${e.toFixed(3)};transform:translate${row ? 'X' : 'Y'}(${((1 - e) * dir * c.body * 2).toFixed(1)}px);">${txt(c, s, sz, { color, align: 'center', weight: 800 })}</div>`;
  };
  const line = `<div style="${row ? `width:${c.body * 0.1}px;height:${(e * 100).toFixed(1)}%` : `height:${c.body * 0.1}px;width:${(e * 100).toFixed(1)}%`};background:${c.t.accent};border-radius:99px;align-self:center;"></div>`;
  return `<div style="display:flex;flex-direction:${row ? 'row' : 'column'};width:100%;height:100%;">${side(l, -1, c.t.text)}${line}${side(r, 1, c.t.accent)}</div>`;
};

const bar_chart: Template = (d, c) => {
  const vals = (d.values ?? []).slice(0, 5), labs = d.labels ?? [], n = vals.length, mx = Math.max(1e-9, ...vals);
  const size = Math.max(c.min, Math.min(c.body, Math.floor((c.ch * 0.8) / Math.max(1, n) / 2)));
  const top = vals.indexOf(Math.max(...vals));
  const rows = vals.map((v, i) => {
    const e = easeOut(stg(c.p, i, n, 0.6)), hi = i === top;
    return `<div style="display:flex;flex-direction:column;gap:${size * 0.15}px;">` +
      `<div style="display:flex;justify-content:space-between;">${txt(c, limitWords(labs[i] ?? '', 3), size, { weight: 600, color: c.t.muted })}${txt(c, String(Math.round(v * e * 100) / 100), size, { weight: 800, color: hi ? c.t.accent : c.t.text })}</div>` +
      `<div style="height:${size * 0.45}px;border-radius:99px;background:rgba(127,127,127,0.18);"><div style="height:100%;width:${((v / mx) * 100 * e).toFixed(1)}%;border-radius:99px;background:${hi ? c.t.accent : (c.t.dot ?? c.t.muted)};"></div></div></div>`;
  }).join('');
  return col((d.title ? txt(c, limitWords(d.title, 5), c.body, { color: c.t.muted, weight: 500 }) : '') + rows, size * 0.6);
};

const line_chart: Template = (d, c) => {
  const v = (d.values ?? []).slice(0, 12); if (v.length < 2) return col(txt(c, limitWords(d.title, 6), c.head));
  const mn = Math.min(...v), mx = Math.max(...v), rg = Math.max(1e-9, mx - mn), W = 1000, H = 500, pd = 30;
  const pts = v.map((y, i) => [pd + (i / (v.length - 1)) * (W - 2 * pd), H - pd - ((y - mn) / rg) * (H - 2 * pd)]);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' '), e = easeOut(c.p), last = pts[pts.length - 1];
  return col((d.title ? txt(c, limitWords(d.title, 5), c.body, { color: c.t.muted, weight: 500 }) : '') +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="flex:none;max-height:${c.ch * 0.75}px;"><path d="${path}" pathLength="1" fill="none" stroke="${c.t.accent}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1" stroke-dashoffset="${(1 - e).toFixed(4)}"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="${14 * clamp01((c.p - 0.85) / 0.15)}" fill="${c.t.accent}"/></svg>`, c.body * 0.5);
};

const progress_ring: Template = (d, c) => {
  const pc = Math.max(0, Math.min(100, d.percent ?? 0)), e = easeOut(c.p), sz = Math.min(c.cw, c.ch * 0.7);
  return col(`<div style="position:relative;width:${sz}px;height:${sz}px;align-self:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${sz}" height="${sz}" style="transform:rotate(-90deg)">` +
    `<circle cx="50" cy="50" r="42" fill="none" stroke="rgba(127,127,127,0.2)" stroke-width="8"/><circle cx="50" cy="50" r="42" fill="none" stroke="${c.t.accent}" stroke-width="8" stroke-linecap="round" pathLength="100" stroke-dasharray="${(pc * e).toFixed(2)} 100"/></svg>` +
    `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${txt(c, `${Math.round(pc * e)}%`, sz * 0.24, { weight: 900, color: c.t.text })}</div></div>` +
    (d.label ? txt(c, limitWords(d.label, 6), c.body, { color: c.t.muted, weight: 500, align: 'center' }) : ''), c.body * 0.4);
};

const timeline: Template = (d, c) => {
  const items = (d.items ?? []).slice(0, 5).map(s => limitWords(s, 5)), n = items.length;
  const size = Math.max(c.min, Math.min(c.body * 1.2, Math.floor((c.ch * 0.8) / Math.max(1, n) / 1.7))), dot = size * 0.6;
  const rows = items.map((s, i) => {
    const e = easeOut(stg(c.p, i, n, 0.4)), le = easeOut(stg(c.p, i + 0.5, n, 0.4));
    return `<div style="display:flex;gap:${size * 0.6}px;flex:1;opacity:${(0.25 + 0.75 * e).toFixed(3)};">` +
      `<div style="display:flex;flex-direction:column;align-items:center;"><div style="flex:none;width:${dot}px;height:${dot}px;border-radius:99px;background:${c.t.accent};transform:scale(${e.toFixed(3)});"></div>` +
      (i < n - 1 ? `<div style="flex:1;width:${size * 0.1}px;background:${c.t.accent};opacity:0.5;transform-origin:top;transform:scaleY(${le.toFixed(3)});"></div>` : '') + `</div>` +
      `<div style="padding-top:${(dot - size) / 2}px;">${txt(c, s, size, { weight: 600 })}</div></div>`;
  }).join('');
  return `<div style="display:flex;flex-direction:column;width:100%;height:100%;">${d.title ? txt(c, limitWords(d.title, 5), c.body, { color: c.t.muted, weight: 500 }) : ''}${rows}</div>`;
};

const keyword_title: Template = (d, c) => {
  const ws = words(limitWords(d.title ?? d.big ?? d.quote ?? '', 4)), s = ws.join(' ');
  const size = fit(s, c.cw, c.ch, c.h * 0.11, c.head * 0.8, 1.1);
  const spans = ws.map((w, i) => {
    const e = easeOut(stg(c.p, i, ws.length, 0.5)), last = i === ws.length - 1;
    return `<span style="display:inline-block;margin-right:0.25em;opacity:${e.toFixed(3)};transform:scale(${(1.3 - 0.3 * e).toFixed(3)});color:${last ? c.t.accent : c.t.text};">${esc(w)}</span>`;
  }).join('');
  return col(`<div style="font-size:${size}px;line-height:1.1;font-weight:900;text-align:center;font-family:${c.t.font};">${spans}</div>`);
};

const windowBar = (c: Ctx, title: string) => `<div style="display:flex;align-items:center;gap:${c.body * 0.3}px;margin-bottom:${c.body * 0.5}px;">` +
  ['#ff5f57', '#febc2e', '#28c840'].map(k => `<div style="width:${c.body * 0.35}px;height:${c.body * 0.35}px;border-radius:99px;background:${k};"></div>`).join('') + txt(c, title, c.min, { color: c.t.muted, font: c.t.mono, weight: 500 }) + `</div>`;

const typed = (lines: string[], p: number) => {
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
  const lines = (d.code ?? '').split('\n').slice(0, 7).map(l => l.slice(0, maxChars(c))), shown = typed(lines, c.p);
  const size = monoSize(c, lines);
  return col(windowBar(c, d.lang ?? 'code') + shown.map(l => txt(c, l || '\u00a0', size, { font: c.t.mono, weight: 700, color: c.t.text, lh: 1.4, nowrap: true })).join(''));
};

const terminal: Template = (d, c) => {
  const lines = (d.lines ?? []).slice(0, 6).map(l => l.slice(0, maxChars(c, c.min * 1.4))), shown = typed(lines, c.p);
  const size = monoSize(c, lines, c.min * 1.4);
  return col(windowBar(c, 'terminal') + shown.map(l => `<div style="display:flex;gap:${size * 0.4}px;">${txt(c, '>', size, { font: c.t.mono, color: c.t.accent })}${txt(c, l || '\u00a0', size, { font: c.t.mono, color: c.t.text, lh: 1.4, nowrap: true })}</div>`).join(''));
};

const post_card: Template = (d, c) => {
  const text = limitWords(d.text ?? d.quote ?? d.title, 12), size = fit(text, c.cw, c.ch * 0.65, c.body * 1.5, c.min);
  const nm = d.name ?? '', e = easeOut(c.p * 2);
  return col(`<div style="display:flex;align-items:center;gap:${c.body * 0.5}px;opacity:${e.toFixed(3)};"><div style="width:${c.body * 1.2}px;height:${c.body * 1.2}px;border-radius:99px;background:${c.t.accent};opacity:0.9;"></div>` +
    `<div>${nm ? txt(c, nm, c.min, { weight: 800 }) : ''}${d.handle ? txt(c, d.handle, c.min, { color: c.t.muted, weight: 500 }) : ''}</div></div>` +
    txt(c, text, size, { weight: 600, ...rise(c, 1, 2, 0.6) }), c.body * 0.7);
};

const receipt_card: Template = (d, c) => {
  const lines = (d.lines ?? []).slice(0, 5), n = lines.length + 1;
  const size = Math.max(c.min, Math.min(c.body, Math.floor((c.ch * 0.8) / (n + 2) / 1.5)));
  const row = (s: string, i: number, bold = false) => {
    const [a, b = ''] = s.split('|').map(x => x.trim()), e = easeOut(stg(c.p, i, n + 1, 0.4));
    return `<div style="display:flex;justify-content:space-between;opacity:${e.toFixed(3)};">${txt(c, a, size, { font: c.t.mono, weight: bold ? 900 : 700 })}${txt(c, b, size, { font: c.t.mono, weight: bold ? 900 : 700, color: bold ? c.t.accent : c.t.text })}</div>`;
  };
  return col((d.shop ? txt(c, limitWords(d.shop, 3), size * 1.2, { font: c.t.mono, align: 'center', weight: 900 }) : '') +
    lines.map((l, i) => row(l, i)).join('') + `<div style="border-top:3px dashed ${c.t.muted};opacity:${easeOut(c.p).toFixed(2)};"></div>` + row(`TOTAL | ${d.total ?? ''}`, n - 1, true), size * 0.4);
};

export const TEMPLATES: Record<VisualType, Template> = {
  stat_counter, quote_card, definition_card, list_card, versus_card, bar_chart, line_chart, progress_ring,
  timeline, keyword_title, code_window, terminal, post_card, receipt_card,
};

export function templateHtml(type: VisualType, d: VisualData, theme: VisualTheme, w: number, h: number, p = 1): string {
  return (TEMPLATES[type] ?? keyword_title)(d, makeCtx(theme, w, h, clamp01(p)));
}
