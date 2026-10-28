/**
 * Retakes found by SOUND ONLY (no Whisper, no internet): when someone says a sentence again after a pause, the second
 * attempt sounds like the first. Each phrase (speech between pauses) becomes a small "sound shape" over time, and a phrase
 * that the next one repeats from its start is dropped, keeping the last attempt.
 * Less exact than the word-based search, so the thresholds are strict and the agent tells the user to check the timeline.
 */
import { SAMPLE_RATE } from './audio';
import { fft } from './fft';
import type { Range } from './timeline';

const HOP = 320;          // 20 ms
const WIN = 512;
const BANDS = 20;
const MAX_DIST = 0.25;    // 0 = identical sound shape, ~1 = unrelated (strict on purpose: a wrong cut is worse than a missed retake)
const PAUSE_FRAMES = 22;  // 440 ms of quiet splits two phrases

export interface Phrase { a: number; b: number }

/** Log energy in BANDS bands (100 Hz - 4 kHz) per 20 ms frame, plus loudness per frame. */
export function frames(pcm: Float32Array): { feat: Float32Array[]; rms: Float32Array } {
  const n = Math.max(0, Math.floor((pcm.length - WIN) / HOP));
  const feat: Float32Array[] = new Array(n);
  const rms = new Float32Array(n);
  const re = new Float32Array(WIN), im = new Float32Array(WIN);
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
  const binHz = SAMPLE_RATE / WIN;
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) edges.push(Math.round((100 * Math.pow(40, b / BANDS)) / binHz));
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = 0; i < WIN; i++) { const v = pcm[f * HOP + i]!; re[i] = v * hann[i]!; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / WIN);
    fft(re, im);
    const out = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      const lo = edges[b]!, hi = Math.max(lo + 1, edges[b + 1]!);
      for (let k = lo; k < hi; k++) sum += re[k]! * re[k]! + im[k]! * im[k]!;
      out[b] = Math.log(sum / (hi - lo) + 1e-9);
    }
    feat[f] = out;
  }
  return { feat, rms };
}

/** Speech phrases split at pauses (frame indexes). */
export function findPhrases(rms: Float32Array): Phrase[] {
  if (!rms.length) return [];
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const thr = Math.max(0.006, sorted[Math.floor(sorted.length * 0.8)]! * 0.18);
  const out: Phrase[] = [];
  let start = -1, quiet = 0;
  for (let f = 0; f < rms.length; f++) {
    if (rms[f]! >= thr) { if (start < 0) start = f; quiet = 0; }
    else if (start >= 0 && ++quiet >= PAUSE_FRAMES) { out.push({ a: start, b: f - quiet + 1 }); start = -1; quiet = 0; }
  }
  if (start >= 0) out.push({ a: start, b: rms.length });
  return out.filter((p) => p.b - p.a >= 40);
}

/** Per-phrase shape: every 2nd frame, minus the phrase average, unit length (so voice level and tone do not matter). */
export function shape(feat: Float32Array[], p: Phrase): Float32Array[] {
  const rows: Float32Array[] = [];
  for (let f = p.a; f < p.b; f += 2) rows.push(feat[f]!);
  const mean = new Float32Array(BANDS);
  for (const r of rows) for (let b = 0; b < BANDS; b++) mean[b]! += r[b]! / rows.length;
  return rows.map((r) => {
    const o = new Float32Array(BANDS);
    let n = 0;
    for (let b = 0; b < BANDS; b++) { o[b] = r[b]! - mean[b]!; n += o[b]! * o[b]!; }
    n = Math.sqrt(n) || 1;
    for (let b = 0; b < BANDS; b++) o[b]! /= n;
    return o;
  });
}

/** Distance of phrase A to the START of phrase B (DTW, B may continue after A ends). 0 = same sound, ~1 = unrelated. */
export function startDistance(A: Float32Array[], B: Float32Array[]): number {
  const n = A.length, m = B.length;
  if (!n || !m) return 1;
  const INF = 1e9;
  let prev = new Float32Array(m).fill(INF), cur = new Float32Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let dot = 0;
      for (let b = 0; b < BANDS; b++) dot += A[i]![b]! * B[j]![b]!;
      const d = 1 - dot;
      if (i === 0) cur[j] = j === 0 ? d : cur[j - 1]! + d;
      else {
        let best = prev[j]!;
        if (j > 0) best = Math.min(best, prev[j - 1]!, cur[j - 1]!);
        cur[j] = best + d;
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  // best end point inside B; a path of n..n+j steps, so divide by its length
  let best = INF;
  for (let j = Math.floor(n * 0.6); j < m; j++) best = Math.min(best, prev[j]! / (n + j));
  return best >= INF ? 1 : best;
}

/** Drop a phrase when the next phrase (within 6 s) repeats it from its start and is at least as long. Returns ms ranges (timeline = source time). */
export function acousticRetakes(pcm: Float32Array): { cuts: Range[]; count: number } {
  const { feat, rms } = frames(pcm);
  const phrases = findPhrases(rms);
  const cuts: Range[] = [];
  const msPerFrame = (HOP / SAMPLE_RATE) * 1000;
  for (let i = 0; i + 1 < phrases.length; i++) {
    const A = phrases[i]!, B = phrases[i + 1]!;
    const lenA = A.b - A.a, lenB = B.b - B.a;
    if (lenA > 1000 || (B.a - A.b) * msPerFrame > 6000) continue; // phrase longer than 20 s, or too far apart
    if (lenB < lenA * 0.85) continue;                             // the second one must be a full retry
    const d = startDistance(shape(feat, A), shape(feat, B));
    if (d <= MAX_DIST) {
      cuts.push({ startMs: Math.round(A.a * msPerFrame) + 20, endMs: Math.round(B.a * msPerFrame) - 20 });
    }
  }
  return { cuts: cuts.filter((c) => c.endMs - c.startMs >= 300), count: cuts.length };
}
