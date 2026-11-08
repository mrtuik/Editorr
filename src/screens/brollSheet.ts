import type { CapWord } from '../core/captions';
import { searchArticles, searchBroll, searchVideos, searchYoutubeClips, type ArticleItem, type BrollItem } from '../core/brollEngine';
import { autoBroll } from '../core/brollPlanner';
import { articleAsset, assetFromItem, conceptAsset, type Asset, type VideoMode } from '../core/brollRouter';
import { conceptFromText } from '../core/brollCards';
import {
  BROLL_DEFAULT_MS, BROLL_DEFAULT_RADIUS, BROLL_FRAME_LABEL, BROLL_MAX_MS, BROLL_MIN_MS, BROLL_MOTIONS, BROLL_MOTION_LABEL, BROLL_SOURCE_LABEL, isBrollVideo, placeBroll,
  type BrollBeat, type BrollFrame, type BrollMotion,
} from '../core/brollTypes';
import { isNative, youtubeAvailable } from '../core/native';
import { uid } from '../core/speaker';
import type { Project } from '../core/types';
import { fmtTime, h, icon, toast, slider as uiSlider, optionRow } from '../ui';


export interface BrollCtx {
  p: Project;
  playMs: () => number;
  durationMs: () => number;
  /** Something changed: redraw the preview and save. */
  changed: () => void;
  seek: (ms: number) => void;
  /** width / height of the output frame (cards are drawn in this shape). Default 16:9. */
  aspect?: () => number;
  /** Words with times (captions or the agent's own transcript). */
  words: () => CapWord[];
  /** open with this beat selected */
  startId?: string;
}
export interface BrollPane { el: HTMLElement; dispose: () => void; select: (id: string) => void }

/** replaceChildren that skips null/false (a null child was printed as the word "null"). */
function fill(el: HTMLElement, ...kids: (Node | null | undefined | false)[]) { el.replaceChildren(...(kids.filter(Boolean) as Node[])); }

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  return uiSlider(label, min, max, step, value, fmt, onInput);
}

function chipRow<T extends string>(label: string, opts: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  return optionRow(label, opts, value, onPick);
}

type SearchKind = 'photo' | 'video' | 'youtube' | 'article';
const KIND_LABEL: Record<SearchKind, string> = { photo: 'Photos', video: 'Videos', youtube: 'YouTube', article: 'Article card' };

/**
 * The B-roll tab of the Docu sheet: Auto B-roll (a clip, photo or card every ~2.5 s, picked by the 4-route engine), a free search with a
 * square grid (photos, videos, YouTube, article cards), a concept-card maker and the beats on the timeline.
 * Everything comes from sources that need no key and is saved on the phone so the export can use it.
 */
