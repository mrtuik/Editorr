/**
 * Draws one documentary beat on a transparent canvas laid over the video (preview) .
 * EditorrNativePlugin.DocuOverlay repeats the same geometry for the export, so preview and video match.
 *
 * Split beats: the whole frame is covered by the dark card colour and a rounded WINDOW is cut out where the talking head
 * shows through. The video underneath is shifted by `docuShift()` so the window shows the middle of the picture.
 */
import { Capacitor } from '@capacitor/core';
import { CARD_SHARE_SIDE, CARD_SHARE_UPDOWN, DOCU_FADE_MS, DEFAULT_CARD_RADIUS, DOCU_FONT_CSS, DOCU_FONT_WEIGHT, type DocuBeat, type DocuLayout, type DocuPos } from './docuTypes';

export interface Rect { x: number; y: number; w: number; h: number }
export interface DocuGeo { vertical: boolean; video: Rect; card: Rect }

/** Margin around the window and the card, fraction of the short side. */
const GAP = 0.018;

/** Where the video window and the typography card sit, as fractions (0..1) of the frame. */
export function docuGeometry(layout: DocuLayout, pos: DocuPos, w: number, h: number, share?: number): DocuGeo {
  const vertical = layout === 'updown';
  const g = GAP * Math.min(w, h);
  if (!vertical) {
    const cw = w * (share ?? CARD_SHARE_SIDE);
    const videoLeft = pos !== 'right';
    const video: Rect = videoLeft ? { x: g, y: g, w: w - cw - g * 1.5, h: h - 2 * g } : { x: cw + g * 0.5, y: g, w: w - cw - g * 1.5, h: h - 2 * g };
    const card: Rect = videoLeft ? { x: w - cw + g * 0.5, y: g, w: cw - g * 1.5, h: h - 2 * g } : { x: g, y: g, w: cw - g * 1.5, h: h - 2 * g };
    return { vertical, video, card };
  }
  const ch = h * (share ?? CARD_SHARE_UPDOWN);
  const videoTop = pos !== 'bottom';
  const video: Rect = videoTop ? { x: g, y: g, w: w - 2 * g, h: h - ch - g * 1.5 } : { x: g, y: ch + g * 0.5, w: w - 2 * g, h: h - ch - g * 1.5 };
  const card: Rect = videoTop ? { x: g, y: h - ch + g * 0.5, w: w - 2 * g, h: ch - g * 1.5 } : { x: g, y: g, w: w - 2 * g, h: ch - g * 1.5 };
  return { vertical, video, card };
}

/**
 * How far the video underneath is moved so its middle sits in the window: { px, py } in frame fractions
 * (same meaning as CropState.px / py: a move in slot sizes, + = right / down). Only the frame SHAPE matters (width / height).
 */
export function docuShift(layout: DocuLayout, pos: DocuPos, ratio: number, share?: number): { px: number; py: number } {
  if (layout === 'one') return { px: 0, py: 0 };
  const w = Math.max(0.1, ratio) * 1000, h = 1000;
  const v = docuGeometry(layout, pos, w, h, share).video;
  return { px: (v.x + v.w / 2) / w - 0.5, py: (v.y + v.h / 2) / h - 0.5 };
}

/** Radius in canvas px: card_radius is given for a 1080 short side. */
export const radiusPx = (b: DocuBeat, w: number, h: number) => Math.round(((b.card_radius ?? DEFAULT_CARD_RADIUS) * Math.min(w, h)) / 1080);

/** 0..1 fade-in of the card at `ms`. */
export const docuAlpha = (b: DocuBeat, ms: number) => Math.max(0, Math.min(1, (ms - b.start) / DOCU_FADE_MS));

const FONT = 'Roboto, "Noto Sans", Arial, sans-serif';

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && g.measureText(t).width > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + k, y); g.lineTo(x + w - k, y); g.arcTo(x + w, y, x + w, y + k, k);
  g.lineTo(x + w, y + h - k); g.arcTo(x + w, y + h, x + w - k, y + h, k);
  g.lineTo(x + k, y + h); g.arcTo(x, y + h, x, y + h - k, k);
  g.lineTo(x, y + k); g.arcTo(x, y, x + k, y, k);
  g.closePath();
}

