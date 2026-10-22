import { fft, nextPow2 } from './fft';
import { rmsEnvelope } from './audio';
import type { Confidence, SyncResult } from './types';

const HOP_MS = 5;
const MAX_LAG_MS = 60_000;

function normalize(env: Float32Array): Float32Array {
  // log-compress so quiet speech still correlates, then zero-mean / unit-var
  const out = new Float32Array(env.length);
  let mean = 0;
  for (let i = 0; i < env.length; i++) { out[i] = Math.log10(1e-4 + env[i]); mean += out[i]; }
  mean /= env.length || 1;
  let v = 0;
  for (let i = 0; i < env.length; i++) { out[i] -= mean; v += out[i] * out[i]; }
  const sd = Math.sqrt(v / (env.length || 1)) || 1;
  for (let i = 0; i < env.length; i++) out[i] /= sd;
  return out;
}

/**
 * Find offset so that constantTime = hostTime + offsetMs.
 * FFT cross-correlation of log-energy envelopes (5 ms hop).
 */
export function findOffset(hostPcm: Float32Array, constPcm: Float32Array): SyncResult {
  const a = normalize(rmsEnvelope(hostPcm, HOP_MS));
  const b = normalize(rmsEnvelope(constPcm, HOP_MS));
  const n = nextPow2(a.length + b.length);
  const ar = new Float32Array(n), ai = new Float32Array(n);
  const br = new Float32Array(n), bi = new Float32Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  // corr[d] = sum_i a[i] * b[i + d]  ->  conj(A) * B
  for (let i = 0; i < n; i++) {
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ar[i] * bi[i] - ai[i] * br[i];
    ar[i] = re; ai[i] = im;
  }
  fft(ar, ai, true);

  const maxLag = Math.min(Math.round(MAX_LAG_MS / HOP_MS), Math.max(a.length, b.length) - 1);
  let best = -Infinity, bestLag = 0, sumAbs = 0, count = 0;
  for (let d = -maxLag; d <= maxLag; d++) {
    const idx = d >= 0 ? d : n + d;
    const v = ar[idx];
    sumAbs += Math.abs(v); count++;
    if (v > best) { best = v; bestLag = d; }
  }
  const meanAbs = sumAbs / (count || 1) || 1;
  const score = best / meanAbs; // peak-to-average ratio
  let confidence: Confidence = 'Low';
  if (score > 12) confidence = 'High';
  else if (score > 6) confidence = 'Medium';
  return { offsetMs: bestLag * HOP_MS, confidence, score };
}
