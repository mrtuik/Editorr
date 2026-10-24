import { app } from '../app';
import { probeVideo } from '../core/audio';
import { runtime, saveMedia, saveProject } from '../core/store';
import type { Role, VideoRef } from '../core/types';
import { EditorrNative, fileSrc, isNative, type PickedVideo } from '../core/native';
import { projectVideoPaths } from '../core/media';
import { askAutoEdit } from './autoOptions';
import { firstFrame } from '../core/thumbs';
import { fmtClock, h, icon, iconButton, spinner, toast } from '../ui';

const MAX_MS = 15 * 60 * 1000;
const other = (r: Role): Role => (r === 'host' ? 'constant' : 'host');

export function importScreen() {
  const p = app.project;
  const info: Partial<Record<Role, VideoRef>> = {};
  const pics: Partial<Record<Role, string>> = {};
  /** slots that are being copied right now, with percent (-1 = waiting for the first number) */
  const busy: Partial<Record<Role, number>> = {};
  if (p.host && runtime.hostUrl) info.host = { ...p.host, url: runtime.hostUrl };
  if (p.constant && runtime.constUrl) info.constant = { ...p.constant, url: runtime.constUrl };

  /** Video files this project had when the screen opened (a replaced video is deleted when you continue). */
  const initialPaths = projectVideoPaths(p);

  /**
   * Save the picked videos into the project right away (IndexedDB), so they are never lost if the app closes
   * before "Add to timeline" is pressed. Browser build: the files themselves go into IndexedDB too.
   */
  async function commit() {
    const strip = (v?: VideoRef) => { if (!v) return undefined; const { url: _u, ...m } = v; return m; };
    const hm = strip(info.host), cm = strip(info.constant);
    const same = (a?: { uri?: string; name: string; durationMs: number }, b?: { uri?: string; name: string; durationMs: number }) =>
      (!a && !b) || (!!a && !!b && a.uri === b.uri && a.name === b.name && a.durationMs === b.durationMs);
    const unchanged = same(p.host, hm) && same(p.constant, cm);
    p.host = hm; p.constant = cm;
    if (!unchanged) {
      // new videos: sync and auto switch run again when the editor opens
      p.segments = []; p.offsetMs = 0; p.syncConfidence = undefined; p.durationMs = 0;
      p.proxyHost = p.proxyConst = false; p.thumb = undefined;
      const primary = hm ?? cm;
      if (primary && primary.width && primary.height) {
        if (primary.height > primary.width) p.aspect = '9:16';
        else if (primary.width > primary.height) p.aspect = '16:9';
        else p.aspect = '1:1';
      }
    }
    runtime.projectId = p.id;
    await saveProject(p);
    if (!isNative()) {
      await saveMedia(p.id, 'host', runtime.hostFile, hm?.name ?? '');
      await saveMedia(p.id, 'constant', runtime.constFile, cm?.name ?? '');
    }
  }

  const slots = h('div', { class: 'slots' });
  const warnings = h('div', { class: 'import-warnings' });
  const cont = h('button', { class: 'btn primary start-editing-btn', disabled: true, onclick: next }, icon('wand', 20), 'Start Editing');
  let alive = true;

  /** A picture of the first frame for each tile (made in the background). */
  function loadPic(role: Role) {
    const v = info[role];
    if (!v) return;
    const path = role === 'host' ? runtime.hostPath : runtime.constPath;
    firstFrame(path, v.url).then((src) => { if (alive && src && info[role] === v) { pics[role] = src; render(); } });
  }
  (['host', 'constant'] as Role[]).forEach(loadPic);

  /** Put one picked video into a slot. */
  function assign(role: Role, v: VideoRef, path?: string, file?: File) {
    info[role] = v;
    delete pics[role];
    if (role === 'host') { runtime.hostPath = path; runtime.hostUrl = v.url; runtime.hostPcm = undefined; runtime.hostFile = file; }
    else { runtime.constPath = path; runtime.constUrl = v.url; runtime.constPcm = undefined; runtime.constFile = file; }
    runtime.hostMotion = runtime.constMotion = undefined;
    loadPic(role);
  }

  async function pickNative(role: Role) {
    if (busy[role] !== undefined) return;
    let targets: Role[] = [];
    const sub = await EditorrNative.addListener('copyProgress', (e: { index: number; count: number; percent: number }) => {
      if (!targets.length) {
        targets = e.count >= 2 ? [role, other(role)] : [role];
        targets.forEach((t) => { busy[t] = 0; });
      }
      const t = targets[e.index];
      if (t) busy[t] = e.percent;
      render();
    });
    try {
      const res = await EditorrNative.pickVideos({ multiple: true });
      const vids: PickedVideo[] = res.videos;
      const want: Role[] = vids.length >= 2 ? [role, other(role)] : [role];
      vids.forEach((v, i) => {
        const url = fileSrc(v.path);
        assign(want[i], { name: v.name, url, uri: 'file://' + v.path, durationMs: v.durationMs, width: v.width, height: v.height, fps: v.fps || 30, codec: v.codec, bitrate: v.bitrate }, v.path);
      });
      if (vids.length) await commit();
      if (res.ignored > 0) toast('Only 2 videos are used. The extra ones were ignored.');
    } catch (e) {
      const m = (e as Error).message || '';
      if (!/cancel/i.test(m)) toast(m || 'Could not open this video.');
    } finally {
      sub.remove().catch(() => {});
      delete busy.host; delete busy.constant;
      if (alive) render();
    }
  }

  function pickWeb(role: Role) {
    const input = h('input', { type: 'file', accept: 'video/*', multiple: true });
    input.onchange = async () => {
      const files = Array.from(input.files ?? []).slice(0, 2);
      if (!files.length) return;
      const want: Role[] = files.length >= 2 ? [role, other(role)] : [role];
      want.forEach((t) => { busy[t] = -1; });
      render();
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const url = URL.createObjectURL(f);
          const meta = await probeVideo(url);
          assign(want[i], { name: f.name, url, durationMs: meta.durationMs, width: meta.width, height: meta.height, fps: 30 }, undefined, f);
        }
      } catch (e) { toast((e as Error).message); }
      await commit();
      want.forEach((t) => { delete busy[t]; });
      render();
    };
    input.click();
  }

  const pick = (role: Role) => (isNative() ? pickNative(role) : pickWeb(role));

  function swap() {
    [info.host, info.constant] = [info.constant, info.host];
    [pics.host, pics.constant] = [pics.constant, pics.host];
    [runtime.hostFile, runtime.constFile] = [runtime.constFile, runtime.hostFile];
    [runtime.hostPath, runtime.constPath] = [runtime.constPath, runtime.hostPath];
    [runtime.hostUrl, runtime.constUrl] = [runtime.constUrl, runtime.hostUrl];
    [runtime.hostPcm, runtime.constPcm] = [runtime.constPcm, runtime.hostPcm];
    runtime.hostMotion = runtime.constMotion = undefined;
    render();
    commit();
  }

  function slot(role: Role, label: string) {
    const v = info[role];
    const pct = busy[role];
    const loading = pct !== undefined;
    const tile = h('div', { class: `tile ${role}` + (v ? ' filled' : '') + (loading ? ' loading' : ''), role: 'button', tabindex: 0, 'aria-label': v ? `Change ${label} video` : `Add ${label} video`, onclick: () => { if (!loading) pick(role); } });
    if (v && pics[role]) tile.style.backgroundImage = `url("${pics[role]}")`;
    tile.append(h('div', { class: 'chip-label' }, label));
    if (loading) {
      tile.append(h('div', { class: 'tile-busy' }, spinner(26), h('div', {}, pct > 0 ? `Adding video... ${pct}%` : 'Adding video...')));
    } else if (v) {
      tile.append(
        h('div', { class: 'tile-change' }, icon('swap', 16), 'Change'),
        h('div', { class: 'tile-badges' },
          h('span', { class: 'tag-duration' }, fmtClock(v.durationMs)),
          h('span', { class: 'tag-res' }, `${v.width}x${v.height}`),
          h('span', { class: 'tag-audio' }, icon('volume', 12), 'Audio')),
        h('div', { class: 'tile-meta' },
          h('div', { class: 'tile-name' }, v.name),
          h('div', { class: 'tile-spec' }, `${v.fps ? `${v.fps} fps` : '30 fps'}${v.codec ? ` • ${v.codec}` : ''}`)));
    } else {
      tile.append(h('div', { class: 'tile-empty' }, h('div', { class: 'plusdot' }, icon('plus', 26)), h('div', { class: 'title' }, `Add ${label} video`), h('div', { class: 'cap' }, 'Tap to pick from gallery')));
    }
    return tile;
  }

  function render() {
    const anyBusy = busy.host !== undefined || busy.constant !== undefined;
    slots.replaceChildren(
      slot('host', 'Host'),
      h('div', { class: 'swaprow' },
        h('button', { class: 'btn small', 'aria-label': 'Swap Host and Constant', disabled: anyBusy, onclick: swap }, icon('swap', 20), 'Swap')),
      slot('constant', 'Constant'));

    const w: string[] = [];
    const { host, constant } = info;
    if (host && host.durationMs > MAX_MS) w.push('Host video is longer than 15 minutes. Trim it first for best results.');
    if (constant && constant.durationMs > MAX_MS) w.push('Constant video is longer than 15 minutes. Trim it first for best results.');
    if (host && constant) {
      if (Math.abs(host.durationMs - constant.durationMs) > 1000) w.push('The two videos differ in length by more than 1 second. The edit will end where the shorter one ends.');
      if (host.width !== constant.width || host.height !== constant.height) w.push('Resolutions differ. Export will scale both to fit.');
      if ((host.width > host.height) !== (constant.width > constant.height)) w.push('One video is portrait and the other landscape. Record both in the same orientation.');
    }
    warnings.replaceChildren(...w.map((t) => h('div', { class: 'warn' }, t)));
    cont.disabled = !(host && constant) || anyBusy;
  }

  async function next() {
    if (!info.host || !info.constant) return;
    cont.disabled = true;
    await commit();
    // new videos get synced and auto edited next: ask for the auto edit options first
    if (p.segments.length === 0 && !(await askAutoEdit())) { cont.disabled = false; return; }
    // a video that was replaced is no longer used: free its space
    if (isNative()) {
      const now = projectVideoPaths(p);
      const old = initialPaths.filter((x) => !now.includes(x));
      if (old.length) EditorrNative.deleteVideos({ paths: old }).catch(() => {});
    }
    app.go('editor');
  }

  render();
  const el = h('div', { class: 'screen import-screen' },
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => app.go('home')), h('h1', {}, 'Import Media')),
    h('div', { class: 'content' },
      slots, warnings,
      h('div', { class: 'cap', style: 'margin-top:10px;text-align:center' }, 'Tip: Pick two camera angles recorded simultaneously. Dual-cam syncing works best with continuous speech.')),
    h('div', { class: 'bottombar' }, cont));
  return { el, destroy: () => { alive = false; } };
}
