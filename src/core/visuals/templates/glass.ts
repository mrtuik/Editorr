/**
 * Glass-card motion graphics (floating cards, curved arrows, metric pills, old-vs-new, workflow, command bar).
 * Pure functions of c.ms like every template. "Glass" is faked with a translucent gradient, a 1.5 px light border, an inner highlight and a
 * soft shadow: backdrop-filter does not work inside an SVG foreignObject picture, and there is nothing behind the card to blur anyway.
 */
import type { VisualData } from '../types';
import { timed } from '../ease';
import { animText } from '../textAnim';
import { Ctx, alpha, esc, fit, limitWords } from './util';

type Template = (d: VisualData, c: Ctx) => string;
const GOOD = '#2ee6a0', BAD = '#ff5a5f';

const lum = (hex: string) => { const m = /^#([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) return 0.2; const n = parseInt(m[1]!, 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const ink = (c: Ctx) => (lum(c.t.accent) > 0.6 ? '#0b0b0b' : '#ffffff');
const op = (e: number) => Math.max(0, Math.min(1, e * 1.6)).toFixed(3);
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

const stage = (c: Ctx, inner: string, glow = true) =>
  `<div style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;">` +
  (glow ? `<div style="position:absolute;left:50%;top:50%;width:${c.cw * 1.25}px;height:${c.cw * 1.25}px;margin:-${c.cw * 0.625}px 0 0 -${c.cw * 0.625}px;background:radial-gradient(circle, ${alpha(c.t.accent, 0.3)}, transparent 62%);opacity:${timed(c.ms, 0, 900, 'ease-out').toFixed(3)};"></div>` : '') + inner + '</div>';

/** the floating card: translucent gradient, light border, inner highlight, shadow, a slight 3D tilt that settles as it springs in */
const glass = (c: Ctx, inner: string, o: { w: number; e: number; pad?: number; tint?: string; extra?: string }) => {
  const u = c.min, e = o.e, settle = Math.min(1, e), tint = o.tint ?? c.t.accent;
  return `<div style="position:relative;box-sizing:border-box;width:${o.w}px;padding:${o.pad ?? Math.round(u * 0.9)}px;border-radius:${Math.round(u * 0.8)}px;` +
    `background:linear-gradient(155deg, ${alpha(c.t.text, 0.14)}, ${alpha(c.t.text, 0.05)});border:1.5px solid ${alpha(tint === c.t.accent ? c.t.text : tint, tint === c.t.accent ? 0.22 : 0.55)};` +
    `box-shadow:0 ${u * 0.7}px ${u * 1.8}px rgba(0,0,0,0.38), 0 0 ${u * 1.8}px ${alpha(tint, 0.26)}, inset 0 1px 0 ${alpha(c.t.text, 0.2)};` +
    `opacity:${op(e)};transform:perspective(${Math.round(c.w * 1.6)}px) rotateX(${((1 - settle) * 16 + 1.5).toFixed(2)}deg) scale(${(0.82 + 0.18 * e).toFixed(3)});transform-origin:50% 100%;${o.extra ?? ''}">${inner}</div>`;
};

/** trend triangle drawn as a shape: a text glyph such as the up triangle is missing from the bundled fonts and breaks the whole text run inside the SVG picture */
const tri = (trend: string | undefined, color: string, size: number) =>
  trend === 'flat' ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="${size}" height="${size}"><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="${color}"/></svg>`
  : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="${size}" height="${size}"><path d="M5 1.2 L9.6 8.8 H0.4 Z" fill="${color}" transform="${trend === 'down' ? 'rotate(180 5 5)' : ''}"/></svg>`;
const dots = (u: number) => `<div style="display:flex;gap:${u * 0.28}px;">${['#ff5f57', '#febc2e', '#28c840'].map(k => `<div style="width:${u * 0.36}px;height:${u * 0.36}px;border-radius:50%;background:${k};"></div>`).join('')}</div>`;
const pill = (c: Ctx, text: string, o: { bg?: string; color?: string; size?: number; glow?: string; icon?: string } = {}) =>
  `<div style="display:inline-flex;align-items:center;gap:${c.min * 0.25}px;padding:${c.min * 0.18}px ${c.min * 0.55}px;border-radius:99px;background:${o.bg ?? c.t.accent};color:${o.color ?? ink(c)};font-family:${c.t.font};font-weight:800;font-size:${o.size ?? Math.round(c.min * 0.62)}px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;${o.glow ? `box-shadow:0 0 ${c.min * 0.8}px ${o.glow};` : ''}">${o.icon ?? ''}${esc(text)}</div>`;
const small = (c: Ctx, s: string, size: number, color: string, e: number, extra = '') =>
  `<div style="font-family:${c.t.font};font-size:${size}px;line-height:1.25;color:${color};font-weight:600;opacity:${op(e)};transform:translateY(${((1 - Math.min(1, e)) * size * 0.6).toFixed(1)}px);overflow-wrap:anywhere;${extra}">${esc(s)}</div>`;

/** floating card: three window dots + category pill, headline, second line, optional metric chip. Entrance 0.82 > 1.02 > 1 ('back' ease). */
export const glass_card_hero: Template = (d, c) => {
  const u = c.min, W = Math.round(c.cw * 0.98), pad = Math.round(u * 0.95), e = timed(c.ms, 0, 750, 'back');
  const badge = limitWords(d.badge ?? d.label ?? '', 3), title = limitWords(d.title ?? d.big ?? d.quote ?? '', 7), sub = limitWords(d.subtitle ?? '', 9), stat = limitWords(d.stat ?? '', 2);
  const size = fit(title, W - 2 * pad, c.ch * 0.36, c.head * 1.05, c.head * 0.5, 1.08), tc = d.trend === 'down' ? BAD : GOOD;
  const hdr = `<div style="display:flex;align-items:center;justify-content:space-between;gap:${u * 0.5}px;margin-bottom:${u * 0.8}px;opacity:${op(timed(c.ms, 150, 500))};">${dots(u)}${badge ? pill(c, badge, { glow: alpha(c.t.accent, 0.6) }) : ''}</div>`;
  const body = animText(c, title, size, { weight: 900, align: 'left', lh: 1.08, accent: 'last', delay: 220 });
  const subEl = sub ? `<div style="margin-top:${u * 0.5}px;">${small(c, sub, Math.round(u * 0.75), c.t.muted, timed(c.ms, 750, 500))}</div>` : '';
  const statEl = stat ? `<div style="margin-top:${u * 0.8}px;opacity:${op(timed(c.ms, 950, 450, 'back'))};${timed(c.ms, 950, 450, 'back') >= 0.999 ? '' : `transform:scale(${(0.8 + 0.2 * timed(c.ms, 950, 450, 'back')).toFixed(3)});transform-origin:left center;`}">${pill(c, stat, { bg: alpha(tc, 0.18), color: tc, size: Math.round(u * 0.8), glow: alpha(tc, 0.45), icon: tri(d.trend ?? 'up', tc, Math.round(u * 0.6)) })}</div>` : '';
  return stage(c, glass(c, hdr + body + subEl + statEl, { w: W, e, pad }));
};

const bez = (t: number, a: number[], b: number[], cc: number[], dd: number[]) => { const k = 1 - t; return [k * k * k * a[0]! + 3 * k * k * t * b[0]! + 3 * k * t * t * cc[0]! + t * t * t * dd[0]!, k * k * k * a[1]! + 3 * k * k * t * b[1]! + 3 * k * t * t * cc[1]! + t * t * t * dd[1]!]; };

/** an S-curve draws itself (stroke-dashoffset, 600 ms), the head springs in, a dot rides the line, the phrase pill bobs 2 px */
export const curved_arrow_callout: Template = (d, c) => {
  const u = c.min, W = c.cw, H = Math.min(c.ch, W * 1.05), label = limitWords(d.arrowLabel ?? d.subtitle ?? d.label ?? '', 6), phrase = limitWords(d.title ?? d.big ?? d.quote ?? '', 4);
  const P0 = [22, 15], P1 = [20, 44], P2 = [64, 30], P3 = [62, 70];
  const e = timed(c.ms, 250, 600, 'ease-in-out'), head = timed(c.ms, 780, 350, 'back');
  const tx = P3[0]! - P2[0]!, ty = P3[1]! - P2[1]!, ang = Math.atan2(ty, tx), L = 7;
  const hd = (da: number) => `${(P3[0]! - L * Math.cos(ang + da)).toFixed(2)} ${(P3[1]! - L * Math.sin(ang + da)).toFixed(2)}`;
  const rideT = ((c.ms - 1100) / 1500) % 1, ride = c.ms > 1100 ? bez(rideT, P0, P1, P2, P3) : null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${W}" height="${H}" style="position:absolute;left:0;top:0;overflow:visible;">` +
    `<path d="M${P0} C${P1} ${P2} ${P3}" fill="none" stroke="${alpha(c.t.accent, 0.35)}" stroke-width="3.4" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - e).toFixed(4)}" style="filter:blur(1.6px);"/>` +
    `<path d="M${P0} C${P1} ${P2} ${P3}" fill="none" stroke="${c.t.accent}" stroke-width="1.5" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - e).toFixed(4)}"/>` +
    `<g transform="translate(${P3[0]} ${P3[1]}) scale(${head.toFixed(3)}) translate(${-P3[0]!} ${-P3[1]!})" opacity="${Math.min(1, head * 2).toFixed(3)}"><path d="M${hd(0.5)} L${P3[0]} ${P3[1]} L${hd(-0.5)}" fill="none" stroke="${c.t.accent}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>` +
    (ride ? `<circle cx="${ride[0]!.toFixed(2)}" cy="${ride[1]!.toFixed(2)}" r="1.6" fill="${c.t.text}" style="filter:drop-shadow(0 0 2px ${c.t.accent});"/>` : '') + `</svg>`;
  const bob = head >= 1 ? Math.sin(c.ms * 0.004) * 2 : 0, pe = timed(c.ms, 700, 500, 'back');
  const size = fit(phrase, W * 0.62, H * 0.1, c.head * 0.95, c.head * 0.45, 1.1);
  const pillEl = `<div style="position:absolute;left:${P3[0]}%;top:${P3[1] + 1.5}%;transform:translate(-50%,${bob.toFixed(2)}px) scale(${(0.7 + 0.3 * pe).toFixed(3)});opacity:${op(pe)};width:max-content;white-space:nowrap;box-sizing:border-box;padding:${u * 0.35}px ${u * 0.85}px;border-radius:${u * 0.7}px;background:${alpha(c.t.accent, 0.16)};border:2px solid ${c.t.accent};box-shadow:0 0 ${u * 1.6}px ${alpha(c.t.accent, 0.55)}, inset 0 1px 0 ${alpha(c.t.text, 0.2)};text-align:center;">${animText(c, phrase, size, { weight: 900, align: 'center', lh: 1.08, delay: 600 })}</div>`;
  const lab = label ? `<div style="position:absolute;left:0;top:0;max-width:${W * 0.7}px;">${small(c, label, Math.round(u * 0.85), c.t.muted, timed(c.ms, 0, 500), 'letter-spacing:0.02em;')}</div>` : '';
  return stage(c, `<div style="position:relative;width:${W}px;height:${H}px;">${svg}${lab}${pillEl}</div>`);
};

/** old way (red, struck through) -> arrow bridge -> new way (green, glow, check). Left at 0 ms, arrow at 350, right at 500. Stacked in portrait, side by side in landscape. */
export const before_after_split: Template = (d, c) => {
  const u = c.min, vertical = c.cw < c.ch * 0.95, tags = (d.badge ?? '').split('|').map(x => limitWords(x.trim(), 2)).filter(Boolean);
  const oldT = limitWords(d.left ?? '', 5), newT = limitWords(d.right ?? d.title ?? '', 5);
  const W = vertical ? Math.round(c.cw * 0.96) : Math.round(c.cw * 0.45), size = fit(`${oldT} ${newT}`.length > 20 ? (oldT.length > newT.length ? oldT : newT) : oldT + newT, W - u * 2.2, c.ch * (vertical ? 0.16 : 0.3), c.head * 0.8, c.head * 0.45, 1.1);
  const eL = timed(c.ms, 0, 650, 'back'), eA = timed(c.ms, 350, 450, 'ease-in-out'), eR = timed(c.ms, 500, 700, 'back');
  const check = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${u * 0.95}" height="${u * 0.95}" style="flex:none;"><circle cx="12" cy="12" r="11" fill="${GOOD}"/><path d="M6.5 12.5 L10.5 16.5 L17.5 8" fill="none" stroke="#06281c" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - timed(c.ms, 900, 350, 'ease-out')).toFixed(3)}"/></svg>`;
  const cross = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${u * 0.95}" height="${u * 0.95}" style="flex:none;"><circle cx="12" cy="12" r="11" fill="${BAD}"/><path d="M8 8 L16 16 M16 8 L8 16" stroke="#2a0507" stroke-width="3" stroke-linecap="round"/></svg>`;
  const card = (tag: string, text: string, tint: string, e: number, icon: string, strike: boolean, glowOn: boolean) =>
    glass(c, `<div style="margin-bottom:${u * 0.55}px;">${pill(c, tag, { bg: tint, color: '#0b0b0b', glow: glowOn ? alpha(tint, 0.6) : undefined })}</div><div style="display:flex;align-items:center;gap:${u * 0.45}px;">${icon}<div style="font-family:${c.t.font};font-weight:800;font-size:${size}px;line-height:1.1;color:${strike ? c.t.muted : c.t.text};${strike ? `text-decoration:line-through;text-decoration-color:${BAD};text-decoration-thickness:3px;` : ''}overflow-wrap:anywhere;">${esc(text)}</div></div>`, { w: W, e, tint, pad: Math.round(u * 0.85) });
  const bw = Math.round(u * 1.5);
  const bridge = vertical
    ? `<div style="height:${u * 1.7}px;width:${bw}px;display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 40" width="${bw}" height="${u * 1.7}"><path d="M10 2 V32 M3 25 L10 33 L17 25" fill="none" stroke="${c.t.accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - eA).toFixed(4)}"/></svg></div>`
    : `<div style="width:${u * 1.7}px;height:${bw}px;display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="${u * 1.7}" height="${bw}"><path d="M2 10 H32 M25 3 L33 10 L25 17" fill="none" stroke="${c.t.accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - eA).toFixed(4)}"/></svg></div>`;
  const row = `<div style="display:flex;flex-direction:${vertical ? 'column' : 'row'};align-items:center;justify-content:center;gap:${u * 0.15}px;">${card(tags[0] ?? 'OLD WAY', oldT, BAD, eL, cross, true, false)}${bridge}${card(tags[1] ?? 'NEW WAY', newT, GOOD, eR, check, false, true)}</div>`;
  return stage(c, row, false);
};

type Stat = { pre: string; val: number; dec: number; comma: boolean; suf: string };
const parseStat = (s: string): Stat | null => { const m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(s.trim()); if (!m) return null; const raw = m[2]!; return { pre: m[1]!, val: parseFloat(raw.replace(/,/g, '')), dec: raw.includes('.') ? raw.split('.')[1]!.length : 0, comma: raw.includes(','), suf: m[3]! }; };
const fmtNum = (v: number, dec: number, comma: boolean) => { const t = v.toFixed(dec); if (!comma) return t; const [i, f] = t.split('.'); return i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); };

