/** Antigravity prompts and answers for the two steps (plan, make one). Every answer is checked; nothing is trusted. */
import type { CapWord } from '../captions';
import { EditorrNative, isNative } from '../native';
import { getPreset, motionIds } from './motion';
import { limitWords, words as wordsOf } from './templates/util';
import { VISUAL_TYPES, type MotionSelection, type VisualData, type VisualSlot, type VisualType } from './types';

const TYPES_JSON = VISUAL_TYPES.map(t => `"${t}"`).join('|');

export function planPrompt(lines: string, seconds: number, theme: string, mix: VisualType[]): string {
  return `You are Editorr's visual director. Do NOT use any tools, do NOT read or write files.
Plan clean, minimalist HTML/CSS visuals for a talking-head video. No photos, no videos.

TRANSCRIPT (seconds):
${lines}
DURATION: ${seconds} s   THEME: ${theme}   PREFERRED TYPES: ${mix.join(', ')}

Return ONE JSON object, no markdown:
{ "slots": [ { "startMs": number, "endMs": number,
   "type": ${TYPES_JSON},
   "intent": "one short sentence: what this visual shows" } ] }

RULES
1. A new visual every 2 to 4 seconds, never a gap over 3 s, never overlapping. Each lasts 2 to 5 s.
2. Pick the type from what is said: number or money -> stat_counter / bar_chart / line_chart / progress_ring; steps -> list_card / timeline; two things compared -> versus_card; a definition -> definition_card; code or tech -> code_window / terminal; one strong line -> quote_card; one key word -> keyword_title.
3. Never the same type twice in a row. One type at most 30 percent of all slots.
4. startMs starts at a sentence beginning, endMs ends at its punchline.
5. Never invent facts, numbers, people or accounts.`;
}

export function makePrompt(slot: VisualSlot, theme: string, sentence: string, prev?: { type: string; title: string }): string {
  return `You are Editorr's visual director. Do NOT use any tools, do NOT read or write files.
Write the content of ONE minimalist visual.

TYPE: ${slot.type}   INTENT: ${slot.intent}   THEME: ${theme}
WHAT IS SAID IN THIS MOMENT (${slot.startMs}-${slot.endMs} ms): "${sentence}"
PREVIOUS VISUAL: ${prev ? `${prev.type} "${prev.title}"` : 'none'}

Return ONE JSON object only:
{ "data": { "title"?: string, "big"?: string, "label"?: string, "quote"?: string, "accent"?: string,
            "term"?: string, "meaning"?: string, "items"?: string[], "left"?: string, "right"?: string,
            "labels"?: string[], "values"?: number[], "percent"?: number,
            "lang"?: "html"|"css"|"javascript"|"terminal", "code"?: string, "lines"?: string[] },
  "motion": { "in": "{id}", "hold": "{id}", "out": "{id}" } }

RULES
1. Max 12 words in total. Short, big, plain. No emoji.
2. Use only what is said. Never invent a number, person, account or quote. If a number is not spoken, do not show one.
3. Same language and script as the speaker (Bengali stays Bengali).
4. Motion ids only from: ${motionIds().join(', ')}. Do not repeat the previous visual's "in".
(for line_chart use "values" as the points; terminal and receipt_card use "lines"; receipt line = "name | price")`;
}

/** null = Antigravity is ready. Otherwise the plain reason it will not work (shown to the user as an error). */
export async function agyProblem(): Promise<string | null> {
  try {
    if (!isNative()) return 'Antigravity works in the Android app only';
    const st = await EditorrNative.antigravityStatus();
    if (!st.installed) return 'Antigravity is not set up yet';
    if (!st.signedIn) return 'Antigravity is not signed in';
    return null;
  } catch (e) { return `Antigravity check failed: ${(e as Error).message || 'error'}`; }
}

async function ask(prompt: string): Promise<string> {
  if (!isNative()) throw new Error('Antigravity works in the Android app only');
  const st = await EditorrNative.antigravityStatus();
  if (!st.installed) throw new Error('Antigravity is not set up yet');
  if (!st.signedIn) throw new Error('Antigravity is not signed in');
  return (await EditorrNative.askAntigravity({ prompt })).response;
}

