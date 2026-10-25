import { h, icon, toast, fmtTime } from '../ui';
import { EditorrNative, youtubeAvailable, type YoutubeItem } from '../core/native';

/**
 * YouTube songs: search, tap a song, the audio is saved on the phone and handed to onAdded.
 * Always on, nothing to tick. Search shows ALL results (no Creative Commons filter).
 * mountYoutubeSearch puts the search box and results inside any container (used by Music > Music).
 * Returns a cleanup function (call it when the container goes away).
 */
export function mountYoutubeSearch(host: HTMLElement, onAdded: (path: string, title: string) => Promise<void>, hintText?: string): () => void {
  let busyId: string | null = null;
  let items: YoutubeItem[] = [];
  const done = new Set<string>();
  let status = '';
  let progress = 0;

  const input = h('input', { type: 'text', class: 'lm-input', placeholder: 'Search songs on YouTube', 'aria-label': 'Search YouTube', enterkeyhint: 'search', autocomplete: 'off' }) as HTMLInputElement;
  const goBtn = h('button', { class: 'lm-go', 'aria-label': 'Search', onclick: () => void search() }, icon('search', 20));
  const list = h('div', { class: 'lm-list' });
  const hint = h('div', { class: 'lm-hint' });
  host.append(h('div', { class: 'lm-search' }, input, goBtn), hint, list);

  let handle: { remove: () => Promise<void> } | null = null;
  let alive = true;
  void EditorrNative.addListener('ytProgress', (e: { id: string; percent: number }) => {
    if (e.id !== busyId) return;
    progress = e.percent; drawList();
  }).then((hd: { remove: () => Promise<void> }) => { if (alive) handle = hd; else void hd.remove(); }).catch(() => { /* browser build: no native events */ });

  function drawHint() {
    hint.textContent = status || hintText || 'Tap a song to add it. Popular songs can get a copyright claim when you post.';
    hint.classList.toggle('err', /fail|refus|answered|no audio|not included|only in the android/i.test(status));
  }
  function drawList() {
    list.replaceChildren(...items.map((it) => {
      const isBusy = busyId === it.id;
      const isDone = done.has(it.id);
      const sub = isBusy ? `Downloading ${progress}%` : isDone ? 'Added' : `${it.channel}  ·  ${fmtTime(it.durationMs)}`;
      const end = isDone ? icon('check', 18) : isBusy ? h('span', { class: 'lm-pct' }, `${progress}%`) : h('span', { class: 'lm-plus' }, '+');
      return h('button', { class: `lm-row${isBusy ? ' busy' : ''}${isDone ? ' done' : ''}`, onclick: () => void pickItem(it) },
        h('div', { class: 'lm-txt' }, h('b', {}, it.title), h('span', {}, sub)),
        h('div', { class: 'lm-end' }, end));
    }));
  }

  async function search() {
    const q = input.value.trim();
    if (!q || busyId) return;
    status = 'Searching...'; drawHint(); items = []; drawList();
    try {
      if (!(await youtubeAvailable())) throw new Error('YouTube works only in the Android app.');
      const r = await EditorrNative.youtubeSearch({ query: q, ccOnly: false });
      items = r.items;
      status = items.length ? '' : 'Nothing found. Try another name.';
    } catch (error) {
      status = error instanceof Error ? error.message : 'YouTube search failed.';
    }
    drawHint(); drawList();
  }

  async function pickItem(it: YoutubeItem) {
    if (busyId || done.has(it.id)) return;
    if (it.durationMs > 15 * 60_000) { toast('This video is over 15 minutes. Pick a shorter song.', 4000); return; }
    busyId = it.id; progress = 0; drawList();
    try {
      const r = await EditorrNative.youtubeDownload({ id: it.id });
      await onAdded(r.path, r.title || it.title);
      done.add(it.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!/cancel|decode/i.test(msg)) toast(msg || 'Download failed.', 6000);
    } finally { busyId = null; drawList(); }
  }

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); void search(); } });
  drawHint();

  return () => {
    alive = false;
    if (handle) void handle.remove();
    if (busyId) void EditorrNative.youtubeCancel().catch(() => {});
  };
}

/** The same search in its own bottom sheet (used by Auto BGM > Add from YouTube). */
export function openYoutubeSheet(onAdded: (path: string, title: string) => Promise<void>): void {
  const body = h('div', { class: 'at-body' });
  const close = () => {
    cleanup();
    sheet.classList.add('out');
    setTimeout(() => box.remove(), 180);
  };
  const sheet = h('div', { class: 'at-sheet lm', role: 'dialog' }, h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Back', onclick: close }, icon('back', 20)),
      h('div', { class: 'at-title' }, 'YouTube'), h('span', { class: 'at-head-gap' })), body);
  const box = h('div', { class: 'at-scrim', style: 'z-index:140', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);
  const cleanup = mountYoutubeSearch(body, onAdded);
  const first = body.querySelector('input') as HTMLInputElement | null;
  if (first) setTimeout(() => first.focus(), 250);
}
