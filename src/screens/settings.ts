import { app } from '../app';
import { clearAllStorage, listProjects, runtime, saveSettings } from '../core/store';
import { EditorrNative, isNative } from '../core/native';
import { fmtBytes } from '../core/media';
import type { Sensitivity } from '../core/types';
import { confirmDialog, h, iconButton, tabBar, toast } from '../ui';

function seg<T extends string | number>(opts: [T, string][], value: T, onPick: (v: T) => void) {
  const wrap = h('div', { class: 'seg' });
  const render = (cur: T) => {
    wrap.replaceChildren(...opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onclick: () => { onPick(v); render(v); } }, l)));
  };
  render(value);
  return wrap;
}

export function settingsScreen() {
  const s = app.settings;
  const save = () => saveSettings(s);

  // ---- storage ----
  const storageInfo = h('div', { class: 'card' }, h('div', { class: 'cap' }, 'Reading storage...'));
  async function refreshStorage() {
    try {
      const projects = await listProjects();
      const rows: [string, string][] = [['Projects saved', String(projects.length)]];
      if (isNative()) {
        const i = await EditorrNative.storageInfo();
        rows.push(['Saved videos', fmtBytes(i.videosBytes)], ['Cache (audio, previews)', fmtBytes(i.cacheBytes)], ['Free on phone', fmtBytes(i.freeMb * 1048576)]);
      } else if (navigator.storage?.estimate) {
        const e = await navigator.storage.estimate();
        rows.push(['Browser storage used', fmtBytes(e.usage ?? 0)]);
      }
      storageInfo.replaceChildren(...rows.map(([k, v]) => h('div', { class: 'row', style: 'justify-content:space-between;margin:4px 0' }, h('span', { class: 'sec' }, k), h('b', {}, v))));
    } catch { storageInfo.replaceChildren(h('div', { class: 'cap' }, 'Could not read storage.')); }
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
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => app.go('home')), h('h1', {}, 'Settings')),
    h('div', { class: 'content' },
      h('div', { class: 'field' }, h('label', {}, 'Speaker detect sensitivity'),
        seg<Sensitivity>([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.sensitivity, (v) => { s.sensitivity = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'Minimum segment length'),
        seg<number>([[1000, '1.0 s'], [1500, '1.5 s'], [2500, '2.5 s'], [4000, '4 s']], s.minSegmentMs, (v) => { s.minSegmentMs = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'When both people talk'),
        seg<'hold' | 'side'>([['hold', 'Keep last speaker'], ['side', 'Side by side']], s.bothSpeaking, (v) => { s.bothSpeaking = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'Default export resolution'),
        seg<number>([[720, '720p'], [1080, '1080p']], s.resolution, (v) => { s.resolution = v as 720 | 1080; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'Storage'),
        storageInfo,
        h('div', { class: 'row' },
          h('button', { class: 'btn', style: 'flex:1', onclick: clearCache }, 'Clear cache'),
          h('button', { class: 'btn danger', style: 'flex:1', onclick: clearProjects }, 'Delete all projects')),
        h('div', { class: 'cap', style: 'margin-top:8px' }, 'Clear cache frees temporary files only. Your projects and saved videos stay.')),
      h('div', { class: 'cap' }, 'Editorr by Tuik')),
    tabBar('me', (tab) => { if (tab === 'me') return; app.homeTab = tab; app.go('home'); }));
  return { el };
}
