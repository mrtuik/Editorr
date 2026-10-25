import { h, icon, fmtClock, toast } from '../ui';
import { EditorrNative, fileSrc, youtubeAvailable, type YoutubeItem } from '../core/native';

/**
 * Sound browser in the CapCut layout: a search pill with a collapse chevron, a row of category tabs
 * (saved first), then rows: note, title, length, save, download. Every sound comes from YouTube.
 *   tap the row           -> hear it (downloads it first)
 *   tap the download icon -> keep it on the phone, the icon turns into a + that puts it at the playhead
 *   tap the bookmark      -> save it in the first tab
 */
export type SoundMode = 'sfx' | 'music';

const CATS: Record<SoundMode, [string, string][]> = {
  sfx: [
    ['Trending', 'viral trending sound effects'],
    ['Music Clip', 'music clip sound effect short'],
    ['Funny', 'funny sound effects'],
    ['Swooshes', 'whoosh swoosh transition sound effect'],
    ['ASMR', 'asmr sound effect'],
    ['Cartoon', 'cartoon sound effects'],
    ['Impact', 'impact hit boom sound effect'],
    ['Click & pop', 'pop click ui sound effect'],
    ['Laugh', 'laugh sound effect'],
    ['Applause', 'applause cheer sound effect'],
    ['Horror', 'horror scary sound effect'],
    ['Nature', 'nature rain birds sound effect'],
  ],
  music: [
    ['Trending', 'trending background music instrumental'],
    ['Lo-fi', 'lofi chill beats no copyright'],
    ['Cinematic', 'cinematic background music'],
    ['Hip hop', 'hip hop beat instrumental'],
    ['Bollywood', 'bollywood instrumental bgm'],
    ['Happy', 'happy upbeat background music'],
    ['Sad', 'sad emotional piano music'],
    ['Vlog', 'vlog background music no copyright'],
  ],
};

