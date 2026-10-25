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

export type SfxKind = 'whoosh' | 'pop' | 'ding' | 'hit' | 'riser' | 'boom' | 'crickets' | 'cash' | 'trombone' | 'boing' | 'applause' | 'laugh';
export const SFX_LABEL: Record<SfxKind, string> = { whoosh: 'Whoosh', pop: 'Pop', ding: 'Ding', hit: 'Hit', riser: 'Riser', boom: 'Boom', crickets: 'Crickets', cash: 'Cha-ching', trombone: 'Sad trombone', boing: 'Boing', applause: 'Applause', laugh: 'Laugh' };

export function synthSfx(kind: SfxKind): Float32Array {
  const r = rng(99 + kind.length);
  const R = BGM_RATE;
  if (kind === 'boom') { // vine-boom style: a deep dropping thump with a bit of crunch
    const out = new Float32Array(Math.round(0.9 * R)); let ph = 0;
    for (let k = 0; k < out.length; k++) { const t = k / R; ph += TAU * (40 + 110 * Math.exp(-t * 9)) / R; out[k] = Math.tanh(2.2 * Math.sin(ph)) * Math.exp(-t * 3.2); }
    noiseHit(out, 0, 0.08, 0.5, r, 0.4); return out;
  }
  if (kind === 'crickets') { // three groups of quick high chirps
    const out = new Float32Array(Math.round(2.4 * R));
    for (let g = 0; g < 3; g++) for (let q = 0; q < 3; q++) {
      const at = Math.round((0.1 + g * 0.75 + q * 0.075) * R), n = Math.round(0.05 * R);
      for (let k = 0; k < n; k++) { const t = k / R; out[at + k]! += Math.sin(TAU * 4600 * t) * Math.sin(Math.PI * k / n) * 0.5; }
    }
    return out;
  }
  if (kind === 'cash') { // two bright bell hits
    const out = new Float32Array(Math.round(1.2 * R));
    for (const [at, f] of [[0, 2093], [0.09, 2637]] as [number, number][]) {
      const s0 = Math.round(at * R);
      for (let k = 0; s0 + k < out.length; k++) { const t = k / R; out[s0 + k]! += (Math.sin(TAU * f * t) + 0.4 * Math.sin(TAU * f * 2.76 * t)) * Math.exp(-t * 7) * 0.4; }
    }
    noiseHit(out, 0, 0.02, 0.4, r, 0.9); return out;
  }
  if (kind === 'trombone') { // wah wah wah waaah
    const notes: [number, number, number][] = [[233, 0.38, 0], [220, 0.38, 0.4], [208, 0.38, 0.8], [196, 1.0, 1.2]];
    const out = new Float32Array(Math.round(2.4 * R));
    for (const [f0, dur, at] of notes) {
      const s0 = Math.round(at * R), n = Math.round(dur * R); let ph = 0, y = 0;
      for (let k = 0; k < n; k++) {
        const t = k / R, last = dur > 0.9;
        const f = f0 * (last ? 1 - 0.14 * Math.max(0, (t - 0.3) / 0.7) : 1) * (1 + (last ? 0.012 * Math.sin(TAU * 6 * t) : 0));
        ph = (ph + f / R) % 1;
        y += ((2 * ph - 1) - y) * (0.08 + 0.1 * Math.min(1, t * 6));
        const e = Math.min(1, k / (0.03 * R)) * Math.min(1, (n - k) / (0.08 * R));
        out[s0 + k]! += (y * 1.6 + Math.sin(TAU * ph) * 0.3) * e * 0.5;
      }
    }
    return out;
  }
  if (kind === 'boing') { // cartoon spring
    const out = new Float32Array(Math.round(0.7 * R)); let ph = 0;
    for (let k = 0; k < out.length; k++) { const t = k / R; ph += TAU * (260 + 380 * Math.exp(-t * 5) + 70 * Math.sin(TAU * 17 * t) * Math.exp(-t * 3)) / R; out[k] = Math.sin(ph) * Math.exp(-t * 4.5) * 0.9; }
    return out;
  }
  if (kind === 'applause') { // a crowd of claps
    const out = new Float32Array(Math.round(2.2 * R));
    for (let c = 0; c < 140; c++) { const t = r() * 1.9, swell = Math.sin(Math.PI * Math.min(1, t / 1.9)) ** 0.6; noiseHit(out, t, 0.025, (0.25 + r() * 0.5) * swell, r, 0.75); }
    return out;
  }
  if (kind === 'laugh') { // ha ha ha ha
    const out = new Float32Array(Math.round(1.3 * R));
    for (let b = 0; b < 4; b++) {
      const s0 = Math.round((0.05 + b * 0.24) * R), n = Math.round(0.14 * R), f0 = 270 - b * 14;
      for (let k = 0; k < n; k++) {
        const t = k / R; let v = 0;
        for (let hnum = 1; hnum <= 10; hnum++) { const f = hnum * f0, g = Math.exp(-(((f - 750) / 320) ** 2)) + 0.6 * Math.exp(-(((f - 1250) / 420) ** 2)); v += Math.sin(TAU * f * t) * g / hnum ** 0.3; }
        out[s0 + k]! += (v * 0.25 + (r() * 2 - 1) * 0.08) * Math.sin(Math.PI * k / n);
      }
    }
    return out;
  }
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
