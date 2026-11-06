/**
 * Draws one documentary beat on a transparent canvas laid over the video (preview) .
 * EditorrNativePlugin.DocuOverlay repeats the same geometry for the export, so preview and video match.
 *
 * Split beats: the whole frame is covered by the dark card colour and a rounded WINDOW is cut out where the talking head
 * shows through. The video underneath is shifted by `docuShift()` so the window shows the middle of the picture.
 */
import { CARD_SHARE_SIDE, CARD_SHARE_UPDOWN, DOCU_FADE_MS, DEFAULT_CARD_RADIUS, type DocuBeat, type DocuLayout, type DocuPos } from './docuTypes';

export interface Rect { x: number; y: number; w: number; h: number }
export interface DocuGeo { vertical: boolean; video: Rect; card: Rect }

/** Margin around the window and the card, fraction of the short side. */
const GAP = 0.018;

/** Where the video window and the typography card sit, as fractions (0..1) of the frame. */
export function docuGeometry(layout: DocuLayout, pos: DocuPos, w: number, h: number): DocuGeo {
  const vertical = layout === 'updown';
  const g = GAP * Math.min(w, h);
  if (!vertical) {
    const cw = w * CARD_SHARE_SIDE;
    const videoLeft = pos !== 'right';
    const video: Rect = videoLeft ? { x: g, y: g, w: w - cw - g * 1.5, h: h - 2 * g } : { x: cw + g * 0.5, y: g, w: w - cw - g * 1.5, h: h - 2 * g };
    const card: Rect = videoLeft ? { x: w - cw + g * 0.5, y: g, w: cw - g * 1.5, h: h - 2 * g } : { x: g, y: g, w: cw - g * 1.5, h: h - 2 * g };
    return { vertical, video, card };
  }
  const ch = h * CARD_SHARE_UPDOWN;
  const videoTop = pos !== 'bottom';
  const video: Rect = videoTop ? { x: g, y: g, w: w - 2 * g, h: h - ch - g * 1.5 } : { x: g, y: ch + g * 0.5, w: w - 2 * g, h: h - ch - g * 1.5 };
  const card: Rect = videoTop ? { x: g, y: h - ch + g * 0.5, w: w - 2 * g, h: ch - g * 1.5 } : { x: g, y: g, w: w - 2 * g, h: ch - g * 1.5 };
  return { vertical, video, card };
}

/**
 * How far the video underneath is moved so its middle sits in the window: { px, py } in frame fractions
 * (same meaning as CropState.px / py: a move in slot sizes, + = right / down). Only the frame SHAPE matters (width / height).
 */
export function docuShift(layout: DocuLayout, pos: DocuPos, ratio: number): { px: number; py: number } {
  if (layout === 'one') return { px: 0, py: 0 };
  const w = Math.max(0.1, ratio) * 1000, h = 1000;
  const v = docuGeometry(layout, pos, w, h).video;
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
function drawText(g: CanvasRenderingContext2D, b: DocuBeat, r: Rect, w: number, h: number, center: boolean, alpha: number) {
  const short = Math.min(w, h);
  const headSize = Math.round(short * (center ? 0.085 : 0.062));
  const subSize = Math.round(short * (center ? 0.034 : 0.03));
  const pad = short * 0.04;
  const bar = Math.max(4, Math.round(short * 0.006));
  const textX = center ? r.x + r.w / 2 : r.x + pad + bar * 2.5;
  const maxW = center ? r.w * 0.86 : r.w - pad * 2 - bar * 2.5;
  g.textAlign = center ? 'center' : 'left';
  g.textBaseline = 'top';
  g.font = `900 ${headSize}px ${FONT}`;
  const head = wrap(g, b.headline.toUpperCase(), maxW).slice(0, 4);
  g.font = `500 ${subSize}px ${FONT}`;
  const sub = b.subtext ? wrap(g, b.subtext, maxW).slice(0, 4) : [];
  const headH = head.length * headSize * 1.12, subH = sub.length * subSize * 1.35;
  const gap = sub.length ? headSize * 0.45 : 0;
  const total = headH + gap + subH;
  let y = r.y + (r.h - total) / 2;
  g.globalAlpha = alpha;
  if (!center) {
    g.fillStyle = b.accent_color;
    g.fillRect(r.x + pad, y, bar, total);
  }
  g.font = `900 ${headSize}px ${FONT}`; g.fillStyle = '#FFFFFF';
  for (const ln of head) { g.fillText(ln, textX, y); y += headSize * 1.12; }
  y += gap;
  g.font = `500 ${subSize}px ${FONT}`; g.fillStyle = center ? b.accent_color : '#A7B0BE';
  for (const ln of sub) { g.fillText(ln, textX, y); y += subSize * 1.35; }
  g.globalAlpha = 1;
}

/** Draw `beat` at timeline time `ms` on a w x h canvas (clear it first). */
export function drawDocuFrame(g: CanvasRenderingContext2D, beat: DocuBeat, ms: number, w: number, h: number): void {
  const a = docuAlpha(beat, ms);
  if (a <= 0) return;
  g.save();
  if (beat.type === 'black_screen') {
    g.globalAlpha = a;
    g.fillStyle = THEME_BG[beat.theme] ?? '#080808';
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    drawText(g, beat, { x: 0, y: 0, w, h }, w, h, true, a);
    g.restore();
    return;
  }
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
  const geo = docuGeometry(beat.layout === 'one' ? 'side' : beat.layout, beat.video_position, w, h);
  const r = radiusPx(beat, w, h);
  g.globalAlpha = a;
  g.fillStyle = THEME_BG[beat.theme] ?? '#0A0A0C';
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-out';
  rr(g, geo.video.x, geo.video.y, geo.video.w, geo.video.h, r);
  g.fillStyle = '#000'; g.fill();
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = THEME_CARD[beat.theme] ?? 'rgba(18,18,22,0.98)';
  rr(g, geo.card.x, geo.card.y, geo.card.w, geo.card.h, r);
  g.fill();
  g.globalAlpha = 1;
  drawText(g, beat, geo.card, w, h, false, a);
  g.restore();
}

/** What the native export needs for one beat: the geometry is worked out here, the phone only draws it. */
export function exportDocu(beats: DocuBeat[] | undefined, outW: number, outH: number) {
  const out: unknown[] = [];
  for (const b of beats ?? []) {
    if (b.end - b.start < 300 || !b.headline.trim()) continue;
    const geo = b.type === 'split_screen' ? docuGeometry(b.layout === 'one' ? 'side' : b.layout, b.video_position, outW, outH) : null;
    out.push({
      type: b.type, s: Math.round(b.start), e: Math.round(b.end), headline: b.headline, subtext: b.subtext ?? '', accent: b.accent_color, theme: b.theme,
      radius: radiusPx(b, outW, outH), fadeMs: DOCU_FADE_MS,
      ...(geo ? { video: geo.video, card: geo.card } : {}),
    });
  }
  return out.length ? out : undefined;
}
