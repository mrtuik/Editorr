import { h, icon, toast, fmtTime } from '../ui';
import { EditorrNative, type YoutubeItem } from '../core/native';

/**
 * Optional YouTube module: search a song, tap it, the audio is saved on the phone and added to Auto BGM.
 * Creative Commons filter is ON by default (safest for Instagram / YouTube posts).
 */
export function openYoutubeSheet(onAdded: (path: string, title: string) => Promise<void>): void {
  let ccOnly = true;
  let busyId: string | null = null;
  let items: YoutubeItem[] = [];
  const done = new Set<string>();
  let status = '';
  let progress = 0;

  const input = h('input', { type: 'text', placeholder: 'Song name or artist', 'aria-label': 'Search YouTube', enterkeyhint: 'search' }) as HTMLInputElement;
  const goBtn = h('button', { class: 'btn primary', style: 'min-width:48px;min-height:48px', 'aria-label': 'Search', onclick: () => void search() }, icon('search', 20));
  const ccBtn = h('button', { class: 'at-tile', style: 'min-height:44px;flex-direction:row;gap:8px;margin-top:8px', onclick: () => { ccOnly = !ccOnly; drawCc(); } });
  const list = h('div', { class: 'rx-list', style: 'max-height:none;margin-top:10px' });
  const hint = h('div', { class: 'at-hint' });
  const body = h('div', { class: 'at-body' },
    h('div', { style: 'display:flex;gap:8px' }, input, goBtn), ccBtn, hint, list);
  const close = () => {
    cleanup();
    sheet.classList.add('out');
    setTimeout(() => box.remove(), 180);
  };
  const sheet = h('div', { class: 'at-sheet', role: 'dialog' }, h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Back', onclick: close }, icon('back', 20)),
      h('div', { class: 'at-title' }, 'YouTube'), h('span', { class: 'at-head-gap' })), body);
  const box = h('div', { class: 'at-scrim', style: 'z-index:140', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  let handle: { remove: () => Promise<void> } | null = null;
  void EditorrNative.addListener('ytProgress', (e: { id: string; percent: number }) => {
    if (e.id !== busyId) return;
    progress = e.percent; drawList();
  }).then((hd: { remove: () => Promise<void> }) => { handle = hd; });
  function cleanup() { if (handle) void handle.remove(); if (busyId) void EditorrNative.youtubeCancel().catch(() => {}); }

  function drawCc() {
    ccBtn.classList.toggle('on', ccOnly);
    ccBtn.replaceChildren(icon('check', 18), h('span', {}, ccOnly ? 'Creative Commons only (safer for posting)' : 'All results (may get claims or be muted)'));
  }
  function drawHint() {
    hint.textContent = status || 'Bollywood and English songs can get a copyright claim or be muted on Instagram / YouTube. YouTube Audio Library and Creative Commons songs are safe.';
  }
  function drawList() {
    list.replaceChildren(...items.map((it) => {
      const isBusy = busyId === it.id;
      const sub = isBusy ? `Downloading ${progress}%` : done.has(it.id) ? 'Added' : `${it.channel}  ·  ${fmtTime(it.durationMs)}`;
      return h('div', { class: 'rx-row' },
        h('button', { class: 'rx-go', onclick: () => void pickItem(it) }, h('b', {}, it.title), h('span', {}, sub)));
    }));
  }

  async function search() {
    const q = input.value.trim();
    if (!q || busyId) return;
    status = 'Searching...'; drawHint(); items = []; drawList();
    try {
      const r = await EditorrNative.youtubeSearch({ query: q, ccOnly });
      items = r.items;
      status = items.length ? '' : ccOnly ? 'Nothing found. Try another name, or turn off Creative Commons only.' : 'Nothing found. Try another name.';
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
      if (!/cancel/i.test(msg)) toast(msg || 'Download failed.', 6000);
    } finally { busyId = null; drawList(); }
  }

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); void search(); } });
  drawCc(); drawHint();
}
