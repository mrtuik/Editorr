/**
 * Zero-key photo search for B-roll. Three open sources, all free, no sign-up:
 *   Wikimedia Commons  (history, people, places, events, science, archives)
 *   Wikipedia          (the lead photo of the best matching article: a person, a company, an event)
 *   Openverse          (Creative Commons photos from many sites; small anonymous quota, so it is skipped when it fails)
 * In the Android app the requests go through Capacitor's native HTTP (no CORS limits, proper User-Agent).
 * In the browser they use fetch (Wikimedia and Wikipedia allow it with origin=*).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { BrollSource } from './brollTypes';
import { EditorrNative, isNative as nativeApp, youtubeAvailable, type YoutubeItem } from './native';

export interface BrollItem {
  id: string;
  url: string;
  thumb: string;
  title: string;
  source: BrollSource;
  credit?: string;
  width?: number;
  height?: number;
  /** missing = photo */
  kind?: 'photo' | 'video';
  /** video: length of the file in ms (0 / missing = not known yet) */
  durationMs?: number;
  /** archive.org video: the item name; the file address is looked up when the clip is picked */
  archiveId?: string;
  /** YouTube video id; the clip is downloaded when picked */
  ytId?: string;
}

const UA = 'Editorr/16 (Android video editor; contact: https://github.com/mrtuik/Editorr)';
const isNative = () => Capacitor.isNativePlatform();

