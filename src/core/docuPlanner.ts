/**
 * Documentary director: picks 3 to 6 high-impact moments of the transcript and turns them into DocuBeats.
 * Antigravity (built in, no API key) decides when it is signed in; otherwise a built-in rule finds numbers, questions and big claims.
 */
import type { CapWord } from './captions';
import { DOCU_ACCENTS, DEFAULT_CARD_RADIUS, defaultPos, docuLayoutFor, flipPos, type DocuBeat, type DocuPos, type DocuTheme, type DocuType, MAX_CARD_RADIUS } from './docuTypes';
import { EditorrNative, isNative } from './native';
import { uid } from './speaker';
import type { Aspect } from './types';

/** The director prompt for Antigravity. Words are listed as timed lines (seconds), the answer is a JSON array. */
export function buildDocuTypographyPrompt(words: CapWord[], aspect: Aspect): string {
  const wide = docuLayoutFor(aspect) === 'side';
  const lines: string[] = [];
  let line: string[] = [], t0 = 0;
  for (const w of words.slice(0, 5000)) {
    if (!line.length) t0 = w.s;
    line.push((w.orig || w.w).trim());
    if (line.length >= 10) { lines.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`); line = []; }
  }
  if (line.length) lines.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`);
  return `You are an elite documentary video director (Vox, Johnny Harris, Apple Keynote style). Do NOT use any tools, do NOT read or write files.
The video is "${aspect}" (${wide ? 'wide' : 'tall'}).

Transcript with timestamps:
${lines.join('\n') || '(no transcript)'}

Pick 3 to 6 high-impact moments (climax statements, shocking statistics, rhetorical questions, topic changes). Each lasts 2 to 6 seconds and they must not overlap.

LAYOUT RULES:
${wide
    ? `- Use "black_screen" for intense climax moments (full black frame, bold centre text).
- Use "split_screen" with layout "side": the video sits on "left" or "right" (about half the frame), the text card takes the other half.`
    : `- Use "black_screen" for intense climax moments.
- Use "split_screen" with layout "updown": the video sits on "top" or "bottom" (about 55%), the text card takes the rest.`}
- "kinetic_quote" = a big quote over the video, for a memorable line.

Reply with ONE valid JSON array only, no markdown, no other text:
[{"type":"black_screen"|"split_screen"|"kinetic_quote","start":<seconds>,"end":<seconds>,"layout":"${wide ? 'side' : 'updown'}","video_position":"${wide ? 'left' : 'top'}","card_radius":28,"headline":"<PUNCHY BOLD TEXT, max 5 words>","subtext":"<supporting context or statistic>","accent_color":"#C6F277"|"#38BDF8"|"#FFD60A"|"#F43F5E","theme":"noir"|"investigative"|"modern"}]`;
}

const clamp = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);

