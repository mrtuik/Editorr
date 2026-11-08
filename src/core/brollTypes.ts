/**
 * B-roll beats: a photo that cuts in over the talking head for 1.5 to 4 seconds, with a slow Ken Burns move.
 * A beat is a moment on the timeline (timeline ms, like texts and docu beats).
 * brollRenderer.ts draws it in the preview and EditorrNativePlugin.BrollOverlay draws the same numbers in the export,
 * so every number that decides how it looks lives here (box, motion, fade).
 */

export type BrollMotion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'slow_zoom';
/** card = rounded photo over a dimmed video, full = fills the frame, blur = photo (or article card) whole in front of a blurred copy of itself */
export type BrollFrame = 'card' | 'full' | 'blur';
export type BrollSource = 'wikimedia' | 'wikipedia' | 'openverse' | 'commons_video' | 'archive' | 'youtube' | 'card';
/** photo = a picture, video = a real moving clip (muted), card = a picture the app drew itself (concept card, article card) */
export type BrollKind = 'photo' | 'video' | 'card';
/** Which of the 4 routes picked this beat's material. */
export type BrollRoute = 'entity' | 'receipt' | 'concept' | 'archival';

export interface BrollBeat {
  id: string;
  /** timeline ms */
  start: number;
  end: number;
  /** what was searched for this moment */
  keyword: string;
  /** picture address on the web (the preview uses it until the file is saved, the download starts from it) */
  url: string;
  thumb: string;
  /** the saved picture (or video file) on the phone. The export reads this file; a beat without it is left out of the export. */
  path?: string;
  title: string;
  source: BrollSource;
  /** author + licence, for the video description */
  credit?: string;
  motion: BrollMotion;
  /** card = rounded photo floating over a dimmed video, full = photo fills the frame, blur = whole picture over a blurred copy */
  frame: BrollFrame;
  /** missing = photo */
  kind?: BrollKind;
  route?: BrollRoute;
  /** video beats: where in the clip file the beat starts (ms) and how long the whole file is (ms) */
  inMs?: number;
  srcMs?: number;
  /** corner radius in px of a 1080-short-side frame (card only) */
  radius: number;
}

export const BROLL_MOTIONS: BrollMotion[] = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'slow_zoom'];
/** The motions Auto B-roll rotates through (slow_zoom is kept for article cards). */
export const BROLL_AUTO_MOTIONS: BrollMotion[] = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right'];
export const BROLL_MOTION_LABEL: Record<BrollMotion, string> = { zoom_in: 'Zoom in', zoom_out: 'Zoom out', pan_left: 'Pan left', pan_right: 'Pan right', slow_zoom: 'Slow zoom' };
export const BROLL_FRAME_LABEL: Record<BrollFrame, string> = { card: 'Card', full: 'Full frame', blur: 'Blur fill' };
export const BROLL_SOURCE_LABEL: Record<BrollSource, string> = {
  wikimedia: 'Commons', wikipedia: 'Wiki', openverse: 'Openverse', commons_video: 'Commons video', archive: 'Archive', youtube: 'YouTube', card: 'Card',
};
export const isBrollVideo = (b: BrollBeat) => b.kind === 'video';
export const BROLL_DEFAULT_MS = 2500;
export const BROLL_MIN_MS = 1500;
export const BROLL_MAX_MS = 4000;
export const BROLL_DEFAULT_RADIUS = 20;
export const BROLL_FADE_IN_MS = 160;
export const BROLL_FADE_OUT_MS = 120;
/** Card: margin around the photo as a share of the short side. */
export const BROLL_CARD_MARGIN = 0.06;
/** Card: how dark the video behind the photo gets (0..1). */
export const BROLL_SCRIM = 0.55;
/** Edge darkening inside the photo (0..1). */
export const BROLL_VIGNETTE = 0.45;
/** Blur frame: the blurred copy is made at 1/BROLL_BLUR_DIV of the frame size and stretched back, then darkened by this much (0..1). */
export const BROLL_BLUR_DIV = 28;
export const BROLL_BLUR_DIM = 0.38;

export interface BrollRect { x: number; y: number; w: number; h: number }

export function brollBeatAt(beats: BrollBeat[] | undefined, ms: number): BrollBeat | undefined {
  if (!beats) return undefined;
  for (const b of beats) if (ms >= b.start && ms < b.end) return b;
  return undefined;
}

/** Where the photo sits in a w x h frame (blur: the box the whole picture is fitted into). */
export function brollBox(frame: BrollFrame, w: number, h: number): BrollRect {
  if (frame === 'full') return { x: 0, y: 0, w, h };
  const m = BROLL_CARD_MARGIN * Math.min(w, h);
  return { x: m, y: m, w: w - 2 * m, h: h - 2 * m };
}

/** The biggest rectangle with the picture's shape that fits inside `box`, centred (blur frame: the whole picture is shown). */
export function brollContain(iw: number, ih: number, box: BrollRect): BrollRect {
  const sc = Math.min(box.w / Math.max(1, iw), box.h / Math.max(1, ih));
  const w = iw * sc, h = ih * sc;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Radius in canvas px: the beat's radius is given for a 1080 short side. Full frame has no corners. */
export const brollRadiusPx = (b: BrollBeat, w: number, h: number) =>
  b.frame === 'full' ? 0 : Math.round(((b.radius ?? BROLL_DEFAULT_RADIUS) * Math.min(w, h)) / 1080);

/**
 * The move over the beat, p = 0..1. The whole layer (photo + card + dimming) is scaled around the middle of the frame
 * and shifted sideways by `tx` (a share of the frame width). The scale never goes below 1, so the dimming always covers the frame.
 */
export function brollMotionAt(motion: BrollMotion, p: number): { s: number; tx: number } {
  const q = Math.max(0, Math.min(1, p));
  const e = q * q * (3 - 2 * q);
  switch (motion) {
    case 'zoom_out': return { s: 1.12 - 0.12 * e, tx: 0 };
    case 'slow_zoom': return { s: 1 + 0.04 * q, tx: 0 };
    case 'pan_left': return { s: 1.06, tx: 0.02 - 0.04 * e };
    case 'pan_right': return { s: 1.06, tx: -0.02 + 0.04 * e };
    default: return { s: 1 + 0.12 * e, tx: 0 };
  }
}

/** 0..1 fade at `ms`: in at the start, out at the end. */
export function brollAlpha(b: BrollBeat, ms: number): number {
  const a = Math.max(0, Math.min(1, (ms - b.start) / BROLL_FADE_IN_MS));
  const z = Math.max(0, Math.min(1, (b.end - ms) / BROLL_FADE_OUT_MS));
  return Math.min(a, z);
}

/**
 * Put `nb` on the timeline. The new beat wins: beats it overlaps are shortened (or dropped when under 500 ms is left).
 * Returns the new sorted list.
 */
export function placeBroll(list: BrollBeat[], nb: BrollBeat): BrollBeat[] {
  const out: BrollBeat[] = [];
  for (const b of list) {
    if (b.id === nb.id) continue;
    if (b.end <= nb.start || b.start >= nb.end) { out.push(b); continue; }
    if (b.start < nb.start) { const c = { ...b, end: nb.start }; if (c.end - c.start >= 500) out.push(c); }
    else { const c = { ...b, start: nb.end }; if (c.end - c.start >= 500) out.push(c); }
  }
  out.push(nb);
  return out.sort((a, b) => a.start - b.start);
}
