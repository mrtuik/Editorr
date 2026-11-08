/**
 * The 4-route B-roll engine (no key). Every beat goes to ONE route; each route has an ordered list of sources
 * and falls back to the next one when nothing is found (video first, then a photo as the last resort).
 *
 *   entity    a named person / brand / product   YouTube clip (Android) -> Commons video -> Wikipedia / Commons photo
 *   receipt   news, claims, tweets, studies      article card (Wikipedia clipping, blur-fill, slow zoom) -> photo
 *   concept   numbers, rises, falls              concept card (big number + trend line)
 *   archival  old times, wars, places, events    archive.org film -> Commons video -> Commons photo
 */
import {
  bestForKeyword, clipInPoint, downloadBroll, downloadBrollVideo, downloadYoutubeClip, resolveArchiveVideo, searchArticles, searchVideos, searchYoutubeClips,
  type ArticleItem, type BrollItem,
} from './brollEngine';
import { conceptFromText, makeArticleCard, makeConceptCard, type ConceptSpec } from './brollCards';
import { BROLL_MOTIONS, type BrollFrame, type BrollKind, type BrollMotion, type BrollRoute, type BrollSource } from './brollTypes';
import { isNative } from './native';

export type VideoMode = 'photos' | 'mix' | 'video';

/** What the router decided for one beat. */
export interface RoutePlan { i: number; route: BrollRoute; keyword: string; motion?: BrollMotion; big?: string; label?: string; trend?: 'up' | 'down' }

/** A ready asset for a beat. `path` is the saved file on the phone (missing in the browser). */
export interface Asset {
  kind: BrollKind;
  url: string;
  thumb: string;
  title: string;
  source: BrollSource;
  credit?: string;
  path?: string;
  inMs?: number;
  srcMs?: number;
  /** the frame this kind of material looks right in */
  frame?: BrollFrame;
  motion?: BrollMotion;
}

// ---------------------------------------------------------------- local rules (used when Antigravity is not available)

const RX_ARCHIVAL = /\b(1[0-8]\d\d|19[0-8]\d)\b|\b(war|wars|empire|ancient|century|centuries|medieval|revolution|colonial|dynasty|world war|ottoman|roman|nazi|soviet|cold war|history|historic|decades ago|years ago)\b|ইতিহাস|যুদ্ধ|সাম্রাজ্য|প্রাচীন|শতাব্দী|বছর আগে/i;
const RX_RECEIPT = /\b(news|reported|reports|report|headline|newspaper|tweet|tweeted|posted|post|announced|statement|study|studies|survey|according|published|article|claimed|claims|leaked|investigation|court|lawsuit|law|bill)\b|খবর|পত্রিকা|প্রতিবেদন|দাবি|ঘোষণা|জরিপ|গবেষণা|মামলা/i;
const RX_CONCEPT = /\d[\d,.]*\s?(%|percent|million|billion|trillion|crore|lakh|k\b)|[$€£₹৳]\s?\d|\b(percent|million|billion|trillion|crash|collapse|surge|soar|plunge|doubled|tripled|record high|all-time|bankrupt)\b|শতাংশ|কোটি|লাখ|ধস|পতন/i;

export function localRouteOf(text: string): BrollRoute | 'plain' {
  if (RX_ARCHIVAL.test(text)) return 'archival';
  if (RX_RECEIPT.test(text)) return 'receipt';
  if (RX_CONCEPT.test(text)) return 'concept';
  if (/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b|\b[A-Z]{2,}\b/.test(text.replace(/^[A-Z][a-z]+\s/, ''))) return 'entity';
  return 'plain';
}

/** Keeps the mix lively: at most ~15% concept cards and ~30% article cards; the rest becomes video / photo. */
export function applyQuotas(plans: RoutePlan[]): RoutePlan[] {
  const n = plans.length;
  const maxConcept = Math.max(1, Math.round(n * 0.15)), maxReceipt = Math.max(1, Math.round(n * 0.3));
  let c = 0, r = 0;
  return plans.map((p) => {
    if (p.route === 'concept') { if (++c > maxConcept) return { ...p, route: 'entity' as BrollRoute }; }
    if (p.route === 'receipt') { if (++r > maxReceipt) return { ...p, route: 'entity' as BrollRoute }; }
    return p;
  });
}

// ---------------------------------------------------------------- Antigravity prompt

