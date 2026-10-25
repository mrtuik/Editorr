/**
 * Auto SFX planner: finds every moment of the video that needs a sound and says which kind.
 *   structure : layout change (whoosh), other camera (pop), reaction cutaway (hit), new text (ding)
 *   words     : funny / surprise / money / sad / applause words in the captions -> a matching meme sound
 *   voice     : a sudden loud shout (vine boom style), an awkward silence in the middle of talking
 * The actual sounds are then searched on YouTube for each kind.
 */
import { rmsEnvelope } from './audio';
import type { CapWord } from './captions';
import type { Segment } from './types';
import type { SfxKind } from './synth';

export type AutoKind = 'whoosh' | 'pop' | 'ding' | 'hit' | 'laugh' | 'meme' | 'wow' | 'bruh' | 'cash' | 'sad' | 'applause' | 'silence';

export interface AutoInfo {
  label: string;
  /** YouTube search */
  query: string;
  /** keep at most this many seconds of the downloaded sound */
  maxS: number;
  /** the loudest part may start up to this long before the moment (ms) */
  lead: number;
  /** meme-class sounds are skipped when YouTube is not available (a made-up beep would sound silly there) */
  meme: boolean;
  /** sound made on the phone when YouTube fails (structure sounds only) */
  synth: SfxKind;
  priority: number;
}

export const AUTO_INFO: Record<AutoKind, AutoInfo> = {
  whoosh:   { label: 'Whoosh',   query: 'whoosh transition sound effect',        maxS: 1.4, lead: 900, meme: false, synth: 'whoosh', priority: 2 },
  pop:      { label: 'Pop',      query: 'pop click sound effect',                maxS: 0.7, lead: 40,  meme: false, synth: 'pop',    priority: 1 },
  ding:     { label: 'Ding',     query: 'notification ding sound effect',        maxS: 1.2, lead: 40,  meme: false, synth: 'ding',   priority: 3 },
  hit:      { label: 'Hit',      query: 'impact hit boom sound effect',          maxS: 1.0, lead: 40,  meme: false, synth: 'hit',    priority: 3 },
  laugh:    { label: 'Laugh',    query: 'laugh track sound effect funny',        maxS: 3.0, lead: 40,  meme: true,  synth: 'hit',    priority: 5 },
  meme:     { label: 'Funny',    query: 'funny meme sound effects',              maxS: 2.5, lead: 40,  meme: true,  synth: 'hit',    priority: 5 },
  wow:      { label: 'Boom',     query: 'vine boom sound effect',                maxS: 1.8, lead: 40,  meme: true,  synth: 'hit',    priority: 4 },
  bruh:     { label: 'Bruh',     query: 'bruh sound effect meme',                maxS: 1.5, lead: 40,  meme: true,  synth: 'hit',    priority: 5 },
  cash:     { label: 'Cash',     query: 'cha ching cash register sound effect',  maxS: 1.5, lead: 40,  meme: true,  synth: 'ding',   priority: 5 },
  sad:      { label: 'Sad',      query: 'sad trombone meme sound effect',        maxS: 3.0, lead: 40,  meme: true,  synth: 'hit',    priority: 5 },
  applause: { label: 'Applause', query: 'applause cheer sound effect',           maxS: 3.0, lead: 40,  meme: true,  synth: 'hit',    priority: 5 },
  silence:  { label: 'Silence',  query: 'crickets awkward silence sound effect', maxS: 3.0, lead: 40,  meme: true,  synth: 'hit',    priority: 3 },
};

const TOKENS: Partial<Record<AutoKind, string[]>> = {
  laugh: ['haha', 'hahaha', 'hehe', 'lol', 'lmao', 'hasi', 'hasna', 'hashi'],
  wow: ['wow', 'omg', 'whoa', 'arre', 'arey', 'waah', 'wah', 'oho', 'baaprey', 'baapre'],
  bruh: ['bruh', 'bakwas', 'pagal', 'pagol', 'stupid', 'idiot', 'gadha', 'bekar'],
  cash: ['paisa', 'paise', 'rupees', 'rupaye', 'lakh', 'crore', 'money', 'dollar', 'dollars', 'taka', 'salary'],
  sad: ['sad', 'cry', 'crying', 'rona', 'kanna', 'dukh', 'dard', 'alone', 'akela'],
  applause: ['congratulations', 'badhai', 'mubarak', 'winner', 'champion', 'jeet', 'jeeta'],
  meme: ['joke', 'comedy', 'mazak', 'masti', 'prank', 'funny', 'hilarious', 'moja', 'mojar'],
};
const LOOKUP = new Map<string, AutoKind>();
for (const [k, list] of Object.entries(TOKENS)) for (const w of list!) LOOKUP.set(w, k as AutoKind);

