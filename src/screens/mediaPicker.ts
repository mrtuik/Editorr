import { app } from '../app';
import { EditorrNative, fileSrc, type GalleryVideo, type PickedVideo } from '../core/native';
import { fmtClock, h, icon, toast } from '../ui';

export type PickResult = { videos: PickedVideo[]; ignored: number };

/**
 * Editorr's own gallery picker, laid out like CapCut's media screen: X, "Albums" dropdown, Videos / Photos tabs,
 * a 4 column grid with durations and select circles, and an HD toggle + Add button at the bottom.
 * `max` = how many videos can be chosen (1 = tapping another one moves the choice). Resolves after the chosen videos
 * are copied into the app (the callers listen to 'copyProgress'). Rejects 'Cancelled' on close.
 * If the phone refuses the media permission, falls back to the system picker.
 */
export async function pickVideosCapcut(opts: { max: number }): Promise<PickResult> {
  let items: GalleryVideo[];
  try {
    items = (await EditorrNative.listVideos()).items;
  } catch (e) {
    const m = (e as Error).message || '';
    if (/PERMISSION/i.test(m)) {
      toast('Allow video access to see your gallery here. Opening the system picker instead.', 3200);
      return EditorrNative.pickVideos({ multiple: opts.max > 1, max: opts.max });
    }
    throw e;
  }

  return new Promise<PickResult>((resolve, reject) => {
    const { max } = opts;
    let album = ''; // '' = all videos (Recent)
    let tab: 'videos' | 'photos' = 'videos';
    let hd = false;
    const chosen: number[] = [];
    const cells = new Map<number, HTMLElement>();
    const prevBack = app.onBack;
    let shown = 0;
    const PAGE = 160;
    let queue: (() => void)[] = [];
    let running = 0;

    const albums = (() => {
      const m = new Map<string, { id: string; name: string; count: number }>();
      for (const v of items) {
        const a = m.get(v.albumId) ?? { id: v.albumId, name: v.album, count: 0 };
        a.count++; m.set(v.albumId, a);
      }
      return [...m.values()].sort((a, b) => b.count - a.count);
    })();
    const albumName = () => (album ? albums.find((a) => a.id === album)?.name ?? 'Recent' : 'Recent');
    const visible = () => (album ? items.filter((v) => v.albumId === album) : items);

    // ---- thumbnails: a few at a time, only for cells that scroll into view
    function pump() {
      while (running < 3 && queue.length) { const job = queue.shift()!; running++; job(); }
    }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target as HTMLElement;
        io.unobserve(el);
        const id = Number(el.dataset.id);
        queue.push(() => {
          EditorrNative.videoThumb({ id })
            .then((r) => { el.style.backgroundImage = `url("${fileSrc(r.path)}")`; })
            .catch(() => { /* stays dark */ })
            .finally(() => { running--; pump(); });
        });
        pump();
      }
    }, { rootMargin: '300px' });

    // ---- ui
    const grid = h('div', { class: 'mp-grid' });
    const addBtn = h('button', { class: 'mp-add', disabled: true, onclick: submit }, 'Add') as HTMLButtonElement;
    const hdBtn = h('button', { class: 'mp-hd', 'aria-label': 'HD', onclick: () => { hd = !hd; hdBtn.classList.toggle('on', hd); } }, h('i', {}), 'HD');
    const title = h('button', { onclick: toggleAlbums, 'aria-label': 'Choose album' });
    const tabV = h('button', { class: 'on', onclick: () => setTab('videos') }, 'Videos');
    const tabP = h('button', { onclick: () => setTab('photos') }, 'Photos');
    const root = h('div', { class: 'mp', role: 'dialog', 'aria-label': 'Pick video' },
      h('div', { class: 'mp-top' },
        h('button', { class: 'mp-x', 'aria-label': 'Close', onclick: cancel }, icon('close', 26)),
        h('div', { class: 'mp-albums' }, title),
        h('div', { class: 'mp-lib' }, 'Library')),
      h('div', { class: 'mp-tabs' }, tabV, tabP),
      grid,
      h('div', { class: 'mp-bottom' }, hdBtn, addBtn));

    function renderTitle() {
      title.replaceChildren(albumName(), h('span', { class: 'mp-chev' }, icon('chevD', 14)));
    }

    function makeCell(v: GalleryVideo) {
      const dot = h('span', { class: 'mp-dot' });
      const el = h('div', { class: 'mp-cell', 'data-id': String(v.id), role: 'button', 'aria-label': `${v.name} ${fmtClock(v.durationMs)}`, onclick: () => toggle(v.id) },
        dot, h('span', { class: 'mp-dur' }, fmtClock(v.durationMs)));
      cells.set(v.id, el);
      io.observe(el);
      return el;
    }

    function paintSel() {
      cells.forEach((el, id) => {
        const i = chosen.indexOf(id);
        el.classList.toggle('sel', i >= 0);
        (el.firstElementChild as HTMLElement).textContent = i >= 0 && max > 1 ? String(i + 1) : i >= 0 ? '\u2713' : '';
      });
      addBtn.disabled = chosen.length === 0;
      addBtn.textContent = chosen.length ? `Add (${chosen.length})` : 'Add';
    }

    function toggle(id: number) {
      const i = chosen.indexOf(id);
      if (i >= 0) chosen.splice(i, 1);
      else if (max === 1) { chosen.length = 0; chosen.push(id); }
      else if (chosen.length >= max) { toast(`You can pick up to ${max} videos.`); return; }
      else chosen.push(id);
      paintSel();
    }

    function more() {
      const list = visible();
      if (shown >= list.length) return;
      const frag = document.createDocumentFragment();
      list.slice(shown, shown + PAGE).forEach((v) => frag.append(makeCell(v)));
      shown = Math.min(list.length, shown + PAGE);
      grid.append(frag);
      paintSel();
    }
    grid.addEventListener('scroll', () => { if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 600) more(); });

    function fill() {
      io.disconnect(); queue = []; cells.clear(); shown = 0;
      grid.replaceChildren();
      grid.scrollTop = 0;
      if (tab === 'photos') { grid.append(h('div', { class: 'mp-empty' }, 'Editorr edits videos only. Pick your video from the Videos tab.')); return; }
      if (!items.length) { grid.append(h('div', { class: 'mp-empty' }, 'No videos found on this phone.')); return; }
      more();
    }

    function setTab(t: 'videos' | 'photos') {
      tab = t; tabV.classList.toggle('on', t === 'videos'); tabP.classList.toggle('on', t === 'photos'); fill();
    }

    let pop: HTMLElement | null = null;
    function closeAlbums() { pop?.remove(); pop = null; }
    function toggleAlbums() {
      if (pop) { closeAlbums(); return; }
      const row = (id: string, name: string, count: number) =>
        h('button', { class: album === id ? 'on' : '', onclick: () => { album = id; renderTitle(); closeAlbums(); setTab('videos'); } }, name, h('span', {}, String(count)));
      pop = h('div', { class: 'mp-pop', onclick: (e: Event) => { if (e.target === pop) closeAlbums(); } },
        h('div', { class: 'mp-list' }, row('', 'Recent', items.length), ...albums.map((a) => row(a.id, a.name, a.count))));
      root.append(pop);
    }

    function close() { io.disconnect(); queue = []; root.remove(); app.onBack = prevBack; }
    function cancel() { close(); reject(new Error('Cancelled')); }
    function submit() {
      if (!chosen.length) return;
      const ids = chosen.slice();
      close();
      EditorrNative.importVideos({ ids }).then(resolve, reject);
    }

    app.onBack = () => { if (pop) { closeAlbums(); return true; } cancel(); return true; };
    renderTitle();
    fill();
    document.body.append(root);
  });
}
