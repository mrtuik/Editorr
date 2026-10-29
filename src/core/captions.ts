/**
 * Captions: data model, six looks, page building (what is on screen at one time) and the drawing code.
 * The same maths is drawn again by the native export (EditorrNativePlugin.drawCaption), so preview and video match.
 */
import { needsRoman, romanize } from './romanize';

export interface CapWord { w: string; orig: string; s: number; e: number }
export interface CaptionData { lang: string; words: CapWord[] }

export type CapLook = 'classic' | 'bold' | 'karaoke' | 'box' | 'minimal' | 'pop' | 'blink';
export interface CaptionStyle {
  look: CapLook;
  /** text height as a fraction of the video height */
  size: number;
  /** vertical centre, 0 top .. 1 bottom */
  y: number;
  wordsPerLine: number;
  upper: boolean;
  color: string;
  highlight: string;
  /** show Banglish / Hinglish (true) or the original script */
  roman: boolean;
}
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { look: 'karaoke', size: 0.055, y: 0.78, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#FFD60A', roman: true };

export interface LookDef {
  id: CapLook; name: string;
  weight: number; stroke: number; strokeColor: string; shadow: boolean;
  box: string | null; activeColor: boolean; activeScale: number;
}
export const LOOKS: LookDef[] = [
  { id: 'classic', name: 'Classic', weight: 700, stroke: 0.14, strokeColor: '#000000', shadow: false, box: null, activeColor: false, activeScale: 1 },
  { id: 'bold', name: 'Bold', weight: 900, stroke: 0.2, strokeColor: '#000000', shadow: true, box: null, activeColor: false, activeScale: 1 },
  { id: 'karaoke', name: 'Karaoke', weight: 800, stroke: 0.16, strokeColor: '#000000', shadow: false, box: null, activeColor: true, activeScale: 1 },
  { id: 'box', name: 'Box', weight: 700, stroke: 0, strokeColor: '#000000', shadow: false, box: 'rgba(0,0,0,0.72)', activeColor: false, activeScale: 1 },
  { id: 'minimal', name: 'Minimal', weight: 500, stroke: 0, strokeColor: '#000000', shadow: true, box: null, activeColor: false, activeScale: 1 },
  { id: 'pop', name: 'Pop', weight: 900, stroke: 0.18, strokeColor: '#000000', shadow: false, box: null, activeColor: true, activeScale: 1.18 },
  // Blink: chunky neon pop — the word being spoken bounces 1.0 -> 1.25 -> 1.0 and lights up in the highlight colour.
  { id: 'blink', name: 'Blink', weight: 900, stroke: 0.2, strokeColor: '#000000', shadow: true, box: null, activeColor: true, activeScale: 1.25 },
];
/** How long the spoken word's pop-in bounce lasts (preview and export use the same number). */
export const BOUNCE_MS = 220;
export const lookOf = (id: CapLook) => LOOKS.find((l) => l.id === id) ?? LOOKS[0];

export interface CapPage { s: number; e: number; from: number; to: number; words: { t: string; s: number; e: number }[] }

/** Words -> pages of `wordsPerLine` words. A long pause or the end of a sentence also starts a new page. */
export function buildPages(c: CaptionData | undefined, st: CaptionStyle): CapPage[] {
  if (!c || !c.words.length) return [];
  const pages: CapPage[] = [];
  let cur: CapPage | null = null;
  for (let iw = 0; iw < c.words.length; iw++) {
    const w = c.words[iw];
    let t = st.roman && needsRoman(w.orig) ? romanize(w.orig) : (st.roman ? w.w : w.orig || w.w);
    if (st.upper) t = t.toUpperCase();
    const gap = cur ? w.s - cur.words[cur.words.length - 1].e : 0;
    const prev = cur ? cur.words[cur.words.length - 1].t : '';
    if (!cur || cur.words.length >= st.wordsPerLine || gap > 800 || /[.!?।]$/.test(prev)) {
      cur = { s: w.s, e: w.e, from: iw, to: iw, words: [] };
      pages.push(cur);
    }
    cur.words.push({ t, s: w.s, e: w.e });
    cur.e = w.e; cur.to = iw;
  }
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    pages[i].e = Math.min(pages[i].e + 250, next ? next.s : Infinity);
  }
  return pages;
}

export function pageAt(pages: CapPage[], ms: number): CapPage | undefined {
  let lo = 0, hi = pages.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ms < pages[m].s) hi = m - 1; else if (ms >= pages[m].e) lo = m + 1; else return pages[m];
  }
  return undefined;
}

