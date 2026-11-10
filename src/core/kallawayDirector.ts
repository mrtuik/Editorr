/**
 * Kallaway director: reads the transcript and picks teaching moments for motion cards, as many as the video needs
 *   step_checklist  tips / rules / steps      -> numbered list, the red bar follows each point
 *   script_blueprint hooks / scripts / copy   -> Hook / Body / CTA card
 *   stat_counter    numbers / growth / money  -> big number counting up
 *   quote_callout   one memorable line        -> big two-font headline
 *   custom_svg      a graphic the AI draws    -> cleaned, then drawn as a picture
 * Antigravity (built in, no key) decides when it is signed in; otherwise built-in rules find lists, numbers and big claims.
 */
import type { CapWord } from './captions';
import type { KallawayKind, KallawaySpec } from './kallaway';
import { syncStepStarts } from './kallaway';
import { sanitizeSvg } from './kallawaySvg';
import { EditorrNative, isNative } from './native';

export interface KallawayPick { spec: KallawaySpec; start: number; end: number }

const KIND_MAP: Record<string, KallawayKind> = {
  step_checklist: 'steps', script_blueprint: 'script', stat_counter: 'stat', quote_callout: 'quote', custom_svg: 'svg', loop_cycle: 'loop', versus: 'versus', tweet_card: 'tweet', receipt_card: 'receipt',
};

