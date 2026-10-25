/**
 * Mood of the video, found on the phone from the voice (loudness, speed, ups and downs) and the spoken words.
 * The video is cut into sections of one mood; each section gets its own music.
 */
import { rmsEnvelope, SAMPLE_RATE } from './audio';
import type { CapWord } from './captions';

export type Mood = 'calm' | 'emotional' | 'energetic' | 'funny' | 'serious';
export interface MoodSection { startMs: number; endMs: number; mood: Mood }
export type MusicLang = 'en' | 'hi' | 'te';

export const MOOD_LABEL: Record<Mood, string> = { calm: 'Calm', emotional: 'Emotional', energetic: 'Energetic', funny: 'Funny', serious: 'Serious' };

const WORDS: Record<Exclude<Mood, 'calm'>, string[]> = {
  emotional: ['sad', 'cry', 'crying', 'miss', 'love', 'pain', 'mother', 'father', 'loss', 'lost', 'heart', 'alone', 'sorry', 'tears', 'dil', 'pyaar', 'pyar', 'maa', 'dard', 'yaad', 'akela', 'ammayi', 'prema', 'amma', 'bada'],
  funny: ['haha', 'lol', 'funny', 'joke', 'comedy', 'laugh', 'hasi', 'mazak', 'masti', 'hilarious', 'prank'],
  energetic: ['amazing', 'wow', 'fire', 'crazy', 'win', 'won', 'best', 'power', 'josh', 'party', 'dance', 'gym', 'goal', 'champion', 'mass'],
  serious: ['news', 'government', 'crime', 'war', 'police', 'court', 'scam', 'fact', 'danger', 'death', 'attack', 'problem', 'issue', 'sarkar'],
};

const QUERY: Record<Mood, Record<MusicLang, string>> = {
  calm: { en: 'calm lofi chill instrumental background music', hi: 'bollywood soft instrumental lofi background music', te: 'telugu melody instrumental lofi background music' },
  emotional: { en: 'emotional sad piano instrumental background music', hi: 'bollywood sad emotional instrumental background music', te: 'telugu emotional bgm instrumental' },
  energetic: { en: 'upbeat energetic background music no copyright', hi: 'bollywood upbeat dance instrumental background music', te: 'telugu mass bgm instrumental energetic' },
  funny: { en: 'funny comedy quirky background music', hi: 'hindi comedy funny bgm background music', te: 'telugu comedy bgm background music' },
  serious: { en: 'cinematic dark tension background music no copyright', hi: 'bollywood dramatic suspense bgm instrumental', te: 'telugu dramatic suspense bgm instrumental' },
};
export const moodQuery = (m: Mood, lang: MusicLang) => QUERY[m][lang];

const WIN_MS = 30_000;
const MIN_SECTION_MS = 45_000;

interface Feat { speech: number; loud: number; dyn: number; rate: number }

function features(env: Float32Array, a: number, b: number): Feat {
  const db: number[] = [];
  for (let f = a; f < b && f < env.length; f++) db.push(20 * Math.log10((env[f] ?? 0) + 1e-6));
  if (db.length < 10) return { speech: 0, loud: -80, dyn: 0, rate: 0 };
  const sorted = [...db].sort((x, y) => x - y);
  const floor = sorted[Math.floor(0.1 * sorted.length)] ?? -80;
  const talk = db.filter((v) => v > floor + 10);
  const mean = talk.length ? talk.reduce((s, v) => s + v, 0) / talk.length : floor;
  const sd = talk.length ? Math.sqrt(talk.reduce((s, v) => s + (v - mean) ** 2, 0) / talk.length) : 0;
  // syllable-like beats: local peaks of the envelope that stand out
  let peaks = 0;
  for (let i = 2; i < db.length - 2; i++) {
    const v = db[i] ?? -80;
    if (v > floor + 10 && v > (db[i - 1] ?? 0) && v >= (db[i + 1] ?? 0) && v > (db[i - 2] ?? 0) + 1.5) peaks++;
  }
  return { speech: talk.length / db.length, loud: mean, dyn: sd, rate: peaks / (db.length * 0.05) };
}

