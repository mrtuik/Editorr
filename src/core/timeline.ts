import type { Segment } from './types';
import { uid } from './speaker';

export const MIN_SEG_MS = 300;

export function segmentAt(segs: Segment[], ms: number): Segment | undefined {
  return segs.find((s) => ms >= s.startMs && ms < s.endMs) ?? segs[segs.length - 1];
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
  const t = Math.max(l.startMs + MIN_SEG_MS, Math.min(r.endMs - MIN_SEG_MS, newMs));
  const out = segs.slice();
  out[leftIndex] = { ...l, endMs: t };
  out[leftIndex + 1] = { ...r, startMs: t };
  return out;
}

export function updateSegment(segs: Segment[], id: string, patch: Partial<Segment>): Segment[] {
  return segs.map((s) => (s.id === id ? { ...s, ...patch } : s));
}
