/**
 * Motion director: reads the transcript and plans the motion graphics of a talking-head video in one go.
 *   code_card        HTML / CSS / JS / terminal window (codeCard.ts)     -> drawn as a picture
 *   stat_card        number counting up                                  -> Kallaway "stat" card
 *   glass_steps      2 to 5 points                                       -> Kallaway "steps" card
 *   quote_card       one punchy line                                     -> Kallaway "quote" card
 *   receipt_article  items with amounts                                  -> Kallaway "receipt" card (quote card when there are no amounts)
 * Plus a punch-in zoom on the speaker at the start of every beat that asks for one.
 * Antigravity (on-device, signed in) plans it; without it the deterministic rules below find code words, numbers and claims, so the feature never fails.
 */
import type { CapWord } from './captions';
import { buildCodeCardSvg, snippetFor, type CodeLang } from './codeCard';
import { localKallawayPicks, type KallawayPick } from './kallawayDirector';
import { syncStepStarts, type KallawaySpec } from './kallaway';
import { EditorrNative, isNative } from './native';

export type MotionBeatType = 'code_card' | 'stat_card' | 'glass_steps' | 'quote_card' | 'receipt_article';
export type MotionSfx = 'whoosh' | 'pop' | 'punch' | 'none';
export interface MotionBeat {
  startMs: number; endMs: number; type: MotionBeatType;
  data: { title: string; codeSnippet?: string; codeLang?: CodeLang; statNumber?: string; statLabel?: string; quote?: string; items?: string[] };
  punchZoom: boolean; sfx: MotionSfx;
}
export interface MotionPlan { picks: KallawayPick[]; punchAt: number[]; theme: string; source: 'llm' | 'local'; note?: string }

