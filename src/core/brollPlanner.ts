/**
 * Auto B-roll: cuts the video into short beats (default 2.5 s), finds a picture keyword for each one
 * (Antigravity when signed in, built-in rules otherwise), searches the free sources, saves the pictures and returns the beats.
 */
import type { CapWord } from './captions';
import { BROLL_AUTO_MOTIONS, BROLL_DEFAULT_RADIUS, BROLL_MIN_MS, BROLL_MAX_MS, BROLL_MOTIONS, type BrollBeat, type BrollFrame, type BrollMotion } from './brollTypes';
import { applyQuotas, buildRoutePrompt, fetchForPlan, localRouteOf, parseRoutePlan, type RoutePlan, type VideoMode } from './brollRouter';
import { conceptFromText } from './brollCards';
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
  /** photos = pictures only, mix = a real clip on every other beat that has one, video = a clip wherever one is found */
  videoMode: VideoMode;
  /** width / height of the output frame (cards are drawn in this shape) */
  aspect: number;
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

async function routesFromAntigravity(slots: BrollSlot[], signal: { cancelled: boolean }): Promise<{ map: Map<number, Omit<RoutePlan, 'i'>>; note?: string }> {
  const map = new Map<number, Omit<RoutePlan, 'i'>>();
  try {
    if (!isNative()) throw new Error('Antigravity works in the Android app only');
    const st = await EditorrNative.antigravityStatus();
    if (!st.installed) throw new Error('Antigravity is not set up yet');
    if (!st.signedIn) throw new Error('Antigravity is not signed in');
    for (let a = 0; a < slots.length && !signal.cancelled; a += 30) {
      const { response } = await EditorrNative.askAntigravity({ prompt: buildRoutePrompt(slots.slice(a, a + 30)) });
      for (const [k, v] of parseRoutePlan(response)) map.set(k, v);
    }
    return { map, note: map.size < slots.length ? 'Antigravity skipped some beats; the built-in rules filled them.' : undefined };
  } catch (e) { return { map, note: `Antigravity: ${(e as Error).message || 'no answer'}. The built-in rules were used.` }; }
}

/** Route + keyword for every beat: Antigravity's answer where it gave one, the built-in rules elsewhere, then the quotas. */
export function planRoutes(slots: BrollSlot[], ai: Map<number, Omit<RoutePlan, 'i'>>): RoutePlan[] {
  let prev = '';
  const plans: RoutePlan[] = slots.map((s) => {
    const a = ai.get(s.i);
    if (a) { prev = a.keyword; return { i: s.i, ...a }; }
    const kind = localRouteOf(s.text);
    const kw = localKeyword(s.text, prev);
    prev = kw || prev;
    const route = kind === 'plain' ? 'entity' : kind;
    const c = route === 'concept' ? conceptFromText(s.text, kw) : undefined;
    return { i: s.i, route, keyword: kw, ...(c ? { big: c.big, trend: c.trend } : {}) };
  });
  return applyQuotas(plans);
}

export async function autoBroll(o: AutoBrollOpts): Promise<AutoBrollResult> {
  const slots = makeSlots(o.words, o.durationMs, o.lenMs, o.busy, o.coverage, o.maxBeats ?? 60);
  if (!slots.length) return { beats: [], missed: 0, note: 'No free beats with speech found.' };
  let note: string | undefined;
  let ai = new Map<number, Omit<RoutePlan, 'i'>>();
  if (o.useAntigravity) {
    o.onProgress(0, slots.length, 'Asking the director to pick the routes...');
    const r = await routesFromAntigravity(slots, o.signal);
    ai = r.map; note = r.note;
  }
  const plans = planRoutes(slots, ai);

  const used = new Set<string>();
  const beats: (BrollBeat | undefined)[] = new Array(slots.length).fill(undefined);
  let next = 0, done = 0, missed = 0;
  const worker = async () => {
    while (!o.signal.cancelled) {
      const idx = next++;
      if (idx >= slots.length) return;
      const s = slots[idx]!, plan = plans[idx]!;
      const label = `${plan.route}: ${plan.keyword || plan.big || ''}`;
      o.onProgress(done, slots.length, label);
      let asset;
      try { asset = await fetchForPlan(plan, s.end - s.start, { used, videoMode: o.videoMode, aspect: o.aspect, idx, text: s.text, signal: o.signal }, o.frame); }
      catch { asset = undefined; }
      if (asset && !o.signal.cancelled) {
        const isVideo = asset.kind === 'video';
        // a clip never runs past the end of its file
        let end = s.end;
        if (isVideo && asset.srcMs) end = Math.min(end, s.start + Math.max(BROLL_MIN_MS, asset.srcMs - (asset.inMs ?? 0) - 200));
        beats[idx] = {
          id: uid(), start: s.start, end, keyword: plan.keyword || plan.big || '', url: asset.url, thumb: asset.thumb, ...(asset.path ? { path: asset.path } : {}),
          title: asset.title, source: asset.source, ...(asset.credit ? { credit: asset.credit } : {}),
          kind: asset.kind, route: plan.route, ...(isVideo ? { inMs: asset.inMs ?? 0, ...(asset.srcMs ? { srcMs: asset.srcMs } : {}) } : {}),
          motion: asset.motion ?? plan.motion ?? BROLL_AUTO_MOTIONS[idx % BROLL_AUTO_MOTIONS.length]!, frame: asset.frame ?? o.frame, radius: BROLL_DEFAULT_RADIUS,
        };
      } else missed++;
      done++;
      o.onProgress(done, slots.length, label);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { beats: beats.filter((b): b is BrollBeat => !!b), note, missed };
}
