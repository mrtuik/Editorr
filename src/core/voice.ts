import { fft } from './fft';
import { SAMPLE_RATE } from './audio';

/**
 * Voice-based 2-speaker separation (no mic-loudness needed).
 * Works when both phones hear both people: it listens to WHO the voice is (timbre / formants),
 * not how loud it is. MFCC per 100 ms -> 2-means -> sticky 2-state Viterbi smoothing.
 */
const HOP_MS = 100;
const NFFT = 512;
const WIN = 400; // 25 ms
const NMEL = 24;
const NCEP = 13;

function hz2mel(f: number) { return 2595 * Math.log10(1 + f / 700); }
function mel2hz(m: number) { return 700 * (Math.pow(10, m / 2595) - 1); }

let FB: Float32Array[] | null = null;
function filterbank(): Float32Array[] {
  if (FB) return FB;
  const lo = hz2mel(80), hi = hz2mel(7600);
  const pts: number[] = [];
  for (let i = 0; i < NMEL + 2; i++) pts.push(Math.floor(((NFFT + 1) * mel2hz(lo + ((hi - lo) * i) / (NMEL + 1))) / SAMPLE_RATE));
  FB = [];
  for (let m = 1; m <= NMEL; m++) {
    const f = new Float32Array(NFFT / 2 + 1);
    for (let k = pts[m - 1]; k < pts[m]; k++) f[k] = (k - pts[m - 1]) / Math.max(1, pts[m] - pts[m - 1]);
    for (let k = pts[m]; k < pts[m + 1]; k++) f[k] = (pts[m + 1] - k) / Math.max(1, pts[m + 1] - pts[m]);
    FB.push(f);
  }
  return FB;
}

const HAMMING = Float32Array.from({ length: WIN }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WIN - 1)));

