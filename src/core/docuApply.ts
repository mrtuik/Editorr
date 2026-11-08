/**
 * Split beats move the talking head into a window. This works out that move for the preview and for the export,
 * without touching the user's own segments: the preview asks `docuCrop()`, the export sends `docuSegments()`.
 */
import { docuShift } from './docuRenderer';
import { defaultPos, docuBeatAt, docuLayoutFor, type DocuBeat } from './docuTypes';
import { aspectValue, type CropState, type Project, type Role, type Segment } from './types';

const isSplit = (b: DocuBeat | undefined): b is DocuBeat => !!b && b.type === 'split_screen';

/** The crop of `base` plus the move that brings the video into the window of this beat. */
export function docuCrop(base: CropState, b: DocuBeat, ratio: number): CropState {
  const m = docuShift(b.layout, b.video_position, ratio, b.share);
  return { ...base, px: (base.px ?? 0) + m.px, py: (base.py ?? 0) + m.py };
}

/** The beat that changes the picture at `ms` (split beats only), else undefined. */
export const splitBeatAt = (beats: DocuBeat[] | undefined, ms: number): DocuBeat | undefined => {
  const b = docuBeatAt(beats, ms);
  return isSplit(b) ? b : undefined;
};

/**
 * Export segments: the user's segments cut at the edges of each split beat; inside a beat the segment is one full-frame clip
 * (the main person) moved into the window. Everything else is returned unchanged.
 */
export function docuSegments(p: Project): Segment[] {
  const beats = (p.docu ?? []).filter(isSplit);
  if (!beats.length) return p.segments;
  const out: Segment[] = [];
  let n = 0;
  for (const s of [...p.segments].sort((a, b) => a.startMs - b.startMs)) {
    const cuts = new Set<number>([s.startMs, s.endMs]);
    for (const b of beats) { if (b.start > s.startMs && b.start < s.endMs) cuts.add(b.start); if (b.end > s.startMs && b.end < s.endMs) cuts.add(b.end); }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!, e = pts[i + 1]!;
      if (e - a < 1) continue;
      const beat = beats.find((b) => a >= b.start && a < b.end);
      const piece: Segment = { ...s, id: pts.length > 2 ? `${s.id}~d${n++}` : s.id, startMs: a, endMs: e };
      if (beat) {
        const role: Role = s.main;
        const k = role === 'host' ? 'cropHost' : 'cropConst';
        piece.style = 'one';
        piece[k] = docuCrop(s[k] ?? p[k], beat, aspectValue(p.aspect));
      }
      out.push(piece);
    }
  }
  return out;
}

/** After a ratio change a beat may have the wrong layout for the new shape: wide = side, tall = updown, and a position that fits it. */
export function fixDocuLayout(p: Project): void {
  const layout = docuLayoutFor(p.aspect);
  for (const b of p.docu ?? []) {
    if (b.layout === layout || b.image) continue; // a Kallaway picture was drawn for one frame shape
    b.layout = layout;
    b.video_position = defaultPos(layout);
  }
}