/** huge gradient number counting up (1200 ms ease-out), trend chip, sparkline that trims itself in. The sparkline is decoration (or the real `values` if given). */
export const stat_pill_counter: Template = (d, c) => {
  const u = c.min, W = Math.round(c.cw * 0.98), raw = limitWords(d.stat ?? d.big ?? d.title ?? '', 2), st = parseStat(raw), cnt = timed(c.ms, 100, 1200, 'ease-out');
  const finalTxt = st ? `${st.pre}${fmtNum(st.val, st.dec, st.comma)}${st.suf}` : raw, shown = st ? `${st.pre}${fmtNum(st.val * cnt, st.dec, st.comma)}${st.suf}` : raw;
  const size = fit(finalTxt, W - u * 2, c.ch * 0.3, c.h * 0.17, c.head * 0.6, 1.0), e = timed(c.ms, 0, 700, 'back');
  const trend = d.trend ?? 'up', tc = trend === 'down' ? BAD : GOOD;
  const pillTxt = limitWords(d.badge ?? '', 3), label = limitWords(d.label ?? d.subtitle ?? '', 6);
  const N = 12, vals = d.values && d.values.length >= 3 ? d.values.slice(0, 16) : Array.from({ length: N }, (_, i) => { const r = ((hash(raw + i) % 1000) / 1000 - 0.5) * 0.35, base = i / (N - 1); return (trend === 'down' ? 1 - base : trend === 'flat' ? 0.5 : base) + r; });
  const lo = Math.min(...vals), hi = Math.max(...vals), pts = vals.map((v, i) => [(i / (vals.length - 1)) * 100, 28 - ((v - lo) / (hi - lo || 1)) * 24] as [number, number]);
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' '), se = timed(c.ms, 500, 900, 'ease-in-out'), last = pts[pts.length - 1]!, dot = timed(c.ms, 1350, 350, 'back');
  const spark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 32" width="${W - u * 2}" height="${u * 2.2}" preserveAspectRatio="none" style="display:block;overflow:visible;margin-top:${u * 0.7}px;"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${alpha(tc, 0.35)}"/><stop offset="1" stop-color="${alpha(tc, 0)}"/></linearGradient></defs>` +
    `<path d="${line} L100 32 L0 32 Z" fill="url(#sg)" opacity="${se.toFixed(3)}"/><path d="${line}" fill="none" stroke="${tc}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - se).toFixed(4)}"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="${(2.2 * dot).toFixed(2)}" fill="${tc}" vector-effect="non-scaling-stroke"/></svg>`;
  const num = `<div style="font-family:${c.t.font};font-weight:900;font-size:${size}px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;text-align:center;background:linear-gradient(90deg, ${c.t.text}, ${c.t.accent});-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 ${u * 0.6}px ${alpha(c.t.accent, 0.4)});">${esc(shown)}</div>`;
  const chip = `<div style="display:flex;justify-content:center;gap:${u * 0.4}px;margin-top:${u * 0.7}px;opacity:${op(timed(c.ms, 700, 450, 'back'))};">${pill(c, pillTxt || (trend === 'down' ? 'down' : 'up'), { bg: alpha(tc, 0.18), color: tc, size: Math.round(u * 0.8), glow: alpha(tc, 0.4), icon: tri(trend, tc, Math.round(u * 0.6)) })}</div>`;
  const lab = label ? `<div style="text-align:center;margin-top:${u * 0.5}px;">${small(c, label, Math.round(u * 0.8), c.t.muted, timed(c.ms, 900, 450), 'text-align:center;')}</div>` : '';
  return stage(c, glass(c, num + chip + spark + lab, { w: W, e, pad: Math.round(u * 1.0) }));
};

/** 2 to 4 nodes in a line, each lights up in turn, beams between them draw and carry a travelling glow */
export const workflow_steps: Template = (d, c) => {
  const u = c.min, items = (d.items ?? []).slice(0, 4).map(x => limitWords(x, 4)).filter(Boolean), vertical = c.cw < c.ch * 1.1;
  if (items.length < 2) return glass_card_hero({ ...d, title: d.title ?? items[0] ?? '' }, c);
  const n = items.length, W = Math.round(c.cw * 0.96), nodeW = vertical ? W : Math.round((c.cw - (n - 1) * u * 1.6) / n), gap = Math.round(u * 1.6);
  const size = fit(items.reduce((a, b) => (a.length > b.length ? a : b), ''), nodeW - u * 2.4, u * 2.2, c.head * 0.7, c.min * 0.7, 1.1);
  const T0 = 150, STEP = 520;
  const node = (i: number) => {
    const e = timed(c.ms, T0 + i * STEP, 600, 'back'), on = c.ms > T0 + i * STEP + 250;
    return glass(c, `<div style="display:flex;${vertical ? 'flex-direction:row' : 'flex-direction:column'};align-items:center;gap:${u * 0.55}px;"><div style="flex:none;width:${u * 1.15}px;height:${u * 1.15}px;border-radius:50%;background:${on ? c.t.accent : alpha(c.t.text, 0.2)};color:${on ? ink(c) : c.t.text};display:flex;align-items:center;justify-content:center;font-family:${c.t.font};font-weight:900;font-size:${u * 0.7}px;box-shadow:${on ? `0 0 ${u * 1.1}px ${alpha(c.t.accent, 0.7)}` : 'none'};">${i + 1}</div>` +
      `<div style="font-family:${c.t.font};font-weight:800;font-size:${size}px;line-height:1.1;color:${c.t.text};text-align:${vertical ? 'left' : 'center'};overflow-wrap:anywhere;">${esc(items[i]!)}</div></div>`, { w: nodeW, e, pad: Math.round(u * 0.7), tint: on ? c.t.accent : c.t.text });
  };
  const beam = (i: number) => {
    const g = timed(c.ms, T0 + i * STEP + 420, 400, 'ease-in-out'), ride = g >= 1 ? ((c.ms * 0.0011 + i * 0.3) % 1) : -1, L = gap;
    const line = vertical ? `width:4px;height:${L}px;` : `height:4px;width:${L}px;`, grow = vertical ? `transform:scaleY(${g.toFixed(3)});transform-origin:top;` : `transform:scaleX(${g.toFixed(3)});transform-origin:left;`;
    const pos = ride >= 0 ? (vertical ? `left:50%;top:${(ride * 100).toFixed(1)}%;margin:-${u * 0.2}px 0 0 -${u * 0.2}px;` : `top:50%;left:${(ride * 100).toFixed(1)}%;margin:-${u * 0.2}px 0 0 -${u * 0.2}px;`) : '';
    return `<div style="position:relative;${line}border-radius:99px;background:linear-gradient(${vertical ? '180deg' : '90deg'}, ${alpha(c.t.accent, 0.9)}, ${alpha(c.t.accent, 0.35)});${grow}box-shadow:0 0 ${u * 0.5}px ${alpha(c.t.accent, 0.5)};">` +
      (ride >= 0 ? `<div style="position:absolute;${pos}width:${u * 0.4}px;height:${u * 0.4}px;border-radius:50%;background:#fff;box-shadow:0 0 ${u * 0.7}px ${c.t.accent}, 0 0 ${u * 1.2}px ${c.t.accent};"></div>` : '') + `</div>`;
  };
  const parts: string[] = []; items.forEach((_, i) => { parts.push(node(i)); if (i < n - 1) parts.push(beam(i)); });
  return stage(c, `<div style="display:flex;flex-direction:${vertical ? 'column' : 'row'};align-items:center;justify-content:center;">${parts.join('')}</div>`, false);
};

/** a Spotlight-style bar types the prompt (blinking cursor), then a result card drops in with staggered rows */
export const command_palette: Template = (d, c) => {
  const u = c.min, W = Math.round(c.cw * 0.98), prompt = limitWords(d.title ?? d.quote ?? '', 8), items = (d.items ?? []).slice(0, 3).map(x => limitWords(x, 5)).filter(Boolean);
  const typeMs = Math.max(700, Math.min(1500, prompt.length * 45)), shown = Math.floor(prompt.length * timed(c.ms, 250, typeMs, 'linear')), done = c.ms > 250 + typeMs;
  const cur = Math.floor(c.ms / 450) % 2 === 0 || !done;
  const size = fit(prompt, W - u * 3.4, u * 1.4, c.head * 0.62, c.min * 0.7, 1.1), e = timed(c.ms, 0, 650, 'back');
  const mag = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${u * 0.95}" height="${u * 0.95}" style="flex:none;"><circle cx="10" cy="10" r="6.5" fill="none" stroke="${c.t.muted}" stroke-width="2.4"/><path d="M15 15 L21 21" stroke="${c.t.muted}" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const bar = glass(c, `<div style="display:flex;align-items:center;gap:${u * 0.5}px;">${mag}<div style="font-family:${c.t.mono};font-weight:700;font-size:${size}px;color:${c.t.text};white-space:pre-wrap;overflow-wrap:anywhere;flex:1;">${esc(prompt.slice(0, shown))}<span style="display:inline-block;width:${Math.max(3, size * 0.1)}px;height:${size * 0.95}px;margin-left:2px;vertical-align:-${size * 0.12}px;background:${c.t.accent};opacity:${cur ? 1 : 0};"></span></div></div>`, { w: W, e, pad: Math.round(u * 0.75) });
  const rows = items.map((it, i) => {
    const r = timed(c.ms, 250 + typeMs + 150 + i * 160, 450, 'back');
    return `<div style="display:flex;align-items:center;gap:${u * 0.55}px;padding:${u * 0.4}px ${u * 0.5}px;border-radius:${u * 0.45}px;background:${i === 0 ? alpha(c.t.accent, 0.2) : 'transparent'};opacity:${op(r)};transform:translateY(${((1 - Math.min(1, r)) * u * 0.6).toFixed(1)}px);">` +
      `<div style="flex:none;width:${u * 0.95}px;height:${u * 0.95}px;border-radius:${u * 0.28}px;background:${alpha(c.t.accent, i === 0 ? 0.9 : 0.35)};color:${i === 0 ? ink(c) : c.t.text};display:flex;align-items:center;justify-content:center;font-family:${c.t.font};font-weight:900;font-size:${u * 0.55}px;">${esc((it[0] ?? '').toUpperCase())}</div>` +
      `<div style="font-family:${c.t.font};font-weight:700;font-size:${Math.round(u * 0.8)}px;color:${c.t.text};overflow-wrap:anywhere;">${esc(it)}</div></div>`;
  }).join('');
  const res = items.length ? `<div style="margin-top:${u * 0.5}px;">${glass(c, rows, { w: W, e: timed(c.ms, 250 + typeMs + 100, 600, 'back'), pad: Math.round(u * 0.45) })}</div>` : '';
  return stage(c, `<div style="display:flex;flex-direction:column;align-items:center;">${bar}${res}</div>`);
};