function mfccAt(pcm: Float32Array, start: number, out: Float64Array): number {
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  let e = 0;
  for (let i = 0; i < WIN; i++) {
    const v = (pcm[start + i] ?? 0) - 0.97 * (pcm[start + i - 1] ?? 0);
    re[i] = v * HAMMING[i];
    e += re[i] * re[i];
  }
  fft(re, im);
  const pw = new Float32Array(NFFT / 2 + 1);
  for (let k = 0; k <= NFFT / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
  const fb = filterbank();
  const logE = new Float64Array(NMEL);
  for (let m = 0; m < NMEL; m++) {
    let s = 0;
    const f = fb[m];
    for (let k = 0; k < f.length; k++) if (f[k]) s += f[k] * pw[k];
    logE[m] = Math.log(s + 1e-9);
  }
  for (let c = 1; c < NCEP; c++) {
    let s = 0;
    for (let m = 0; m < NMEL; m++) s += logE[m] * Math.cos((Math.PI * c * (m + 0.5)) / NMEL);
    out[c - 1] += s;
  }
  return e;
}

export interface VoiceResult {
  /** 0 or 1 per 100 ms frame (cluster id) */
  labels: Uint8Array;
  voiced: boolean[];
  /** cluster separation (distance between centres / average spread). < ~1.2 = weak */
  quality: number;
}

export function separateByVoice(mix: Float32Array, frames: number): VoiceResult {
  const D = NCEP - 1;
  const hop = (SAMPLE_RATE * HOP_MS) / 1000;
  const feats: Float64Array[] = [];
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const v = new Float64Array(D);
    let e = 0;
    for (let k = 0; k < 3; k++) e += mfccAt(mix, f * hop + Math.round((k * (hop - WIN)) / 2), v);
    for (let d = 0; d < D; d++) v[d] /= 3;
    energy[f] = 10 * Math.log10(e / 3 / WIN + 1e-12);
    feats.push(v);
  }
  const sorted = Float64Array.from(energy).sort();
  const floor = sorted[Math.floor(0.1 * frames)] ?? -90;
  const top = sorted[Math.floor(0.95 * frames)] ?? floor;
  const gate = floor + Math.max(6, (top - floor) * 0.25);
  const voiced = Array.from(energy, (e) => e > gate);

  // temporal smoothing of features (+-2 frames, voiced only)
  const sm: Float64Array[] = feats.map((v, f) => {
    const o = new Float64Array(D);
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const g = f + k;
      if (g < 0 || g >= frames || !voiced[g]) continue;
      n++;
      for (let d = 0; d < D; d++) o[d] += feats[g][d];
    }
    if (n) for (let d = 0; d < D; d++) o[d] /= n;
    return o;
  });

  // standardise on voiced frames
  const idx: number[] = [];
  voiced.forEach((v, i) => v && idx.push(i));
  const labels = new Uint8Array(frames);
  if (idx.length < 40) return { labels, voiced, quality: 0 };
  const mean = new Float64Array(D), sd = new Float64Array(D);
  for (const i of idx) for (let d = 0; d < D; d++) mean[d] += sm[i][d] / idx.length;
  for (const i of idx) for (let d = 0; d < D; d++) sd[d] += (sm[i][d] - mean[d]) ** 2 / idx.length;
  for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d]) + 1e-6;
  const X = sm.map((v) => Float64Array.from(v, (x, d) => (x - mean[d]) / sd[d]));

  const dist2 = (a: Float64Array, b: Float64Array) => { let s = 0; for (let d = 0; d < D; d++) s += (a[d] - b[d]) ** 2; return s; };

  // k-means, several deterministic restarts
  let best: { c: Float64Array[]; inertia: number } | null = null;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let r = 0; r < 8; r++) {
    let c0 = X[idx[Math.floor(rnd() * idx.length)]];
    let far = idx[0], fd = -1;
    for (const i of idx) { const d = dist2(X[i], c0); if (d > fd) { fd = d; far = i; } }
    let c: Float64Array[] = [Float64Array.from(c0), Float64Array.from(X[far])];
    let inertia = 0;
    for (let it = 0; it < 20; it++) {
      const sum = [new Float64Array(D), new Float64Array(D)], cnt = [0, 0];
      inertia = 0;
      for (const i of idx) {
        const a = dist2(X[i], c[0]), b = dist2(X[i], c[1]);
        const k = a <= b ? 0 : 1;
        inertia += Math.min(a, b);
        cnt[k]++;
        for (let d = 0; d < D; d++) sum[k][d] += X[i][d];
      }
      c = c.map((old, k) => (cnt[k] ? Float64Array.from(sum[k], (x) => x / cnt[k]) : old));
    }
    if (!best || inertia < best.inertia) best = { c, inertia };
  }
  const cent = best!.c;

  // per-cluster diagonal Gaussians
  const mu = [new Float64Array(D), new Float64Array(D)], va = [new Float64Array(D).fill(1e-3), new Float64Array(D).fill(1e-3)], n = [0, 0];
  const assign = idx.map((i) => (dist2(X[i], cent[0]) <= dist2(X[i], cent[1]) ? 0 : 1));
  idx.forEach((i, j) => { n[assign[j]]++; for (let d = 0; d < D; d++) mu[assign[j]][d] += X[i][d]; });
  for (let k = 0; k < 2; k++) for (let d = 0; d < D; d++) mu[k][d] /= Math.max(1, n[k]);
  idx.forEach((i, j) => { for (let d = 0; d < D; d++) va[assign[j]][d] += (X[i][d] - mu[assign[j]][d]) ** 2 / Math.max(1, n[assign[j]]); });
  const spread = Math.sqrt(va.reduce((s, v) => s + v.reduce((a, b) => a + b, 0) / D, 0) / 2);
  const quality = Math.sqrt(dist2(cent[0], cent[1])) / (spread * Math.sqrt(D) + 1e-9);

  const ll = (x: Float64Array, k: number) => {
    let s = 0;
    for (let d = 0; d < D; d++) s -= 0.5 * (Math.log(va[k][d]) + (x[d] - mu[k][d]) ** 2 / va[k][d]);
    return s;
  };

  // Viterbi with sticky switching
  const PEN = 15;
  let s0 = 0, s1 = 0;
  const from: [Uint8Array, Uint8Array] = [new Uint8Array(frames), new Uint8Array(frames)];
  for (let f = 0; f < frames; f++) {
    const e0 = voiced[f] ? ll(X[f], 0) : 0, e1 = voiced[f] ? ll(X[f], 1) : 0;
    const a0 = s0, a1 = s1 - PEN, b0 = s0 - PEN, b1 = s1;
    from[0][f] = a0 >= a1 ? 0 : 1; from[1][f] = b0 >= b1 ? 0 : 1;
    s0 = Math.max(a0, a1) + e0; s1 = Math.max(b0, b1) + e1;
  }
  let st = s0 >= s1 ? 0 : 1;
  for (let f = frames - 1; f >= 0; f--) { labels[f] = st; st = from[st][f]; }
  return { labels, voiced, quality };
}