export function buildKallawayPrompt(words: CapWord[]): string {
  const lines: string[] = [];
  let line: string[] = [], t0 = 0;
  for (const w of words.slice(0, 5000)) {
    if (!line.length) t0 = w.s;
    line.push((w.orig || w.w).trim());
    if (line.length >= 10) { lines.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`); line = []; }
  }
  if (line.length) lines.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`);
  return `You are an expert motion designer who copies the look of Kallaway Marketing. Do NOT use any tools, do NOT read or write files.

Transcript with timestamps:
${lines.join('\n') || '(no transcript)'}

Pick EVERY high-value teaching moment for a typography card: about one card per 6 to 8 seconds of video (a 60 second video gets 7 to 10 cards). Cards must not overlap, each 2.5 to 10 seconds. Short sentences with a number or a bold claim get short stat / quote cards; lists get step_checklist. VARIETY IS REQUIRED: never use the same template twice in a row, never repeat a title, use each template at most 3 times, and give every card its own words from THIS moment of the transcript (never generic titles like "Key Steps") and choose a template for each:
- "step_checklist": the speaker lists tips, rules or steps. items = 2 to 5 short points in the speaker's order.
- "loop_cycle": the speaker describes a repeating cycle, framework or 3 to 5 stages. items = the stage names (1 to 3 words each), subtitle = a short word for the centre.
- "versus": the speaker compares two things (this vs that, wrong vs right). items = exactly 2 short labels.
- "stat_counter": the speaker talks about growth, percentages or money. stat.big = the number as spoken ("40%", "$1.2M", "300"), stat.label = a short line, stat.trend = "up" or "down" when it clearly rises or falls.
- "quote_callout": one memorable line. subtitle = a supporting line.
- "tweet_card": ONLY when the speaker reads out or paraphrases a post, comment, review or message. post.text = that text (max 160 chars), post.name + post.handle = the author ONLY if the speaker names them, otherwise leave them empty (never invent a real person or account), post.likes / post.reposts = numbers only if spoken.\n- "receipt_card": the speaker adds up costs, prices or earnings (2 to 6 items). receipt.shop = short heading, receipt.lines = [{label, amount}] as spoken ("$4.50"), receipt.total = the sum only if spoken.\n- "custom_svg": ONLY when a simple graphic explains the idea better. svg = ONE <svg> with a viewBox, plain shapes and text, no scripts, no images, no external links.

Title: titleSans = 1 to 2 bold words (e.g. "The"), titleSerif = 1 to 3 italic words (e.g. "Desire Hook"), titleLine2 = an optional bold second line (e.g. "Method").

Reply with ONE valid JSON array only, no markdown, no other text:
[{"kind":"step_checklist"|"loop_cycle"|"versus"|"stat_counter"|"quote_callout"|"tweet_card"|"receipt_card"|"custom_svg","start":<seconds>,"end":<seconds>,"titleSans":"","titleSerif":"","titleLine2":"","items":[],"stat":{"big":"","label":"","trend":"up"},"subtitle":"","post":{"name":"","handle":"","text":"","likes":"","reposts":""},"receipt":{"shop":"","lines":[{"label":"","amount":""}],"total":""},"svg":""}]`;
}

const clampMs = (v: unknown) => { const n = Math.round(Number(v) * 1000); return isFinite(n) ? n : NaN; };

/** Reads the director's answer. Bad entries are dropped, times are fixed to the video, picks never overlap, step times come from the words. */
export function parseKallawayJson(text: string, words: CapWord[], durationMs: number): KallawayPick[] {
  const m = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: KallawayPick[] = [];
  for (const o of arr as Record<string, unknown>[]) {
    if (!o || typeof o !== 'object') continue;
    const kind = KIND_MAP[String(o.kind)];
    if (!kind) continue;
    const start = clampMs(o.start);
    let end = clampMs(o.end);
    if (!isFinite(start) || !isFinite(end) || start < 0 || start >= durationMs) continue;
    const str = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const items = Array.isArray(o.items) ? (o.items as unknown[]).map((x) => str(x, 60)).filter(Boolean).slice(0, 5) : [];
    const spec: KallawaySpec = { kind, a: str(o.titleSans, 20), b: str(o.titleSerif, 28), c: str(o.titleLine2, 20), steps: kind === 'steps' || kind === 'loop' || kind === 'versus' ? items : [], handle: '' };
    if ((kind === 'steps' || kind === 'loop') && items.length < 2) continue;
    if (kind === 'versus') { if (items.length < 2) continue; spec.steps = items.slice(0, 2); }
    if (kind === 'loop') spec.sub = str(o.subtitle, 20);
    if (kind === 'stat') {
      const st = o.stat as Record<string, unknown> | undefined;
      const big = str(st?.big, 14);
      if (!big) continue;
      spec.stat = { big, label: str(st?.label, 90) || undefined, trend: st?.trend === 'down' ? 'down' : st?.trend === 'up' ? 'up' : undefined };
    }
    if (kind === 'quote') { spec.sub = str(o.subtitle, 120); if (!spec.a && !spec.b) continue; }
    if (kind === 'tweet') {
      const po = o.post as Record<string, unknown> | undefined;
      const text = str(po?.text, 160);
      if (!text) continue;
      spec.post = { name: str(po?.name, 28), handle: str(po?.handle, 24), text, likes: str(po?.likes, 10) || undefined, reposts: str(po?.reposts, 10) || undefined };
    }
    if (kind === 'receipt') {
      const ro = o.receipt as Record<string, unknown> | undefined;
      const lines = (Array.isArray(ro?.lines) ? (ro!.lines as Record<string, unknown>[]) : []).map((l) => ({ label: str(l?.label, 28), amount: str(l?.amount, 12) })).filter((l) => l.label && l.amount).slice(0, 6);
      if (lines.length < 2) continue;
      spec.receipt = { shop: str(ro?.shop, 24), lines, total: str(ro?.total, 12) || undefined };
    }
    if (kind === 'svg') {
      const clean = sanitizeSvg(String(o.svg ?? ''));
      if (!clean) continue;
      spec.svg = clean;
    }
    // length: long enough for every point, short enough to stay a moment
    const min = kind === 'steps' || kind === 'loop' ? items.length * 2000 : kind === 'stat' ? 2500 : kind === 'receipt' ? 3500 : 3000;
    end = Math.min(durationMs, Math.max(end, start + min), start + 14000);
    if (end - start < 1800) continue;
    if (kind === 'steps' || kind === 'loop') spec.stepStarts = syncStepStarts(items, words, start, end);
    out.push({ spec, start, end });
  }
  return spread(out);
}

/**
 * Variety guard: every scene must look different. Drops a card whose title repeats, a card of the same template as the one right before it
 * (a list-type may follow a list-type only when 2 cards apart), and a 4th use of any template. Dropped moments are covered by B-roll.
 */
export function diversify(picks: KallawayPick[]): KallawayPick[] {
  const out: KallawayPick[] = [], titles = new Set<string>(), uses = new Map<string, number>();
  for (const p of picks) {
    const key = [p.spec.a, p.spec.b, p.spec.c].join(' ').trim().toLowerCase() || p.spec.stat?.big || p.spec.post?.text || p.spec.receipt?.shop || '';
    if (key && titles.has(key)) continue;
    if (out.length && out[out.length - 1]!.spec.kind === p.spec.kind) continue;
    if ((uses.get(p.spec.kind) ?? 0) >= 3) continue;
    if (p.spec.kind === 'script') continue;
    if (key) titles.add(key);
    uses.set(p.spec.kind, (uses.get(p.spec.kind) ?? 0) + 1);
    out.push(p);
  }
  return out;
}

/** Sorted, no overlaps (min gap 300 ms). No cap on the count: the gaps between cards are filled with B-roll, so the video never sits on a plain talking head. */
function spread(picks: KallawayPick[]): KallawayPick[] {
  picks.sort((a, b) => a.start - b.start);
  const out: KallawayPick[] = [];
  for (const p of picks) {
    const l = out[out.length - 1];
    if (l && p.start < l.end + 300) continue;
    out.push(p);
  }
  return diversify(out);
}

// ---------------------------------------------------------------- built-in rules (no Antigravity)

const ORDINAL = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|step\s*\d|number\s*(?:one|two|three|four|five|\d)|tip\s*\d|rule\s*\d)\b[\s,:-]*/i;
const NUM = /(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|million|billion|trillion|thousand|crore|lakh|k|x|times)?/i;
const MONEY = /[$€£₹]\s?\d[\d,]*(?:\.\d+)?\s?[kKmMbB]?/g;
const POSTY = /\b(tweet|tweeted|posted|a post|comment|comments|replied|review|reviews|dm|dmed|texted me)\b/i;
const UP = /\b(up|rise|rose|grew|grow|growth|jump|jumped|surge|increase|gain|doubled|tripled)\b/i;
const DOWN = /\b(down|fall|fell|drop|dropped|lost|lose|decline|crash|halved)\b/i;
const CLAIM = /\b(never|always|nobody|everyone|biggest|worst|best|secret|truth|shocking|changed|mistake)\b/i;

