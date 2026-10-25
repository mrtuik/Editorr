/**
 * Background music + sound effects, made on the phone:
 * songs are joined (2 s crossfade, looped if short), set to a level under the voice, ducked while someone talks,
 * mixed with the effects at their times, and saved as ONE wav at timeline time. Preview and export play that same wav.
 */
import { rmsEnvelope } from './audio';

export const BGM_RATE = 44100;
const FRAME = 50;

export async function decodeFile(file: File): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, BGM_RATE); // decodeAudioData resamples to this rate
  return ctx.decodeAudioData(await file.arrayBuffer());
}

/** Decode a song that is a file on the phone (for example audio saved from YouTube). */
export async function decodeUrl(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Cannot open the audio file');
  const ctx = new OfflineAudioContext(1, 1, BGM_RATE);
  return ctx.decodeAudioData(await res.arrayBuffer());
}

function mono(b: AudioBuffer): Float32Array {
  if (b.numberOfChannels === 1) return b.getChannelData(0);
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < out.length; i++) out[i] += d[i] / b.numberOfChannels; }
  return out;
}
const rmsDb = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0, n = 0;
  for (let i = from; i < to; i += 4) { s += a[i] * a[i]; n++; }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-12);
};

export interface MixInput {
  songs: AudioBuffer[];
  sfx: { buf: AudioBuffer; startMs: number; gain?: number }[];
  /** Songs placed by hand (Music > Music): start at startMs, played once, level compared with the voice. */
  clips?: { buf: AudioBuffer; startMs: number; levelDb: number; duck: boolean; endMs?: number; loop?: boolean }[];
  durationMs: number;
  /** the voice (mono 16 kHz) and where its time 0 is on the timeline */
  voice?: Float32Array;
  voiceShiftMs: number;
  /** music level compared with the voice, in dB (negative) */
  levelDb: number;
  /** how far the music drops while someone talks, in dB */
  duckDb: number;
  fadeMs: number;
}

/** Per 50 ms: 1 = music at full level, lower = ducked. Plus the loudness of the voice in dB. */
function duckCurve(i: MixInput): { curve: Float32Array; voiceDb: number } {
  const frames = Math.ceil(i.durationMs / FRAME) + 2;
  const curve = new Float32Array(frames).fill(1);
  if (!i.voice) return { curve, voiceDb: -20 };
  const env = rmsEnvelope(i.voice, FRAME);
  const shift = Math.round(i.voiceShiftMs / FRAME);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) db[f] = 20 * Math.log10((env[f + shift] ?? 0) + 1e-6);
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(0.1 * sorted.length)] ?? -80;
  const speech = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) speech[f] = db[f] > floor + 10 ? 1 : 0;
  // short gaps inside a sentence do not bring the music back up
  const gap = Math.round(300 / FRAME);
  for (let f = 0; f < frames; f++) {
    if (speech[f]) continue;
    let k = f; while (k < frames && !speech[k]) k++;
    if (k - f <= gap && f > 0 && k < frames) for (let q = f; q < k; q++) speech[q] = 1;
    f = k;
  }
  const target = Math.pow(10, -i.duckDb / 20);
  const att = 1 - Math.exp(-FRAME / 150), rel = 1 - Math.exp(-FRAME / 400);
  let y = 1;
  const loud: number[] = [];
  for (let f = 0; f < frames; f++) {
    const g = speech[f] ? target : 1;
    y += (g - y) * (g < y ? att : rel);
    curve[f] = y;
    if (speech[f]) loud.push(db[f]);
  }
  loud.sort((a, b) => a - b);
  return { curve, voiceDb: loud.length ? loud[Math.floor(loud.length / 2)] : -20 };
}