const THEME_BG = { noir: '#0A0A0C', investigative: '#10141B', modern: '#14141A' } as const;
const THEME_CARD = { noir: 'rgba(18,18,22,0.98)', investigative: 'rgba(22,28,38,0.98)', modern: 'rgba(28,28,36,0.98)' } as const;

/** Text block centred in a rect: headline (bold, wrapped, max 4 lines) and the supporting line under it. */
function drawText(g: CanvasRenderingContext2D, b: DocuBeat, r: Rect, w: number, h: number, center: boolean, alpha: number, maxHead = 4) {
  const st = b.style ?? {};
  const fam = DOCU_FONT_CSS[st.font ?? 'inter'] ?? FONT, wt = DOCU_FONT_WEIGHT[st.font ?? 'inter'] ?? 900;
  const k = Math.max(0.5, Math.min(1.6, st.textScale ?? 1));
  const short = Math.min(w, h);
  const headSize = Math.round(short * (center ? 0.085 : 0.062) * k);
  const subSize = Math.round(short * (center ? 0.034 : 0.03) * k);
  const pad = st.pad != null ? (st.pad * short) / 1080 : short * 0.04;
  const bar = Math.max(4, Math.round(short * 0.006));
  const textX = center ? r.x + r.w / 2 : r.x + pad + bar * 2.5;
  const maxW = Math.max(40, center ? r.w * 0.86 : r.w - pad * 2 - bar * 2.5);
  g.textAlign = center ? 'center' : 'left';
  g.textBaseline = 'top';
  g.font = `${wt} ${headSize}px ${fam}`;
  const headText = st.caps === false ? b.headline : b.headline.toUpperCase();
  const head = wrap(g, headText, maxW).slice(0, maxHead);
  g.font = `500 ${subSize}px ${fam}`;
  const sub = b.subtext ? wrap(g, b.subtext, maxW).slice(0, maxHead) : [];
  const headH = head.length * headSize * 1.12, subH = sub.length * subSize * 1.35;
  const gap = sub.length ? headSize * 0.45 : 0;
  const total = headH + gap + subH;
  let y = r.y + (r.h - total) / 2;
  const tc = st.text ?? '#FFFFFF';
  g.globalAlpha = alpha;
  if (!center) {
    g.fillStyle = b.accent_color;
    g.fillRect(r.x + pad, y, bar, total);
  }
  g.font = `${wt} ${headSize}px ${fam}`; g.fillStyle = tc;
  for (const ln of head) { g.fillText(ln, textX, y); y += headSize * 1.12; }
  y += gap;
  g.font = `500 ${subSize}px ${fam}`; g.fillStyle = center ? b.accent_color : (st.text ? tc : '#A7B0BE');
  if (!center && st.text) g.globalAlpha = alpha * 0.78;
  for (const ln of sub) { g.fillText(ln, textX, y); y += subSize * 1.35; }
  g.globalAlpha = 1;
}

/** Where the Breaking News slab and its red tag sit (the export uses the same numbers). */
export function lowerGeo(b: DocuBeat, w: number, h: number, measure: CanvasRenderingContext2D | null) {
  const st = b.style ?? {};
  const short = Math.min(w, h), vertical = h > w, m = short * 0.04;
  const slabH = h * (vertical ? 0.17 : 0.26), slabY = h - slabH - h * (vertical ? 0.1 : 0.07);
  const slab: Rect = { x: m, y: slabY, w: w - 2 * m, h: slabH };
  const tagH = Math.round(short * 0.05), fam = DOCU_FONT_CSS[st.font ?? 'oswald'];
  const text = (st.tag ?? 'BREAKING NEWS').toUpperCase(), fontPx = Math.round(tagH * 0.58);
  let tw = text.length * fontPx * 0.62 + tagH * 0.9;
  if (measure) { measure.save(); measure.font = `700 ${fontPx}px ${fam}`; tw = measure.measureText(text).width + tagH * 0.9; measure.restore(); }
  const tag: Rect = { x: slab.x + m * 0.6, y: slab.y - tagH * 0.62, w: tw, h: tagH };
  return { slab, tag, tagH, fontPx, text, fam };
}