const FRAME = 50;
export interface Moment { kind: AutoKind; startMs: number }

export function planSfx(i: { segments: Segment[]; texts: { s: number; e: number }[]; words?: CapWord[]; voice?: Float32Array; voiceShiftMs: number; durationMs: number }): Moment[] {
  const cand: Moment[] = [];

  // structure
  for (let k = 1; k < i.segments.length; k++) {
    const a = i.segments[k - 1]!, b = i.segments[k]!;
    const kind: AutoKind | null = b.reaction && !a.reaction ? 'hit' : a.style !== b.style ? 'whoosh' : a.main !== b.main ? 'pop' : null;
    if (kind) cand.push({ kind, startMs: b.startMs });
  }
  for (const t of i.texts) if (t.e > t.s) cand.push({ kind: 'ding', startMs: t.s });

  // words
  let lastWord = -1e9;
  for (const w of i.words ?? []) {
    const tok = (w.w || w.orig || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const kind = LOOKUP.get(tok);
    if (!kind || w.s - lastWord < 8000) continue;
    cand.push({ kind, startMs: w.s }); lastWord = w.s;
  }

  // voice: sudden shout, awkward silence
  if (i.voice && i.voice.length > 16000 * 2) {
    const env = rmsEnvelope(i.voice, FRAME);
    const shift = Math.round(i.voiceShiftMs / FRAME);
    const n = Math.ceil(i.durationMs / FRAME);
    const db = new Float32Array(n);
    for (let f = 0; f < n; f++) db[f] = 20 * Math.log10((env[f + shift] ?? 0) + 1e-6);
    const sorted = Float32Array.from(db).sort();
    const floor = sorted[Math.floor(0.1 * n)] ?? -80;
    const speech = new Uint8Array(n);
    for (let f = 0; f < n; f++) speech[f] = db[f]! > floor + 10 ? 1 : 0;
    // rolling mean level of speech within +-3 s
    const pre = new Float64Array(n + 1), cnt = new Int32Array(n + 1);
    for (let f = 0; f < n; f++) { pre[f + 1] = pre[f]! + (speech[f] ? db[f]! : 0); cnt[f + 1] = cnt[f]! + speech[f]!; }
    const R = 60;
    let lastSpike = -1e9;
    for (let f = 4; f < n; f++) {
      if (!speech[f]) continue;
      const a = Math.max(0, f - R), b = Math.min(n, f + R);
      const c = cnt[b]! - cnt[a]!;
      if (c < 20) continue;
      const mean = (pre[b]! - pre[a]!) / c;
      if (db[f]! < mean + 9 || db[f]! < floor + 25) continue;
      let before = -200; for (let q = 1; q <= 4; q++) before = Math.max(before, db[f - q]!);
      if (before > db[f]! - 6) continue; // not sudden
      const ms = f * FRAME;
      if (ms - lastSpike < 8000) continue;
      cand.push({ kind: 'wow', startMs: ms }); lastSpike = ms;
    }
    // silence in the middle of talking
    let lastSil = -1e9, silCount = 0;
    for (let f = 20; f < n - 20 && silCount < 3; f++) {
      if (speech[f] || !speech[f - 1]) continue;
      let e = f; while (e < n && !speech[e]) e++;
      const len = (e - f) * FRAME;
      if (len >= 1800 && len <= 6000 && e < n - 10 && f * FRAME - lastSil > 30_000) {
        cand.push({ kind: 'silence', startMs: f * FRAME + 200 }); lastSil = f * FRAME; silCount++;
      }
      f = e;
    }
  }

  // keep the best, never two sounds on top of each other, meme sounds are spread out
  cand.sort((x, y) => AUTO_INFO[y.kind].priority - AUTO_INFO[x.kind].priority || x.startMs - y.startMs);
  const max = Math.min(60, Math.ceil(i.durationMs / 9000) + 4);
  const out: Moment[] = [];
  for (const c of cand) {
    if (out.length >= max) break;
    const meme = AUTO_INFO[c.kind].meme;
    if (out.some((o) => Math.abs(o.startMs - c.startMs) < (meme && AUTO_INFO[o.kind].meme ? 6000 : 2000))) continue;
    out.push(c);
  }
  return out.sort((x, y) => x.startMs - y.startMs);
}
