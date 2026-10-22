import { app } from '../app';
import { EditorrNative, isNative, toExportRequest } from '../core/native';
import { h, iconButton, progressBar, toast } from '../ui';
import { LocalNotifications } from '@capacitor/local-notifications';
import { ASPECTS, type Aspect, type Role } from '../core/types';

export function exportScreen() {
  const p = app.project;
  let res: 720 | 1080 = app.settings.resolution;
  let running = false;

  const settingsBox = h('div');
  const runBox = h('div', { style: 'display:none' });
  const status = h('div', { class: 'title' }, 'Exporting...');
  const eta = h('div', { class: 'cap' }, '');
  const pb = progressBar();
  const doneBox = h('div', { style: 'display:none' });
  const startBtn = h('button', { class: 'btn primary', onclick: start }, 'Start export');
  const cancelBtn = h('button', { class: 'btn', style: 'flex:1;display:none', onclick: cancel }, 'Cancel export');

  function seg<T extends string | number>(opts: [T, string][], value: T, on: (v: T) => void) {
    const w = h('div', { class: 'seg' });
    const r = (cur: T) => w.replaceChildren(...opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onclick: () => { on(v); r(v); } }, l)));
    r(value); return w;
  }

  settingsBox.append(
    h('div', { class: 'field' }, h('label', {}, 'Resolution'), seg<number>([[720, '720p'], [1080, '1080p']], res, (v) => { res = v as 720 | 1080; })),
    h('div', { class: 'field' }, h('label', {}, 'Aspect ratio'), seg<string>((Object.keys(ASPECTS) as Aspect[]).map((a) => [a, a] as [string, string]), p.aspect, (v) => { p.aspect = v as Aspect; })),
    h('div', { class: 'field' }, h('label', {}, 'Audio source'), seg<Role>([['host', 'Host mic'], ['constant', 'Constant mic']], p.mainAudio, (v) => { p.mainAudio = v; })),
    h('div', { class: 'field' }, h('label', {}, 'Normalize volume'), seg<string>([['off', 'Off'], ['on', 'On']], p.normalize ? 'on' : 'off', (v) => { p.normalize = v === 'on'; })),
    h('div', { class: 'cap' }, 'Output: MP4 (H.264 + AAC), saved to your gallery. 1080p needs 6 GB+ RAM. Keep the phone plugged in for long exports.'));

  async function start() {
    if (running) return;
    if (!isNative()) {
      toast('Export runs in the Android app. Install the APK to export.');
      return;
    }
    const hostUri = p.host?.uri, constUri = p.constant?.uri;
    if (!hostUri || !constUri) {
      toast('Original video paths are missing. Re-import the videos, then export.');
      return;
    }
    running = true;
    settingsBox.style.display = 'none'; runBox.style.display = ''; startBtn.style.display = 'none'; cancelBtn.style.display = '';
    try {
      const { mb } = await EditorrNative.freeSpaceMb();
      const keptMs = p.segments.reduce((a, s) => a + (s.endMs - s.startMs), 0) || p.durationMs;
      const needMb = Math.round((keptMs / 60000) * (res === 1080 ? 120 : 60));
      if (mb < needMb) throw new Error(`Not enough storage. Free about ${needMb - mb} MB and try again.`);
      try { await LocalNotifications.requestPermissions(); } catch { /* optional */ }
      const t0 = Date.now();
      EditorrNative.addListener('exportProgress', (e: { path?: string; percent: number }) => {
        pb.set(e.percent);
        if (e.percent > 3) {
          const left = ((Date.now() - t0) / e.percent) * (100 - e.percent);
          eta.textContent = `About ${Math.max(1, Math.round(left / 60000))} min left`;
        }
      });
      const out = await EditorrNative.exportProject(toExportRequest(p, hostUri, constUri, res));
      finish(out.outputUri);
    } catch (e) {
      status.className = 'err';
      status.textContent = `${(e as Error).message || 'Export failed.'} Try 720p or close other apps.`;
      cancelBtn.style.display = 'none'; startBtn.style.display = ''; startBtn.textContent = 'Try again';
      running = false;
    }
  }

  async function cancel() {
    try { await EditorrNative.cancelExport(); } catch { /* ignore */ }
    running = false;
    app.go('editor');
  }

  function finish(uri: string) {
    running = false;
    runBox.style.display = 'none'; cancelBtn.style.display = 'none';
    doneBox.style.display = '';
    doneBox.replaceChildren(
      h('div', { class: 'title ok' }, 'Export complete'),
      h('p', { class: 'sec' }, 'Saved to your gallery (Movies/Editorr).'),
      h('div', { class: 'cap' }, uri),
      h('button', { class: 'btn primary', style: 'margin-top:16px;width:100%', onclick: () => app.go('home') }, 'Back to Home'));
    LocalNotifications.schedule({ notifications: [{ id: 1, title: 'Editorr', body: 'Your video is ready in the gallery.' }] }).catch(() => {});
  }

  runBox.append(status, pb.el, eta);
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => { if (!running) app.go('editor'); }), h('h1', {}, 'Export')),
    h('div', { class: 'content' }, settingsBox, runBox, doneBox),
    h('div', { class: 'bottombar' }, startBtn, cancelBtn));
  return { el };
}
