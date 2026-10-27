/**
 * Extra auto edits on top of the Host / Constant cuts:
 * - Reaction cutaways: while one person talks for a long time, show the listener for a moment.
 * - Auto zoom: a soft punch-in on loud moments (big words, laughs).
 * Both work by splitting segments, so preview and export are always the same.
 */
import { rmsEnvelope } from './audio';
import { uid } from './speaker';
import type { CropState, Role, Segment } from './types';

const HOP = 100;

function dup(s: Segment, patch: Partial<Segment>): Segment {
  const n: Segment = { ...s, ...patch };
  if (s.cropHost) n.cropHost = { ...s.cropHost };
  if (s.cropConst) n.cropConst = { ...s.cropConst };
  return n;
}
const sameCrop = (a?: CropState, b?: CropState) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Join neighbours that look exactly the same (used after a reaction is removed). */
export function mergeEqual(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const l = out[out.length - 1];
    if (l && !l.reaction && !s.reaction && (l.speed ?? 1) === (s.speed ?? 1) && l.style === s.style && l.main === s.main && l.corner === s.corner && l.size === s.size
      && sameCrop(l.cropHost, s.cropHost) && sameCrop(l.cropConst, s.cropConst) && Math.abs(l.endMs - s.startMs) < 2) l.endMs = s.endMs;
    else out.push(dup(s, {}));
  }
  return out;
}

function envOf(pcm: Float32Array, shiftFrames: number, frames: number): Float32Array {
  const env = rmsEnvelope(pcm, HOP);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) out[f] = 20 * Math.log10((env[f + shiftFrames] ?? 0) + 1e-6);
  return out;
}

export interface ReactionOpts { afterMs: number; lengthMs: number }

/**
 * Inside every long one-person part, after `afterMs` of talking, cut to the listener for `lengthMs`.
 * The cut starts at a short pause of the speaker, so it feels like a natural breath. Audio is never touched.
 * `visible(role, ms)` can say the listener has no face in view (then that spot is skipped).
 */
export function addReactions(
  segs: Segment[], hostPcm: Float32Array, constPcm: Float32Array, offsetMs: number, durationMs: number,
  o: ReactionOpts, visible?: (role: Role, ms: number) => boolean,
): Segment[] {
  const frames = Math.ceil(durationMs / HOP) + 2;
  const shift = Math.round(offsetMs / HOP);
  const dbHost = envOf(hostPcm, 0, frames), dbConst = envOf(constPcm, shift, frames);
  const out: Segment[] = [];
  for (const sg of segs) {
    if (sg.style !== 'one' || sg.reaction) { out.push(sg); continue; }
    const speaker = sg.main, listener: Role = sg.main === 'host' ? 'constant' : 'host';
    const db = speaker === 'host' ? dbHost : dbConst;
    const cuts: { a: number; b: number }[] = [];
    let t = sg.startMs + o.afterMs;
    while (t + o.lengthMs + 1500 <= sg.endMs) {
      let best = Math.round(t / HOP), bv = Infinity;
      for (let f = Math.round((t - 800) / HOP); f <= Math.round((t + 1200) / HOP); f++) {
        const ms = f * HOP;
        if (ms < sg.startMs + 1500 || ms + o.lengthMs > sg.endMs - 1000) continue;
        const v = db[f] ?? 0;
        if (v < bv) { bv = v; best = f; }
      }
      const a = best * HOP, b = a + o.lengthMs;
      if (b > sg.endMs - 1000 || a < sg.startMs + 1500) break;
      if (visible && !visible(listener, a + o.lengthMs / 2)) { t += 1000; continue; }
      cuts.push({ a, b });
      t = b + o.afterMs;
    }
    if (!cuts.length) { out.push(sg); continue; }
    let from = sg.startMs;
    cuts.forEach((c, i) => {
      out.push(dup(sg, { id: i === 0 ? sg.id : uid(), startMs: from, endMs: c.a }));
      out.push(dup(sg, { id: uid(), startMs: c.a, endMs: c.b, main: listener, reaction: true }));
      from = c.b;
    });
    out.push(dup(sg, { id: uid(), startMs: from, endMs: sg.endMs }));
  }
  return out;
}

/** Turn one reaction back into the normal part (the speaker is shown again). */
export function removeReaction(segs: Segment[], id: string): Segment[] {
  const i = segs.findIndex((s) => s.id === id);
  if (i < 0) return segs;
  const nb = segs[i - 1] ?? segs[i + 1];
  const out = segs.map((s) => ({ ...s }));
  out[i].main = nb ? nb.main : out[i].main;
  delete out[i].reaction;
  return mergeEqual(out);
}
export const removeAllReactions = (segs: Segment[]) => {
  let cur = segs;
  for (const s of segs) if (s.reaction) cur = removeReaction(cur, s.id);
  return cur;
};

// ------------------------------------------------------------------ auto zoom

export type ZoomStrength = 'soft' | 'medium' | 'strong';
export const ZOOM_FACTOR: Record<ZoomStrength, number> = { soft: 1.08, medium: 1.15, strong: 1.25 };

