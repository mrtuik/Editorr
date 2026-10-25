/**
 * Music and sound effects made from nothing, on the phone (no internet, no copyright).
 * Used when a song cannot be fetched, and for Auto SFX.
 */
import { BGM_RATE } from './bgm';
import type { Mood } from './mood';

const TAU = Math.PI * 2;
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** Tiny deterministic random so the same mood sounds the same. */
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

function tone(out: Float32Array, at: number, dur: number, midi: number, amp: number, o: { saw?: number; attack?: number; release?: number; decay?: number } = {}) {
  const f = hz(midi), a0 = Math.max(1, Math.round((o.attack ?? 0.02) * BGM_RATE)), rel = Math.max(1, Math.round((o.release ?? 0.15) * BGM_RATE));
  const n = Math.round(dur * BGM_RATE), start = Math.round(at * BGM_RATE), dec = o.decay ?? 0;
  const saw = o.saw ?? 0;
  for (let k = 0; k < n + rel; k++) {
    const i = start + k; if (i < 0 || i >= out.length) continue;
    const t = k / BGM_RATE, ph = (f * t) % 1;
    let w = Math.sin(TAU * ph) * (1 - saw) + (2 * ph - 1) * saw * 0.6;
    w += Math.sin(TAU * ph * 2) * 0.15;
    let e = k < a0 ? k / a0 : 1;
    if (dec > 0) e *= Math.exp(-t * dec);
    if (k > n) e *= Math.max(0, 1 - (k - n) / rel);
    out[i]! += w * e * amp;
  }
}
function noiseHit(out: Float32Array, at: number, dur: number, amp: number, r: () => number, lp = 0.3) {
  const n = Math.round(dur * BGM_RATE), start = Math.round(at * BGM_RATE); let y = 0;
  for (let k = 0; k < n; k++) { const i = start + k; if (i >= out.length) break; y += (r() * 2 - 1 - y) * lp; out[i]! += y * amp * Math.pow(1 - k / n, 2); }
}
function kick(out: Float32Array, at: number, amp: number) {
  const n = Math.round(0.28 * BGM_RATE), start = Math.round(at * BGM_RATE); let ph = 0;
  for (let k = 0; k < n; k++) { const i = start + k; if (i >= out.length) break; const t = k / BGM_RATE; ph += TAU * (45 + 90 * Math.exp(-t * 28)) / BGM_RATE; out[i]! += Math.sin(ph) * Math.exp(-t * 11) * amp; }
}

interface Style { bpm: number; chords: number[][]; bass: number[]; pad: number; arp: number; beat: 'none' | 'soft' | 'four' | 'bounce'; saw: number; decay: number }
const STYLE: Record<Mood, Style> = {
  calm:      { bpm: 72,  chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], bass: [45, 41, 36, 43], pad: 0.10, arp: 0.07, beat: 'soft',   saw: 0.05, decay: 3 },
  emotional: { bpm: 66,  chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], bass: [45, 41, 36, 43], pad: 0.12, arp: 0.10, beat: 'none',   saw: 0.00, decay: 2 },
  energetic: { bpm: 122, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], bass: [45, 41, 36, 43], pad: 0.07, arp: 0.08, beat: 'four',   saw: 0.45, decay: 6 },
  funny:     { bpm: 108, chords: [[60, 64, 67], [65, 69, 72], [55, 59, 62], [60, 64, 67]], bass: [48, 53, 43, 48], pad: 0.04, arp: 0.12, beat: 'bounce', saw: 0.10, decay: 9 },
  serious:   { bpm: 82,  chords: [[45, 48, 52], [43, 46, 50], [41, 45, 48], [40, 44, 47]], bass: [33, 31, 29, 28], pad: 0.12, arp: 0.04, beat: 'soft',   saw: 0.30, decay: 1.5 },
};

