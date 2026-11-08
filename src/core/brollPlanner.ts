/**
 * Auto B-roll: cuts the video into short beats (default 2.5 s), finds a picture keyword for each one
 * (Antigravity when signed in, built-in rules otherwise), searches the free sources, saves the pictures and returns the beats.
 */
import type { CapWord } from './captions';
import { bestForKeyword, downloadBroll } from './brollEngine';
import { BROLL_DEFAULT_RADIUS, BROLL_MIN_MS, BROLL_MAX_MS, BROLL_MOTIONS, type BrollBeat, type BrollFrame, type BrollMotion } from './brollTypes';
import { EditorrNative, isNative } from './native';
import { uid } from './speaker';

export interface BrollSlot { i: number; start: number; end: number; text: string }
export interface AutoBrollOpts {
  words: CapWord[];
  durationMs: number;
  lenMs: number;
  frame: BrollFrame;
  /** every = a photo on every beat, alternate = every other beat keeps the talking head */
  coverage: 'every' | 'alternate';
  /** timeline ranges that are already taken (docu beats, b-roll beats that stay) */
  busy: { start: number; end: number }[];
  maxBeats?: number;
  useAntigravity: boolean;
  signal: { cancelled: boolean };
  onProgress: (done: number, total: number, label: string) => void;
}
export interface AutoBrollResult { beats: BrollBeat[]; note?: string; missed: number }

/** Beats of `lenMs` along the transcript. Only beats with speech get a slot; taken ranges are skipped. */
export function makeSlots(words: CapWord[], durationMs: number, lenMs: number, busy: { start: number; end: number }[], coverage: 'every' | 'alternate', maxBeats: number): BrollSlot[] {
  const len = Math.max(BROLL_MIN_MS, Math.min(BROLL_MAX_MS, lenMs));
  const first = words.length ? Math.max(0, words[0]!.s - 200) : 0;
  const out: BrollSlot[] = [];
  let n = 0, k = 0;
  for (let t = first; t + 1000 <= durationMs && out.length < maxBeats; t += len, k++) {
    const e = Math.min(durationMs, t + len);
    if (coverage === 'alternate' && k % 2 === 1) continue;
    if (busy.some((b) => t < b.end && e > b.start)) continue;
    const text = words.filter((w) => w.s >= t - 100 && w.s < e).map((w) => (w.orig || w.w).trim()).join(' ').trim();
    if (!text) continue;
    out.push({ i: ++n, start: t, end: e, text });
  }
  return out;
}

/** The prompt for Antigravity: one search keyword per numbered beat, answer as JSON. */
export function buildBrollPrompt(slots: BrollSlot[]): string {
  const lines = slots.map((s) => `${s.i}. [${(s.start / 1000).toFixed(1)}s-${(s.end / 1000).toFixed(1)}s] ${s.text}`);
  return `You are a fast-paced Vox / Johnny Harris documentary director picking stock photos. Do NOT use any tools, do NOT read or write files.
Below are numbered 2-3 second beats of a voice-over transcript (it may be in any language). For EACH beat give ONE English photo search keyword
that Wikimedia Commons or Wikipedia would find: the most concrete visual thing in that beat (a person's full name, a place, an event with its year, an object).
Make every keyword self-contained: add the main subject or year from the surrounding beats when the beat alone is vague (e.g. "Black Monday 1987 trading floor", not "panic").
Never return generic words like "business" or "people". Also pick a motion: zoom_in, zoom_out, pan_left or pan_right.

Beats:
${lines.join('\n')}

Reply with ONE valid JSON array only, no markdown, no other text:
[{"i":1,"keyword":"...","motion":"zoom_in"}]`;
}

/** Reads the answer: { beat number -> keyword + motion }. Bad entries are dropped. */
export function parseBrollJson(text: string): Map<number, { keyword: string; motion?: BrollMotion }> {
  const out = new Map<number, { keyword: string; motion?: BrollMotion }>();
  const m = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const o of arr as Record<string, unknown>[]) {
    const i = Number(o?.i), kw = String(o?.keyword ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!isFinite(i) || !kw) continue;
    out.set(i, { keyword: kw, motion: BROLL_MOTIONS.includes(o.motion as BrollMotion) ? (o.motion as BrollMotion) : undefined });
  }
  return out;
}

// ---------------------------------------------------------------- built-in keyword rule (no Antigravity)

const STOP = new Set(('a an the and or but if so as of to in on at by for with from into over under about than then that this these those is are was were be been being am do does did have has had will would can could should may might must not no nor ' +
  'i me my we our you your he him his she her it its they them their what which who whom whose when where why how all any both each few more most other some such only own same too very just also now here there up down out off again further once ' +
  'like really actually basically literally thing things stuff lot kind sort way okay yes yeah well see look know think going got get gets one two three first second').split(' '));