export function buildMotionDirectorPrompt(words: CapWord[], durationMs: number): string {
  const lines: string[] = [];
  let line: string[] = [], t0 = 0;
  for (const w of words.slice(0, 5000)) {
    if (!line.length) t0 = w.s;
    line.push((w.orig || w.w).trim());
    if (line.length >= 10) { lines.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`); line = []; }
  }
  if (line.length) lines.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`);
  return `You are Editorr's Lead Motion Graphics Director. Do NOT use any tools, do NOT read or write files.
Analyze this video transcript and design high-retention motion graphics for a talking-head video.

TRANSCRIPT:
${lines.join('\n') || '(no transcript)'}

TOTAL DURATION: ${Math.round(durationMs / 1000)} seconds.

OUTPUT FORMAT: Return STRICT JSON ONLY (no markdown, no other text):
{
  "theme": "kallaway" | "code_tech" | "vox" | "hormozi" | "minimal",
  "beats": [
    {
      "startMs": number,
      "endMs": number,
      "type": "code_card" | "stat_card" | "glass_steps" | "quote_card" | "receipt_article",
      "data": {
        "title": string,
        "codeSnippet"?: string,
        "codeLang"?: "html" | "css" | "javascript" | "terminal",
        "statNumber"?: string,
        "statLabel"?: string,
        "quote"?: string,
        "items"?: string[]
      },
      "punchZoom": boolean,
      "sfx": "whoosh" | "pop" | "punch" | "none"
    }
  ]
}

RULES:
1. One graphic every 3 to 6 seconds of speech; beats never overlap; each lasts 2 to 6 seconds.
2. When the speaker mentions code, building, tech or the web, use "code_card" with 3 to 8 short lines (max 38 characters per line) of real, relevant code.
3. When the speaker mentions numbers, percentages or money, use "stat_card": statNumber as spoken ("40%", "$1.2M", "100K"), statLabel = a short line.
4. When the speaker lists tips or steps, use "glass_steps" with items = 2 to 5 short points in spoken order.
5. For one memorable line use "quote_card" with quote = that line (max 60 characters).
6. "receipt_article": items = "label | amount" lines ("Coffee | $4.50"), only when the speaker adds up prices.
7. startMs and endMs must match sentence beginnings and punchlines of the transcript. Never invent facts, people or accounts. Use the speaker's own words for titles.`;
}

const str = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const LANGS: CodeLang[] = ['html', 'css', 'javascript', 'terminal'];

/** Moves a time to the nearest word edge (within 600 ms), so a card never starts in the middle of a word. */
function snap(ms: number, words: CapWord[], edge: 's' | 'e'): number {
  let best = ms, d = 600;
  for (const w of words) { const x = Math.abs(w[edge] - ms); if (x < d) { d = x; best = w[edge]; } }
  return best;
}

/** Reads the director's answer. Bad entries are dropped, times are fixed to the video and the words, beats never overlap. */
export function parseMotionJson(text: string, words: CapWord[], durationMs: number): { beats: MotionBeat[]; theme: string } {
  const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) return { beats: [], theme: 'kallaway' };
  let root: unknown;
  try { root = JSON.parse(m[0]); } catch { return { beats: [], theme: 'kallaway' }; }
  const r = root as { theme?: unknown; beats?: unknown };
  const arr = Array.isArray(r?.beats) ? (r.beats as Record<string, unknown>[]) : [];
  const out: MotionBeat[] = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const type = o.type as MotionBeatType;
    if (!['code_card', 'stat_card', 'glass_steps', 'quote_card', 'receipt_article'].includes(type)) continue;
    let s = Number(o.startMs), e = Number(o.endMs);
    if (!isFinite(s) || !isFinite(e) || s < 0 || s >= durationMs) continue;
    s = snap(s, words, 's'); e = Math.min(durationMs, snap(e, words, 'e'));
    if (e - s < 1800) e = Math.min(durationMs, s + 2400);
    if (e - s < 1500) continue;
    if (e - s > 9000) e = s + 9000;
    const d = (o.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(d.items) ? (d.items as unknown[]).map((x) => str(x, 60)).filter(Boolean).slice(0, 5) : [];
    const lang = LANGS.includes(d.codeLang as CodeLang) ? (d.codeLang as CodeLang) : 'javascript';
    const data = { title: str(d.title, 40), codeSnippet: String(d.codeSnippet ?? '').slice(0, 900), codeLang: lang, statNumber: str(d.statNumber, 14), statLabel: str(d.statLabel, 90), quote: str(d.quote, 90), items };
    if (type === 'code_card' && data.codeSnippet.trim().split('\n').length < 1) continue;
    if (type === 'code_card' && !data.codeSnippet.trim()) continue;
    if (type === 'stat_card' && !data.statNumber) continue;
    if (type === 'glass_steps' && items.length < 2) continue;
    if (type === 'quote_card' && !data.quote && !data.title) continue;
    const sfx = (['whoosh', 'pop', 'punch', 'none'] as const).find((k) => k === o.sfx) ?? 'whoosh';
    out.push({ startMs: s, endMs: e, type, data, punchZoom: o.punchZoom !== false, sfx });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  const clean: MotionBeat[] = [];
  for (const b of out) { const l = clean[clean.length - 1]; if (l && b.startMs < l.endMs + 300) continue; clean.push(b); }
  return { beats: clean, theme: str(r?.theme, 20) || 'kallaway' };
}

/** A beat as a card recipe (every card is then drawn by makeKallawayBeats, like all other cards). */
export function beatToPick(b: MotionBeat, words: CapWord[]): KallawayPick | null {
  const base = { a: '', b: '', c: '', steps: [] as string[], handle: '' };
  const d = b.data;
  let spec: KallawaySpec;
  if (b.type === 'code_card') {
    spec = { ...base, kind: 'svg', svg: buildCodeCardSvg({ lang: d.codeLang ?? 'javascript', code: d.codeSnippet ?? '', title: d.title }) };
  } else if (b.type === 'stat_card') {
    spec = { ...base, kind: 'stat', a: '', b: d.title, stat: { big: d.statNumber ?? '', label: d.statLabel || undefined } };
  } else if (b.type === 'glass_steps') {
    const items = d.items ?? [];
    spec = { ...base, kind: 'steps', a: 'The', b: d.title || 'Steps', steps: items, stepStarts: syncStepStarts(items, words, b.startMs, b.endMs) };
  } else if (b.type === 'receipt_article') {
    const lines = (d.items ?? []).map((x) => { const [label, amount] = x.split('|').map((y) => y.trim()); return { label: label ?? '', amount: amount ?? '' }; }).filter((l) => l.label && l.amount);
    spec = lines.length >= 2 ? { ...base, kind: 'receipt', receipt: { shop: d.title || 'The Math', lines: lines.slice(0, 6) } }
      : { ...base, kind: 'quote', b: d.title || d.quote || '', sub: d.quote || undefined };
  } else {
    spec = { ...base, kind: 'quote', b: d.quote || d.title || '', sub: d.quote && d.title && d.title !== d.quote ? d.title : undefined };
  }
  return { spec, start: b.startMs, end: b.endMs };
}

// ---------------------------------------------------------------- deterministic fallback (no Antigravity, no internet)

function sentencesOf(words: CapWord[]): { s: number; e: number; text: string }[] {
  const out: { s: number; e: number; text: string }[] = [];
  let cur: CapWord[] = [];
  const flush = () => { if (cur.length >= 3) out.push({ s: cur[0]!.s, e: cur[cur.length - 1]!.e, text: cur.map((w) => (w.orig || w.w).trim()).join(' ') }); cur = []; };
  for (const w of words) {
    if (cur.length && (w.s - cur[cur.length - 1]!.e >= 600 || /[.?!।]$/.test((cur[cur.length - 1]!.orig || '').trim()))) flush();
    cur.push(w);
  }
  flush();
  return out;
}

/** Code and tech sentences become code cards; numbers, lists, claims and prices come from the Kallaway rules. Never throws. */
export function localMotionPicks(words: CapWord[], durationMs: number): KallawayPick[] {
  if (durationMs < 6000 || !words.length) return [];
  const all: KallawayPick[] = [...localKallawayPicks(words, durationMs)];
  const free = (s: number, e: number) => all.every((o) => s > o.end + 300 || e < o.start - 300);
  let lastKey = '';
  for (const sn of sentencesOf(words)) {
    if (sn.s < 600 || sn.e - sn.s < 1500) continue;
    const snip = snippetFor(sn.text);
    if (!snip) continue;
    const start = Math.max(0, sn.s - 150), end = Math.min(durationMs, Math.max(sn.e + 500, sn.s + 2800));
    if (!free(start, end) || snip.code === lastKey) continue;
    lastKey = snip.code;
    all.push({ spec: { kind: 'svg', a: '', b: '', c: '', steps: [], handle: '', svg: buildCodeCardSvg(snip) }, start, end });
  }
  all.sort((a, b) => a.start - b.start);
  const out: KallawayPick[] = [];
  for (const p of all) { const l = out[out.length - 1]; if (l && p.start < l.end + 300) continue; out.push(p); }
  return out;
}

/** Plans the motion graphics. Antigravity first (Android app, signed in); on any problem the built-in rules are used and `note` says why. */
export async function planMotionGraphics(words: CapWord[], durationMs: number, useAntigravity: boolean): Promise<MotionPlan> {
  let note: string | undefined;
  if (useAntigravity) {
    try {
      if (!isNative()) throw new Error('Antigravity works in the Android app only');
      const st = await EditorrNative.antigravityStatus();
      if (!st.installed) throw new Error('Antigravity is not set up yet');
      if (!st.signedIn) throw new Error('Antigravity is not signed in');
      const { response } = await EditorrNative.askAntigravity({ prompt: buildMotionDirectorPrompt(words, durationMs) });
      const { beats, theme } = parseMotionJson(response, words, durationMs);
      const picks = beats.map((b) => beatToPick(b, words)).filter((x): x is KallawayPick => !!x);
      if (picks.length) return { picks, punchAt: beats.filter((b) => b.punchZoom).map((b) => b.startMs), theme, source: 'llm' };
      throw new Error('no usable beats in the answer');
    } catch (e) { note = `Antigravity: ${(e as Error).message || 'no answer'}. The built-in rules were used.`; }
  }
  const picks = localMotionPicks(words, durationMs);
  return { picks, punchAt: picks.map((p) => p.start), theme: 'code_tech', source: 'local', note };
}
