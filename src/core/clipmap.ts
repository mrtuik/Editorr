/**
 * Clip time map, ported from CapCraft (concat-core/timeline.rs + the TrimClip / SplitClips commands).
 *
 * One rule decides everything: a clip sits on the timeline at `startMs` for `lenMs`, plays its file from the in-point
 * `srcMs`, and consumes `speed` file-seconds per timeline-second. So
 *     file time = srcMs + (timeline time - startMs) * speed
 * Preview, trim, split and export all derive from this one formula, so picture, sound and handles cannot disagree.
 */
export interface MapClip {
  startMs: number;     // where it starts on the timeline
  lenMs: number;       // how long it runs on the timeline
  durationMs: number;  // length of the file
  srcMs?: number;      // in-point inside the file (default 0)
  speed?: number;      // file seconds per timeline second (default 1)
}

/** Shortest a clip may get (CapCraft: a tenth of a second). */
export const MIN_CLIP_MS = 100;

export const srcOf = (c: MapClip) => Math.max(0, c.srcMs ?? 0);
export const speedOf = (c: MapClip) => (c.speed && c.speed > 0 ? c.speed : 1);
export const endOf = (c: MapClip) => c.startMs + c.lenMs;
export const containsMs = (c: MapClip, t: number) => t >= c.startMs && t < endOf(c);

/** File time (ms) under timeline time `t`, or null when the clip is not on screen then. Clamped inside the file. */
export function fileTimeAt(c: MapClip, t: number): number | null {
  if (!containsMs(c, t)) return null;
  const f = srcOf(c) + (t - c.startMs) * speedOf(c);
  return Math.max(0, Math.min(Math.max(0, c.durationMs - 1), f));
}

/** The longest the clip can run before its file ends. */
export function maxLenMs(c: MapClip): number {
  return Math.max(MIN_CLIP_MS, (c.durationMs - srcOf(c)) / speedOf(c));
}

/** Opacity ramp at `t`: fades in over `fadeIn` ms from the start, out over `fadeOut` ms into the end. 1 outside the fades. */
export function fadeFactor(c: MapClip, t: number, fadeIn = 0, fadeOut = 0): number {
  let f = 1;
  const local = t - c.startMs, remaining = c.lenMs - local;
  if (fadeIn > 0 && local < fadeIn) f *= Math.max(0, Math.min(1, local / fadeIn));
  if (fadeOut > 0 && remaining < fadeOut) f *= Math.max(0, Math.min(1, remaining / fadeOut));
  return f;
}

/**
 * Drag one edge to timeline time `to`. A HEAD trim moves the in-point with the edge (scaled by speed) so the frames that
 * stay do not slide; a TAIL trim only changes the length. Neither edge can pass the other end (minus MIN_CLIP_MS) or
 * the ends of the file. Returns a new clip; the input is untouched.
 */
export function trimEdge<T extends MapClip>(c: T, edge: 'head' | 'tail', to: number, minMs = MIN_CLIP_MS): T {
  const sp = speedOf(c), end = endOf(c);
  if (edge === 'head') {
    const earliest = Math.max(0, c.startMs - srcOf(c) / sp);       // cannot reveal more than the file has before the in-point
    const ns = Math.round(Math.max(earliest, Math.min(end - minMs, to)));
    const d = ns - c.startMs;
    return { ...c, startMs: ns, lenMs: end - ns, srcMs: Math.max(0, Math.round(srcOf(c) + d * sp)) };
  }
  const len = Math.round(Math.max(minMs, Math.min(maxLenMs(c), to - c.startMs)));
  return { ...c, lenMs: len };
}

/** Move the whole clip so it starts at `to` (never before 0). */
export function moveClip<T extends MapClip>(c: T, to: number): T {
  return { ...c, startMs: Math.max(0, Math.round(to)) };
}

/**
 * Cut at timeline time `t`: the head keeps the id, the tail is a new piece that continues the file exactly where the
 * head stopped (source-continuous). Returns null when `t` misses the clip or grazes an end within minMs.
 */
export function splitClip<T extends MapClip>(c: T, t: number, minMs = MIN_CLIP_MS): [T, T] | null {
  if (!(t > c.startMs + minMs && t < endOf(c) - minMs)) return null;
  const head = { ...c, lenMs: Math.round(t - c.startMs) };
  const tail = { ...c, startMs: Math.round(t), lenMs: Math.round(endOf(c) - t), srcMs: Math.round(srcOf(c) + (t - c.startMs) * speedOf(c)) };
  return [head, tail];
}

/** The target nearest `time` within `threshold`, or null (CapCraft snapTarget). */
export function snapTo(time: number, targets: number[], threshold: number): number | null {
  let best: number | null = null, bd = Infinity;
  for (const t of targets) { const d = Math.abs(t - time); if (d < bd) { bd = d; best = t; } }
  return best !== null && bd <= threshold ? best : null;
}

/** Times a moving edge snaps to: the playhead, 0 and every other clip's ends. */
export function snapTargets(clips: { id: string; startMs: number; lenMs: number }[], exceptId: string, playheadMs: number): number[] {
  const out = [0, playheadMs];
  for (const c of clips) if (c.id !== exceptId) out.push(c.startMs, c.startMs + c.lenMs);
  return out;
}

/** Ruler tick spacing in seconds: the first step whose spacing on screen is at least `minPx` (CapCraft STEPS table). */
export const RULER_STEPS = [1 / 30, 0.05, 1 / 12, 1 / 6, 0.25, 0.5, 1, 1.5, 2.5, 5, 10, 15, 30, 60, 90, 150, 300, 600, 900];
export function rulerStep(pxPerSec: number, minPx = 48): number {
  for (const s of RULER_STEPS) if (s * pxPerSec >= minPx) return s;
  return RULER_STEPS[RULER_STEPS.length - 1]!;
}

/** Stack overlapping clips into rows (lanes): a clip goes to the first lane that is free at its start. */
export function assignLanes(spans: [number, number][], gapMs = 0): { line: number[]; n: number } {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a]![0] - spans[b]![0]);
  const ends: number[] = [], line: number[] = new Array(spans.length).fill(0);
  for (const i of order) {
    let l = ends.findIndex((e) => e + gapMs <= spans[i]![0]);
    if (l < 0) { l = ends.length; ends.push(0); }
    ends[l] = spans[i]![1]; line[i] = l;
  }
  return { line, n: Math.max(1, ends.length) };
}
