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

export interface BrollItem {
  id: string;
  url: string;
  thumb: string;
  title: string;
  source: BrollSource;
  credit?: string;
  width?: number;
  height?: number;
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