/** Capitalised words in the middle of a sentence (names, places) first, then the longest plain words. */
export function localKeyword(text: string, previous = ''): string {
  const toks = text.replace(/[^\p{L}\p{N}' -]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!toks.length) return previous;
  if (!/[A-Za-z]/.test(text)) return toks.slice(0, 3).join(' ');
  const names: string[] = [];
  let run: string[] = [];
  toks.forEach((t, i) => {
    if (/^[A-Z][a-zA-Z'-]+$/.test(t) && !(i === 0 && STOP.has(t.toLowerCase()))) run.push(t);
    else { if (run.length) names.push(run.join(' ')); run = []; }
  });
  if (run.length) names.push(run.join(' '));
  if (names.length) return names.sort((a, b) => b.length - a.length)[0]!;
  const plain = [...new Set(toks.map((t) => t.toLowerCase()).filter((t) => t.length > 3 && !STOP.has(t)))].sort((a, b) => b.length - a.length).slice(0, 2);
  return plain.length ? plain.join(' ') : previous;
}

// ---------------------------------------------------------------- the whole run

async function keywordsFromAntigravity(slots: BrollSlot[], signal: { cancelled: boolean }): Promise<{ map: Map<number, { keyword: string; motion?: BrollMotion }>; note?: string }> {
  const map = new Map<number, { keyword: string; motion?: BrollMotion }>();
  try {
    if (!isNative()) throw new Error('Antigravity works in the Android app only');
    const st = await EditorrNative.antigravityStatus();
    if (!st.installed) throw new Error('Antigravity is not set up yet');
    if (!st.signedIn) throw new Error('Antigravity is not signed in');
    for (let a = 0; a < slots.length && !signal.cancelled; a += 30) {
      const { response } = await EditorrNative.askAntigravity({ prompt: buildBrollPrompt(slots.slice(a, a + 30)) });
      for (const [k, v] of parseBrollJson(response)) map.set(k, v);
    }
    return { map, note: map.size < slots.length ? 'Antigravity skipped some beats; the built-in rules filled them.' : undefined };
  } catch (e) { return { map, note: `Antigravity: ${(e as Error).message || 'no answer'}. The built-in rules were used.` }; }
}

export async function autoBroll(o: AutoBrollOpts): Promise<AutoBrollResult> {
  const slots = makeSlots(o.words, o.durationMs, o.lenMs, o.busy, o.coverage, o.maxBeats ?? 60);
  if (!slots.length) return { beats: [], missed: 0, note: 'No free beats with speech found.' };
  let note: string | undefined;
  let kws = new Map<number, { keyword: string; motion?: BrollMotion }>();
  if (o.useAntigravity) {
    o.onProgress(0, slots.length, 'Asking the director for keywords...');
    const r = await keywordsFromAntigravity(slots, o.signal);
    kws = r.map; note = r.note;
  }
  let prev = '';
  for (const s of slots) {
    if (!kws.get(s.i)?.keyword) kws.set(s.i, { keyword: localKeyword(s.text, prev), motion: kws.get(s.i)?.motion });
    prev = kws.get(s.i)!.keyword;
  }

  const used = new Set<string>();
  const beats: (BrollBeat | undefined)[] = new Array(slots.length).fill(undefined);
  let next = 0, done = 0, missed = 0;
  const worker = async () => {
    while (!o.signal.cancelled) {
      const idx = next++;
      if (idx >= slots.length) return;
      const s = slots[idx]!, kw = kws.get(s.i)!;
      o.onProgress(done, slots.length, kw.keyword);
      const item = kw.keyword ? await bestForKeyword(kw.keyword, used) : undefined;
      if (item) {
        used.add(item.url);
        const path = await downloadBroll(item);
        if (path || !isNative()) {
          beats[idx] = {
            id: uid(), start: s.start, end: s.end, keyword: kw.keyword, url: item.url, thumb: item.thumb, ...(path ? { path } : {}),
            title: item.title, source: item.source, ...(item.credit ? { credit: item.credit } : {}),
            motion: kw.motion ?? BROLL_MOTIONS[idx % BROLL_MOTIONS.length]!, frame: o.frame, radius: BROLL_DEFAULT_RADIUS,
          };
        } else missed++;
      } else missed++;
      done++;
      o.onProgress(done, slots.length, kw.keyword);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { beats: beats.filter((b): b is BrollBeat => !!b), note, missed };
}