/** Reads the director's answer. Bad entries are dropped, times are fixed to the video, beats never overlap. Seconds in, ms out. */
export function parseDocuJson(text: string, durationMs: number, aspect: Aspect): DocuBeat[] {
  const m = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const layout = docuLayoutFor(aspect);
  const types: DocuType[] = ['black_screen', 'split_screen', 'kinetic_quote'];
  const themes: DocuTheme[] = ['noir', 'investigative', 'modern'];
  const out: DocuBeat[] = [];
  for (const o of arr as Record<string, unknown>[]) {
    if (!o || typeof o !== 'object') continue;
    const type = types.includes(o.type as DocuType) ? (o.type as DocuType) : 'split_screen';
    const start = Math.round(Number(o.start) * 1000), end = Math.round(Number(o.end) * 1000);
    if (!isFinite(start) || !isFinite(end) || end - start < 1200 || start < 0 || start >= durationMs) continue;
    const headline = String(o.headline ?? '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
    if (!headline) continue;
    // the layout always follows the project shape; the position is kept only when it fits that layout
    let pos = o.video_position as DocuPos;
    const ok = layout === 'side' ? pos === 'left' || pos === 'right' : pos === 'top' || pos === 'bottom';
    if (!ok) pos = defaultPos(layout);
    const accent = typeof o.accent_color === 'string' && /^#[0-9a-f]{6}$/i.test(o.accent_color) ? o.accent_color : DOCU_ACCENTS[out.length % DOCU_ACCENTS.length]!;
    out.push({
      id: uid(), type, start, end: Math.min(end, durationMs, start + 8000), layout, video_position: pos,
      card_radius: Math.round(clamp(o.card_radius, 0, MAX_CARD_RADIUS, DEFAULT_CARD_RADIUS)),
      headline, ...(o.subtext ? { subtext: String(o.subtext).slice(0, 140) } : {}), accent_color: accent,
      theme: themes.includes(o.theme as DocuTheme) ? (o.theme as DocuTheme) : 'noir',
    });
  }
  return spread(out);
}

/** Sorted, no overlaps, at most 6, and the card side alternates so it does not look the same every time. */
function spread(beats: DocuBeat[]): DocuBeat[] {
  beats.sort((a, b) => a.start - b.start);
  const out: DocuBeat[] = [];
  for (const b of beats) {
    const l = out[out.length - 1];
    if (l && b.start < l.end + 500) continue;
    out.push(b);
    if (out.length >= 6) break;
  }
  return out;
}

// ---------------------------------------------------------------- built-in rules (no Antigravity)

const NUM = /\b\d[\d,.]*\s?(%|percent|million|billion|crore|lakh|thousand|x|times)?\b/i;
const CLAIM = /\b(never|always|nobody|everyone|biggest|worst|best|secret|truth|shocking|changed|billion|million|crore|lakh)\b/i;

/** Sentences from the words (a pause of 600 ms or more ends a sentence). */
function sentences(words: CapWord[]): { s: number; e: number; text: string }[] {
  const out: { s: number; e: number; text: string }[] = [];
  let cur: CapWord[] = [];
  const flush = () => { if (cur.length >= 3) out.push({ s: cur[0]!.s, e: cur[cur.length - 1]!.e, text: cur.map((w) => (w.orig || w.w).trim()).join(' ') }); cur = []; };
  for (let i = 0; i < words.length; i++) {
    if (cur.length && (words[i]!.s - cur[cur.length - 1]!.e >= 600 || /[.?!।]$/.test((cur[cur.length - 1]!.orig || '').trim()))) flush();
    cur.push(words[i]!);
  }
  flush();
  return out;
}

/** Score = numbers, questions and big words. Picks the best few that are far apart. */
export function localDocuBeats(words: CapWord[], durationMs: number, aspect: Aspect): DocuBeat[] {
  if (durationMs < 8000) return [];
  const layout = docuLayoutFor(aspect);
  const want = Math.max(2, Math.min(5, Math.round(durationMs / 20000)));
  const cand = sentences(words).map((s) => {
    let sc = 0;
    if (NUM.test(s.text)) sc += 3;
    if (/\?/.test(s.text)) sc += 2;
    if (CLAIM.test(s.text)) sc += 2;
    sc += Math.min(1, s.text.split(' ').length / 12);
    return { ...s, sc };
  }).filter((c) => c.sc >= 2 && c.s > 1500).sort((a, b) => b.sc - a.sc);
  const picked: typeof cand = [];
  for (const c of cand) {
    if (picked.every((p) => Math.abs(p.s - c.s) > 6000)) picked.push(c);
    if (picked.length >= want) break;
  }
  picked.sort((a, b) => a.s - b.s);
  let pos: DocuPos = defaultPos(layout);
  return picked.map((c, i) => {
    const num = c.text.match(NUM)?.[0]?.trim();
    const head = (num && c.text.split(' ').length > 5 ? num : c.text.split(' ').slice(0, 5).join(' ')).replace(/[,.;:!?]+$/, '');
    const type: DocuType = c.sc >= 5 ? 'black_screen' : 'split_screen';
    const beat: DocuBeat = {
      id: uid(), type, start: Math.max(0, c.s - 200), end: Math.min(durationMs, Math.max(c.e + 400, c.s + 2500)), layout, video_position: pos,
      card_radius: DEFAULT_CARD_RADIUS, headline: head, subtext: c.text.length > 90 ? c.text.slice(0, 87) + '...' : c.text,
      accent_color: DOCU_ACCENTS[i % DOCU_ACCENTS.length]!, theme: 'noir',
    };
    pos = flipPos(pos);
    return beat;
  });
}

/**
 * Plans the beats. Antigravity first (Android app, signed in); on any problem the built-in rules are used and `note` says why.
 */
export async function planDocuBeats(words: CapWord[], aspect: Aspect, durationMs: number, useAntigravity: boolean): Promise<{ beats: DocuBeat[]; source: 'llm' | 'local'; note?: string }> {
  let note: string | undefined;
  if (useAntigravity) {
    try {
      if (!isNative()) throw new Error('Antigravity works in the Android app only');
      const st = await EditorrNative.antigravityStatus();
      if (!st.installed) throw new Error('Antigravity is not set up yet');
      if (!st.signedIn) throw new Error('Antigravity is not signed in');
      const { response } = await EditorrNative.askAntigravity({ prompt: buildDocuTypographyPrompt(words, aspect) });
      const beats = parseDocuJson(response, durationMs, aspect);
      if (beats.length) return { beats, source: 'llm' };
      throw new Error('no usable beats in the answer');
    } catch (e) { note = `Antigravity: ${(e as Error).message || 'no answer'}. The built-in rules were used.`; }
  }
  return { beats: localDocuBeats(words, durationMs, aspect), source: 'local', note };
}