/** Breaking News: a slab along the bottom with a red tag sitting on its top-left corner. */
function drawLower(g: CanvasRenderingContext2D, b: DocuBeat, w: number, h: number, a: number) {
  const st = b.style ?? {};
  const short = Math.min(w, h);
  const r = radiusPx(b, w, h);
  const L = lowerGeo(b, w, h, g);
  g.save();
  g.globalAlpha = a;
  if (st.shadow && (st.shadow.blur || st.shadow.dist)) { const sc = short / 1080; g.shadowColor = st.shadow.color; g.shadowBlur = st.shadow.blur * sc * 2; g.shadowOffsetY = st.shadow.dist * sc; }
  g.fillStyle = st.card ?? 'rgba(14,14,18,0.96)';
  rr(g, L.slab.x, L.slab.y, L.slab.w, L.slab.h, r); g.fill();
  g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
  g.fillStyle = b.accent_color; rr(g, L.tag.x, L.tag.y, L.tag.w, L.tag.h, Math.min(r, 6)); g.fill();
  g.font = `700 ${L.fontPx}px ${L.fam}`;
  g.fillStyle = '#FFFFFF'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(L.text, L.tag.x + L.tagH * 0.45, L.tag.y + L.tagH / 2 + 1);
  g.globalAlpha = 1;
  drawText(g, b, { x: L.slab.x, y: L.slab.y + L.tagH * 0.2, w: L.slab.w, h: L.slab.h - L.tagH * 0.2 }, w, h, false, a, 2);
  g.restore();
}

const frameImgs = new Map<string, { img: HTMLImageElement; ok: boolean }>();
function frameImage(src: string, onLoad?: () => void): HTMLImageElement | undefined {
  let e = frameImgs.get(src);
  if (!e) {
    const img = new Image();
    e = { img, ok: false };
    frameImgs.set(src, e);
    img.onload = () => { e!.ok = true; onLoad?.(); };
    img.src = src;
    if (frameImgs.size > 64) { const k = frameImgs.keys().next().value; if (k !== undefined && k !== src) frameImgs.delete(k); }
  }
  return e.ok ? e.img : undefined;
}

/** Draw `beat` at timeline time `ms` on a w x h canvas (clear it first). `onLoad` redraws when a Kallaway picture has just arrived. */
export function drawDocuFrame(g: CanvasRenderingContext2D, beat: DocuBeat, ms: number, w: number, h: number, onLoad?: () => void): void {
  if (beat.image) {
    // finished picture (no fade: the steps of a list follow each other without a flash).
    // The first moments of a Kallaway beat play baked motion pictures (pop, red wipe, count-up); they are all loaded ahead of time.
    const srcOf = (im: { url: string; path?: string }) => (im.path ? Capacitor.convertFileSrc('file://' + im.path) : im.url);
    const fr = beat.frames, fms = beat.framesMs ?? 0;
    let pic = beat.image;
    if (fr?.length && fms > 0) {
      for (const f of fr) frameImage(srcOf(f), onLoad);
      const into = ms - beat.start;
      if (into >= 0 && into < fms) pic = fr[Math.min(fr.length - 1, Math.floor((into / fms) * fr.length))]!;
    }
    const im = frameImage(srcOf(pic), onLoad) ?? (pic !== beat.image ? frameImage(srcOf(beat.image), onLoad) : undefined);
    if (im) g.drawImage(im, 0, 0, w, h);
    return;
  }
  const a = docuAlpha(beat, ms);
  if (a <= 0) return;
  g.save();
  if (beat.type === 'black_screen') {
    g.globalAlpha = a;
    g.fillStyle = beat.style?.bg ?? THEME_BG[beat.theme] ?? '#080808';
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    drawText(g, beat, { x: 0, y: 0, w, h }, w, h, true, a);
    g.restore();
    return;
  }
  if (beat.type === 'kinetic_quote' && beat.style?.lower) { drawLower(g, beat, w, h, a); g.restore(); return; }
  if (beat.type === 'kinetic_quote') {
    g.globalAlpha = a * 0.62;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    drawText(g, beat, { x: 0, y: 0, w, h }, w, h, true, a);
    g.restore();
    return;
  }
  // split_screen
  const geo = docuGeometry(beat.layout === 'one' ? 'side' : beat.layout, beat.video_position, w, h, beat.share);
  const r = radiusPx(beat, w, h);
  const st = beat.style ?? {}, sc = Math.min(w, h) / 1080;
  g.globalAlpha = a;
  g.fillStyle = st.bg ?? THEME_BG[beat.theme] ?? '#0A0A0C';
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-out';
  rr(g, geo.video.x, geo.video.y, geo.video.w, geo.video.h, r);
  g.fillStyle = '#000'; g.fill();
  g.globalCompositeOperation = 'source-over';
  g.save();
  if (st.shadow && (st.shadow.blur || st.shadow.dist)) { g.shadowColor = st.shadow.color; g.shadowBlur = st.shadow.blur * sc * 2; g.shadowOffsetY = st.shadow.dist * sc; }
  g.fillStyle = st.card ?? THEME_CARD[beat.theme] ?? 'rgba(18,18,22,0.98)';
  rr(g, geo.card.x, geo.card.y, geo.card.w, geo.card.h, r);
  g.fill();
  g.restore();
  if (st.border) { g.lineWidth = st.border * sc; g.strokeStyle = beat.accent_color; rr(g, geo.card.x + g.lineWidth / 2, geo.card.y + g.lineWidth / 2, geo.card.w - g.lineWidth, geo.card.h - g.lineWidth, Math.max(0, r - g.lineWidth / 2)); g.stroke(); }
  g.globalAlpha = 1;
  drawText(g, beat, geo.card, w, h, false, a);
  g.restore();
}