async function getJson(url: string): Promise<any> {
  if (isNative()) {
    const r = await CapacitorHttp.get({ url, headers: { 'User-Agent': UA, Accept: 'application/json' }, connectTimeout: 12000, readTimeout: 15000 });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const stripHtml = (s: unknown) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
const q = encodeURIComponent;

/** Wikimedia only serves a fixed set of thumbnail widths. 330 is one of them. */
function smallThumb(url: string): string {
  return /upload\.wikimedia\.org\/.*\/thumb\//.test(url) ? url.replace(/\/\d+px-([^/]+)$/, '/330px-$1') : url;
}

// ---------------------------------------------------------------- sources

async function fromCommons(query: string, limit: number): Promise<BrollItem[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${q(query)}&gsrnamespace=6&gsrlimit=${limit}`
    + `&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1280&iiextmetadatafilter=Artist|LicenseShortName`;
  const data = await getJson(url);
  const pages = Object.values(data?.query?.pages ?? {}) as any[];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: BrollItem[] = [];
  for (const pg of pages) {
    const info = pg.imageinfo?.[0];
    if (!info) continue;
    const mime = String(info.mime ?? '');
    if (!/^image\/(jpeg|png|webp|svg\+xml)$/.test(mime)) continue;
    if ((info.width ?? 0) < 640) continue;
    const full = String(info.thumburl || info.url || '');
    if (!full) continue;
    const artist = stripHtml(info.extmetadata?.Artist?.value), lic = stripHtml(info.extmetadata?.LicenseShortName?.value);
    out.push({
      id: `wm_${pg.pageid}`, url: full, thumb: smallThumb(full), title: String(pg.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
      source: 'wikimedia', credit: [artist, lic, 'Wikimedia Commons'].filter(Boolean).join(' / '), width: info.width, height: info.height,
    });
  }
  return out;
}

async function fromWikipedia(query: string, limit: number): Promise<BrollItem[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${q(query)}&gsrlimit=${limit}`
    + `&prop=pageimages&piprop=thumbnail&pithumbsize=1280`;
  const data = await getJson(url);
  const pages = Object.values(data?.query?.pages ?? {}) as any[];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: BrollItem[] = [];
  for (const pg of pages) {
    const t = pg.thumbnail;
    if (!t?.source || (t.width ?? 0) < 400) continue;
    out.push({ id: `wp_${pg.pageid}`, url: t.source, thumb: smallThumb(t.source), title: String(pg.title ?? ''), source: 'wikipedia', credit: `Wikipedia: ${pg.title}`, width: t.width, height: t.height });
  }
  return out;
}

async function fromOpenverse(query: string, limit: number): Promise<BrollItem[]> {
  const url = `https://api.openverse.org/v1/images/?q=${q(query)}&page_size=${limit}&mature=false&license_type=commercial`;
  const data = await getJson(url);
  const out: BrollItem[] = [];
  for (const r of (data?.results ?? []) as any[]) {
    if (!r?.url) continue;
    if (r.width && r.width < 640) continue;
    out.push({
      id: `ov_${r.id}`, url: String(r.url), thumb: String(r.thumbnail || r.url), title: String(r.title || query),
      source: 'openverse', credit: [r.creator, r.license ? `CC ${String(r.license).toUpperCase()}${r.license_version ? ' ' + r.license_version : ''}` : '', r.source].filter(Boolean).join(' / '), width: r.width, height: r.height,
    });
  }
  return out;
}

// ---------------------------------------------------------------- search

const cache = new Map<string, BrollItem[]>();

/** Round-robin merge so the grid mixes sources instead of showing all of one first. */
function interleave(lists: BrollItem[][], limit: number): BrollItem[] {
  const seen = new Set<string>(), out: BrollItem[] = [];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const l of lists) {
      const it = l[i];
      if (!it) continue;
      any = true;
      if (seen.has(it.url)) continue;
      seen.add(it.url); out.push(it);
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

/**
 * Search all sources at once. A source that fails (offline, quota) is skipped. `quick` leaves Openverse out unless the
 * free Wikimedia sources found too little, which spares its small anonymous quota during Auto B-roll.
 */
export async function searchBroll(query: string, opts: { limit?: number; quick?: boolean } = {}): Promise<BrollItem[]> {
  const clean = query.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const limit = opts.limit ?? 12;
  const key = `${clean.toLowerCase()}|${limit}|${opts.quick ? 'q' : 'a'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const per = Math.max(6, Math.ceil(limit * 0.7));
  const ok = <T,>(r: PromiseSettledResult<T[]>): T[] => (r.status === 'fulfilled' ? r.value : []);
  const [commons, wiki] = await Promise.allSettled([fromCommons(clean, per), fromWikipedia(clean, 4)]);
  const lists = [ok(wiki), ok(commons)];
  if (!opts.quick || lists.reduce((n, l) => n + l.length, 0) < 3) {
    try { lists.push(await fromOpenverse(clean, per)); } catch { /* quota or offline: skip */ }
  }
  if (commons.status === 'rejected' && wiki.status === 'rejected' && lists.every((l) => !l.length)) throw new Error('No connection to the photo sources.');
  const res = interleave(lists, limit);
  if (res.length) cache.set(key, res);
  return res;
}

/** The best picture for a keyword that has not been used yet (landscape preferred), or undefined. */
export async function bestForKeyword(keyword: string, used: Set<string>): Promise<BrollItem | undefined> {
  const tries = [keyword, keyword.split(' ').slice(0, 2).join(' ')].filter((k, i, a) => k && a.indexOf(k) === i);
  for (const k of tries) {
    let items: BrollItem[] = [];
    try { items = await searchBroll(k, { limit: 8, quick: true }); } catch { continue; }
    const fresh = items.filter((i) => !used.has(i.url));
    const wide = fresh.find((i) => !i.width || !i.height || i.width >= i.height * 0.9);
    const pick = wide ?? fresh[0];
    if (pick) return pick;
  }
  return undefined;
}

// ---------------------------------------------------------------- saving the picture on the phone

/**
 * Saves the picture in the app's files folder (so the export can read it and it survives a cache clear).
 * Returns the absolute path, or undefined in the browser or when the download failed.
 */
export async function downloadBroll(item: { id: string; url: string }): Promise<string | undefined> {
  if (!isNative()) return undefined;
  const ext = (item.url.match(/\.(jpe?g|png|webp)(?:\?|$)/i)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const rel = `broll/${item.id.replace(/[^a-z0-9_-]/gi, '')}.${ext}`;
  try {
    const r = await Filesystem.downloadFile({ url: item.url, path: rel, directory: Directory.Data, recursive: true, headers: { 'User-Agent': UA } });
    const raw = r.path ?? (await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri;
    return raw ? raw.replace(/^file:\/\//, '') : undefined;
  } catch { return undefined; }
}


// ================================================================ VIDEO CLIPS (no key)
// Wikimedia Commons video (history, science, places, archives: small MP4/WebM transcodes) and archive.org movies
// (Prelinger, NASA and other public-domain film). YouTube (Android app only) is used for people and brands.

const COMMONS_MAX_MS = 6 * 60_000;

function absUrl(u: string): string { return u.startsWith('//') ? 'https:' + u : u; }

/** Wikimedia gives several transcodes per video. Best for a phone: MP4 (H.264) near 480 px wide, then WebM, then the original. */
function pickDerivative(info: any): { url: string; w?: number; h?: number } | undefined {
  const der: any[] = Array.isArray(info?.derivatives) ? info.derivatives : [];
  const score = (d: any) => {
    const w = Number(d.width) || 0;
    const mp4 = /mp4/i.test(String(d.type ?? '')) ? 0 : 1;
    const dist = w >= 480 ? w - 480 : 2000 + (480 - w);
    return mp4 * 100000 + dist;
  };
  const usable = der.filter((d) => d?.src && /(mp4|webm)/i.test(String(d.type ?? '')));
  usable.sort((a, b) => score(a) - score(b));
  const d = usable[0];
  if (d) return { url: absUrl(String(d.src)), w: Number(d.width) || undefined, h: Number(d.height) || undefined };
  const mime = String(info?.mime ?? '');
  if (/^video\/(mp4|webm)/.test(mime) && info?.url && (info.size ?? 0) < 40_000_000) return { url: String(info.url), w: info.width, h: info.height };
  return undefined;
}

async function fromCommonsVideo(query: string, limit: number): Promise<BrollItem[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${q(query + ' filetype:video')}&gsrnamespace=6&gsrlimit=${limit}`
    + `&prop=videoinfo&viprop=url|size|mime|duration|derivatives|extmetadata&viurlwidth=640&viextmetadatafilter=Artist|LicenseShortName`;
  const data = await getJson(url);
  const pages = Object.values(data?.query?.pages ?? {}) as any[];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: BrollItem[] = [];
  for (const pg of pages) {
    const info = pg.videoinfo?.[0] ?? pg.imageinfo?.[0];
    if (!info) continue;
    const durMs = Math.round((Number(info.duration) || 0) * 1000);
    if (durMs < 3000 || durMs > COMMONS_MAX_MS) continue;
    const pick = pickDerivative(info);
    if (!pick) continue;
    const artist = stripHtml(info.extmetadata?.Artist?.value), lic = stripHtml(info.extmetadata?.LicenseShortName?.value);
    out.push({
      id: `cv_${pg.pageid}`, url: pick.url, thumb: info.thumburl ? smallThumb(String(info.thumburl)) : '', kind: 'video', durationMs: durMs,
      title: String(pg.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''), source: 'commons_video',
      credit: [artist, lic, 'Wikimedia Commons'].filter(Boolean).join(' / '), width: pick.w, height: pick.h,
    });
  }
  return out;
}

async function fromArchive(query: string, limit: number): Promise<BrollItem[]> {
  const clean = query.replace(/["():]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const lucene = `(${clean}) AND mediatype:(movies) AND (collection:(prelinger) OR collection:(nasa) OR licenseurl:(*publicdomain*))`;
  const url = `https://archive.org/advancedsearch.php?q=${q(lucene)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=${limit}&page=1&output=json&sort%5B%5D=downloads+desc`;
  const data = await getJson(url);
  const out: BrollItem[] = [];
  for (const d of (data?.response?.docs ?? []) as any[]) {
    const id = String(d?.identifier ?? '');
    if (!id) continue;
    const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator;
    out.push({
      id: `ia_${id.replace(/[^a-z0-9_-]/gi, '').slice(0, 60)}`, url: '', thumb: `https://archive.org/services/img/${encodeURIComponent(id)}`, kind: 'video',
      title: stripHtml(Array.isArray(d.title) ? d.title[0] : d.title) || id, source: 'archive', archiveId: id,
      credit: [stripHtml(creator), 'Internet Archive'].filter(Boolean).join(' / '),
    });
  }
  return out;
}

const vcache = new Map<string, BrollItem[]>();

/** Video clips for a keyword: Commons video and archive.org together (`archive: 'first'` puts old film first). A source that fails is skipped. */
export async function searchVideos(query: string, opts: { limit?: number; archive?: 'first' | 'last' | 'off' } = {}): Promise<BrollItem[]> {
  const clean = query.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const limit = opts.limit ?? 9;
  const mode = opts.archive ?? 'last';
  const key = `${clean.toLowerCase()}|${limit}|${mode}`;
  const hit = vcache.get(key);
  if (hit) return hit;
  const ok = <T,>(r: PromiseSettledResult<T[]>): T[] => (r.status === 'fulfilled' ? r.value : []);
  const [cv, ia] = await Promise.allSettled([fromCommonsVideo(clean, Math.max(6, limit)), mode === 'off' ? Promise.resolve([] as BrollItem[]) : fromArchive(clean, Math.max(5, Math.ceil(limit / 2)))]);
  if (cv.status === 'rejected' && ia.status === 'rejected') throw new Error('No connection to the video sources.');
  const lists = mode === 'first' ? [ok(ia), ok(cv)] : [ok(cv), ok(ia)];
  const res = interleave(lists, limit);
  if (res.length) vcache.set(key, res);
  return res;
}

/** archive.org: finds the MP4 address of an item (the biggest file that is still under ~25 MB, else the smallest). */
export async function resolveArchiveVideo(item: BrollItem): Promise<BrollItem | undefined> {
  if (item.url) return item;
  if (!item.archiveId) return undefined;
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(item.archiveId)}`);
  const files: any[] = Array.isArray(meta?.files) ? meta.files : [];
  const mp4 = files.filter((f) => /\.mp4$/i.test(String(f?.name ?? '')) && Number(f.size) > 200_000 && Number(f.size) <= 45_000_000);
  if (!mp4.length) return undefined;
  const fit = mp4.filter((f) => Number(f.size) <= 25_000_000).sort((a, b) => Number(b.size) - Number(a.size));
  const f = fit[0] ?? mp4.sort((a, b) => Number(a.size) - Number(b.size))[0]!;
  const lenS = parseFloat(String(f.length ?? '')) || parseFloat(String(meta?.metadata?.runtime ?? '')) || 0;
  if (lenS > 0 && lenS < 3) return undefined;
  return { ...item, url: `https://archive.org/download/${encodeURIComponent(item.archiveId)}/${String(f.name).split('/').map(encodeURIComponent).join('/')}`, durationMs: lenS > 0 ? Math.round(lenS * 1000) : item.durationMs };
}

/** Where in the clip a beat of `lenMs` should start: a little in (title cards and leaders are skipped), never past the end. */
export function clipInPoint(durationMs: number | undefined, lenMs: number): number {
  if (!durationMs || durationMs <= 0) return 0;
  const room = durationMs - lenMs - 300;
  if (room <= 0) return 0;
  return Math.round(Math.min(room, Math.max(600, durationMs * 0.15)));
}

/** Saves a video file in the app's files folder (broll/). Android app only. Returns the absolute path or undefined. */
export async function downloadBrollVideo(item: { id: string; url: string }): Promise<string | undefined> {
  if (!isNative() || !item.url) return undefined;
  const ext = (item.url.match(/\.(mp4|webm|m4v|mov)(?:\?|$)/i)?.[1] ?? 'mp4').toLowerCase();
  const rel = `broll/${item.id.replace(/[^a-z0-9_-]/gi, '')}.${ext}`;
  try {
    const r = await Filesystem.downloadFile({ url: item.url, path: rel, directory: Directory.Data, recursive: true, headers: { 'User-Agent': UA } });
    const raw = r.path ?? (await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri;
    return raw ? raw.replace(/^file:\/\//, '') : undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------- YouTube clips (people, brands, events)

/** The YouTube module runs one download at a time, so ask it in a queue. */
let ytQueue: Promise<unknown> = Promise.resolve();

export async function searchYoutubeClips(query: string, limit = 8): Promise<BrollItem[]> {
  if (!nativeApp() || !(await youtubeAvailable())) return [];
  const r = await EditorrNative.youtubeSearch({ query, ccOnly: false, maxSeconds: 8 * 60 });
  return ((r.items ?? []) as YoutubeItem[]).filter((v: YoutubeItem) => v.durationMs >= 5000).slice(0, limit).map((v: YoutubeItem) => ({
    id: `yt_${v.id}`, url: '', thumb: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, kind: 'video' as const, title: v.title, source: 'youtube' as const,
    ytId: v.id, durationMs: v.durationMs, credit: `${v.channel} / YouTube`,
  }));
}

/** Downloads one YouTube video (video track only, small size) and returns the saved file. Queue: one at a time. */
export function downloadYoutubeClip(item: BrollItem): Promise<{ path: string; durationMs: number } | undefined> {
  if (!item.ytId) return Promise.resolve(undefined);
  const id = item.ytId;
  const job = ytQueue.then(async () => {
    try {
      const r = await EditorrNative.youtubeDownloadVideo({ id });
      return r.path ? { path: r.path, durationMs: r.durationMs || item.durationMs || 0 } : undefined;
    } catch { return undefined; }
  });
  ytQueue = job.catch(() => undefined);
  return job;
}

// ================================================================ ARTICLES (for the article card)

export interface ArticleItem { id: string; title: string; extract: string; url: string; thumb?: string }

/** Wikipedia articles (title + first sentences + lead photo) for a keyword. */
export async function searchArticles(query: string, limit = 6): Promise<ArticleItem[]> {
  const clean = query.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${q(clean)}&gsrlimit=${limit}`
    + `&prop=extracts|pageimages&exintro=1&explaintext=1&exsentences=4&exlimit=max&piprop=thumbnail&pithumbsize=640`;
  const data = await getJson(url);
  const pages = Object.values(data?.query?.pages ?? {}) as any[];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: ArticleItem[] = [];
  for (const pg of pages) {
    const extract = String(pg.extract ?? '').replace(/\s+/g, ' ').trim();
    if (extract.length < 60) continue;
    out.push({ id: `ar_${pg.pageid}`, title: String(pg.title ?? ''), extract, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(pg.title ?? '').replace(/ /g, '_'))}`, thumb: pg.thumbnail?.source });
  }
  return out;
}
