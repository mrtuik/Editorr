/**
 * Retake finder: reads the transcript and lists the parts to cut, like Detect Silence does for pauses.
 *   retake   a sentence said again (the earlier attempt goes, the later take stays), false starts, corrected mistakes
 *   stutter  the same word or phrase twice in a row ("the car the car")
 *   filler   um, uh, hmm, matlab ... and any words the user adds
 * Built-in rules always run. Antigravity (Android app, signed in) reads the whole script as well and adds what rules cannot see.
 */
import type { CapWord } from './captions';
import { EditorrNative, isNative } from './native';

export type RetakeKind = 'retake' | 'stutter' | 'filler';
export interface RetakeHit { startMs: number; endMs: number; kind: RetakeKind; reason: string; text: string }
export interface RetakeOpts { repeats: boolean; fillers: boolean; stutters: boolean; ai: boolean; extraWords: string[] }

export const DEFAULT_FILLERS = ['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'hmm', 'hmmm', 'ah', 'aah', 'matlab', 'mane'];
const FILLER_PAIRS = ['you know', 'i mean'];
const OK_REPEAT = new Set(['very', 'no', 'so', 'ha', 'haan', 'na', 'nahi', 'go', 'bye', 'ho', 'hai']);

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export interface Take { i: number; s: number; e: number; first: number; last: number; text: string; toks: string[] }

/** The words as takes: a new one starts after a pause of 450 ms, after . ? ! or after 28 words. */
export function takesOf(words: CapWord[]): Take[] {
  const out: Take[] = [];
  let first = 0;
  const push = (a: number, b: number) => {
    const ws = words.slice(a, b + 1);
    out.push({ i: out.length, s: ws[0]!.s, e: ws[ws.length - 1]!.e, first: a, last: b, text: ws.map((w) => (w.orig || w.w).trim()).join(' '), toks: ws.map((w) => norm(w.w || w.orig)).filter(Boolean) });
  };
  for (let k = 1; k < words.length; k++) {
    const gap = words[k]!.s - words[k - 1]!.e;
    if (gap >= 450 || /[.?!।]$/.test((words[k - 1]!.orig || '').trim()) || k - first >= 28) { push(first, k - 1); first = k; }
  }
  if (words.length) push(first, words.length - 1);
  return out;
}

const jaccard = (a: string[], b: string[]) => {
  const A = new Set(a), B = new Set(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(1, A.size + B.size - n);
};

const short = (t: string, n = 70) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

export function localRetakes(words: CapWord[], o: RetakeOpts): RetakeHit[] {
  const hits: RetakeHit[] = [];
  const takes = takesOf(words);

  if (o.repeats) {
    for (let i = 0; i < takes.length - 1; i++) {
      const a = takes[i]!;
      if (a.toks.length < 3) continue;
      for (let j = i + 1; j <= Math.min(i + 3, takes.length - 1); j++) {
        const b = takes[j]!;
        if (b.s - a.e > 20000) break;
        const n = Math.min(3, a.toks.length, b.toks.length);
        const prefix = n >= 3 && a.toks.slice(0, n).every((t, k) => t === b.toks[k]);
        const sim = b.toks.length >= 3 ? jaccard(a.toks, b.toks) : 0;
        if (prefix || sim >= 0.6) {
          const end = takes[i + 1]!.s;
          hits.push({ startMs: a.s, endMs: end, kind: 'retake', reason: 'Said again later (kept the later take)', text: short(a.text) });
          break;
        }
      }
    }
  }

  if (o.repeats) {
    // the speaker announces a restart: "wait", "sorry", "let me say it again", "one more time"
    for (const t of takes) {
      if (t.toks.length <= 8 && /^(wait|sorry|oops|ruko|ek minute|let me (say|do|start|try)|one more time|again|take (one|two|three|\d))\b/i.test(t.text.replace(/[^\p{L}\p{N} ]/gu, ' ').trim()))
        hits.push({ startMs: t.s, endMs: t.e + 60, kind: 'retake', reason: 'Restart talk', text: short(t.text) });
    }
  }

  if (o.stutters) {
    for (const t of takes) {
      const ws = words.slice(t.first, t.last + 1);
      const tk = ws.map((w) => norm(w.w || w.orig));
      for (let i = 0; i < ws.length; i++) {
        for (let n = 4; n >= 1; n--) {
          if (i + 2 * n > ws.length) continue;
          let same = true;
          for (let k = 0; k < n; k++) if (!tk[i + k] || tk[i + k] !== tk[i + n + k]) { same = false; break; }
          if (!same) continue;
          if (n === 1 && OK_REPEAT.has(tk[i]!)) continue;
          const a = ws[i]!, nxt = ws[i + n]!;
          hits.push({ startMs: a.s, endMs: Math.max(a.s + 120, nxt.s), kind: 'stutter', reason: n === 1 ? 'Word repeated' : 'Phrase repeated', text: ws.slice(i, i + n).map((w) => (w.orig || w.w).trim()).join(' ') });
          i += n - 1; break;
        }
      }
    }
  }

  if (o.fillers) {
    const set = new Set([...DEFAULT_FILLERS, ...o.extraWords.map(norm).filter(Boolean)]);
    const pairs = new Set(FILLER_PAIRS);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!, t = norm(w.w || w.orig);
      const nx = words[i + 1];
      if (nx && pairs.has(`${t} ${norm(nx.w || nx.orig)}`) && nx.s - w.e < 300) {
        hits.push({ startMs: w.s, endMs: nx.e, kind: 'filler', reason: 'Filler words', text: `${(w.orig || w.w).trim()} ${(nx.orig || nx.w).trim()}` }); i++; continue;
      }
      if (set.has(t)) hits.push({ startMs: Math.max(0, w.s - 30), endMs: Math.max(w.e + 30, w.s + 120), kind: 'filler', reason: 'Filler word', text: (w.orig || w.w).trim() });
    }
  }
  return hits;
}

// ---------------------------------------------------------------- AI pass
export function buildRetakePrompt(takes: Take[]): string {
  const lines = takes.slice(0, 600).map((t) => `#${t.i} [${(t.s / 1000).toFixed(1)}s-${(t.e / 1000).toFixed(1)}s] ${t.text}`);
  return `You are a careful video editor cleaning a talking-head recording. Do NOT use any tools, do NOT read or write files.

The transcript is split into numbered takes (a take = one breath or sentence):
${lines.join('\n') || '(no transcript)'}

Find the takes to CUT:
1. a sentence or idea said again, better, later: cut the EARLIER attempt, keep the best final version
2. false starts, sentences that stop half way, wrong words the speaker then corrects
3. talk that is not part of the video: "wait", "let me say it again", "cut", "ok recording", reading instructions out loud, coughing, off-topic chatter
Never cut the final good version of anything. Never cut a take that adds new information. Be conservative: when unsure, keep it. Each reason must be 2 to 6 words.

Reply with ONE valid JSON array only, no markdown, no other text. Consecutive takes may share one entry:
[{"from":<take number>,"to":<take number>,"reason":"..."}]
Reply [] when nothing needs to be cut.`;
}

export function parseRetakeJson(text: string, takes: Take[]): RetakeHit[] {
  const m = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: RetakeHit[] = [];
  for (const o of arr as Record<string, unknown>[]) {
    const a = Math.round(Number(o.from)), b = Math.round(Number(o.to ?? o.from));
    if (!isFinite(a) || !isFinite(b) || a < 0 || b < a || b >= takes.length) continue;
    const ta = takes[a]!, tb = takes[b]!, nx = takes[b + 1];
    out.push({
      startMs: ta.s, endMs: nx ? Math.max(tb.e, nx.s) : tb.e + 80, kind: 'retake',
      reason: String(o.reason ?? 'Cut by AI').slice(0, 60), text: short(takes.slice(a, b + 1).map((t) => t.text).join(' ')),
    });
  }
  return out;
}

const PRI: Record<RetakeKind, number> = { retake: 3, stutter: 2, filler: 1 };

/** Overlapping hits become one (the stronger kind and its reason win), sorted, inside the video. */
export function mergeHits(hits: RetakeHit[], durationMs: number): RetakeHit[] {
  const s = hits.map((h) => ({ ...h, startMs: Math.max(0, h.startMs), endMs: Math.min(durationMs, h.endMs) })).filter((h) => h.endMs - h.startMs >= 80).sort((a, b) => a.startMs - b.startMs);
  const out: RetakeHit[] = [];
  for (const h of s) {
    const l = out[out.length - 1];
    if (l && h.startMs < l.endMs) {
      if (PRI[h.kind] > PRI[l.kind]) { l.kind = h.kind; l.reason = h.reason; }
      l.endMs = Math.max(l.endMs, h.endMs);
      if (!l.text.includes(h.text)) l.text = short(`${l.text} ${h.text}`, 90);
    } else out.push({ ...h });
  }
  return out;
}

export async function planRetakes(words: CapWord[], durationMs: number, o: RetakeOpts): Promise<{ hits: RetakeHit[]; source: 'ai' | 'local'; note?: string }> {
  let hits = localRetakes(words, o);
  let note: string | undefined, source: 'ai' | 'local' = 'local';
  if (o.ai) {
    try {
      if (!isNative()) throw new Error('Antigravity works in the Android app only');
      const st = await EditorrNative.antigravityStatus();
      if (!st.installed) throw new Error('Antigravity is not set up yet');
      if (!st.signedIn) throw new Error('Antigravity is not signed in');
      const takes = takesOf(words);
      const { response } = await EditorrNative.askAntigravity({ prompt: buildRetakePrompt(takes) });
      if (!/\[[\s\S]*\]/.test(response)) throw new Error('no answer in the right format');
      hits = hits.concat(parseRetakeJson(response, takes));
      source = 'ai';
    } catch (e) { note = `AI check skipped: ${(e as Error).message || 'no answer'}. Built-in rules were used.`; }
  }
  return { hits: mergeHits(hits, durationMs), source, note };
}