/** Files already saved on the phone this session: video id -> path. */
const files = new Map<string, string>();
const cache = new Map<string, YoutubeItem[]>();
const SAVED_KEY = 'editorr.saved.sounds.';
function loadSaved(mode: SoundMode): YoutubeItem[] {
  try { const a = JSON.parse(localStorage.getItem(SAVED_KEY + mode) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function storeSaved(mode: SoundMode, items: YoutubeItem[]): void {
  try { localStorage.setItem(SAVED_KEY + mode, JSON.stringify(items.slice(0, 200))); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- one shared preview player
let audio: HTMLAudioElement | null = null;
let playingId = '';
export function stopSound(): void {
  if (audio) { try { audio.pause(); } catch { /* ok */ } audio = null; }
  playingId = '';
}

// ---------------------------------------------------------------- row pieces (also used by Auto BGM / Auto SFX lists)
export function sbBtn(name: Parameters<typeof icon>[0], label: string, run: () => void, cls = ''): HTMLElement {
  return h('button', { class: 'sb-btn ' + cls, 'aria-label': label, onclick: (e: Event) => { e.stopPropagation(); run(); } }, icon(name, 24));
}
export function sbRow(o: { title: string; sub?: string; dur?: string; active?: boolean; tag?: string; onTap?: () => void }, ...ends: (Node | null)[]): HTMLElement {
  return h('div', { class: 'sb-row' + (o.active ? ' on' : '') + (o.onTap ? ' tap' : ''), role: o.onTap ? 'button' : undefined, onclick: o.onTap },
    h('span', { class: 'sb-note' }, icon(o.active ? 'pause' : 'note', 22)),
    h('div', { class: 'sb-txt' }, h('div', { class: 'sb-title' }, o.tag ? h('span', { class: 'sb-tag' }, o.tag) : null, o.title), o.sub ? h('div', { class: 'sb-sub' }, o.sub) : null),
    o.dur ? h('span', { class: 'sb-dur' }, o.dur) : null,
    ...ends);
}

export interface ExtraTab { key: string; label: string; /** 'end' = after the categories (default: right after Saved) */ at?: 'start' | 'end'; render: (host: HTMLElement) => void | (() => void) }
export interface SoundBrowserOpts {
  mode: SoundMode;
  /** The + was tapped on a sound that is on the phone: put it on the timeline. */
  onAdd: (path: string, title: string) => Promise<void>;
  /** The chevron next to the search pill. */
  onClose: () => void;
  extraTabs?: ExtraTab[];
  /** The "Add with auto" switch under the search bar: on = everything the whole video needs is added by itself. */
  autoToggle?: { label: string; isOn: () => boolean; run: (on: boolean, status: (s: string) => void) => Promise<void> };
  /** Tab to open first: 'saved', an extra tab key, or the number of a category. */
  first?: string | number;
}

export function mountSoundBrowser(host: HTMLElement, o: SoundBrowserOpts): { destroy: () => void; refresh: () => void } {
  const { mode } = o;
  const cats = CATS[mode];
  let alive = true;
  let tab: string = o.first !== undefined ? String(o.first) : '0';
  let items: YoutubeItem[] = [];
  let msg = '', loading = false, seq = 0;
  let saved = loadSaved(mode);
  const busy = new Map<string, number>();
  const pctEls = new Map<string, HTMLElement>();
  const added = new Set<string>();
  let extraClean: (() => void) | void = undefined;

  const input = h('input', { type: 'text', class: 'sb-input', placeholder: mode === 'sfx' ? 'Search sound effects' : 'Search music', enterkeyhint: 'search', autocomplete: 'off', 'aria-label': 'Search' }) as HTMLInputElement;
  const search = h('div', { class: 'sb-search' },
    h('label', { class: 'sb-pill' }, icon('search', 22), input),
    h('button', { class: 'sb-collapse', 'aria-label': 'Close', onclick: () => o.onClose() }, icon('chevD', 26)));
  const tabsEl = h('div', { class: 'sb-tabs', role: 'tablist' });
  const listEl = h('div', { class: 'sb-list' });
  const autoEl = h('div', { class: 'sb-auto' });
  let autoBusy = false, autoStatus = '';
  function drawAuto() {
    const t = o.autoToggle;
    if (!t || !alive) return;
    const on = t.isOn();
    autoEl.replaceChildren(
      h('span', { class: 'sb-auto-ic' }, icon(mode === 'sfx' ? 'bolt' : 'bgm', 20)),
      h('div', { class: 'sb-auto-txt' }, h('div', { class: 'sb-auto-label' }, t.label),
        autoBusy ? h('div', { class: 'sb-auto-sub' }, h('span', { class: 'sb-spin' }), autoStatus || 'Working...') : null),
      h('button', { class: 'sb-switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), 'aria-label': t.label, disabled: autoBusy ? 'true' : undefined,
        onclick: async () => {
          if (autoBusy) return;
          autoBusy = true; autoStatus = 'Starting...'; drawAuto();
          try { await t.run(!on, (s) => { autoStatus = s; if (alive) drawAuto(); }); }
          catch (error) { toast(`Auto failed: ${error instanceof Error ? error.message : 'unknown error'}`, 6000); }
          autoBusy = false; drawAuto();
          if (tab !== 'saved' && !(o.extraTabs?.some((x) => x.key === tab))) draw(); else if (o.extraTabs?.some((x) => x.key === tab)) select(tab);
        } }, h('i', {})));
  }
  host.replaceChildren(search, ...(o.autoToggle ? [autoEl] : []), tabsEl, listEl);
  drawAuto();

  void EditorrNative.addListener('ytProgress', (e: { id: string; percent: number }) => {
    if (!busy.has(e.id)) return;
    busy.set(e.id, e.percent);
    const el = pctEls.get(e.id); if (el) el.textContent = `${e.percent}%`;
  }).then((hd: { remove: () => Promise<void> }) => { if (alive) handle = hd; else void hd.remove(); }).catch(() => { /* browser build */ });
  let handle: { remove: () => Promise<void> } | null = null;

  // ------------------------------------------------------------ tabs
  function drawTabs() {
    const all: { key: string; label: string; ic?: boolean }[] = [
      { key: 'saved', label: 'Saved', ic: true },
      ...(o.extraTabs ?? []).filter((t) => t.at !== 'end').map((t) => ({ key: t.key, label: t.label })),
      ...cats.map(([l], i) => ({ key: String(i), label: l })),
      ...(o.extraTabs ?? []).filter((t) => t.at === 'end').map((t) => ({ key: t.key, label: t.label })),
    ];
    tabsEl.replaceChildren(...all.map((t) => h('button', {
      class: 'sb-tab' + (t.ic ? ' ic' : '') + (tab === t.key ? ' on' : ''), role: 'tab', 'aria-selected': String(tab === t.key), 'aria-label': t.label,
      onclick: () => { input.value = ''; select(t.key); },
    }, t.ic ? icon(tab === 'saved' ? 'bookmarkFill' : 'bookmark', 24) : t.label)));
    requestAnimationFrame(() => {
      const on = tabsEl.querySelector('.sb-tab.on') as HTMLElement | null;
      if (!on) return;
      // only move the row when the chosen tab is not fully in view
      const r = on.getBoundingClientRect(), t = tabsEl.getBoundingClientRect();
      if (r.left < t.left || r.right > t.right) tabsEl.scrollLeft += r.left - t.left - (tabsEl.clientWidth - on.offsetWidth) / 2;
    });
  }

  function select(key: string) {
    tab = key; msg = '';
    if (extraClean) { extraClean(); extraClean = undefined; }
    drawTabs();
    const extra = o.extraTabs?.find((t) => t.key === key);
    if (extra) { listEl.replaceChildren(); listEl.scrollTop = 0; extraClean = extra.render(listEl); return; }
    if (key === 'saved') { items = saved; draw(); return; }
    const c = cats[Number(key)];
    if (c) void load(c[1]);
  }

  async function load(query: string) {
    const mine = ++seq;
    loading = true; msg = ''; items = []; draw();
    try {
      if (!(await youtubeAvailable())) throw new Error('Sounds from YouTube work only in the Android app.');
      const key = `${mode}|${query}`;
      let r: YoutubeItem[] = cache.get(key) ?? [];
      if (!r.length) {
        const res: { items: YoutubeItem[] } = await EditorrNative.youtubeSearch({ query, ccOnly: false, ...(mode === 'sfx' ? { shortOnly: true, maxSeconds: 60 } : {}) });
        r = mode === 'music' ? res.items.filter((it: YoutubeItem) => it.durationMs >= 30_000 && it.durationMs <= 10 * 60_000) : res.items;
        if (r.length) cache.set(key, r);
      }
      if (mine !== seq || !alive) return;
      items = r;
      if (!r.length) msg = 'Nothing found. Try another word.';
    } catch (error) {
      if (mine !== seq || !alive) return;
      msg = error instanceof Error ? error.message : 'YouTube search failed.';
    }
    loading = false; draw();
  }

  function runSearch() {
    const q = input.value.trim();
    if (!q) return;
    tab = ''; msg = '';
    if (extraClean) { extraClean(); extraClean = undefined; }
    drawTabs();
    void load(mode === 'sfx' && !/sound|sfx|effect/i.test(q) ? `${q} sound effect` : q);
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); runSearch(); } });

  // ------------------------------------------------------------ rows
  async function fetchFile(it: YoutubeItem): Promise<string | null> {
    const have = files.get(it.id);
    if (have) return have;
    if (busy.has(it.id)) return null;
    busy.set(it.id, 0); draw();
    try {
      const r = await EditorrNative.youtubeDownload({ id: it.id });
      files.set(it.id, r.path);
      return r.path;
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      if (!/cancel/i.test(m)) { msg = m || 'Download failed.'; toast(msg, 5000); }
      return null;
    } finally { busy.delete(it.id); if (alive) draw(); }
  }

  async function toggle(it: YoutubeItem) {
    if (playingId === it.id) { stopSound(); draw(); return; }
    const path = await fetchFile(it);
    if (!path || !alive) return;
    stopSound();
    const a = new Audio(fileSrc(path));
    audio = a; playingId = it.id;
    a.onended = () => { if (audio === a) { audio = null; playingId = ''; if (alive) draw(); } };
    a.play().catch(() => { if (audio === a) { audio = null; playingId = ''; } toast('Cannot play this sound.', 3500); if (alive) draw(); });
    draw();
  }

  async function add(it: YoutubeItem) {
    const path = files.get(it.id);
    if (!path) return;
    try { await o.onAdd(path, it.title); added.add(it.id); } catch { /* the editor already showed why */ }
    if (alive) draw();
  }

  function flipSaved(it: YoutubeItem) {
    const i = saved.findIndex((s) => s.id === it.id);
    if (i >= 0) saved.splice(i, 1); else saved.unshift(it);
    storeSaved(mode, saved);
    if (tab === 'saved') items = saved;
    draw();
  }

  function row(it: YoutubeItem): HTMLElement {
    const path = files.get(it.id), pct = busy.get(it.id), isSaved = saved.some((s) => s.id === it.id);
    let end: HTMLElement;
    if (path) end = sbBtn(added.has(it.id) ? 'check' : 'plus', 'Add to the video', () => void add(it), 'sb-add');
    else if (pct !== undefined) {
      const t = h('span', { class: 'sb-pct' }, `${pct}%`);
      pctEls.set(it.id, t);
      end = h('span', { class: 'sb-btn busy', 'aria-label': 'Downloading' }, t);
    } else end = sbBtn('download', 'Download', () => void fetchFile(it));
    return sbRow({ title: it.title, tag: mode === 'sfx' ? 'SFX' : undefined, dur: fmtClock(it.durationMs), active: playingId === it.id, onTap: () => void toggle(it) },
      sbBtn(isSaved ? 'bookmarkFill' : 'bookmark', isSaved ? 'Remove from saved' : 'Save', () => flipSaved(it), isSaved ? 'sb-saved' : ''), end);
  }

  function draw() {
    if (!alive) return;
    if (o.extraTabs?.some((t) => t.key === tab)) return;
    pctEls.clear();
    const kids: Node[] = [];
    if (msg) kids.push(h('div', { class: 'sb-msg err' }, msg));
    if (loading) kids.push(h('div', { class: 'sb-msg' }, h('span', { class: 'sb-spin' }), 'Searching YouTube...'));
    else if (!items.length && !msg) kids.push(h('div', { class: 'sb-msg' }, tab === 'saved' ? 'Tap the bookmark on a sound to keep it here.' : ''));
    for (const it of items) kids.push(row(it));
    listEl.replaceChildren(...kids);
  }

  select(tab);

  return {
    refresh: () => { if (o.extraTabs?.some((t) => t.key === tab)) select(tab); else draw(); },
    destroy: () => {
      alive = false;
      stopSound();
      if (extraClean) extraClean();
      if (handle) void handle.remove();
      if (busy.size) void EditorrNative.youtubeCancel().catch(() => {});
    },
  };
}