/** What the native export needs for one beat: the geometry is worked out here, the phone only draws it. */
export function exportDocu(beats: DocuBeat[] | undefined, outW: number, outH: number) {
  const out: unknown[] = [];
  for (const b of beats ?? []) {
    if (b.end - b.start < 300 || !b.headline.trim()) continue;
    if (b.image && !b.image.path) continue; // a Kallaway picture that only exists in the browser cannot be exported
    const geo = b.type === 'split_screen' ? docuGeometry(b.layout === 'one' ? 'side' : b.layout, b.video_position, outW, outH, b.share) : null;
    out.push({
      type: b.type, s: Math.round(b.start), e: Math.round(b.end), headline: b.headline, subtext: b.subtext ?? '', accent: b.accent_color, theme: b.theme,
      radius: radiusPx(b, outW, outH), fadeMs: b.image ? 1 : DOCU_FADE_MS,
      ...(b.image?.path ? { image: b.image.path } : {}),
      ...(b.image?.path && b.frames?.length && b.framesMs && b.frames.every((f) => f.path) ? { frames: b.frames.map((f) => f.path), framesMs: Math.round(b.framesMs) } : {}),
      ...(geo ? { video: geo.video, card: geo.card } : {}),
      ...exportStyle(b, outW, outH),
    });
  }
  return out.length ? out : undefined;
}

/** Look fields for the native export (sizes already in output pixels). Missing style = old look. */
function exportStyle(b: DocuBeat, outW: number, outH: number): Record<string, unknown> {
  const st = b.style; if (!st) return {};
  const sc = Math.min(outW, outH) / 1080;
  const o: Record<string, unknown> = { font: st.font ?? 'inter', caps: st.caps !== false, textScale: st.textScale ?? 1 };
  if (st.text) o.textColor = st.text;
  if (st.bg) o.bg = st.bg;
  if (st.card) o.cardColor = st.card;
  if (st.pad != null) o.pad = st.pad * sc;
  if (st.border) o.border = st.border * sc;
  if (st.shadow && (st.shadow.blur || st.shadow.dist)) o.shadow = { blur: st.shadow.blur * sc * 2, dist: st.shadow.dist * sc, color: st.shadow.color };
  if (st.lower && b.type === 'kinetic_quote') {
    const ctx = document.createElement('canvas').getContext('2d');
    const L = lowerGeo(b, outW, outH, ctx);
    o.lower = true; o.slab = L.slab; o.tag = { ...L.tag, text: L.text, size: L.fontPx };
  }
  return o;
}
