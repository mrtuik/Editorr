import { rmsEnvelope } from './audio';
import type { Role, Segment, Sensitivity, Settings } from './types';

const HOP_MS = 100;

const MARGIN_DB: Record<Sensitivity, number> = { low: 14, medium: 10, high: 6 };

function toDb(env: Float32Array): Float32Array {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) out[i] = 20 * Math.log10(env[i] + 1e-6);
  return out;
}

function percentile(arr: Float32Array, p: number): number {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? -90;
}

let _id = 0;
export const uid = () => `s${Date.now().toString(36)}${(_id++).toString(36)}`;

/**
 * Energy-based VAD + loudness compare.
 * Timeline time = host time. Constant audio is shifted by offsetMs.
 */
export function detectSpeakers(
  hostPcm: Float32Array,
  constPcm: Float32Array,
  offsetMs: number,
  durationMs: number,
  settings: Settings,
): Segment[] {
  const hostDb = toDb(rmsEnvelope(hostPcm, HOP_MS));
  const constDbRaw = toDb(rmsEnvelope(constPcm, HOP_MS));
  const shift = Math.round(offsetMs / HOP_MS);
  const frames = Math.ceil(durationMs / HOP_MS);

  const hostFloor = percentile(hostDb, 0.1);
  const constFloor = percentile(constDbRaw, 0.1);
  const margin = MARGIN_DB[settings.sensitivity];

  const labels: (Role | 'both' | 'none')[] = [];
  let prev: Role = 'host';
  for (let f = 0; f < frames; f++) {
    const h = hostDb[f] ?? -90;
    const c = constDbRaw[f + shift] ?? -90;
    const hv = h > hostFloor + margin;
    const cv = c > constFloor + margin;
    let l: Role | 'both' | 'none';
    if (hv && !cv) l = 'host';
    else if (cv && !hv) l = 'constant';
    else if (hv && cv) {
      // compare loudness relative to each mic's own floor
      const dh = h - hostFloor, dc = c - constFloor;
      l = Math.abs(dh - dc) > 6 ? (dh > dc ? 'host' : 'constant') : 'both';
    } else l = 'none';
    labels.push(l);
    if (l === 'host' || l === 'constant') prev = l;
  }

  // Resolve none/both by holding previous speaker (or side-by-side).
  type Cell = { role: Role; side: boolean };
  const cells: Cell[] = [];
  let cur: Cell = { role: 'host', side: false };
  for (const l of labels) {
    if (l === 'host' || l === 'constant') cur = { role: l, side: false };
    else if (l === 'both' && settings.bothSpeaking === 'side') cur = { role: cur.role, side: true };
    // 'none' or 'both'+hold: stay on current
    cells.push(cur);
  }

  // Run-length encode.
  const raw: Segment[] = [];
  let start = 0;
  for (let f = 1; f <= cells.length; f++) {
    if (f === cells.length || cells[f].role !== cells[start].role || cells[f].side !== cells[start].side) {
      const c = cells[start];
      raw.push({
        id: uid(),
        startMs: start * HOP_MS,
        endMs: Math.min(durationMs, f * HOP_MS),
        style: c.side ? 'side' : 'one',
        main: c.role,
        corner: 'br',
        size: 'M',
      });
      start = f;
    }
  }
  return mergeShort(raw, settings.minSegmentMs, durationMs);
}

/** Merge segments shorter than minMs into the previous one. */
export function mergeShort(segs: Segment[], minMs: number, durationMs: number): Segment[] {
  if (!segs.length) return [{ id: uid(), startMs: 0, endMs: durationMs, style: 'one', main: 'host', corner: 'br', size: 'M' }];
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && s.endMs - s.startMs < minMs) last.endMs = s.endMs;
    else if (last && last.style === s.style && last.main === s.main) last.endMs = s.endMs;
    else out.push({ ...s });
  }
  // first segment too short: absorb into next
  if (out.length > 1 && out[0].endMs - out[0].startMs < minMs) {
    out[1].startMs = out[0].startMs;
    out.shift();
  }
  out[0].startMs = 0;
  out[out.length - 1].endMs = durationMs;
  return out;
}
