/**
 * HTML string -> SVG foreignObject -> Image -> canvas. Deterministic: renderFrame(visual, tMs) always gives the same picture,
 * so the preview and the export draw identical frames.
 */
import { drawFallback } from './fallback2d';
import { visualFontCssNow } from './fonts';
import { innerProgress, motionCss, visualMotionAt, getPreset } from './motion';
import { isTextAnim, textEndMs } from './textAnim';
import { cardBox, esc } from './templates/util';
import { templateHtml } from './templates';
import { getTheme } from './themes';
import type { Visual, VisualTheme } from './types';

/** Thin progress line along the bottom of the card (paper-red look): a pure function of the time since the scene started. */
const progressLine = (theme: VisualTheme, tMs: number, dur: number, pad: number, short: number) => {
  if (!theme.progressLine) return '';
  const k = Math.max(0, Math.min(1, tMs / dur)), th = Math.max(3, Math.round(short * 0.006)), inset = Math.round(pad * 0.45);
  return `<div style="position:absolute;left:${inset}px;right:${inset}px;bottom:${inset}px;height:${th}px;border-radius:99px;background:${theme.progressLine}33;"><div style="width:${(k * 100).toFixed(2)}%;height:100%;border-radius:99px;background:${theme.progressLine};"></div></div>`;
};

/** The card with its motion applied, as XHTML (foreignObject needs well-formed markup). */
export function visualHtml(v: Visual, tMs: number, w: number, h: number): string {
  const theme: VisualTheme = getTheme(v.themeId), dur = Math.max(300, v.endMs - v.startMs);
  const mp = visualMotionAt(v.motion, tMs, dur), p = innerProgress(v.motion, tMs);
  const box = cardBox(w, h, v.full), short = Math.min(w, h), pad = Math.round(short * 0.06);
  const inner = templateHtml(v.type, v.data, theme, w, h, p, tMs, v.motion.text ?? 'kinetic', v.full);
  return `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${w}px;height:${h}px;overflow:hidden;font-family:${theme.font};">` +
    `<style>${visualFontCssNow()}</style>` +
    (v.bleed ? `<div style="position:absolute;left:0;top:0;width:${w}px;height:${h}px;background:${theme.card};opacity:${Math.max(0, Math.min(1, mp.o)).toFixed(3)};"></div>` : '') +
    `<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;box-sizing:border-box;padding:${pad}px;` +
    (v.bleed ? `color:${theme.text};` : `background:${theme.card};color:${theme.text};border-radius:${Math.round(theme.radius * short / 1080)}px;box-shadow:${theme.shadow};border:${theme.border};`) +
    `${motionCss(mp, short)}">${inner}${progressLine(theme, tMs, dur, pad, short)}</div></div>`;
}

export const svgOf = (html: string, w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${html}</foreignObject></svg>`;

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const cache = new Map<string, HTMLCanvasElement>();
const CACHE_MAX = 48;

export const frameKey = (v: Visual, tMs: number, w: number, h: number) =>
  hash(JSON.stringify([v.type, v.data, v.themeId, v.motion, Math.round(v.endMs - v.startMs), Math.round(tMs / 8), w, h, !!v.full, !!v.bleed, visualFontCssNow().length > 0]));

/** HTML -> foreignObject picture -> canvas. If the picture fails to load or the canvas is tainted (a WebView that blocks it), Canvas 2D draws the card instead. */
async function drawHtml(v: Visual, tMs: number, w: number, h: number): Promise<HTMLCanvasElement> {
  if (!htmlBroken) {
    try {
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgOf(visualHtml(v, tMs, w, h), w, h));
      const img = new Image(); img.decoding = 'async'; img.src = url;
      await img.decode();
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
      if (canvasReadable(cv)) { htmlFails = 0; return cv; }
      htmlBroken = true; // tainted: this WebView will never give a readable picture, so stop trying
    } catch { if (++htmlFails >= 2) htmlBroken = true; /* one bad frame alone does not switch the whole session */ }
  }
  return drawFallback(v, tMs, w, h);
}
/** True once this WebView could not use the foreignObject path; every frame is then drawn with Canvas 2D. */
let htmlBroken = false, htmlFails = 0;
export const usingCanvasFallback = () => htmlBroken;

export async function renderFrame(v: Visual, tMs: number, w: number, h: number): Promise<HTMLCanvasElement> {
  const key = frameKey(v, tMs, w, h), hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const cv = await drawHtml(v, tMs, w, h);
  cache.set(key, cv); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return cv;
}

/** True when the canvas can be read back. If a WebView taints foreignObject pictures this is false: draw with Canvas 2D instead. */
export function canvasReadable(cv: HTMLCanvasElement): boolean {
  try { cv.getContext('2d')!.getImageData(0, 0, 1, 1); return true; } catch { return false; }
}

export interface BakedVisual { frames: HTMLCanvasElement[]; framesMs: number[]; still: HTMLCanvasElement }

/** Time the picture needs to settle: the card entrance, the text animation and the charts (open-motion's longest piece is 1.2 s). */
export function settleMs(v: Visual): number {
  const d = v.data, text = d.quote ?? d.title ?? d.big ?? d.term ?? d.text ?? d.label ?? '';
  const t = isTextAnim(v.motion.text) ? textEndMs(v.motion.text, text) : 0;
  return Math.round(Math.max(getPreset(v.motion.in).durationMs + 450, Math.min(2200, t + 150), ['title_stack', 'pill_row', 'flow_diagram', 'cta_card', 'window_card', 'radial_burst', 'bracket_focus'].includes(v.type) ? 2000 : v.type === 'highlight_card' ? 1900 : ['bar_chart', 'stat_counter', 'progress_ring', 'line_chart', 'stack_card', 'frame_card'].includes(v.type) ? 1500 : 0));
}

/** Entrance frames (about one per 55 ms, 18 to 30) plus one still for the hold. framesMs are relative to the visual's start. */
export async function bakeVisual(v: Visual, w: number, h: number): Promise<BakedVisual> {
  const inMs = settleMs(v), n = Math.max(18, Math.min(30, Math.round(inMs / 55))), frames: HTMLCanvasElement[] = [], framesMs: number[] = [];
  for (let i = 0; i < n; i++) { const t = Math.round((i / (n - 1)) * inMs); framesMs.push(t); frames.push(await renderFrame(v, t, w, h)); }
  return { frames, framesMs, still: await renderFrame(v, inMs + 200, w, h) };
}

export const visualTitle = (v: Visual) => esc(v.data.title ?? v.data.big ?? v.data.term ?? v.data.quote ?? v.data.left ?? v.data.text ?? v.type);
