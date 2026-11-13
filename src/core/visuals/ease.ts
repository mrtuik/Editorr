/**
 * Easing curves exactly as open-motion defines them (shared/motion/easing.ts, MIT, see THIRD_PARTY.md): the CSS keywords plus
 * PRESET_BEZIER. One cubic-bezier solver evaluates all of them, so a card, a word and a bar all use the same maths as the web runtime.
 * The older names (out, inOut, expo) stay so beats saved before this change still redraw.
 */
export type EaseName =
  | 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
  | 'ease-in-quad' | 'ease-out-quad' | 'ease-in-out-quad' | 'ease-in-cubic' | 'ease-out-cubic' | 'ease-in-out-cubic'
  | 'bounce' | 'back' | 'elastic' | 'snappy' | 'smooth' | 'soft'
  | 'out' | 'inOut' | 'expo';

const BEZIER: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
  'ease-in-quad': [0.11, 0, 0.5, 0], 'ease-out-quad': [0.5, 1, 0.89, 1], 'ease-in-out-quad': [0.45, 0, 0.55, 1],
  'ease-in-cubic': [0.32, 0, 0.67, 0], 'ease-out-cubic': [0.33, 1, 0.68, 1], 'ease-in-out-cubic': [0.65, 0, 0.35, 1],
  bounce: [0.68, -0.6, 0.32, 1.6], back: [0.34, 1.56, 0.64, 1], elastic: [0.5, -0.6, 0.1, 1.4],
  snappy: [0.2, 0.8, 0.2, 1], smooth: [0.45, 0, 0.15, 1], soft: [0.4, 0, 0.6, 1],
  // legacy ids
  out: [0.33, 1, 0.68, 1], inOut: [0.65, 0, 0.35, 1], expo: [0.16, 1, 0.3, 1],
};

/** cubic-bezier(x1,y1,x2,y2) as a function of time 0..1 (Newton steps, then bisection, same as CSS). */
export function bezierFn(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t, sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-6) return sy(t); const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
    let lo = 0, hi = 1; t = x;
    while (lo < hi) { const e = sx(t); if (Math.abs(e - x) < 1e-6) break; if (x > e) lo = t; else hi = t; t = (hi - lo) / 2 + lo; if (hi - lo < 1e-7) break; }
    return sy(t);
  };
}

const CACHE = new Map<string, (t: number) => number>();
export function easeFn(n: EaseName | string): (t: number) => number {
  if (n === 'linear') return t => Math.max(0, Math.min(1, t));
  let f = CACHE.get(n);
  if (!f) { const b = BEZIER[n] ?? BEZIER['ease-out']!; f = bezierFn(b[0], b[1], b[2], b[3]); CACHE.set(n, f); }
  return f;
}

/** 0..1 progress of something that starts `delayMs` into the visual and lasts `durMs`, eased. */
export const timed = (ms: number, delayMs: number, durMs: number, ease: EaseName | string = 'ease-out'): number =>
  easeFn(ease)(Math.max(0, Math.min(1, (ms - delayMs) / Math.max(1, durMs))));
