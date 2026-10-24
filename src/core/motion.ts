/** Turns lip movement (per 100 ms) into a 0..1 "is this person talking" curve, smoothed over about 1 s. */
export function motionToActivity(m: Float32Array): Float32Array {
  const s = Float32Array.from(m).sort();
  const p20 = s[Math.floor(0.2 * s.length)] ?? 0, p90 = s[Math.floor(0.9 * s.length)] ?? 1;
  const span = Math.max(1e-3, p90 - p20);
  const z = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) z[i] = Math.max(-0.5, Math.min(2, (m[i] - p20) / span));
  const out = new Float32Array(m.length);
  const R = 4;
  for (let i = 0; i < m.length; i++) {
    let a = 0, c = 0;
    for (let k = -R; k <= R; k++) { const j = i + k; if (j >= 0 && j < m.length) { a += z[j]; c++; } }
    out[i] = a / c;
  }
  return out;
}
