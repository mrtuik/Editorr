import { app } from '../app';
import { clearAllStorage, listProjects, mediaBytes, runtime, saveSettings } from '../core/store';
import { EditorrNative, isNative } from '../core/native';
import { fmtBytes } from '../core/media';
import type { Sensitivity } from '../core/types';
import { confirmDialog, h, icon, iconButton, tabBar, toast } from '../ui';

/** CapCut-style option row: label (+ hint) on top, tile-like options below. */
function option<T extends string | number>(label: string, hint: string, opts: [T, string][], value: T, onPick: (v: T) => void) {
  const chips = h('div', { class: 'schips' });
  const render = (cur: T) => {
    chips.replaceChildren(...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => { onPick(v); render(v); } }, l)));
  };
  render(value);
  return h('div', { class: 'srow' }, h('div', { class: 'slabel' }, label), hint ? h('div', { class: 'sdesc' }, hint) : null, chips);
}

const group = (title: string, ...rows: Node[]) => h('section', { class: 'sgroup' }, h('div', { class: 'sgtitle' }, title), h('div', { class: 'scard' }, ...rows));

export function settingsScreen() {
  const s = app.settings;
  const save = () => saveSettings(s);

  // ---- storage (projects live in IndexedDB; Android keeps the video files in the app's private folder) ----
  const storageBody = h('div', { class: 'srow' }, h('div', { class: 'sdesc' }, 'Reading storage...'));
  async function refreshStorage() {
    try {
      const projects = await listProjects();
      let videos = 0, cache = 0, free = 0, db = 0;
      if (isNative()) {
        const i = await EditorrNative.storageInfo();
        videos = i.videosBytes; cache = i.cacheBytes; free = i.freeMb * 1048576;
      } else {
        videos = await mediaBytes();
      }
      if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); db = e.usage ?? 0; if (!isNative()) free = Math.max(0, (e.quota ?? 0) - db); }
      const used = videos + cache;
      const total = Math.max(1, used + free);
      const pct = (n: number) => `${Math.min(100, (n / total) * 100).toFixed(2)}%`;
      const legend = (color: string, name: string, val: string) => h('div', { class: 'legend' }, h('i', { style: `background:${color}` }), h('span', {}, name), h('b', {}, val));
      storageBody.replaceChildren(
        h('div', { class: 'sbar' }, h('i', { style: `width:${pct(videos)};background:#19e6c1` }), h('i', { style: `width:${pct(cache)};background:#8a8a8a` })),
        legend('#19e6c1', 'Saved videos', fmtBytes(videos)),
        ...(isNative() ? [legend('#8a8a8a', 'Cache (audio, previews)', fmtBytes(cache))] : []),
        legend('#3a3a3c', 'Free', fmtBytes(free)),
        h('div', { class: 'sdesc', style: 'margin-top:8px' }, `${projects.length} ${projects.length === 1 ? 'project' : 'projects'} saved in IndexedDB.`));
    } catch { storageBody.replaceChildren(h('div', { class: 'sdesc' }, 'Could not read storage.')); }
  }
  refreshStorage();

  async function clearCache() {
    if (!isNative()) { toast('Nothing to clear in the browser.'); return; }
    try {
      const r = await EditorrNative.clearCache();
      // loaded audio stays in memory; it is read again from the saved videos next time a project opens
      toast(`Cache cleared (${fmtBytes(r.freedBytes)}). Projects and videos are safe.`);
    } catch (e) { toast((e as Error).message); }
    refreshStorage();
  }

  async function clearProjects() {
    if (!(await confirmDialog('Delete all projects?', 'All projects and their saved video copies are removed. The originals in your gallery stay.', 'Delete all'))) return;
    await clearAllStorage();
    if (isNative()) { try { await EditorrNative.pruneVideos({ keep: [] }); } catch { /* ignore */ } }
    runtime.projectId = undefined; runtime.hostUrl = runtime.constUrl = undefined; runtime.hostPcm = runtime.constPcm = undefined;
    toast('All projects deleted');
    refreshStorage();
  }

  const action = (ic: Parameters<typeof icon>[0], text: string, run: () => void, cls = '') =>
    h('button', { class: 'saction ' + cls, onclick: run }, icon(ic, 22), h('span', {}, text), icon('chevR', 18));

  const el = h('div', { class: 'screen settings' },
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => app.go('home')), h('h1', {}, 'Settings')),
    h('div', { class: 'content' },
      group('Auto edit',
        option<Sensitivity>('Speaker detect sensitivity', 'How easily the switch follows a new speaker.', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.sensitivity, (v) => { s.sensitivity = v; save(); }),
        option<number>('Minimum segment length', 'Shorter parts are merged into their neighbour.', [[1000, '1.0 s'], [1500, '1.5 s'], [2500, '2.5 s'], [4000, '4 s']], s.minSegmentMs, (v) => { s.minSegmentMs = v; save(); }),
        option<'hold' | 'side'>('When both people talk', '', [['hold', 'Keep last speaker'], ['side', 'Side by side']], s.bothSpeaking, (v) => { s.bothSpeaking = v; save(); })),
      group('Export',
        option<number>('Default resolution', 'Used when you open the editor. You can change it there too.', [[480, '480p'], [720, '720p'], [1080, '1080p'], [1440, '2K'], [2160, '4K']], s.resolution, (v) => { s.resolution = v; save(); })),
      group('Storage',
        storageBody,
        action('silence', 'Clear cache', clearCache),
        action('trash', 'Delete all projects', clearProjects, 'danger')),
      h('div', { class: 'sfoot' }, 'Clear cache frees temporary files only. Your projects and saved videos stay.'),
      h('div', { class: 'sfoot' }, 'Editorr by Tuik')),
    tabBar('me', (tab) => { if (tab === 'me') return; app.homeTab = tab; app.go('home'); }));
  return { el };
}