/** One loop of music (8 bars) for a mood, mono. */
export function synthLoop(mood: Mood, seed = 7): Float32Array {
  const st = STYLE[mood], r = rng(seed + mood.length * 31);
  const beat = 60 / st.bpm, bar = beat * 4, bars = 8;
  const out = new Float32Array(Math.round(bar * bars * BGM_RATE));
  for (let b = 0; b < bars; b++) {
    const ci = b % 4, t0 = b * bar, chord = st.chords[ci]!;
    for (const m of chord) tone(out, t0, bar * 0.98, m, st.pad, { attack: 0.35, release: 0.6, saw: st.saw });
    tone(out, t0, beat * 1.9, st.bass[ci]!, 0.16, { attack: 0.02, release: 0.2, decay: 1.2 });
    tone(out, t0 + beat * 2, beat * 1.9, st.bass[ci]!, 0.12, { attack: 0.02, release: 0.2, decay: 1.2 });
    const steps = st.beat === 'four' || st.beat === 'bounce' ? 8 : 4;
    for (let s = 0; s < steps; s++) {
      const m = chord[(s + (r() < 0.25 ? 1 : 0)) % 3]! + (s % 3 === 2 ? 12 : 0);
      tone(out, t0 + (s * bar) / steps, bar / steps * 0.9, m + 12, st.arp, { attack: 0.005, release: 0.1, decay: st.decay });
    }
    for (let q = 0; q < 4; q++) {
      const at = t0 + q * beat;
      if (st.beat === 'four') { kick(out, at, 0.5); noiseHit(out, at + beat / 2, 0.05, 0.12, r, 0.9); noiseHit(out, at + beat, 0.12, 0.18, r, 0.5); }
      else if (st.beat === 'soft') { if (q % 2 === 0) kick(out, at, 0.28); noiseHit(out, at + beat / 2, 0.04, 0.05, r, 0.9); }
      else if (st.beat === 'bounce') { if (q % 2 === 0) kick(out, at, 0.35); if (q % 2 === 1) noiseHit(out, at, 0.08, 0.14, r, 0.5); }
    }
  }
  // smooth the loop seam
  const x = Math.round(0.4 * BGM_RATE);
  for (let k = 0; k < x; k++) { const w = k / x; out[k]! *= w; out[out.length - 1 - k]! *= w; }
  let peak = 1e-6; for (let k = 0; k < out.length; k++) peak = Math.max(peak, Math.abs(out[k]!));
  for (let k = 0; k < out.length; k++) out[k]! *= 0.8 / peak;
  return out;
}

export type SfxKind = 'whoosh' | 'pop' | 'ding' | 'hit' | 'riser';
export const SFX_LABEL: Record<SfxKind, string> = { whoosh: 'Whoosh', pop: 'Pop', ding: 'Ding', hit: 'Hit', riser: 'Riser' };

export function synthSfx(kind: SfxKind): Float32Array {
  const r = rng(99 + kind.length);
  if (kind === 'whoosh' || kind === 'riser') {
    const dur = kind === 'whoosh' ? 0.65 : 1.6, n = Math.round(dur * BGM_RATE), out = new Float32Array(n);
    let y = 0;
    for (let k = 0; k < n; k++) {
      const p = k / n, env = kind === 'whoosh' ? Math.sin(Math.PI * p) ** 1.5 : p * p;
      const a = kind === 'whoosh' ? 0.04 + 0.5 * Math.sin(Math.PI * p) : 0.03 + 0.5 * p;
      y += (r() * 2 - 1 - y) * a; out[k] = y * env;
    }
    return out;
  }
  if (kind === 'pop') { const out = new Float32Array(Math.round(0.14 * BGM_RATE)); tone(out, 0, 0.05, 84, 0.9, { attack: 0.002, release: 0.08, decay: 30 }); noiseHit(out, 0, 0.02, 0.4, r, 0.8); return out; }
  if (kind === 'ding') { const out = new Float32Array(Math.round(1.1 * BGM_RATE)); tone(out, 0, 0.9, 88, 0.6, { attack: 0.002, release: 0.2, decay: 4 }); tone(out, 0, 0.9, 100, 0.25, { attack: 0.002, release: 0.2, decay: 6 }); return out; }
  const out = new Float32Array(Math.round(0.7 * BGM_RATE)); kick(out, 0, 0.9); noiseHit(out, 0, 0.35, 0.6, r, 0.25); return out;
}
