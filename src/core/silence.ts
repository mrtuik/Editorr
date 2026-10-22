import { rmsEnvelope } from './audio';
import type { Range } from './timeline';
import type { SilenceSens } from './types';

const HOP_MS = 50;

/** Share of the (quiet floor -> speech level) distance that still counts as silence. */
const LEVEL: Record<SilenceSens, number> = { low: 0.12, medium: 0.22, high: 0.35 };

export interface SilenceOptions {
  /** Both people quiet for at least this long. */
  minMs: number;
  /** Quiet time kept next to speech. */
  padMs: number;
  sens: SilenceSens;
}

function toDb(env: Float32Array): Float32Array {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) out[i] = 20 * Math.log10(env[i] + 1e-6);
  return out;
}

function percentile(arr: Float32Array, p: number): number {
  if (!arr.length) return -90;
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Silence level for one mic: just above its own noise floor, so a noisy phone still works. */
function threshold(db: Float32Array, sens: SilenceSens): number {
  const floor = percentile(db, 0.1);
  const top = percentile(db, 0.95);
  const span = Math.max(6, top - floor);
  return floor + span * LEVEL[sens];
}

/**
 * Finds parts where BOTH people are quiet. Timeline time = Host time, the Constant mic is shifted by offsetMs.
 * Because the two videos are synced, one cut range removes the same moment from both.
 * `keep` limits the search to parts that are still on the timeline.
 */
export function detectSilence(
  hostPcm: Float32Array,
  constPcm: Float32Array,
  offsetMs: number,
  durationMs: number,
  o: SilenceOptions,
  keep?: Range[],
): Range[] {
  const hostDb = toDb(rmsEnvelope(hostPcm, HOP_MS));
  const constDb = toDb(rmsEnvelope(constPcm, HOP_MS));
  const shift = Math.round(offsetMs / HOP_MS);
  const frames = Math.ceil(durationMs / HOP_MS);
  const th = threshold(hostDb, o.sens);
  const tc = threshold(constDb, o.sens);

  const quiet = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    const h = hostDb[f] ?? -90;
    const c = constDb[f + shift] ?? -90;
    quiet[f] = h < th && c < tc ? 1 : 0;
  }
  // a sound shorter than 100 ms (click, breath) does not break a silence
  for (let f = 0; f < frames; f++) {
    if (quiet[f]) continue;
    let e = f;
    while (e < frames && !quiet[e]) e++;
    if (e - f < 2 && f > 0 && e < frames) for (let k = f; k < e; k++) quiet[k] = 1;
    f = e;
  }

  const minFrames = Math.max(1, Math.round(o.minMs / HOP_MS));
  const cuts: Range[] = [];
  for (let f = 0; f < frames; f++) {
    if (!quiet[f]) continue;
    let e = f;
    while (e < frames && quiet[e]) e++;
    if (e - f >= minFrames) {
      const a = f === 0 ? 0 : f * HOP_MS + o.padMs;
      const b = e >= frames ? durationMs : e * HOP_MS - o.padMs;
      if (b - a >= 100) cuts.push({ startMs: a, endMs: Math.min(durationMs, b) });
    }
    f = e;
  }
  if (!keep) return cuts;
  const out: Range[] = [];
  for (const c of cuts) for (const k of keep) {
    const a = Math.max(c.startMs, k.startMs), b = Math.min(c.endMs, k.endMs);
    if (b - a >= 100) out.push({ startMs: a, endMs: b });
  }
  return out;
}