/** The crop zoomed in by `f` around the centre of what it shows now (same maths as the preview and the export). */
export function zoomCrop(c: CropState, f: number): CropState {
  const z = Math.max(0.2, Math.min(6, c.zoom));
  const half = 1 / z;
  const cx = -c.x * (z > 1 ? 1 - half : 1);
  const cy = c.y * (z > 1 ? 1 - half : 1);
  const z2 = Math.min(3.5, z * f);
  const half2 = 1 / z2;
  const k = 1 - half2;
  const clamp = (q: number) => Math.max(-1, Math.min(1, q));
  return { ...c, zoom: z2, x: k > 1e-6 ? clamp(-cx / k) : 0, y: k > 1e-6 ? clamp(cy / k) : 0 };
}

/** Moments of strong speech (loud and a local peak), at least `gapMs` apart, at most `perMin` per minute. */
export function findPeaks(pcm: Float32Array, shiftFrames: number, durationMs: number, gapMs: number, perMin: number): number[] {
  const frames = Math.ceil(durationMs / HOP);
  const db = envOf(pcm, shiftFrames, frames);
  const sorted = Float32Array.from(db).sort();
  const p90 = sorted[Math.floor(0.9 * sorted.length)] ?? 0, med = sorted[Math.floor(0.5 * sorted.length)] ?? 0;
  const peaks: number[] = [];
  for (let f = 4; f < frames - 4; f++) {
    const v = db[f];
    if (v < p90 || v < med + 6) continue;
    let top = true;
    for (let k = -4; k <= 4; k++) if (db[f + k] > v) { top = false; break; }
    if (!top) continue;
    const t = f * HOP;
    if (peaks.length && t - peaks[peaks.length - 1] < gapMs) continue;
    peaks.push(t);
  }
  const max = Math.max(1, Math.round((durationMs / 60000) * perMin));
  if (peaks.length <= max) return peaks;
  // keep the loudest ones
  return peaks.map((t) => ({ t, v: db[Math.round(t / HOP)] })).sort((a, b) => b.v - a.v).slice(0, max).map((x) => x.t).sort((a, b) => a - b);
}

export interface ZoomShape { amount: number; inMs: number; holdMs: number; outMs: number; ease: number[] }

/** CSS-style cubic-bezier(x1, y1, x2, y2): progress u (0..1) -> eased value. y may go past 0..1 (overshoot / bounce). */
export function bezier(e: number[], u: number): number {
  const [x1, y1, x2, y2] = e;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  let t = u;
  for (let i = 0; i < 8; i++) {
    const x = ((ax * t + bx) * t + cx) * t - u;
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(x) < 1e-5 || Math.abs(d) < 1e-6) break;
    t -= x / d;
  }
  t = Math.max(0, Math.min(1, t));
  return ((ay * t + by) * t + cy) * t;
}

/**
 * Punch-in at each peak, shaped like a graph editor: ease in (curve), hold, ease out (same curve backwards).
 * The curve is sampled in small steps (about every 60 ms), each step is a tiny clip with its own crop.
 * Only inside one-person parts, and only when the whole zoom fits inside that part.
 */
export function addPunchZooms(
  segs: Segment[], peaks: number[], shape: ZoomShape,
  baseCrop: (sg: Segment, role: Role) => CropState,
): Segment[] {
  const A = Math.max(1.01, shape.amount);
  const inMs = Math.max(80, shape.inMs), outMs = Math.max(80, shape.outMs), holdMs = Math.max(0, shape.holdMs);
  const total = inMs + holdMs + outMs;
  const nIn = Math.max(3, Math.min(16, Math.round(inMs / 60))), nOut = Math.max(3, Math.min(16, Math.round(outMs / 60)));
  const lead = Math.round(inMs / 2);
  const f = (e: number) => 1 + (A - 1) * e;
  const out: Segment[] = [];
  for (const sg of segs) {
    const key = (sg.main === 'host' ? 'cropHost' : 'cropConst') as 'cropHost' | 'cropConst';
    const mine = sg.style === 'one' ? peaks.filter((t) => t - lead > sg.startMs + 100 && t - lead + total < sg.endMs - 100) : [];
    const picked: number[] = [];
    for (const t of mine) if (!picked.length || t - picked[picked.length - 1] > total + 200) picked.push(t);
    if (!picked.length) { out.push(sg); continue; }
    const base = baseCrop(sg, sg.main);
    const pieces: { a: number; b: number; f: number }[] = [];
    let from = sg.startMs;
    for (const t of picked) {
      const start = t - lead;
      pieces.push({ a: from, b: start, f: 1 });
      for (let k = 0; k < nIn; k++) pieces.push({ a: start + (k * inMs) / nIn, b: start + ((k + 1) * inMs) / nIn, f: f(bezier(shape.ease, (k + 0.5) / nIn)) });
      const holdStart = start + inMs, holdEnd = holdStart + holdMs;
      if (holdMs > 0) pieces.push({ a: holdStart, b: holdEnd, f: A });
      for (let k = 0; k < nOut; k++) pieces.push({ a: holdEnd + (k * outMs) / nOut, b: holdEnd + ((k + 1) * outMs) / nOut, f: f(1 - bezier(shape.ease, (k + 0.5) / nOut)) });
      from = holdEnd + outMs;
    }
    pieces.push({ a: from, b: sg.endMs, f: 1 });
    pieces.forEach((pc, i) => {
      const a = Math.round(pc.a), b = Math.round(pc.b);
      if (b - a < 20) return;
      const n = dup(sg, { id: i === 0 ? sg.id : uid(), startMs: a, endMs: b });
      n[key] = Math.abs(pc.f - 1) < 0.002 ? { ...base } : zoomCrop(base, pc.f);
      out.push(n);
    });
  }
  return out;
}