/** Draw one page. `active` is the index of the word being spoken (-1 = none). */
export function drawCaption(g: CanvasRenderingContext2D, w: number, h: number, page: CapPage, ms: number, st: CaptionStyle): void {
  const look = lookOf(st.look);
  const fs = Math.max(8, st.size * h);
  let active = -1;
  for (let i = 0; i < page.words.length; i++) if (ms >= page.words[i].s) active = i;
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  const font = (scale: number) => `${look.weight} ${Math.round(fs * scale)}px Roboto, "Noto Sans", Arial, sans-serif`;
  const gapW = fs * 0.28;
  const widths = page.words.map((x, i) => { g.font = font(i === active ? look.activeScale : 1); return g.measureText(x.t).width; });
  let total = widths.reduce((a, b) => a + b, 0) + gapW * (page.words.length - 1);
  const maxW = w * 0.9;
  let k = 1;
  if (total > maxW) k = maxW / total;
  total *= k;
  const cy = st.y * h;
  let x = (w - total) / 2;
  if (look.box) {
    g.fillStyle = look.box;
    const padX = fs * 0.45, padY = fs * 0.3, r = fs * 0.3;
    const bx = x - padX, by = cy - fs * 0.62 - padY, bw = total + padX * 2, bh = fs * 1.24 + padY * 2;
    g.beginPath();
    g.moveTo(bx + r, by); g.arcTo(bx + bw, by, bx + bw, by + bh, r); g.arcTo(bx + bw, by + bh, bx, by + bh, r);
    g.arcTo(bx, by + bh, bx, by, r); g.arcTo(bx, by, bx + bw, by, r); g.closePath(); g.fill();
  }
  for (let i = 0; i < page.words.length; i++) {
    const on = i === active;
    // Word pop / bounce: the spoken word grows 1.0 -> activeScale -> 1.0 over BOUNCE_MS, then settles.
    // Neighbours keep the peak width, so the layout does not reflow while the word bounces.
    let sc = (on ? look.activeScale : 1);
    let popAt = 0;
    if (on && look.activeScale > 1) {
      const t = Math.min(1, Math.max(0, (ms - page.words[i].s) / BOUNCE_MS));
      sc = 1 + (look.activeScale - 1) * Math.sin(Math.PI * t);
      popAt = (widths[i] * k * (1 - sc / look.activeScale)) / 2;
    }
    g.font = font(sc * k);
    const tw = widths[i] * k;
    const base = cy + fs * 0.34;
    if (look.shadow) { g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = fs * 0.25; g.shadowOffsetY = fs * 0.06; }
    if (look.stroke > 0) { g.shadowColor = 'transparent'; g.lineWidth = fs * look.stroke; g.strokeStyle = look.strokeColor; g.strokeText(page.words[i].t, x + popAt, base); }
    if (look.shadow) { g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = fs * 0.25; g.shadowOffsetY = fs * 0.06; }
    g.fillStyle = look.activeColor && on ? st.highlight : st.color;
    g.fillText(page.words[i].t, x + popAt, base);
    g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
    x += tw + gapW * k;
  }
}

/** What the native export needs: pages with their words and the style numbers. */
export function exportCaptions(c: CaptionData | undefined, st: CaptionStyle | undefined) {
  if (!c || !st) return undefined;
  const pages = buildPages(c, st);
  if (!pages.length) return undefined;
  const look = lookOf(st.look);
  return {
    pages: pages.map((p) => ({ s: Math.round(p.s), e: Math.round(p.e), words: p.words.map((x) => ({ t: x.t, s: Math.round(x.s), e: Math.round(x.e) })) })),
    style: {
      size: st.size, y: st.y, color: st.color, highlight: st.highlight,
      weight: look.weight, stroke: look.stroke, strokeColor: look.strokeColor, shadow: look.shadow,
      box: look.box ?? '', activeColor: look.activeColor, activeScale: look.activeScale,
      bounceMs: look.activeScale > 1 ? BOUNCE_MS : 0,
    },
  };
}

// ---------------------------------------------------------------------- free text (Text > Add text)

export type TextLook = 'classic' | 'bold' | 'box' | 'minimal';
export const TEXT_LOOKS: TextLook[] = ['classic', 'bold', 'box', 'minimal'];
/** A piece of text you type and place on the video. Same look engine as captions (preview and export match). */
export interface TextItem { id: string; text: string; s: number; e: number; look: TextLook; size: number; y: number; color: string; opacity?: number }

/** #RRGGBB + 0..1 opacity -> css colour the preview canvas and the native export both understand. */
export function withOpacity(hex: string, a: number | undefined): string {
  if (a === undefined || a >= 1 || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${Math.max(0, a).toFixed(2)})`;
}

export function textStyleOf(t: TextItem): CaptionStyle {
  return { ...DEFAULT_CAPTION_STYLE, look: t.look, size: t.size, y: t.y, color: withOpacity(t.color, t.opacity), wordsPerLine: 99, upper: false, roman: false };
}
export function textPage(t: TextItem): CapPage {
  const words = t.text.trim().split(/\s+/).filter(Boolean).map((w) => ({ t: w, s: t.s, e: t.e }));
  return { s: t.s, e: t.e, from: 0, to: 0, words };
}
/** One caption-shaped block per text, so the native export draws each with its own look. */
export function exportTexts(items: TextItem[] | undefined) {
  const out: unknown[] = [];
  for (const it of items ?? []) {
    const pg = textPage(it);
    if (!pg.words.length || it.e <= it.s) continue;
    const look = lookOf(it.look);
    out.push({
      pages: [{ s: Math.round(it.s), e: Math.round(it.e), words: pg.words.map((x) => ({ t: x.t, s: Math.round(x.s), e: Math.round(x.e) })) }],
      style: {
        size: it.size, y: it.y, color: withOpacity(it.color, it.opacity), highlight: it.color,
        weight: look.weight, stroke: look.stroke, strokeColor: look.strokeColor, shadow: look.shadow,
        box: look.box ?? '', activeColor: false, activeScale: 1,
      },
    });
  }
  return out.length ? out : undefined;
}