export function buildBrollPane(ctx: BrollCtx): BrollPane {
  const list = (): BrollBeat[] => (ctx.p.broll ??= []);
  let lenMs = BROLL_DEFAULT_MS;
  let coverage: 'every' | 'alternate' = 'every';
  let newMotion: BrollMotion = 'zoom_in';
  let newFrame: BrollFrame = 'card';
  let videoMode: VideoMode = 'mix';
  let searchKind: SearchKind = 'photo';
  let ytOk = false;
  let results: BrollItem[] = [];
  let articles: ArticleItem[] = [];
  let searching = false, searched = false;
  let addingId: string | null = null;
  let sel: string | null = (ctx.startId && list().some((b) => b.id === ctx.startId) ? ctx.startId : list()[0]?.id) ?? null;
  let replaceId: string | null = null;
  let run: { cancelled: boolean } | null = null;
  let progress = '';
  let disposed = false;

  const cur = () => list().find((b) => b.id === sel);
  const autoBox = h('div', {});
  const gridBox = h('div', {});
  const beatsBox = h('div', {});
  const aspect = () => { const a = ctx.aspect?.() ?? 16 / 9; return a > 0 ? a : 16 / 9; };
  const input = h('input', { type: 'text', class: 'ts-input', placeholder: 'Search: Elon Musk, Black Monday 1987...', enterkeyhint: 'search', 'aria-label': 'Search B-roll', style: 'flex:1;min-width:0' }) as HTMLInputElement;
  const kindBox = h('div', {});
  const cardBox = h('div', {});
  void youtubeAvailable().then((v) => { ytOk = v; if (!disposed) renderKinds(); }).catch(() => { /* browser */ });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); void doSearch(input.value); } });
  const searchRow = h('div', { class: 'br-search' }, input,
    h('button', { class: 'btn primary', style: 'min-height:44px;padding:0 14px', 'aria-label': 'Search', onclick: () => void doSearch(input.value) }, icon('search', 20)));

  // ------------------------------------------------------------ auto
  async function runAuto() {
    if (run) return;
    const words = ctx.words();
    if (!words.length) { toast('No transcript yet. Make Auto captions first, then tap Auto B-roll.', 5000); return; }
    const busy = [...(ctx.p.docu ?? []).map((d) => ({ start: d.start, end: d.end })), ...list().map((b) => ({ start: b.start, end: b.end }))];
    const signal = { cancelled: false };
    run = signal; progress = 'Starting...'; renderAuto();
    try {
      const r = await autoBroll({
        words, durationMs: ctx.durationMs(), lenMs, frame: newFrame, coverage, busy, useAntigravity: true, signal, videoMode, aspect: aspect(),
        onProgress: (d, t, label) => { progress = `${d}/${t} · ${label}`; if (!disposed) renderAuto(); },
      });
      let next = list();
      for (const b of r.beats) next = placeBroll(next, b);
      ctx.p.broll = next;
      if (r.beats.length) { sel = r.beats[0]!.id; ctx.seek(r.beats[0]!.start); }
      ctx.changed();
      const vids = r.beats.filter(isBrollVideo).length, cards = r.beats.filter((b) => b.kind === 'card').length;
      const parts = [`${r.beats.length} beats added (${vids} clips, ${r.beats.length - vids - cards} photos, ${cards} cards)`];
      if (r.missed) parts.push(`${r.missed} beats found nothing`);
      if (signal.cancelled) parts.push('stopped');
      toast(`${parts.join(', ')}.${r.note ? ' ' + r.note : ''}`, r.note ? 8000 : 4500);
    } catch (e) { toast(`Auto B-roll failed: ${(e as Error).message || 'unknown error'}`, 6000); }
    finally { run = null; if (!disposed) renderAll(); }
  }

  function renderAuto() {
    const running = !!run;
    fill(autoBox, 
      h('div', { class: 'at-sec', style: 'display:flex;gap:8px;margin-top:6px' },
        h('button', { class: 'btn primary', style: 'flex:1;min-height:46px', onclick: () => void runAuto(), disabled: running ? 'true' : undefined }, running ? 'Finding B-roll...' : 'Auto B-roll'),
        running ? h('button', { class: 'btn danger', style: 'min-height:46px', onclick: () => { if (run) run.cancelled = true; } }, 'Stop') : (null as unknown as Node)),
      running ? h('div', { class: 'at-hint' }, progress) : (null as unknown as Node),
    );
  }

  // ------------------------------------------------------------ search + grid
  function renderKinds() {
    const kinds: SearchKind[] = ytOk ? ['photo', 'video', 'youtube', 'article'] : ['photo', 'video', 'article'];
    if (!kinds.includes(searchKind)) searchKind = 'photo';
    kindBox.replaceChildren(chipRow<SearchKind>('Search in', kinds.map((k) => [k, KIND_LABEL[k]] as [SearchKind, string]), searchKind, (v) => { searchKind = v; results = []; articles = []; searched = false; renderGrid(); }));
  }

  async function doSearch(qs: string) {
    const query = qs.trim();
    if (!query || searching) return;
    searching = true; searched = true; renderGrid();
    try {
      results = []; articles = [];
      if (searchKind === 'photo') results = await searchBroll(query, { limit: 12 });
      else if (searchKind === 'video') results = await searchVideos(query, { limit: 12 });
      else if (searchKind === 'youtube') results = await searchYoutubeClips(query, 12);
      else articles = await searchArticles(query, 8);
    }
    catch (e) { results = []; articles = []; toast((e as Error).message || 'Search failed', 4500); }
    finally { searching = false; renderGrid(); }
  }

  /** Length a new beat gets: the chosen beat length, but never longer than the room left in the video or in the clip. */
  function lenFor(a: Asset, start: number): number {
    const dur = ctx.durationMs();
    let end = Math.min(dur || start + lenMs, start + lenMs);
    if (a.kind === 'video' && a.srcMs) end = Math.min(end, start + Math.max(BROLL_MIN_MS, a.srcMs - (a.inMs ?? 0) - 200));
    return end;
  }

  /** Puts an asset on the timeline at the playhead, or swaps it into the beat being replaced. */
  function commitAsset(a: Asset, keyword: string) {
    const fields = { url: a.url, thumb: a.thumb, title: a.title, source: a.source, credit: a.credit, kind: a.kind };
    if (replaceId) {
      const b = list().find((x) => x.id === replaceId);
      replaceId = null;
      if (b) {
        Object.assign(b, fields);
        if (a.path) b.path = a.path; else delete b.path;
        if (a.kind === 'video') { b.inMs = a.inMs ?? 0; if (a.srcMs) b.srcMs = a.srcMs; else delete b.srcMs; b.end = Math.min(b.end, lenFor(a, b.start)); }
        else { delete b.inMs; delete b.srcMs; }
        delete b.route;
        if (a.frame) b.frame = a.frame;
        if (a.motion) b.motion = a.motion;
        ctx.changed();
        toast(a.path || !isNative() ? 'Swapped.' : 'Could not save this one. It shows in the preview but will not be in the export.', 4500);
        renderAll(); return;
      }
    }
    const dur = ctx.durationMs();
    const start = Math.max(0, Math.min(Math.round(ctx.playMs()), Math.max(0, dur - 800)));
    const end = lenFor(a, start);
    if (end - start < 500) { toast('Not enough room at the end of the video.'); renderGrid(); return; }
    const nb: BrollBeat = {
      id: uid(), start, end, keyword, ...fields, ...(a.path ? { path: a.path } : {}),
      ...(a.kind === 'video' ? { inMs: a.inMs ?? 0, ...(a.srcMs ? { srcMs: a.srcMs } : {}) } : {}),
      motion: a.motion ?? newMotion, frame: a.frame ?? newFrame, radius: BROLL_DEFAULT_RADIUS,
    };
    ctx.p.broll = placeBroll(list(), nb);
    sel = nb.id;
    if (!a.path && isNative()) toast('Could not save this one. It shows in the preview but will not be in the export.', 5000);
    ctx.changed(); ctx.seek(nb.start);
    renderAll();
  }

  async function pickItem(it: BrollItem) {
    if (addingId) return;
    addingId = it.id; renderGrid();
    let a: Asset | undefined;
    try { a = await assetFromItem(it, lenMs, aspect(), newFrame); } catch { a = undefined; }
    addingId = null;
    if (disposed) return;
    if (!a) { toast(it.kind === 'video' ? 'Could not get this clip. Pick another one.' : 'Could not get this photo.', 4500); renderGrid(); return; }
    commitAsset(a, input.value.trim() || it.title);
  }

  async function pickArticle(art: ArticleItem) {
    if (addingId) return;
    addingId = art.id; renderGrid();
    let a: Asset | undefined;
    try { a = await articleAsset(art, input.value.trim() || art.title); } catch { a = undefined; }
    addingId = null;
    if (disposed) return;
    if (!a) { toast('Could not make the article card.', 4500); renderGrid(); return; }
    commitAsset(a, input.value.trim() || art.title);
  }

  function renderGrid() {
    if (searching) { fill(gridBox, h('div', { class: 'at-hint', style: 'margin-top:14px' }, 'Searching...')); return; }
    const none = searchKind === 'article' ? !articles.length : !results.length;
    if (none) {
      const idle = searchKind === 'video' ? 'Search a place, event or thing. Tap a clip to put it on the timeline at the playhead (clips play without their sound).'
        : searchKind === 'youtube' ? 'Search a person, brand or event on YouTube. A short clip of the video is saved on the phone.'
        : searchKind === 'article' ? 'Search a news subject. Tap an article to make a paper clipping card of it.'
        : 'Search a person, place or event. Tap a photo to put it on the timeline at the playhead.';
      fill(gridBox, h('div', { class: 'at-hint', style: 'margin-top:12px' }, searched
        ? 'Nothing found. Try the name in English or a simpler word.'
        : replaceId ? 'Search something new, then tap it to swap.' : idle));
      return;
    }
    const swapHint = replaceId ? h('div', { class: 'at-hint', style: 'margin-top:10px' }, 'Tap one to swap it in.') : (null as unknown as Node);
    if (searchKind === 'article') {
      fill(gridBox, swapHint, h('div', { class: 'br-arts' }, ...articles.map((art) =>
        h('button', { class: 'br-art' + (addingId === art.id ? ' busy' : ''), onclick: () => void pickArticle(art) },
          h('b', {}, art.title), h('span', {}, art.extract.slice(0, 140) + (art.extract.length > 140 ? '...' : ''))))));
      return;
    }
    fill(gridBox, swapHint,
      h('div', { class: 'br-grid' }, ...results.map((it) => {
        const img = h('img', { src: it.thumb, alt: it.title, loading: 'lazy', referrerpolicy: 'no-referrer' }) as HTMLImageElement;
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        const isV = it.kind === 'video';
        return h('button', { class: 'br-tile' + (addingId === it.id ? ' busy' : ''), 'aria-label': it.title, onclick: () => void pickItem(it) },
          img, h('span', { class: 'src' }, `${isV ? '▶ ' : ''}${BROLL_SOURCE_LABEL[it.source]}${isV && it.durationMs ? ' ' + fmtTime(it.durationMs) : ''}`));
      })));
  }

  // ------------------------------------------------------------ concept card maker
  async function addConcept(text: string) {
    const t = text.trim();
    if (!t || addingId) return;
    addingId = 'concept'; renderCard();
    let a: Asset | undefined;
    try { a = await conceptAsset(conceptFromText(t, t), aspect()); } catch { a = undefined; }
    addingId = null;
    if (disposed) return;
    renderCard();
    if (!a) { toast('Could not make the card.', 4000); return; }
    commitAsset(a, t);
  }

  function renderCard() {
    const ci = h('input', { type: 'text', class: 'ts-input', placeholder: 'Concept card: "Sales fell 40%", "3 billion users"', enterkeyhint: 'done', 'aria-label': 'Concept card text', style: 'flex:1;min-width:0' }) as HTMLInputElement;
    ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ci.blur(); void addConcept(ci.value); } });
    cardBox.replaceChildren(h('div', { class: 'br-search', style: 'margin-top:14px' }, ci,
      h('button', { class: 'btn', style: 'min-height:48px;padding:0 16px', disabled: addingId === 'concept' ? 'true' : undefined, onclick: () => void addConcept(ci.value) }, icon('plus', 18), 'Add card')));
  }

  // ------------------------------------------------------------ placed beats
  const kindMark = (b: BrollBeat) => (isBrollVideo(b) ? '▶ ' : b.kind === 'card' ? '▣ ' : '');

  function renderBeats() {
    const all = list();
    const b = cur();
    const kids: Node[] = [];
    if (all.length) {
      kids.push(h('div', { class: 'schips', style: 'margin-top:16px;flex-wrap:nowrap;overflow-x:auto' }, ...all.map((x, i) =>
        h('button', { class: 'chip' + (x.id === sel ? ' on' : ''), onclick: () => { sel = x.id; replaceId = null; ctx.seek(Math.min(ctx.durationMs(), x.start + 400)); renderAll(); } }, `${i + 1} · ${kindMark(x)}${(x.keyword || x.title).slice(0, 14)}${!x.path && isNative() ? ' !' : ''}`))));
    }
    if (b) {
      const video = isBrollVideo(b);
      const maxLen = video && b.srcMs ? Math.max(BROLL_MIN_MS, b.srcMs - (b.inMs ?? 0) - 200) : BROLL_MAX_MS;
      kids.push(
        h('div', { class: 'at-hint', style: 'margin-top:8px' }, `${b.title} · ${BROLL_SOURCE_LABEL[b.source]}${b.route ? ' · ' + b.route : ''}${!b.path && isNative() ? ' · not saved on the phone, left out of the export' : ''}`),
        slider('Length', BROLL_MIN_MS / 1000, Math.max(BROLL_MIN_MS, Math.min(BROLL_MAX_MS, maxLen)) / 1000, 0.5, Math.min((b.end - b.start) / 1000, maxLen / 1000), (v) => `${v}s`, (v) => {
          b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000));
          ctx.changed();
        }),
        ...(video
          ? [h('div', { class: 'at-hint' }, 'Clip: full frame, plays without its own sound.')]
          : [
            chipRow<BrollMotion>('Motion', BROLL_MOTIONS.map((m) => [m, BROLL_MOTION_LABEL[m]] as [BrollMotion, string]), b.motion, (v) => { b.motion = v; ctx.changed(); }),
            chipRow<BrollFrame>('Frame', (Object.keys(BROLL_FRAME_LABEL) as BrollFrame[]).map((f) => [f, BROLL_FRAME_LABEL[f]] as [BrollFrame, string]), b.frame, (v) => { b.frame = v; ctx.changed(); }),
          ]),
        h('div', { class: 'br-acts' },
          h('button', { class: 'btn', onclick: () => { input.value = b.keyword || b.title; void doSearch(input.value); } }, icon('search', 18), 'Find similar'),
          h('button', { class: 'btn' + (replaceId ? ' primary' : ''), onclick: () => { replaceId = replaceId ? null : b.id; renderAll(); } }, icon('swap', 18), replaceId ? 'Swapping...' : 'Swap'),
          h('button', { class: 'btn danger ico', 'aria-label': 'Delete beat', onclick: () => { ctx.p.broll = list().filter((x) => x.id !== b.id); sel = list()[0]?.id ?? null; replaceId = null; ctx.changed(); renderAll(); } }, icon('trash', 20))));
    }
    if (all.length) {
      kids.push(h('div', { class: 'br-acts' },
        h('button', { class: 'btn', onclick: () => void copyCredits() }, icon('copy', 18), 'Copy credits'),
        h('button', { class: 'btn danger', onclick: () => { ctx.p.broll = []; sel = null; replaceId = null; ctx.changed(); renderAll(); } }, icon('trash', 18), 'Clear all')));
    }
    beatsBox.replaceChildren(...kids);
  }

  async function copyCredits() {
    const seen = new Set<string>(), lines: string[] = [];
    for (const b of list()) {
      if (b.source === 'card' && !b.credit) continue;
      const l = `${b.title}${b.credit ? ' - ' + b.credit : ''}`;
      if (!seen.has(l)) { seen.add(l); lines.push(l); }
    }
    try { await navigator.clipboard.writeText('B-roll credits:\n' + lines.join('\n')); toast('Credits copied. Paste them in the video description.', 3500); }
    catch { toast('Could not copy.'); }
  }

  const renderAll = () => { renderAuto(); renderKinds(); renderGrid(); renderCard(); renderBeats(); };

  const el = h('div', {},
    autoBox,
    chipRow<VideoMode>('Auto B-roll uses', [['photos', 'Photos only'], ['mix', 'Clips + photos'], ['video', 'Clips first']], videoMode, (v) => { videoMode = v; }),
    slider('Beat length', BROLL_MIN_MS / 1000, BROLL_MAX_MS / 1000, 0.5, lenMs / 1000, (v) => `${v}s`, (v) => { lenMs = Math.round(v * 1000); }),
    chipRow<'every' | 'alternate'>('Auto coverage', [['every', 'Every beat'], ['alternate', 'Every other beat']], coverage, (v) => { coverage = v; }),
    chipRow<BrollMotion>('New photo motion', BROLL_MOTIONS.map((m) => [m, BROLL_MOTION_LABEL[m]] as [BrollMotion, string]), newMotion, (v) => { newMotion = v; }),
    chipRow<BrollFrame>('New photo frame', (Object.keys(BROLL_FRAME_LABEL) as BrollFrame[]).map((f) => [f, BROLL_FRAME_LABEL[f]] as [BrollFrame, string]), newFrame, (v) => { newFrame = v; }),
    kindBox, searchRow, gridBox, cardBox, beatsBox);
  renderAll();
  return {
    el, dispose: () => { disposed = true; if (run) run.cancelled = true; },
    select: (id) => { if (list().some((b) => b.id === id)) { sel = id; replaceId = null; renderBeats(); } },
  };
}