function sentences(words: CapWord[]): { s: number; e: number; text: string }[] {
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

const title = (s: string) => s.split(' ').slice(0, 4).join(' ').replace(/[,.;:!?]+$/, '');

export function localKallawayPicks(words: CapWord[], durationMs: number): KallawayPick[] {
  if (durationMs < 8000 || !words.length) return [];
  const sent = sentences(words);
  const out: KallawayPick[] = [];
  // 1) EVERY spoken list: 3+ sentences with ordinal words close together
  const ord = sent.filter((s) => ORDINAL.test(s.text));
  for (let i = 0; i + 2 < ord.length; i++) {
    const run = [ord[i]!];
    while (i + run.length < ord.length && ord[i + run.length]!.s - run[run.length - 1]!.e < 6000 && ord[i + run.length]!.e - run[0]!.s < 14000 && run.length < 5) run.push(ord[i + run.length]!);
    if (run.length >= 3) {
      const items = run.map((r) => r.text.replace(ORDINAL, '').split(' ').slice(0, 7).join(' ').replace(/[,.;:!?]+$/, '')).filter(Boolean);
      const start = Math.max(0, run[0]!.s - 200), end = Math.min(durationMs, run[run.length - 1]!.e + 1200);
      const asLoop = out.some((o) => o.spec.kind === 'steps');
      out.push({ spec: { kind: asLoop ? 'loop' : 'steps', a: 'The', b: asLoop ? 'Loop' : 'Key', c: asLoop ? '' : 'Steps', steps: items, handle: '', stepStarts: syncStepStarts(items, words, start, end) }, start, end });
      i += run.length - 1;
    }
  }
  // 2) EVERY sentence with a number, 3) EVERY sentence with a big claim (not the same sentence twice, not over a list card)
  const free = (x: { s: number; e: number }) => out.every((o) => x.s > o.end + 300 || x.e < o.start - 300);
  for (const sn of sent) {
    if (sn.s < 800 || sn.e - sn.s < 1800 || !free(sn)) continue;
    const win = { start: Math.max(0, sn.s - 200), end: Math.min(durationMs, Math.max(sn.e + 600, sn.s + 3200)) };
    // two or more prices in one sentence -> a receipt that prints them
    const money = [...sn.text.matchAll(MONEY)];
    if (money.length >= 2) {
      let prev = 0;
      const lines = money.slice(0, 6).map((mm) => {
        const label = sn.text.slice(prev, mm.index).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\b(and|plus|then|is|are|was|for|the|a|an|of)\b/gi, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(-3).join(' ');
        prev = (mm.index ?? 0) + mm[0].length;
        return { label: label || 'Item', amount: mm[0].trim() };
      });
      out.push({ spec: { kind: 'receipt', a: '', b: '', c: '', steps: [], handle: '', receipt: { shop: 'The Math', lines } }, ...win });
      continue;
    }
    // somebody's post / comment / review: shown as a post card with a neutral author (never a real account)
    if (POSTY.test(sn.text) && sn.text.length > 24) {
      out.push({ spec: { kind: 'tweet', a: '', b: '', c: '', steps: [], handle: '', post: { name: 'Someone online', handle: '@someone', text: sn.text.length > 150 ? sn.text.slice(0, 147) + '...' : sn.text } }, ...win });
      continue;
    }
    const m = sn.text.match(NUM);
    const isNum = !!m && m[0].trim().length >= 2 && /\d/.test(m[0]);
    if (isNum) {
      const big = m![0].trim().replace(/\s?(percent)$/i, '%').toUpperCase();
      const trend = DOWN.test(sn.text) ? 'down' : UP.test(sn.text) ? 'up' : undefined;
      out.push({ spec: { kind: 'stat', a: 'The', b: 'Numbers', c: '', steps: [], handle: '', stat: { big, label: sn.text.replace(m![0], ' ').replace(/\s+/g, ' ').trim().slice(0, 90), trend } }, start: Math.max(0, sn.s - 200), end: Math.min(durationMs, Math.max(sn.e + 600, sn.s + 3000)) });
    } else if (CLAIM.test(sn.text) && sn.e - sn.s >= 2000) {
      out.push({ spec: { kind: 'quote', a: '', b: title(sn.text), c: '', steps: [], handle: '', sub: sn.text.length > 100 ? sn.text.slice(0, 97) + '...' : sn.text }, start: Math.max(0, sn.s - 200), end: Math.min(durationMs, Math.max(sn.e + 500, sn.s + 3000)) });
    }
  }
  return spread(out);
}

/** Plans the cards. Antigravity first (Android app, signed in); on any problem the built-in rules are used and `note` says why. */
export async function planKallaway(words: CapWord[], durationMs: number, useAntigravity: boolean): Promise<{ picks: KallawayPick[]; source: 'llm' | 'local'; note?: string }> {
  let note: string | undefined;
  if (useAntigravity) {
    try {
      if (!isNative()) throw new Error('Antigravity works in the Android app only');
      const st = await EditorrNative.antigravityStatus();
      if (!st.installed) throw new Error('Antigravity is not set up yet');
      if (!st.signedIn) throw new Error('Antigravity is not signed in');
      const { response } = await EditorrNative.askAntigravity({ prompt: buildKallawayPrompt(words) });
      const picks = parseKallawayJson(response, words, durationMs);
      if (picks.length) return { picks, source: 'llm' };
      throw new Error('no usable cards in the answer');
    } catch (e) { note = `Antigravity: ${(e as Error).message || 'no answer'}. The built-in rules were used.`; }
  }
  return { picks: localKallawayPicks(words, durationMs), source: 'local', note };
}
