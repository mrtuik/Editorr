import { runtime } from './store';
import type { Project, Role } from './types';

const cache = new WeakMap<Float32Array, number>();

/** Automatic gain that brings a mic to a similar speech level (about -20 dBFS RMS). Looks at the non-silent parts only. */
export function normGain(pcm?: Float32Array): number {
  if (!pcm || !pcm.length) return 1;
  const hit = cache.get(pcm);
  if (hit !== undefined) return hit;
  const FR = 800; // 50 ms at 16 kHz
  let sum = 0, n = 0;
  for (let i = 0; i + FR <= pcm.length; i += FR) {
    let e = 0;
    for (let j = 0; j < FR; j++) e += pcm[i + j] * pcm[i + j];
    const rms = Math.sqrt(e / FR);
    if (rms > 0.003) { sum += e; n += FR; }
  }
  let g = 1;
  if (n > 0) { const rms = Math.sqrt(sum / n); if (rms > 0) g = Math.min(6, Math.max(0.3, 0.1 / rms)); }
  cache.set(pcm, g);
  return g;
}

/** Final gain for one mic: manual volume (0 to 1000 %) times the automatic normalize gain when it is on. */
export function effectiveGain(p: Project, role: Role): number {
  const vol = (role === 'host' ? p.volumeHost : p.volumeConst) ?? 100;
  let g = vol / 100;
  if (p.normalize) g *= normGain(role === 'host' ? runtime.hostPcm : runtime.constPcm);
  return g;
}
