/**
 * Canvas 2D drawing of a visual, used only when the SVG foreignObject picture cannot be used (a WebView that taints it,
 * or an image that fails to load). Same card box, theme colours, caption-safe zone, motion and one-accent rule as the HTML
 * templates, but a simpler layout: headline, big number, lines of text. Never throws for missing data.
 */
import { innerProgress, visualMotionAt } from './motion';
import { cardBox } from './templates/util';
import { getTheme } from './themes';
import type { Visual, VisualData } from './types';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** The text lines this visual would show, in reading order, as [text, role]. */
function linesOf(v: Visual, p: number): [string, 'head' | 'big' | 'body' | 'muted'][] {
  const d: VisualData = v.data, out: [string, 'head' | 'big' | 'body' | 'muted'][] = [];
  const add = (s: string | undefined, r: 'head' | 'big' | 'body' | 'muted') => { if (s && s.trim()) out.push([s.trim(), r]); };
  switch (v.type) {
    case 'stat_counter': add(d.big ?? d.title, 'big'); add(d.label, 'muted'); break;
    case 'quote_card': add(d.quote ?? d.title ?? d.text, 'head'); break;
    case 'definition_card': add(d.term ?? d.title, 'head'); add(d.meaning, 'body'); break;
    case 'versus_card': add(d.left, 'head'); add('vs', 'muted'); add(d.right, 'head'); break;
    case 'progress_ring': add(`${Math.round((d.percent ?? 0) * clamp01(p))}%`, 'big'); add(d.label ?? d.title, 'muted'); break;
    case 'bar_chart': case 'line_chart': add(d.title, 'head'); (d.labels ?? []).forEach((l, i) => add(`${l}  ${d.values?.[i] ?? ''}`, 'body')); break;
    case 'list_card': case 'timeline': add(d.title, 'head'); (d.items ?? []).slice(0, Math.max(1, Math.ceil((d.items ?? []).length * clamp01(p * 1.4)))).forEach((s, i) => add(v.type === 'timeline' ? `${i + 1}. ${s}` : s, 'body')); break;
    case 'terminal': case 'code_window': (d.lines ?? (d.code ?? '').split('\n')).slice(0, 6).forEach((s) => add(s, 'body')); break;
    case 'post_card': add(d.name, 'muted'); add(d.text ?? d.title, 'head'); break;
    case 'receipt_card': add(d.shop, 'head'); (d.lines ?? []).slice(0, 5).forEach((s) => add(s.replace('|', '   '), 'body')); add(d.total, 'big'); break;
    case 'pill_row': case 'flow_diagram': add(d.title, 'head'); (d.items ?? []).forEach((x) => add(x, 'body')); break;
    case 'title_stack': add(d.title, 'head'); add(d.label, 'body'); add(d.accent, 'big'); break;
    case 'before_after': add(d.left, 'head'); add('>', 'muted'); add(d.right, 'head'); break;
    case 'cta_card': add(d.title, 'head'); add(d.accent, 'big'); add(d.label, 'muted'); break;
    default: add(d.title ?? d.big ?? d.quote ?? d.term, 'head');
  }
  if (!out.length) add(d.title ?? d.big ?? d.text ?? v.type, 'head');
  return out;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const ws = text.split(/\s+/), lines: string[] = []; let cur = '';
  for (const w of ws) { const t = cur ? cur + ' ' + w : w; if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}

export function drawFallback(v: Visual, tMs: number, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!, theme = getTheme(v.themeId), short = Math.min(w, h);
  const dur = Math.max(300, v.endMs - v.startMs), mp = visualMotionAt(v.motion, tMs, dur), p = innerProgress(v.motion, tMs);
  const box = cardBox(w, h), pad = Math.round(short * 0.06), r = Math.round(theme.radius * short / 1080);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.save();
  ctx.globalAlpha = clamp01(mp.o);
  ctx.translate(cx + mp.x * short, cy + mp.y * short); ctx.rotate((mp.r * Math.PI) / 180); ctx.scale(mp.s, mp.s); ctx.translate(-cx, -cy);
  if (mp.b > 0.0005) ctx.filter = `blur(${(mp.b * short).toFixed(1)}px)`;
  // card
  ctx.fillStyle = theme.cardSolid ?? theme.card; ctx.beginPath();
  const rr = (ctx as CanvasRenderingContext2D & { roundRect?: (...a: number[]) => void }).roundRect;
  if (rr) rr.call(ctx, box.x, box.y, box.w, box.h, r); else ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fill();
  // text, vertically centred, headline 8.5% of height, body 5%, nothing under 4.5%
  const sizes = { head: Math.round(h * 0.075), big: Math.round(h * 0.13), body: Math.round(h * 0.05), muted: Math.round(h * 0.045) };
  const colour = { head: theme.text, big: theme.accent, body: theme.text, muted: theme.muted };
  const maxW = box.w - 2 * pad, laid: { s: string; role: keyof typeof sizes; y: number }[] = [];
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let total = 0;
  for (const [text, role] of linesOf(v, p)) {
    ctx.font = `700 ${sizes[role]}px ${theme.font}`;
    for (const s of wrap(ctx, text, maxW).slice(0, 4)) { laid.push({ s, role, y: total }); total += sizes[role] * 1.25; }
    total += sizes[role] * 0.25;
  }
  let scale = 1; if (total > box.h - 2 * pad) scale = (box.h - 2 * pad) / total;
  const y0 = cy - (total * scale) / 2;
  for (const l of laid) {
    const size = Math.max(Math.round(h * 0.045), Math.round(sizes[l.role] * scale));
    ctx.font = `700 ${size}px ${theme.font}`; ctx.fillStyle = colour[l.role];
    ctx.fillText(l.s, cx, y0 + l.y * scale, maxW);
  }
  ctx.restore();
  return cv;
}
