import type { Segment } from './types';
import { uid } from './speaker';

export const MIN_SEG_MS = 300;

export function segmentAt(segs: Segment[], ms: number): Segment | undefined {
  const hit = segs.find((s) => ms >= s.startMs && ms < s.endMs);
  if (hit) return hit;
  // inside a cut part: use the next kept segment (or the last one at the very end)
  let next: Segment | undefined;
  for (const s of segs) if (s.startMs >= ms && (!next || s.startMs < next.startMs)) next = s;
  return next ?? segs[segs.length - 1];
}

export function splitAt(segs: Segment[], ms: number): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (ms > s.startMs + MIN_SEG_MS && ms < s.endMs - MIN_SEG_MS) {
      out.push({ ...s, endMs: ms });
      out.push({ ...s, id: uid(), startMs: ms });
    } else out.push(s);
  }
  return out;
}

/** Merge the selected segment with the one before it. */
export function mergeWithPrev(segs: Segment[], id: string): Segment[] {
  const i = segs.findIndex((s) => s.id === id);
  if (i <= 0) return segs;
  const out = segs.slice();
  out[i - 1] = { ...out[i - 1], endMs: out[i].endMs };
  out.splice(i, 1);
  return out;
}

/** Delete: neighbour absorbs the gap so timeline stays contiguous. */
export function deleteSegment(segs: Segment[], id: string): Segment[] {
  if (segs.length <= 1) return segs;
  const i = segs.findIndex((s) => s.id === id);
  if (i < 0) return segs;
  const out = segs.slice();
  const s = out[i];
  if (i > 0) out[i - 1] = { ...out[i - 1], endMs: s.endMs };
  else out[i + 1] = { ...out[i + 1], startMs: s.startMs };
  out.splice(i, 1);
  return out;
}

/** Drag the boundary between segment i and i+1 to newMs. */
export function moveBoundary(segs: Segment[], leftIndex: number, newMs: number): Segment[] {
  if (leftIndex < 0 || leftIndex >= segs.length - 1) return segs;
  const l = segs[leftIndex], r = segs[leftIndex + 1];
  if (Math.abs(l.endMs - r.startMs) > 1) return segs; // a cut part sits between them
  const t = Math.max(l.startMs + MIN_SEG_MS, Math.min(r.endMs - MIN_SEG_MS, newMs));
  const out = segs.slice();
  out[leftIndex] = { ...l, endMs: t };
  out[leftIndex + 1] = { ...r, startMs: t };
  return out;
}

export function updateSegment(segs: Segment[], id: string, patch: Partial<Segment>): Segment[] {
  return segs.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

// ---------- removed parts (silence cut) ----------
// Segments may have gaps between them: a gap is a part that was cut out of BOTH videos.

export interface Range { startMs: number; endMs: number }

/** The parts of the timeline that are still kept, merged where segments touch. */
export function coverage(segs: Segment[]): Range[] {
  const out: Range[] = [];
  for (const s of [...segs].sort((a, b) => a.startMs - b.startMs)) {
    const last = out[out.length - 1];
    if (last && s.startMs <= last.endMs + 1) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return out;
}

export function keptMs(segs: Segment[]): number {
  return coverage(segs).reduce((a, r) => a + (r.endMs - r.startMs), 0);
}

/** Cut ranges out of the segments (segments are split where a cut lands inside). */
export function subtractRanges(segs: Segment[], cuts: Range[]): Segment[] {
  let out = segs.map((s) => ({ ...s }));
  for (const c of cuts) {
    const next: Segment[] = [];
    for (const s of out) {
      if (c.endMs <= s.startMs || c.startMs >= s.endMs) { next.push(s); continue; }
      if (c.startMs - s.startMs >= 1) next.push({ ...s, endMs: c.startMs });
      if (s.endMs - c.endMs >= 1) next.push({ ...s, id: uid(), startMs: c.endMs });
    }
    out = next;
  }
  return out;
}

/** Keep only the parts of segs that fall inside ranges (used so auto switch does not bring cut parts back). */
export function intersectRanges(segs: Segment[], ranges: Range[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    for (const r of ranges) {
      const a = Math.max(s.startMs, r.startMs), b = Math.min(s.endMs, r.endMs);
      if (b - a >= 1) out.push({ ...s, id: out.some((o) => o.id === s.id) ? uid() : s.id, startMs: a, endMs: b });
    }
  }
  return out;
}

/** Start of the first kept part after ms, or null when nothing is left. */
export function nextKeptStart(segs: Segment[], ms: number): number | null {
  let best: number | null = null;
  for (const s of segs) if (s.startMs >= ms && (best === null || s.startMs < best)) best = s.startMs;
  return best;
}

export function isKept(segs: Segment[], ms: number): boolean {
  return segs.some((s) => ms >= s.startMs && ms < s.endMs);
}

/** A cut can leave a tiny leftover piece next to it. Join it to the neighbour it touches (or drop it when alone). */
export function dropSlivers(segs: Segment[], minMs = MIN_SEG_MS): Segment[] {
  const out = segs.map((s) => ({ ...s })).sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.endMs - s.startMs >= minMs || out.length === 1) continue;
    const prev = out[i - 1], next = out[i + 1];
    if (prev && Math.abs(prev.endMs - s.startMs) <= 1) prev.endMs = s.endMs;
    else if (next && Math.abs(next.startMs - s.endMs) <= 1) next.startMs = s.startMs;
    out.splice(i, 1); i--;
  }
  return out;
}