export function buildRoutePrompt(slots: { i: number; start: number; end: number; text: string }[]): string {
  const lines = slots.map((s) => `${s.i}. [${(s.start / 1000).toFixed(1)}s-${(s.end / 1000).toFixed(1)}s] ${s.text}`);
  return `You are a fast-paced Vox / Johnny Harris documentary director choosing B-roll. Do NOT use any tools, do NOT read or write files.
Below are numbered 2-3 second beats of a voice-over transcript (any language). For EACH beat choose ONE route and ONE English search keyword:
- "entity": the beat names a specific person, brand, product or organisation. Keyword = its full name (e.g. "Elon Musk", "SpaceX Starship launch"). Real video clips are searched.
- "receipt": the beat cites news, a claim, a study, a tweet or a statement. Keyword = the subject of the story (e.g. "Silicon Valley Bank collapse"). A paper article clipping is shown.
- "concept": the beat is an abstract idea or number (a percentage, a price crash, growth). Also give "big" (the number or 1-3 words to show huge, e.g. "-40%") and "trend" ("up" or "down" when it rises or falls). Keyword = short subject.
- "archival": the beat is about the past: an era, war, old city, historic event. Keyword = the thing with its year or era (e.g. "Black Monday 1987 trading floor", "Berlin Wall 1989"). Old film is searched.
Rules: make every keyword self-contained (add the main subject or year from nearby beats when the beat alone is vague). Never generic words like "business" or "people".
Use "concept" for at most 1 beat in 7 and "receipt" for at most 1 beat in 3. Also pick a motion: zoom_in, zoom_out, pan_left or pan_right.

Beats:
${lines.join('\n')}

Reply with ONE valid JSON array only, no markdown, no other text:
[{"i":1,"route":"entity","keyword":"...","motion":"zoom_in"},{"i":2,"route":"concept","keyword":"...","big":"-40%","trend":"down"}]`;
}

const ROUTES: BrollRoute[] = ['entity', 'receipt', 'concept', 'archival'];

