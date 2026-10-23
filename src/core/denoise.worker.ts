import { fft } from './fft';

const FRAME = 1024;
const HOP = 256;
const HALF = FRAME / 2;
const BINS = HALF + 1;

type Request = { pcm: ArrayBuffer; strength: number };
type Scope = {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
const scope = self as unknown as Scope;

function sampleAt(pcm: Float32Array, index: number): number {
  return index < 0 || index >= pcm.length ? 0 : pcm[index];
}

function frameRms(pcm: Float32Array, start: number): number {
  let sum = 0, count = 0;
  for (let i = 0; i < FRAME; i++) {
    const at = start + i;
    if (at < 0 || at >= pcm.length) continue;
    const value = pcm[at];
    sum += value * value;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function analyseFrame(pcm: Float32Array, start: number, window: Float32Array, re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < FRAME; i++) {
    re[i] = sampleAt(pcm, start + i) * window[i];
    im[i] = 0;
  }
  fft(re, im);
}

function reduceNoise(pcm: Float32Array, strength: number, report: (percent: number) => void): Float32Array {
  if (strength <= 0 || pcm.length === 0) {
    report(100);
    return pcm.slice();
  }

  const frameCount = Math.ceil((pcm.length + HALF) / HOP);
  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  // Find the quietest tenth of the signal without retaining every frame's spectrum.
  const rms = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    rms[f] = frameRms(pcm, f * HOP - HALF);
    if (f % 256 === 0) report(Math.round((f / frameCount) * 15));
  }
  const order = Array.from({ length: frameCount }, (_, i) => i);
  order.sort((a, b) => rms[a] - rms[b]);
  const quietCount = Math.max(1, Math.ceil(frameCount * 0.1));
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  const noise = new Float32Array(BINS);
  for (let q = 0; q < quietCount; q++) {
    const start = order[q] * HOP - HALF;
    analyseFrame(pcm, start, window, re, im);
    for (let k = 0; k < BINS; k++) noise[k] += Math.hypot(re[k], im[k]) / quietCount;
    if (q % 128 === 0) report(15 + Math.round((q / quietCount) * 10));
  }

  const output = new Float32Array(pcm.length);
  const weights = new Float32Array(pcm.length);
  const rawGain = new Float32Array(BINS), freqGain = new Float32Array(BINS), prevGain = new Float32Array(BINS);
  prevGain.fill(1);
  const amount = strength / 100;
  const overSubtract = 1 + 2.5 * amount;
  const floor = 0.5 - 0.42 * amount;

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP - HALF;
    analyseFrame(pcm, start, window, re, im);
    for (let k = 0; k < BINS; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const clean = Math.max(mag - noise[k] * overSubtract, mag * floor);
      rawGain[k] = mag > 1e-8 ? Math.max(floor, Math.min(1, clean / mag)) : 1;
    }
    for (let k = 0; k < BINS; k++) {
      const left = rawGain[Math.max(0, k - 1)];
      const right = rawGain[Math.min(BINS - 1, k + 1)];
      const acrossFrequency = left * 0.25 + rawGain[k] * 0.5 + right * 0.25;
      freqGain[k] = prevGain[k] * 0.55 + acrossFrequency * 0.45;
      prevGain[k] = freqGain[k];
      re[k] *= freqGain[k];
      im[k] *= freqGain[k];
      if (k > 0 && k < HALF) {
        const mirror = FRAME - k;
        re[mirror] *= freqGain[k];
        im[mirror] *= freqGain[k];
      }
    }
    fft(re, im, true);
    for (let i = 0; i < FRAME; i++) {
      const at = start + i;
      if (at < 0 || at >= pcm.length) continue;
      const w = window[i];
      output[at] += re[i] * w;
      weights[at] += w * w;
    }
    if (f % 128 === 0) report(25 + Math.round((f / frameCount) * 75));
  }

  for (let i = 0; i < output.length; i++) {
    if (weights[i] > 1e-8) output[i] /= weights[i];
    else output[i] = pcm[i];
  }
  report(100);
  return output;
}

scope.onmessage = (event) => {
  try {
    const { pcm: buffer, strength } = event.data;
    const cleaned = reduceNoise(new Float32Array(buffer), strength, (percent) => scope.postMessage({ type: 'progress', percent }));
    const result = cleaned.buffer as ArrayBuffer;
    scope.postMessage({ type: 'done', pcm: result }, [result]);
  } catch (error) {
    scope.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Noise reduction failed.' });
  }
};