/** Sections of one mood over the whole video. Without a voice or words it is one calm section. */
export function analyzeMood(voice: Float32Array | undefined, voiceShiftMs: number, durationMs: number, words: CapWord[] | undefined): MoodSection[] {
  const total = Math.max(1000, durationMs);
  const n = Math.max(1, Math.round(total / WIN_MS));
  const step = total / n;
  const feats: Feat[] = [];
  const env = voice && voice.length > SAMPLE_RATE ? rmsEnvelope(voice, 50) : null;
  for (let i = 0; i < n; i++) {
    const a = Math.round((i * step + voiceShiftMs) / 50), b = Math.round(((i + 1) * step + voiceShiftMs) / 50);
    feats.push(env ? features(env, Math.max(0, a), b) : { speech: 0, loud: -80, dyn: 0, rate: 0 });
  }
  // 0 = the quietest / slowest part of this video, 1 = the loudest / fastest. A video that stays the same all the way stays in the middle.
  const rank = (get: (f: Feat) => number, minRange: number) => {
    const v = feats.map(get);
    const lo = Math.min(...v), hi = Math.max(...v);
    return (x: number) => (hi - lo < minRange ? 0.5 : (x - lo) / (hi - lo));
  };
  const rLoud = rank((f) => f.loud, 3), rDyn = rank((f) => f.dyn, 1.5), rRate = rank((f) => f.rate, 0.7);

  const moods: Mood[] = feats.map((f, i) => {
    const t0 = i * step, t1 = (i + 1) * step;
    const text = (words ?? []).filter((w) => w.s >= t0 && w.s < t1).map((w) => (w.w || w.orig).toLowerCase().replace(/[^a-z0-9\u0900-\u097f\u0c00-\u0c7f]/g, ''));
    const hit = (k: keyof typeof WORDS) => text.filter((w) => WORDS[k].includes(w)).length;
    const sc: Record<Mood, number> = {
      calm: 0.35 + (1 - rRate(f.rate)) * 0.35 + (1 - rLoud(f.loud)) * 0.25,
      emotional: (1 - rRate(f.rate)) * 0.2 + rDyn(f.dyn) * 0.25 + Math.min(1, hit('emotional') / 2) * 0.8,
      energetic: rRate(f.rate) * 0.45 + rLoud(f.loud) * 0.35 + Math.min(1, hit('energetic') / 2) * 0.6,
      funny: Math.min(1, hit('funny')) * 0.9 + rDyn(f.dyn) * 0.15 + rRate(f.rate) * 0.1,
      serious: Math.min(1, hit('serious') / 2) * 0.8 + (1 - rDyn(f.dyn)) * 0.2 + rLoud(f.loud) * 0.1,
    };
    if (!env || f.speech < 0.1) return 'calm';
    return (Object.keys(sc) as Mood[]).reduce((best, k) => (sc[k] > sc[best] ? k : best), 'calm' as Mood);
  });

  // join neighbours with the same mood, then fold sections that are too short into the one before
  const out: MoodSection[] = [];
  for (let i = 0; i < n; i++) {
    const m = moods[i] ?? 'calm';
    const last = out[out.length - 1];
    const s = Math.round(i * step), e = Math.round((i + 1) * step);
    if (last && last.mood === m) last.endMs = e; else out.push({ startMs: s, endMs: e, mood: m });
  }
  for (let i = 1; i < out.length; ) {
    const s = out[i]!;
    if (s.endMs - s.startMs < MIN_SECTION_MS) { out[i - 1]!.endMs = s.endMs; out.splice(i, 1); } else i++;
  }
  if (out.length > 1 && out[0]!.endMs - out[0]!.startMs < MIN_SECTION_MS) { out[1]!.startMs = 0; out.shift(); }
  for (let i = 1; i < out.length; ) { // folding can leave two neighbours with the same mood
    if (out[i]!.mood === out[i - 1]!.mood) { out[i - 1]!.endMs = out[i]!.endMs; out.splice(i, 1); } else i++;
  }
  const first = out[0]; if (first) first.startMs = 0;
  const last = out[out.length - 1]; if (last) last.endMs = Math.round(total);
  return out;
}