export function parseRoutePlan(text: string): Map<number, Omit<RoutePlan, 'i'>> {
  const out = new Map<number, Omit<RoutePlan, 'i'>>();
  const m = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const o of arr as Record<string, unknown>[]) {
    const i = Number(o?.i), kw = String(o?.keyword ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const route = ROUTES.includes(o?.route as BrollRoute) ? (o.route as BrollRoute) : undefined;
    if (!isFinite(i) || !kw || !route) continue;
    const big = String(o?.big ?? '').trim().slice(0, 28);
    out.set(i, {
      route, keyword: kw, motion: BROLL_MOTIONS.includes(o.motion as BrollMotion) ? (o.motion as BrollMotion) : undefined,
      ...(big ? { big } : {}), ...(o.trend === 'up' || o.trend === 'down' ? { trend: o.trend } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- fetching the asset for one beat

export interface FetchCtx {
  /** ids / urls already used in this run (no repeats) */
  used: Set<string>;
  videoMode: VideoMode;
  /** width / height of the output frame */
  aspect: number;
  /** running number of the beat, used to alternate video and photo in `mix` mode */
  idx: number;
  /** the words of the beat */
  text: string;
  /** keeps a started file from being written after Stop */
  signal: { cancelled: boolean };
}

/** A portrait or very square picture on a wide frame (or the reverse) is shown whole over a blurred copy instead of being cropped. */
export function frameForPhoto(item: { width?: number; height?: number }, aspect: number, wanted: BrollFrame): BrollFrame {
  if (wanted === 'blur' || !item.width || !item.height) return wanted;
  const ia = item.width / item.height;
  return Math.abs(Math.log(ia / Math.max(0.2, aspect))) > 0.55 ? 'blur' : wanted;
}

async function videoAsset(item: BrollItem, lenMs: number, ctx: FetchCtx): Promise<Asset | undefined> {
  let it: BrollItem | undefined = item;
  let path: string | undefined, dur = item.durationMs ?? 0;
  if (item.source === 'youtube') {
    const r = await downloadYoutubeClip(item);
    if (!r) return undefined;
    path = r.path; dur = r.durationMs || dur;
  } else {
    if (item.source === 'archive') { try { it = await resolveArchiveVideo(item); } catch { it = undefined; } }
    if (!it?.url) return undefined;
    dur = it.durationMs ?? dur;
    path = await downloadBrollVideo(it);
    if (!path && isNative()) return undefined;
  }
  if (ctx.signal.cancelled) return undefined;
  const inMs = clipInPoint(dur, lenMs);
  return {
    kind: 'video', url: it?.url || item.url, thumb: item.thumb, title: item.title, source: item.source, credit: item.credit,
    ...(path ? { path } : {}), inMs, ...(dur ? { srcMs: dur } : {}), frame: 'full',
  };
}

async function firstVideo(items: BrollItem[], lenMs: number, ctx: FetchCtx, tries = 3): Promise<Asset | undefined> {
  let n = 0;
  for (const it of items) {
    if (ctx.signal.cancelled || n >= tries) break;
    if (ctx.used.has(it.id)) continue;
    n++;
    const a = await videoAsset(it, lenMs, ctx);
    if (a) { ctx.used.add(it.id); return a; }
  }
  return undefined;
}

async function photoAsset(keyword: string, ctx: FetchCtx, wantedFrame: BrollFrame): Promise<Asset | undefined> {
  const item = await bestForKeyword(keyword, ctx.used);
  if (!item) return undefined;
  ctx.used.add(item.url);
  const path = await downloadBroll(item);
  if (!path && isNative()) return undefined;
  return {
    kind: 'photo', url: item.url, thumb: item.thumb, title: item.title, source: item.source, credit: item.credit,
    ...(path ? { path } : {}), frame: frameForPhoto(item, ctx.aspect, wantedFrame),
  };
}

export async function conceptAsset(spec: ConceptSpec, aspect: number): Promise<Asset> {
  const c = await makeConceptCard(spec, aspect);
  return { kind: 'card', url: c.url, thumb: c.thumb, title: spec.big, source: 'card', ...(c.path ? { path: c.path } : {}), frame: 'full', motion: 'slow_zoom' };
}

export async function articleAsset(a: ArticleItem, keywords: string): Promise<Asset> {
  const c = await makeArticleCard(a, keywords);
  return {
    kind: 'card', url: c.url, thumb: c.thumb, title: a.title, source: 'card', credit: `Wikipedia: ${a.title} (CC BY-SA)`,
    ...(c.path ? { path: c.path } : {}), frame: 'blur', motion: 'slow_zoom',
  };
}

const wantsVideo = (ctx: FetchCtx) => ctx.videoMode === 'video' || (ctx.videoMode === 'mix' && ctx.idx % 2 === 0);

/** The dual asset engine: tries the sources of the beat's route in order, video before photo. */
export async function fetchForPlan(plan: RoutePlan, lenMs: number, ctx: FetchCtx, wantedFrame: BrollFrame): Promise<Asset | undefined> {
  const kw = plan.keyword;
  const video = wantsVideo(ctx) && ctx.videoMode !== 'photos';

  if (plan.route === 'concept') {
    const auto = conceptFromText(ctx.text, kw);
    return conceptAsset({ big: plan.big || auto.big, label: plan.big ? auto.label ?? ctx.text.slice(0, 90) : auto.label, trend: plan.trend ?? auto.trend }, ctx.aspect);
  }

  if (plan.route === 'receipt') {
    try {
      const arts = await searchArticles(kw, 5);
      const art = arts.find((a) => !ctx.used.has(a.id));
      if (art) { ctx.used.add(art.id); return await articleAsset(art, kw); }
    } catch { /* fall through to a photo */ }
    return photoAsset(kw, ctx, wantedFrame);
  }

  if (plan.route === 'archival') {
    if (video) {
      try { const a = await firstVideo(await searchVideos(kw, { limit: 8, archive: 'first' }), lenMs, ctx); if (a) return a; } catch { /* next source */ }
    }
    return photoAsset(kw, ctx, wantedFrame);
  }

  // entity (and plain): a real clip of the person / thing first
  if (video) {
    try {
      const yt = await searchYoutubeClips(kw, 5);
      const a = await firstVideo(yt, lenMs, ctx, 2);
      if (a) return a;
    } catch { /* YouTube not available: next source */ }
    try { const a = await firstVideo(await searchVideos(kw, { limit: 8, archive: 'off' }), lenMs, ctx); if (a) return a; } catch { /* next source */ }
  }
  return photoAsset(kw, ctx, wantedFrame);
}

/** Turns one search result (any kind) into an Asset: used by the manual search tab. */
export async function assetFromItem(it: BrollItem, lenMs: number, aspect: number, wantedFrame: BrollFrame, signal: { cancelled: boolean } = { cancelled: false }): Promise<Asset | undefined> {
  if (it.kind === 'video') return videoAsset(it, lenMs, { used: new Set(), videoMode: 'video', aspect, idx: 0, text: '', signal });
  // a photo that could not be saved still goes on the timeline (preview works, the export skips it: the sheet tells the user)
  const path = await downloadBroll(it);
  return { kind: 'photo', url: it.url, thumb: it.thumb, title: it.title, source: it.source, credit: it.credit, ...(path ? { path } : {}), frame: frameForPhoto(it, aspect, wantedFrame) };
}