/** Mono 44.1 kHz mix, the length of the video. */
export function renderMix(i: MixInput): Float32Array {
  const N = Math.ceil((i.durationMs / 1000) * BGM_RATE);
  const out = new Float32Array(N);
  const { curve, voiceDb } = duckCurve(i);

  if (i.songs.length) {
    const cross = Math.round((2000 / 1000) * BGM_RATE);
    const tracks = i.songs.map(mono);
    let start = 0, idx = 0;
    while (start < N && idx < 200) {
      const t = tracks[idx % tracks.length];
      const len = t.length;
      const c = Math.min(cross, Math.floor(len / 3));
      const nextStart = start + len - c;
      const hasNext = nextStart < N;
      for (let j = 0; j < len && start + j < N; j++) {
        let w = 1;
        if (idx > 0 && j < c) w = j / c;
        if (hasNext && j > len - c) w = Math.min(w, (len - j) / c);
        out[start + j] += t[j] * w;
      }
      start = nextStart; idx++;
    }
    // level under the voice
    const mixDb = rmsDb(out);
    const gain = Math.min(10, Math.pow(10, (voiceDb + i.levelDb - mixDb) / 20));
    const fade = Math.max(1, Math.round((i.fadeMs / 1000) * BGM_RATE));
    for (let k = 0; k < N; k++) {
      const pos = (k / BGM_RATE) * 1000 / FRAME;
      const f0 = Math.floor(pos), fr = pos - f0;
      const d = (curve[f0] ?? 1) * (1 - fr) + (curve[f0 + 1] ?? 1) * fr;
      let w = gain * d;
      if (k < fade) w *= k / fade;
      if (k > N - fade) w *= (N - k) / fade;
      out[k] *= w;
    }
  }
  // hand-placed songs: start where the user put them, play once, cut at the end of the video
  for (const c of i.clips ?? []) {
    const t = mono(c.buf);
    const at = Math.max(0, Math.round((c.startMs / 1000) * BGM_RATE));
    const want = c.endMs !== undefined ? Math.round(((c.endMs - c.startMs) / 1000) * BGM_RATE) : t.length;
    const len = Math.min(c.loop ? Infinity : t.length, want, N - at);
    if (len <= 0 || !isFinite(len)) continue;
    const g = Math.min(10, Math.pow(10, (voiceDb + c.levelDb - rmsDb(t)) / 20));
    const fade = Math.max(1, Math.min(Math.round((i.fadeMs / 1000) * BGM_RATE), Math.floor(len / 2)));
    for (let k = 0; k < len; k++) {
      let d = 1;
      if (c.duck) {
        const pos = ((at + k) / BGM_RATE) * 1000 / FRAME;
        const f0 = Math.floor(pos), fr = pos - f0;
        d = (curve[f0] ?? 1) * (1 - fr) + (curve[f0 + 1] ?? 1) * fr;
      }
      let w = g * d;
      if (k < fade) w *= k / fade;
      if (k > len - fade) w *= (len - k) / fade;
      out[at + k] += t[k % t.length] * w;
    }
  }
  // effects: peak 0.7 of full scale, not ducked
  for (const s of i.sfx) {
    const t = mono(s.buf);
    let peak = 1e-6; for (let k = 0; k < t.length; k++) peak = Math.max(peak, Math.abs(t[k]));
    const g = (0.7 / peak) * (s.gain ?? 1);
    const at = Math.round((s.startMs / 1000) * BGM_RATE);
    for (let k = 0; k < t.length && at + k < N; k++) if (at + k >= 0) out[at + k] += t[k] * g;
  }
  for (let k = 0; k < N; k++) out[k] = Math.max(-1, Math.min(1, out[k]));
  return out;
}

export function toWav(mono16: Float32Array, rate = BGM_RATE): Uint8Array {
  const n = mono16.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let k = 0; k < n; k++) v.setInt16(44 + k * 2, Math.round(mono16[k] * 32767), true);
  return new Uint8Array(buf);
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(s);
}

/** An AudioBuffer made from samples (mono, 44.1 kHz). */
export function toBuffer(samples: Float32Array): AudioBuffer {
  const b = new OfflineAudioContext(1, 1, BGM_RATE).createBuffer(1, samples.length, BGM_RATE);
  b.getChannelData(0).set(samples);
  return b;
}