export const withTimeout = <V,>(p: Promise<V>, ms: number): Promise<V> => new Promise<V>((res, rej) => {
  const t = window.setTimeout(() => rej(new Error('timeout')), ms);
  p.then(v => { window.clearTimeout(t); res(v); }, e => { window.clearTimeout(t); rej(e); });
});

function json(text: string): unknown {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in the answer');
  return JSON.parse(text.slice(a, b + 1));
}

/** Transcript lines "[12.3] sentence" for the plan prompt. */
export function transcriptLines(ws: CapWord[]): string {
  const out: string[] = []; let cur: CapWord[] = [];
  const flush = () => { if (cur.length) { out.push(`[${(cur[0]!.s / 1000).toFixed(1)}] ${cur.map(w => w.orig || w.w).join(' ')}`); cur = []; } };
  ws.forEach((w, i) => { cur.push(w); const gap = ws[i + 1] ? ws[i + 1]!.s - w.e : 0; if (/[.!?।]$/.test(w.orig || w.w) || gap > 600 || cur.length >= 18) flush(); });
  flush(); return out.join('\n');
}

export async function planAi(ws: CapWord[], durationMs: number, theme: string, mix: VisualType[]): Promise<VisualSlot[]> {
  const raw = json(await ask(planPrompt(transcriptLines(ws), Math.round(durationMs / 1000), theme, mix))) as { slots?: Record<string, unknown>[] };
  const out: VisualSlot[] = []; let cursor = 0;
  for (const s of (raw.slots ?? []).sort((a, b) => Number(a.startMs) - Number(b.startMs))) {
    const type = s.type as VisualType, st = Math.max(cursor, Math.round(Number(s.startMs))), en = Math.min(durationMs, Math.round(Number(s.endMs)));
    if (!VISUAL_TYPES.includes(type) || !(st < en) || en - st < 1200) continue;
    const e2 = Math.min(en, st + 5000);
    out.push({ id: `v${out.length + 1}`, startMs: st, endMs: e2, type, intent: String(s.intent ?? '').slice(0, 120) });
    cursor = e2;
  }
  if (!out.length) throw new Error('no usable slots in the answer');
  return out;
}

const TEXT_KEYS = ['title', 'big', 'label', 'quote', 'accent', 'term', 'meaning', 'left', 'right', 'text', 'name', 'handle', 'shop', 'total'] as const;

export async function makeAi(slot: VisualSlot, theme: string, sentence: string, prev?: { type: string; title: string }): Promise<{ data: VisualData; motion?: Partial<MotionSelection> }> {
  const raw = json(await ask(makePrompt(slot, theme, sentence, prev))) as { data?: Record<string, unknown>; motion?: Record<string, string> };
  const d = raw.data ?? {}, data: VisualData = {};
  for (const k of TEXT_KEYS) if (typeof d[k] === 'string') (data as Record<string, string>)[k] = limitWords(d[k] as string, 12);
  if (Array.isArray(d.items)) data.items = d.items.slice(0, 5).map(x => limitWords(String(x), 5));
  if (Array.isArray(d.labels)) data.labels = d.labels.slice(0, 5).map(x => limitWords(String(x), 3));
  if (Array.isArray(d.values)) data.values = d.values.slice(0, 12).map(Number).filter(n => Number.isFinite(n));
  if (Array.isArray(d.lines)) data.lines = d.lines.slice(0, 6).map(x => String(x).slice(0, 40));
  if (typeof d.percent === 'number') data.percent = d.percent;
  if (typeof d.code === 'string') data.code = d.code.split('\n').slice(0, 7).join('\n');
  if (typeof d.lang === 'string') data.lang = d.lang as VisualData['lang'];
  if (!Object.keys(data).length || !wordsOf(JSON.stringify(data)).length) throw new Error('empty visual');
  const m = raw.motion ?? {}, motion: Partial<MotionSelection> = {};
  (['in', 'hold', 'out'] as const).forEach(k => { if (typeof m[k] === 'string' && getPreset(m[k]!).id === m[k]) motion[k] = m[k]; });
  return { data, motion };
}
