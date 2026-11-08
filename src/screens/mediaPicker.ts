import { app } from '../app';
import { EditorrNative, fileSrc, type GalleryKind, type GalleryVideo, type PickedVideo } from '../core/native';
import { fmtClock, h, icon, toast } from '../ui';

export type PickResult = { videos: PickedVideo[]; ignored: number };

type Pick = { kind: GalleryKind; id: number };
const keyOf = (kind: GalleryKind, id: number) => `${kind}:${id}`;

/**
 * Editorr's own gallery picker: X, album dropdown, Videos / Photos tabs, a 4 column grid with select circles and a small Add button.
 * A photo is turned into a 5 second clip when it is added, so it works like any other video.
 * `max` = how many items can be chosen (1 = tapping another one moves the choice). Resolves after the chosen items
 * are copied into the app (the callers listen to 'copyProgress'). Rejects 'Cancelled' on close.
 * If the phone refuses the media permission, falls back to the system picker (videos only).
 */
export async function pickVideosCapcut(opts: { max: number }): Promise<PickResult> {
  let videoItems: GalleryVideo[];
  try {
    videoItems = (await EditorrNative.listVideos({ kind: 'video' })).items;
  } catch (e) {
    const m = (e as Error).message || '';
    if (/PERMISSION/i.test(m)) {
      toast('Allow photo and video access to see your gallery here. Opening the system picker instead.', 3200);
      return EditorrNative.pickVideos({ multiple: opts.max > 1, max: opts.max });
    }
    throw e;
  }

  return new Promise<PickResult>((resolve, reject) => {
    const { max } = opts;
    let album = ''; // '' = everything (Recent)
    let tab: 'videos' | 'photos' = 'videos';
    let photoItems: GalleryVideo[] | null = null; // loaded the first time the Photos tab opens
    let photoFailed = false;
    const chosen: Pick[] = [];
    const cells = new Map<string, HTMLElement>();
    const prevBack = app.onBack;
    let shown = 0;
    const PAGE = 160;
    let queue: (() => void)[] = [];
    let running = 0;

    const kind = (): GalleryKind => (tab === 'photos' ? 'image' : 'video');
    const items = (): GalleryVideo[] => (tab === 'photos' ? photoItems ?? [] : videoItems);
    const albums = () => {
      const m = new Map<string, { id: string; name: string; count: number }>();
      for (const v of items()) {
        const a = m.get(v.albumId) ?? { id: v.albumId, name: v.album, count: 0 };
        a.count++; m.set(v.albumId, a);
      }
      return [...m.values()].sort((a, b) => b.count - a.count);
    };
    const albumName = () => (album ? albums().find((a) => a.id === album)?.name ?? 'Recent' : 'Recent');
    const visible = () => (album ? items().filter((v) => v.albumId === album) : items());

    // ---- thumbnails: a few at a time, only for cells that scroll into view
    function pump() {
      while (running < 4 && queue.length) { const job = queue.shift()!; running++; job(); }
    }
    const show = (el: HTMLElement, src: string) => new Promise<void>((ok, bad) => {
      const im = new Image();
      im.onload = () => { el.style.backgroundImage = `url("${src}")`; el.classList.remove('nothumb'); ok(); };
      im.onerror = () => bad(new Error('img'));
      im.src = src;
    });
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target as HTMLElement;
        io.unobserve(el);
        const id = Number(el.dataset.id);
        const k = (el.dataset.kind as GalleryKind) || 'video';
        const load = (tries: number) => {
          EditorrNative.videoThumb({ id, kind: k })
            // the file could not be shown from its path: ask for the picture itself
            .then((r) => show(el, fileSrc(r.path)).catch(() =>
              EditorrNative.videoThumb({ id, kind: k, inline: true }).then((r2) => {
                if (!r2.data) throw new Error('no data');
                return show(el, r2.data);
              })))
            .catch(() => {
              if (tries > 0) setTimeout(() => { queue.push(() => load(tries - 1)); pump(); }, 500);
              else el.classList.add('nothumb');
            })
            .finally(() => { running--; pump(); });
        };
        queue.push(() => load(2));
        pump();
      }
    }, { rootMargin: '300px' });

    // ---- ui
    const grid = h('div', { class: 'mp-grid' });
    const addBtn = h('button', { class: 'mp-add', disabled: true, onclick: submit }, 'Add') as HTMLButtonElement;
    const title = h('button', { onclick: toggleAlbums, 'aria-label': 'Choose album' });
    const tabV = h('button', { class: 'on', onclick: () => setTab('videos') }, 'Videos');
    const tabP = h('button', { onclick: () => setTab('photos') }, 'Photos');
    const root = h('div', { class: 'mp', role: 'dialog', 'aria-label': 'Pick video or photo' },
      h('div', { class: 'mp-top' },
        h('button', { class: 'mp-x', 'aria-label': 'Close', onclick: cancel }, icon('close', 26)),
        h('div', { class: 'mp-albums' }, title),
        h('span', { class: 'mp-gap' })),
      h('div', { class: 'mp-tabs' }, tabV, tabP),
      grid,
      h('div', { class: 'mp-bottom' }, addBtn));

    function renderTitle() {
      title.replaceChildren(albumName(), h('span', { class: 'mp-chev' }, icon('chevD', 14)));
    }

    function makeCell(v: GalleryVideo) {
      const k = kind();
      const dot = h('span', { class: 'mp-dot' });
      const label = k === 'image' ? v.name : `${v.name} ${fmtClock(v.durationMs)}`;
      const el = h('div', { class: 'mp-cell' + (k === 'image' ? ' photo' : ''), 'data-id': String(v.id), 'data-kind': k, role: 'button', 'aria-label': label, onclick: () => toggle(k, v.id) },
        dot, ...(k === 'image' ? [] : [h('span', { class: 'mp-dur' }, fmtClock(v.durationMs))]));
      cells.set(keyOf(k, v.id), el);
      io.observe(el);
      return el;
    }

    function paintSel() {
      cells.forEach((el, key) => {
        const i = chosen.findIndex((c) => keyOf(c.kind, c.id) === key);
        el.classList.toggle('sel', i >= 0);
        const dot = el.firstElementChild as HTMLElement;
        if (i < 0) dot.replaceChildren();
        else if (max > 1) dot.replaceChildren(String(i + 1));
        else dot.replaceChildren(icon('check', 14));
      });
      addBtn.disabled = chosen.length === 0;
      addBtn.textContent = chosen.length ? `Add (${chosen.length})` : 'Add';
    }

    function toggle(k: GalleryKind, id: number) {
      const i = chosen.findIndex((c) => c.kind === k && c.id === id);
      if (i >= 0) chosen.splice(i, 1);
      else if (max === 1) { chosen.length = 0; chosen.push({ kind: k, id }); }
      else if (chosen.length >= max) { toast(`You can pick up to ${max}.`); return; }
      else chosen.push({ kind: k, id });
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
      if (tab === 'photos' && photoItems === null) { grid.append(h('div', { class: 'mp-empty' }, 'Loading photos...')); return; }
      if (!items().length) {
        const msg = tab === 'photos'
          ? (photoFailed ? 'Allow photo access to see your photos here.' : 'No photos found on this phone.')
          : 'No videos found on this phone.';
        grid.append(h('div', { class: 'mp-empty' }, msg));
        return;
      }
      more();
    }

    async function setTab(t: 'videos' | 'photos') {
      if (t === tab && cells.size) return;
      tab = t; album = '';
      tabV.classList.toggle('on', t === 'videos'); tabP.classList.toggle('on', t === 'photos');
      closeAlbums(); renderTitle(); fill();
      if (t === 'photos' && photoItems === null) {
        try { photoItems = (await EditorrNative.listVideos({ kind: 'image' })).items; photoFailed = false; }
        catch { photoItems = []; photoFailed = true; }
        if (tab === 'photos') { renderTitle(); fill(); }
      }
    }

    let pop: HTMLElement | null = null;
    function closeAlbums() { pop?.remove(); pop = null; }
    function toggleAlbums() {
      if (pop) { closeAlbums(); return; }
      const row = (id: string, name: string, count: number) =>
        h('button', { class: album === id ? 'on' : '', onclick: () => { album = id; renderTitle(); closeAlbums(); fill(); } }, name, h('span', {}, String(count)));
      pop = h('div', { class: 'mp-pop', onclick: (e: Event) => { if (e.target === pop) closeAlbums(); } },
        h('div', { class: 'mp-list' }, row('', 'Recent', items().length), ...albums().map((a) => row(a.id, a.name, a.count))));
      root.append(pop);
    }

    function close() { io.disconnect(); queue = []; root.remove(); app.onBack = prevBack; }
    function cancel() { close(); reject(new Error('Cancelled')); }
    function submit() {
      if (!chosen.length) return;
      const ids = chosen.map((c) => c.id);
      const kinds = chosen.map((c) => c.kind);
      close();
      EditorrNative.importVideos({ ids, kinds }).then(resolve, reject);
    }

    app.onBack = () => { if (pop) { closeAlbums(); return true; } cancel(); return true; };
    renderTitle();
    fill();
    document.body.append(root);
  });
}
