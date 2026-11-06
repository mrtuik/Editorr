/**
 * Captions: data model, six looks, page building (what is on screen at one time) and the drawing code.
 * The same maths is drawn again by the native export (EditorrNativePlugin.drawCaption), so preview and video match.
 */
import { needsRoman, romanize } from './romanize';

export interface CapWord { w: string; orig: string; s: number; e: number; /** own style of this word (tap a word in Captions) */ fx?: Fx }
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
  /** font, stroke, glow, shadow, background for ALL words (a word can add its own on top) */
  fx?: Fx;
}
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { look: 'karaoke', size: 0.055, y: 0.78, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#FFD60A', roman: true };

// ---------------------------------------------------------------------- per-word / per-text effects (Fx)
export type FontId = 'sans' | 'condensed' | 'serif' | 'mono' | 'casual' | 'script';
export const FONTS: { id: FontId; name: string; css: string }[] = [
  { id: 'sans', name: 'Clean', css: 'Roboto, "Noto Sans", Arial, sans-serif' },
  { id: 'condensed', name: 'Condensed', css: '"sans-serif-condensed", "Roboto Condensed", sans-serif' },
  { id: 'serif', name: 'Serif', css: 'serif' },
  { id: 'mono', name: 'Mono', css: 'monospace' },
  { id: 'casual', name: 'Casual', css: 'casual, cursive' },
  { id: 'script', name: 'Script', css: 'cursive' },
];
export const fontCss = (id: FontId | undefined) => (FONTS.find((f) => f.id === id) ?? FONTS[0]).css;

/**
 * Everything you can change on a text or on one caption word. A field left out = "use the look".
 * null = switched off on purpose (for example no stroke even though the look has one).
 */
export interface Fx {
  color?: string;
  font?: FontId;
  italic?: boolean;
  /** size multiplier of this word, 1 = as the line */
  scale?: number;
  /** stroke width as a fraction of the font size */
  stroke?: { c: string; w: number } | null;
  /** soft light around the letters; b = blur as a fraction of the font size */
  glow?: { c: string; b: number } | null;
  /** drop shadow; b blur, d distance (fractions of the font size), a angle in degrees (90 = down) */
  shadow?: { c: string; b: number; d: number; a: number } | null;
  /** rounded box behind the text; o opacity 0..1, r corner radius (fraction of the font size) */
  bg?: { c: string; o: number; r: number } | null;
}
export type TextAnim = 'none' | 'fade' | 'pop' | 'rise';
export const ANIM_IN_MS = 300;
export const ANIM_OUT_MS = 250;

/** Concrete numbers for one word after look + text style + word style are merged. */
export interface RFx {
  color: string; font: FontId; italic: boolean; scale: number;
  stroke: { c: string; w: number } | null;
  glow: { c: string; b: number } | null;
  shadow: { c: string; b: number; dx: number; dy: number } | null;
  bg: { c: string; r: number } | null;
}
export function hexA(hex: string, a: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(2)})`;
}
/** Look defaults -> block Fx (a text's own style) -> word Fx (one caption word). Preview and export both use this. */
export function resolveFx(look: LookDef, color: string, ...layers: (Fx | undefined)[]): RFx {
  let stroke: RFx['stroke'] = look.stroke > 0 ? { c: look.strokeColor, w: look.stroke } : null;
  let shadow: RFx['shadow'] = look.shadow ? { c: 'rgba(0,0,0,0.75)', b: 0.25, dx: 0, dy: 0.06 } : null;
  let glow: RFx['glow'] = null;
  let bg: RFx['bg'] = null;
  let font: FontId = 'sans', italic = false, scale = 1, col = color;
  for (const f of layers) {
    if (!f) continue;
    if (f.color) col = f.color;
    if (f.font) font = f.font;
    if (f.italic !== undefined) italic = f.italic;
    if (f.scale) scale *= f.scale;
    if (f.stroke !== undefined) stroke = f.stroke && f.stroke.w > 0 ? { c: f.stroke.c, w: f.stroke.w } : null;
    if (f.glow !== undefined) glow = f.glow && f.glow.b > 0 ? { c: f.glow.c, b: f.glow.b } : null;
    if (f.shadow !== undefined) {
      const sh = f.shadow;
      if (!sh) shadow = null;
      else { const r = (sh.a * Math.PI) / 180; shadow = { c: sh.c, b: sh.b, dx: Math.cos(r) * sh.d, dy: Math.sin(r) * sh.d }; }
    }
    if (f.bg !== undefined) bg = f.bg ? { c: hexA(f.bg.c, f.bg.o), r: f.bg.r } : null;
  }
  return { color: col, font, italic, scale, stroke, glow, shadow, bg };
}
/** The same numbers, as the native export reads them. */
export function fxForExport(r: RFx) {
  return {
    color: r.color, font: r.font, italic: r.italic, scale: r.scale,
    strokeW: r.stroke?.w ?? 0, strokeColor: r.stroke?.c ?? '#000000',
    glowB: r.glow?.b ?? 0, glowColor: r.glow?.c ?? '#FFFFFF',
    shadowOn: !!r.shadow, shadowB: r.shadow?.b ?? 0, shadowDx: r.shadow?.dx ?? 0, shadowDy: r.shadow?.dy ?? 0, shadowColor: r.shadow?.c ?? 'rgba(0,0,0,0.75)',
    wordBg: r.bg?.c ?? '', wordBgR: r.bg?.r ?? 0.3,
  };
}
export const fxIsEmpty = (f: Fx | undefined) => !f || Object.keys(f).length === 0;

/** What a tap on the preview can hit: the box of a drawn text or caption word, in canvas pixels. */
export interface HitRect { x: number; y: number; w: number; h: number; word: number }

/** Animation of a text at `ms`: opacity, size and a vertical offset (fraction of the font size). */
export function animAt(anim: TextAnim | undefined, ms: number, s: number, e: number): { a: number; k: number; dy: number } {
  if (!anim || anim === 'none') return { a: 1, k: 1, dy: 0 };
  const t = Math.max(0, Math.min(1, (ms - s) / ANIM_IN_MS));
  const easeOut = 1 - Math.pow(1 - t, 3);
  const back = 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
  let a = 1, k = 1, dy = 0;
  if (anim === 'fade') { a = easeOut; a *= Math.max(0, Math.min(1, (e - ms) / ANIM_OUT_MS)); }
  else if (anim === 'pop') { k = 0.55 + 0.45 * back; a = Math.min(1, t * 3); }
  else if (anim === 'rise') { dy = (1 - easeOut) * 0.9; a = easeOut; }
  return { a, k, dy };
}

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

export interface CapPage { s: number; e: number; from: number; to: number; words: { t: string; s: number; e: number; fx?: Fx }[] }

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
    cur.words.push({ t, s: w.s, e: w.e, ...(w.fx ? { fx: w.fx } : {}) });
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

export interface DrawOpts {
  /** style of the whole block (a Text item); captions leave it out */
  fx?: Fx;
  /** horizontal centre 0..1 (default 0.5) */
  x?: number;
  anim?: TextAnim;
  /** filled with the box of every drawn word (canvas pixels), so a tap on the video can find it */
  hits?: HitRect[];
  /** preview only: dashed frame around this word */
  selected?: number;
  /** preview only: dashed frame around the whole block */
  outline?: boolean;
}

/**
 * Draw one page. A line that is wider than 90% of the video wraps to the next line.
 * EditorrNativePlugin.CaptionOverlay.drawPage repeats exactly this, so preview and export match.
 */
export function drawCaption(g: CanvasRenderingContext2D, w: number, h: number, page: CapPage, ms: number, st: CaptionStyle, o: DrawOpts = {}): void {
  const look = lookOf(st.look);
  const fs = Math.max(8, st.size * h);
  let active = -1;
  for (let i = 0; i < page.words.length; i++) if (ms >= page.words[i].s) active = i;
  const an = animAt(o.anim, ms, page.s, page.e);
  if (an.a <= 0.001) return;
  const R = page.words.map((x) => resolveFx(look, st.color, o.fx, x.fx));
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  const font = (r: RFx, size: number) => `${r.italic ? 'italic ' : ''}${look.weight} ${size.toFixed(1)}px ${fontCss(r.font)}`;
  const gapW = fs * 0.28;
  const wd = page.words.map((x, i) => { g.font = font(R[i], fs * R[i].scale * (i === active ? look.activeScale : 1)); return g.measureText(x.t).width; });
  const maxW = w * 0.9;
  const lines: number[][] = [];
  let cur: number[] = [], curW = 0;
  for (let i = 0; i < wd.length; i++) {
    const add = (cur.length ? gapW : 0) + wd[i];
    if (cur.length && curW + add > maxW) { lines.push(cur); cur = [i]; curW = wd[i]; } else { cur.push(i); curW += add; }
  }
  if (cur.length) lines.push(cur);
  const n = lines.length;
  const pitch = fs * 1.2;
  const cx = Math.max(0, Math.min(1, o.x ?? 0.5)) * w;
  const cy = st.y * h;
  // geometry of every line first (the box behind the text needs all of them)
  const lk: number[] = [], lx: number[] = [], lw: number[] = [];
  for (const ln of lines) {
    const raw = ln.reduce((a, i) => a + wd[i], 0) + gapW * (ln.length - 1);
    const k = raw > maxW ? maxW / raw : 1;
    const wl = raw * k;
    lk.push(k); lw.push(wl);
    lx.push(Math.max(w * 0.02, Math.min(w - wl - w * 0.02, cx - wl / 2)));
  }
  const top = cy - ((n - 1) * pitch) / 2 - fs * 0.62;
  const boxH = (n - 1) * pitch + fs * 1.24;
  const minX = Math.min(...lx), maxX = Math.max(...lx.map((v, i) => v + lw[i]));
  const roundRect = (x: number, y: number, bw: number, bh: number, r: number) => {
    r = Math.min(r, bw / 2, bh / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + bw, y, x + bw, y + bh, r); g.arcTo(x + bw, y + bh, x, y + bh, r);
    g.arcTo(x, y + bh, x, y, r); g.arcTo(x, y, x + bw, y, r); g.closePath();
  };
  g.save();
  if (an.a < 1) g.globalAlpha = an.a;
  if (an.k !== 1 || an.dy) { g.translate(cx, cy); g.scale(an.k, an.k); g.translate(-cx, -cy + an.dy * fs); }
  // box behind the whole text: the look's box, or the Background the person picked (null = switched off)
  const bgFx = o.fx?.bg;
  const boxColor = bgFx !== undefined ? (bgFx ? hexA(bgFx.c, bgFx.o) : null) : look.box;
  if (boxColor) {
    const padX = fs * 0.45, padY = fs * 0.3;
    g.fillStyle = boxColor;
    roundRect(minX - padX, top - padY, maxX - minX + padX * 2, boxH + padY * 2, fs * (bgFx ? bgFx.r : 0.3));
    g.fill();
  }
  for (let L = 0; L < n; L++) {
    const ln = lines[L], k = lk[L];
    const lineCy = cy + (L - (n - 1) / 2) * pitch;
    const base = lineCy + fs * 0.34;
    let x = lx[L];
    for (const i of ln) {
      const wdd = page.words[i], r = R[i];
      const on = i === active;
      // Word pop / bounce: the spoken word grows 1.0 -> activeScale -> 1.0 over BOUNCE_MS, then settles.
      // Neighbours keep the peak width, so the layout does not reflow while the word bounces.
      let sc = on ? look.activeScale : 1;
      let popAt = 0;
      if (on && look.activeScale > 1) {
        const t = Math.min(1, Math.max(0, (ms - wdd.s) / BOUNCE_MS));
        sc = 1 + (look.activeScale - 1) * Math.sin(Math.PI * t);
        popAt = (wd[i] * k * (1 - sc / look.activeScale)) / 2;
      }
      const tw = wd[i] * k;
      const px = x + popAt;
      if (wdd.fx?.bg) {
        g.fillStyle = hexA(wdd.fx.bg.c, wdd.fx.bg.o);
        roundRect(x - fs * 0.18, lineCy - fs * 0.7, tw + fs * 0.36, fs * 1.4, fs * wdd.fx.bg.r);
        g.fill();
      }
      g.font = font(r, fs * r.scale * sc * k);
      const col = look.activeColor && on && !wdd.fx?.color ? st.highlight : r.color;
      if (r.glow) {
        g.shadowColor = r.glow.c; g.shadowBlur = fs * r.glow.b; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
        g.fillStyle = col;
        g.fillText(wdd.t, px, base); g.fillText(wdd.t, px, base);
      }
      g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
      if (r.stroke) { g.lineWidth = fs * r.stroke.w; g.strokeStyle = r.stroke.c; g.strokeText(wdd.t, px, base); }
      if (r.shadow) { g.shadowColor = r.shadow.c; g.shadowBlur = fs * r.shadow.b; g.shadowOffsetX = fs * r.shadow.dx; g.shadowOffsetY = fs * r.shadow.dy; }
      g.fillStyle = col;
      g.fillText(wdd.t, px, base);
      g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
      o.hits?.push({ x: x - fs * 0.1, y: lineCy - fs * 0.7, w: tw + fs * 0.2, h: fs * 1.4, word: i });
      if (o.selected === i) {
        g.save(); g.setLineDash([fs * 0.14, fs * 0.1]); g.lineWidth = Math.max(2, fs * 0.04); g.strokeStyle = '#19C3D8';
        roundRect(x - fs * 0.12, lineCy - fs * 0.72, tw + fs * 0.24, fs * 1.44, fs * 0.16); g.stroke(); g.restore();
      }
      x += tw + gapW * k;
    }
  }
  if (o.outline) {
    g.save(); g.setLineDash([fs * 0.16, fs * 0.1]); g.lineWidth = Math.max(2, fs * 0.04); g.strokeStyle = '#19C3D8';
    roundRect(minX - fs * 0.3, top - fs * 0.16, maxX - minX + fs * 0.6, boxH + fs * 0.32, fs * 0.2); g.stroke(); g.restore();
  }
  g.restore();
}

/** What the native export needs: pages with their words and the style numbers. */
export function exportCaptions(c: CaptionData | undefined, st: CaptionStyle | undefined) {
  if (!c || !st) return undefined;
  const pages = buildPages(c, st);
  if (!pages.length) return undefined;
  const look = lookOf(st.look);
  return {
    pages: pages.map((p) => ({ s: Math.round(p.s), e: Math.round(p.e), words: p.words.map((x) => wordOut(look, st.color, st.fx, x)) })),
    style: {
      size: st.size, y: st.y, highlight: st.highlight,
      weight: look.weight, box: st.fx?.bg !== undefined ? (st.fx.bg ? hexA(st.fx.bg.c, st.fx.bg.o) : '') : (look.box ?? ''), boxR: st.fx?.bg?.r ?? 0.3,
      activeColor: look.activeColor, activeScale: look.activeScale,
      bounceMs: look.activeScale > 1 ? BOUNCE_MS : 0,
      ...baseOut(look, st.color, st.fx),
    },
  };
}
function baseOut(look: LookDef, color: string, fx: Fx | undefined) {
  const f = fxForExport(resolveFx(look, color, fx));
  // the block's Background is the box behind the whole text (style.box); only a word's own Background is drawn per word
  return { ...f, wordBg: '', stroke: f.strokeW, shadow: f.shadowOn };
}
function wordOut(look: LookDef, color: string, block: Fx | undefined, x: { t: string; s: number; e: number; fx?: Fx }) {
  const out: Record<string, unknown> = { t: x.t, s: Math.round(x.s), e: Math.round(x.e) };
  if (!fxIsEmpty(x.fx)) {
    out.fx = { ...fxForExport(resolveFx(look, color, block, x.fx)), ownColor: !!x.fx?.color, wordBg: x.fx?.bg ? hexA(x.fx.bg.c, x.fx.bg.o) : '', wordBgR: x.fx?.bg?.r ?? 0.3 };
  }
  return out;
}

// ---------------------------------------------------------------------- free text (Text > Add text)

export type TextLook = 'classic' | 'bold' | 'box' | 'minimal';
export const TEXT_LOOKS: TextLook[] = ['classic', 'bold', 'box', 'minimal'];
/** A piece of text you type and place on the video. Same look engine as captions (preview and export match). */
export interface TextItem {
  id: string; text: string; s: number; e: number; look: TextLook; size: number;
  /** vertical centre 0..1 */
  y: number;
  /** horizontal centre 0..1 (default 0.5) */
  x?: number;
  color: string; opacity?: number;
  /** stroke, glow, shadow, background, font, italic on top of the look */
  fx?: Fx;
  anim?: TextAnim;
}

/** #RRGGBB + 0..1 opacity -> css colour the preview canvas and the native export both understand. */
export function withOpacity(hex: string, a: number | undefined): string {
  if (a === undefined || a >= 1 || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return hexA(hex, a);
}

export function textStyleOf(t: TextItem): CaptionStyle {
  return { ...DEFAULT_CAPTION_STYLE, look: t.look, size: t.size, y: t.y, color: withOpacity(t.color, t.opacity), wordsPerLine: 99, upper: false, roman: false };
}
export function textPage(t: TextItem): CapPage {
  const words = t.text.trim().split(/\s+/).filter(Boolean).map((w) => ({ t: w, s: t.s, e: t.e }));
  return { s: t.s, e: t.e, from: 0, to: 0, words };
}
export const textDrawOpts = (t: TextItem): DrawOpts => ({ fx: t.fx, x: t.x, anim: t.anim });

/** One caption-shaped block per text, so the native export draws each with its own look. */
export function exportTexts(items: TextItem[] | undefined) {
  const out: unknown[] = [];
  for (const it of items ?? []) {
    const pg = textPage(it);
    if (!pg.words.length || it.e <= it.s) continue;
    const look = lookOf(it.look);
    const col = withOpacity(it.color, it.opacity);
    const bg = it.fx?.bg;
    out.push({
      pages: [{ s: Math.round(it.s), e: Math.round(it.e), words: pg.words.map((x) => wordOut(look, col, it.fx, x)) }],
      style: {
        size: it.size, y: it.y, x: it.x ?? 0.5, highlight: it.color,
        weight: look.weight, box: bg !== undefined ? (bg ? hexA(bg.c, bg.o) : '') : (look.box ?? ''), boxR: bg ? bg.r : 0.3,
        activeColor: false, activeScale: 1, anim: it.anim ?? 'none',
        ...baseOut(look, col, it.fx),
      },
    });
  }
  return out.length ? out : undefined;
}
