import { rmsEnvelope } from './audio';
import { separateByVoice } from './voice';
import type { Role, Segment, Sensitivity, Settings } from './types';

const HOP_MS = 100;


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

/** How far apart the two speakers sit in the loudness difference (dB). Low = mics hear almost the same thing. */
export let lastSeparationDb = 0;
/** Which method produced the last result: mic loudness or voice (who is talking). */
export let lastMethod: 'loudness' | 'voice' = 'loudness';
export let lastVoiceQuality = 0;

const DEAD_ZONE: Record<Sensitivity, number> = { low: 0.3, medium: 0.2, high: 0.1 };

function median5(a: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  const w: number[] = [];
  for (let i = 0; i < a.length; i++) {
    w.length = 0;
    for (let k = -2; k <= 2; k++) w.push(a[Math.min(a.length - 1, Math.max(0, i + k))]);
    w.sort((x, y) => x - y);
    out[i] = w[2];
  }
  return out;
}

/**
 * Two phones, each hears BOTH people (mic bleed). The person closest to a phone is
 * louder on that phone, so we look at the DIFFERENCE between the two mics:
 *   d = host loudness (dB) - const loudness (dB)
 * d is high when the Host person talks, low when the Constant person talks.
 * The two "modes" of d are found automatically (2-means), so different mic gains do not matter.
 * Timeline time = host time. Constant audio is shifted by offsetMs.
 */
export function detectSpeakers(
  hostPcm: Float32Array,
  constPcm: Float32Array,
  offsetMs: number,
  durationMs: number,
  settings: Settings,
  preferred?: Role,
): Segment[] {
  const hostDb = toDb(rmsEnvelope(hostPcm, HOP_MS));
  const constDbRaw = toDb(rmsEnvelope(constPcm, HOP_MS));
  const shift = Math.round(offsetMs / HOP_MS);
  const frames = Math.ceil(durationMs / HOP_MS);

  const hostFloor = percentile(hostDb, 0.1);
  const constFloor = percentile(constDbRaw, 0.1);
  const margin = 4; // only skip true silence; speaker choice comes from the mic difference

  const dRaw = new Float32Array(frames);
  const active: boolean[] = [];
  const act: number[] = [];
  for (let f = 0; f < frames; f++) {
    const h = hostDb[f] ?? -90;
    const c = constDbRaw[f + shift] ?? -90;
    dRaw[f] = h - c; // dB difference; mic gain offset is removed by the 2-means threshold
    const a = h > hostFloor + margin || c > constFloor + margin;
    active.push(a);
    if (a) act.push(dRaw[f]);
  }
  const d = median5(dRaw);

  // 2-means on active frames
  lastSeparationDb = 0;
  let thresh = 0;
  let ok = false;
  if (act.length > 20) {
    const s = Float32Array.from(act).sort();
    let lo = s[Math.floor(0.15 * s.length)], hi = s[Math.floor(0.85 * s.length)];
    for (let it = 0; it < 12; it++) {
      const mid = (lo + hi) / 2;
      let ls = 0, ln = 0, hs = 0, hn = 0;
      for (const v of s) { if (v < mid) { ls += v; ln++; } else { hs += v; hn++; } }
      if (ln) lo = ls / ln;
      if (hn) hi = hs / hn;
    }
    thresh = (lo + hi) / 2;
    lastSeparationDb = hi - lo;
    ok = lastSeparationDb >= 2;
  }
  ok = ok && lastSeparationDb >= 6;
  lastMethod = ok ? 'loudness' : 'voice';
  if (!ok) return voicePath(hostPcm, constPcm, shift, frames, durationMs, d, active, settings, preferred);

  const dead = lastSeparationDb * DEAD_ZONE[settings.sensitivity];
  type Cell = { role: Role; side: boolean };
  const cells: Cell[] = [];
  let cur: Cell = { role: d[0] >= thresh ? 'host' : 'constant', side: false };
  for (let f = 0; f < frames; f++) {
    if (active[f]) {
      if (d[f] > thresh + dead) cur = { role: 'host', side: false };
      else if (d[f] < thresh - dead) cur = { role: 'constant', side: false };
      else if (settings.bothSpeaking === 'side') cur = { role: cur.role, side: true };
    }
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

function rmsOf(a: Float32Array) { let s = 0; for (let i = 0; i < a.length; i += 7) s += a[i] * a[i]; return Math.sqrt(s / (a.length / 7)) + 1e-9; }

/** Both mics sound alike (mic bleed): tell the two people apart by their VOICE instead. */
function voicePath(hostPcm: Float32Array, constPcm: Float32Array, shift: number, frames: number, durationMs: number, d: Float32Array, active: boolean[], settings: Settings, preferred?: Role): Segment[] {
  const n = Math.min(hostPcm.length, Math.max(0, constPcm.length - shift * 1600));
  const rh = rmsOf(hostPcm), rc = rmsOf(constPcm);
  const mix = new Float32Array(n);
  // use the audio the person picked as the better one (Sound: Host / Const); otherwise mix both
  for (let i = 0; i < n; i++) {
    const a = hostPcm[i] / rh, b = (constPcm[i + shift * 1600] ?? 0) / rc;
    mix[i] = preferred === 'host' ? a : preferred === 'constant' ? b : a + b;
  }
  const r = separateByVoice(mix, frames);
  lastVoiceQuality = r.quality;
  if (r.quality < 0.6) return mergeShort([], settings.minSegmentMs, durationMs);
  // decide which cluster is Host: louder on the Host mic -> Host. No info -> first voice = Host.
  let sum0 = 0, n0 = 0, sum1 = 0, n1 = 0, first = -1;
  for (let f = 0; f < frames; f++) {
    if (!r.voiced[f]) continue;
    if (first < 0) first = r.labels[f];
    if (r.labels[f] === 0) { sum0 += d[f]; n0++; } else { sum1 += d[f]; n1++; }
  }
  const diff = (n0 ? sum0 / n0 : 0) - (n1 ? sum1 / n1 : 0);
  const hostLabel = Math.abs(diff) > 0.7 ? (diff > 0 ? 0 : 1) : first < 0 ? 0 : first;
  const raw: Segment[] = [];
  let start = 0;
  for (let f = 1; f <= frames; f++) {
    if (f === frames || r.labels[f] !== r.labels[start]) {
      raw.push({ id: uid(), startMs: start * HOP_MS, endMs: Math.min(durationMs, f * HOP_MS), style: 'one', main: r.labels[start] === hostLabel ? 'host' : 'constant', corner: 'br', size: 'M' });
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
