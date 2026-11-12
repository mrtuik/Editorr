/** Offline planner: same slots and same data shape as the AI, built from regex rules. Never returns 0 visuals for speech. */
import { pickMotion } from './motion';
import { getTheme } from './themes';
import type { MotionSelection, TWord, VisualData, VisualSlot, VisualType } from './types';
import { limitWords, words } from './templates/util';

const NUM = /(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|lakh|crore|million|billion|thousand|k\b|taka|rupees?|dollars?|টাকা|শতাংশ|লাখ|কোটি)?/gi;
const RE_VS = /\b(vs\.?|versus|instead of|rather than|compared to)\b|বনাম|এর বদলে|के बजाय|बनाम/i;
const RE_DEF = /\b(is an?|means|called|refers to|stands for)\b|মানে|বলা হয়|कहते हैं|मतलब/i;
const RE_CODE = /\b(code|function|api|html|css|javascript|python|bug|server|database|terminal|command|github|app)\b|কোড|कोड/i;
const RE_LIST = /\b(first|second|third|step|steps|finally|then)\b|প্রথম|দ্বিতীয়|তৃতীয়|पहला|दूसरा/i;

interface Sentence { text: string; startMs: number; endMs: number }

export function sentencesOf(ws: TWord[]): Sentence[] {
  const out: Sentence[] = []; let cur: TWord[] = [];
  const flush = () => { if (cur.length) { out.push({ text: cur.map(w => w.text).join(' ').trim(), startMs: cur[0].startMs, endMs: cur[cur.length - 1].endMs }); cur = []; } };
  for (let i = 0; i < ws.length; i++) {
    cur.push(ws[i]);
    const gap = i + 1 < ws.length ? ws[i + 1].startMs - ws[i].endMs : 0;
    if (/[.!?।]$/.test(ws[i].text) || gap > 600 || cur.length >= 20) flush();
  }
  flush(); return out;
}

const numsOf = (s: string) => (s.match(NUM) ?? []).map(x => x.trim()).filter(x => /\d/.test(x));
const listParts = (s: string) => s.split(/,|;|\band\b|\bthen\b| এবং | আর | और /i).map(x => limitWords(x.trim(), 4)).filter(x => x.length > 1);

export function classify(s: string): VisualType {
  const n = numsOf(s);
  if (RE_CODE.test(s)) return 'terminal';
  if (RE_VS.test(s)) return 'versus_card';
  if (n.length >= 2 && n.every(x => /\d/.test(x))) return 'bar_chart';
  if (n.length === 1) return /%|percent|শতাংশ/i.test(n[0]) ? 'progress_ring' : 'stat_counter';
  if (RE_LIST.test(s) || listParts(s).length >= 3) return 'list_card';
  if (RE_DEF.test(s)) return 'definition_card';
  return words(s).length <= 12 ? 'quote_card' : 'keyword_title';
}

const ALT: VisualType[] = ['keyword_title', 'quote_card', 'definition_card', 'list_card', 'stat_counter'];

export function planLocal(ws: TWord[], durationMs: number): VisualSlot[] {
  const ss = sentencesOf(ws).filter(s => s.endMs - s.startMs > 500 && words(s.text).length >= 2);
  const slots: VisualSlot[] = []; let cursor = 0;
  for (const s of ss) {
    if (s.startMs < cursor || s.startMs >= durationMs) continue;
    const start = s.startMs, end = Math.min(durationMs, start + Math.max(2000, Math.min(5000, s.endMs - s.startMs)));
    const prev = slots[slots.length - 1];
    if (prev && start - prev.endMs <= 3000 && prev.endMs - prev.startMs < 5000) prev.endMs = Math.min(start, prev.startMs + 5000);
    slots.push({ id: `v${slots.length + 1}`, startMs: start, endMs: end, type: classify(s.text), intent: limitWords(s.text, 10) });
    cursor = end;
  }
  // rotation: never the same type twice in a row; one type at most 30% of the slots
  const cap = Math.max(2, Math.ceil(slots.length * 0.3)), count: Partial<Record<VisualType, number>> = {};
  slots.forEach((sl, i) => {
    const bad = (t: VisualType) => t === slots[i - 1]?.type || (count[t] ?? 0) >= cap;
    if (bad(sl.type)) sl.type = ALT.find(t => !bad(t)) ?? 'keyword_title';
    count[sl.type] = (count[sl.type] ?? 0) + 1;
  });
  return slots;
}

const longest = (s: string, n: number) => words(s).sort((a, b) => b.length - a.length).slice(0, n);

/** Fill one slot's data from the sentence. Quotes only what was said; never invents numbers or names. */
export function makeLocal(slot: VisualSlot, sentence: string, themeId: string, index: number, prevIn?: string): { data: VisualData; motion: MotionSelection; type: VisualType } {
  const s = sentence.replace(/\s+/g, ' ').trim(), n = numsOf(s);
  let type = slot.type, data: VisualData = {};
  const asKeyword = () => { type = 'keyword_title'; const k = longest(s, 2); data = { title: words(s).filter(w => k.includes(w)).join(' ') || limitWords(s, 3) }; };
  if (type === 'stat_counter' || type === 'progress_ring') {
    if (!n.length) asKeyword();
    else if (type === 'progress_ring' && /\d/.test(n[0])) { data = { percent: parseFloat(n[0].replace(/[^\d.]/g, '')), label: limitWords(s.replace(n[0], '').trim(), 6) }; }
    else data = { big: n[0], label: limitWords(s.replace(n[0], '').trim(), 6) };
  } else if (type === 'bar_chart') {
    const ws = words(s), labels: string[] = [], values: number[] = [];
    ws.forEach((w, i) => { const m = w.match(/\d[\d,]*(?:\.\d+)?/); if (m && i > 0 && values.length < 5) { values.push(parseFloat(m[0].replace(/,/g, ''))); labels.push(ws[i - 1].replace(/[^\p{L}\p{N}]/gu, '')); } });
    if (values.length >= 2 && labels.every(Boolean)) data = { labels, values }; else { type = 'stat_counter'; data = { big: n[0], label: limitWords(s.replace(n[0] ?? '', '').trim(), 6) }; }
  } else if (type === 'versus_card') {
    const [l, r] = s.split(RE_VS).filter((_, i) => i !== 1 && (_ ?? '').trim());
    if (l && r) data = { left: limitWords(l.trim().split(' ').slice(-3).join(' '), 3), right: limitWords(r.trim(), 3) }; else asKeyword();
  } else if (type === 'list_card') {
    const it = listParts(s).slice(0, 5); if (it.length >= 2) data = { title: '', items: it }; else asKeyword();
  } else if (type === 'definition_card') {
    const m = s.split(RE_DEF); const term = (m[0] ?? '').trim().split(' ').slice(-3).join(' '), mean = (m[m.length - 1] ?? '').trim();
    if (term && mean && m.length >= 3) data = { term, meaning: limitWords(mean, 8) }; else asKeyword();
  } else if (type === 'terminal') {
    data = { lines: [limitWords(s, 6)] };
  } else if (type === 'quote_card') {
    data = { quote: limitWords(s, 12), accent: longest(s, 1)[0]?.replace(/[^\p{L}\p{N}]/gu, '') };
  } else asKeyword();
  return { data, motion: pickMotion(getTheme(themeId), index, prevIn), type };
}
