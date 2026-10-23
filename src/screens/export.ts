import { app } from '../app';
import { EditorrNative, isNative, toExportRequest } from '../core/native';
import { saveSettings } from '../core/store';
import { h, iconButton, toast } from '../ui';
import { LocalNotifications } from '@capacitor/local-notifications';
import { ASPECTS, BITRATE_STEPS, FPS_STEPS, RES_STEPS, recommendedMbps, resLabel, type Aspect, type Role } from '../core/types';

/** Position 0..100 on the bitrate slider <-> Mbps. Ticks 5, 10, 20, 50, 100 sit evenly (like CapCut), values between are linear. */
function posToMbps(pos: number): number {
  const seg = Math.min(BITRATE_STEPS.length - 2, Math.floor(pos / 25));
  const t = (pos - seg * 25) / 25;
  return Math.round(BITRATE_STEPS[seg] + (BITRATE_STEPS[seg + 1] - BITRATE_STEPS[seg]) * t);
}
function mbpsToPos(m: number): number {
  const v = Math.max(5, Math.min(100, m));
  const seg = Math.min(BITRATE_STEPS.length - 2, BITRATE_STEPS.findIndex((s, i) => v <= BITRATE_STEPS[i + 1]));
  const a = BITRATE_STEPS[seg], b = BITRATE_STEPS[seg + 1];
  return seg * 25 + ((v - a) / (b - a)) * 25;
}

export function exportScreen() {
  const p = app.project;
  const st = app.settings;
  let res = RES_STEPS.includes(st.resolution) ? st.resolution : 1080;
  let fps = FPS_STEPS.includes(st.fps) ? st.fps : 30;
  let mbps = st.bitrateMbps > 0 ? st.bitrateMbps : recommendedMbps(res, fps);
  let auto = !(st.bitrateMbps > 0); // follows the recommendation until the user moves the bitrate slider
  let running = false;

  const keptMs = () => p.segments.reduce((a, s) => a + (s.endMs - s.startMs), 0) || p.durationMs;
  const sizeMb = () => Math.round(((mbps * 1_000_000 + 128_000) * (keptMs() / 1000)) / 8 / 1_000_000);

  // ------------------------------------------------------------ slider (steps, CapCut look)
  function slider(opts: { label: string; hint: () => string; ticks: string[]; value: () => number; max: number; step: number; onInput: (v: number) => void }) {
    const hint = h('span', { class: 'xhint' }, opts.hint());
    const input = h('input', { type: 'range', min: '0', max: String(opts.max), step: String(opts.step), value: String(opts.value()), class: 'xrange' }) as HTMLInputElement;
    const fill = () => input.style.setProperty('--p', `${(Number(input.value) / opts.max) * 100}%`);
    input.addEventListener('input', () => { opts.onInput(Number(input.value)); fill(); refresh(); });
    fill();
    const labels = h('div', { class: 'xticks' }, ...opts.ticks.map((t) => h('span', {}, t)));
    const el = h('div', { class: 'xsec' }, h('div', { class: 'xhead' }, h('span', { class: 'xlabel' }, opts.label), hint), input, labels);
    return { el, input, hint, sync: () => { hint.textContent = opts.hint(); input.value = String(opts.value()); fill(); } };
  }

  const srcShort = Math.min(p.host?.width ?? 0, p.host?.height ?? 0) || 1080;
  const srcFps = Math.round(p.host?.fps || 30);

  const resS = slider({
    label: 'Resolution',
    hint: () => (res > srcShort ? `${resLabel(res)} (larger than your video)` : res >= 1080 ? 'High definition' : 'Smaller file, lighter export'),
    ticks: RES_STEPS.map(resLabel), max: RES_STEPS.length - 1, step: 1,
    value: () => RES_STEPS.indexOf(res),
    onInput: (i) => { res = RES_STEPS[i]; if (auto) mbps = recommendedMbps(res, fps); st.resolution = res; },
  });
  const fpsS = slider({
    label: 'Frame rate',
    hint: () => (fps > srcFps ? `Your video is ${srcFps} fps, so it exports at ${srcFps}` : fps >= 50 ? 'Smoother playback' : 'Standard'),
    ticks: FPS_STEPS.map(String), max: FPS_STEPS.length - 1, step: 1,
    value: () => FPS_STEPS.indexOf(fps),
    onInput: (i) => { fps = FPS_STEPS[i]; if (auto) mbps = recommendedMbps(res, fps); st.fps = fps; },
  });
  const brS = slider({
    label: 'Bitrate (Mbps)',
    hint: () => `${mbps} Mbps · recommended ${recommendedMbps(res, fps)}`,
    ticks: BITRATE_STEPS.map(String), max: 100, step: 1,
    value: () => Math.round(mbpsToPos(mbps)),
    onInput: (pos) => { mbps = posToMbps(pos); auto = mbps === recommendedMbps(res, fps); st.bitrateMbps = auto ? 0 : mbps; },
  });
  const sizeLine = h('div', { class: 'xsize' }, '');
  function refresh() {
    if (auto) { st.bitrateMbps = 0; }
    resS.sync(); fpsS.sync(); brS.sync();
    sizeLine.textContent = `Estimated file size: ${sizeMb()} MB`;
  }

  // ------------------------------------------------------------ other options (kept from before)
  function seg<T extends string | number>(opts: [T, string][], value: T, on: (v: T) => void) {
    const w = h('div', { class: 'seg' });
    const r = (cur: T) => w.replaceChildren(...opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onclick: () => { on(v); r(v); } }, l)));
    r(value); return w;
  }
  const settingsBox = h('div', { class: 'xwrap' },
    resS.el, fpsS.el, brS.el, sizeLine,
    h('div', { class: 'field' }, h('label', {}, 'Aspect ratio'), seg<string>((Object.keys(ASPECTS) as Aspect[]).map((a) => [a, a] as [string, string]), p.aspect, (v) => { p.aspect = v as Aspect; })),
    h('div', { class: 'field' }, h('label', {}, 'Audio source'), seg<Role>([['host', 'Host mic'], ['constant', 'Constant mic']], p.mainAudio, (v) => { p.mainAudio = v; })),
    h('div', { class: 'field' }, h('label', {}, 'Normalize volume'), seg<string>([['off', 'Off'], ['on', 'On']], p.normalize ? 'on' : 'off', (v) => { p.normalize = v === 'on'; })),
    h('div', { class: 'cap' }, 'MP4 (H.264 + AAC), saved to your gallery. 2K and 4K need a strong phone. Keep the phone plugged in for long exports.'));

  // ------------------------------------------------------------ progress + done screens
  const pct = h('div', { class: 'xpct' }, '0%');
  const eta = h('div', { class: 'cap', style: 'text-align:center;margin-top:14px' }, '');
  const status = h('div', { class: 'xtitle' }, 'Exporting...');
  const sub = h('div', { class: 'xsub' }, "Please don't close Editorr or lock your screen.");
  const runBox = h('div', { class: 'xrun', style: 'display:none' }, status, sub, h('div', { class: 'xbox' }, pct), eta);
  const doneBox = h('div', { class: 'xrun', style: 'display:none' });
  const exportBtn = h('button', { class: 'xexport', onclick: start }, 'Export');
  const cancelBtn = h('button', { class: 'btn', style: 'display:none;margin:24px auto 0', onclick: cancel }, 'Cancel export');
  runBox.append(cancelBtn);

  let lastPct = -1;
  async function start() {
    if (running) return;
    if (!isNative()) { toast('Export runs in the Android app. Install the APK to export.'); return; }
    const hostUri = p.host?.uri, constUri = p.constant?.uri;
    if (!hostUri || !constUri) { toast('Original video paths are missing. Re-import the videos, then export.'); return; }
    running = true;
    saveSettings(st);
    top.style.display = 'none'; settingsBox.style.display = 'none'; exportBtn.style.display = 'none';
    runBox.style.display = ''; cancelBtn.style.display = '';
    status.className = 'xtitle'; status.textContent = 'Exporting...'; sub.style.display = '';
    try {
      const { mb } = await EditorrNative.freeSpaceMb();
      const needMb = Math.round(sizeMb() * 1.15) + 50;
      if (mb < needMb) throw new Error(`Not enough storage. Free about ${needMb - mb} MB and try again.`);
      try { await LocalNotifications.requestPermissions(); } catch { /* optional */ }
      const t0 = Date.now();
      EditorrNative.addListener('exportProgress', (e: { path?: string; percent: number }) => {
        const n = Math.floor(e.percent * 10) / 10;
        if (n === lastPct) return; // no repaint when nothing changed (keeps the UI thread free for the encoder)
        lastPct = n;
        pct.textContent = `${n.toFixed(1)}%`;
        if (e.percent > 3) {
          const left = ((Date.now() - t0) / e.percent) * (100 - e.percent);
          eta.textContent = `About ${Math.max(1, Math.round(left / 60000))} min left`;
        }
      });
      const out = await EditorrNative.exportProject(toExportRequest(p, hostUri, constUri, res, Math.min(fps, srcFps), mbps));
      finish(out.outputUri);
    } catch (e) {
      running = false;
      status.className = 'xtitle err'; status.textContent = (e as Error).message || 'Export failed.';
      sub.textContent = 'Try a lower resolution or bitrate, or close other apps.'; sub.style.display = '';
      pct.textContent = '!'; cancelBtn.textContent = 'Back'; cancelBtn.onclick = () => { app.go('editor'); };
    }
  }

  async function cancel() {
    try { await EditorrNative.cancelExport(); } catch { /* ignore */ }
    running = false;
    app.go('editor');
  }

  function finish(uri: string) {
    running = false;
    runBox.style.display = 'none';
    doneBox.style.display = '';
    doneBox.replaceChildren(
      h('div', { class: 'xtitle ok' }, 'Saved to device'),
      h('div', { class: 'xsub' }, `${resLabel(res)} · ${Math.min(fps, srcFps)} fps · ${mbps} Mbps · Movies/Editorr`),
      h('div', { class: 'cap', style: 'text-align:center;word-break:break-all;margin-top:10px' }, uri),
      h('button', { class: 'btn primary', style: 'margin-top:28px;width:100%', onclick: () => app.go('home') }, 'Done'));
    LocalNotifications.schedule({ notifications: [{ id: 1, title: 'Editorr', body: 'Your video is ready in the gallery.' }] }).catch(() => {});
  }

  const top = h('div', { class: 'topbar' },
    iconButton('back', 'Back', () => { if (!running) app.go('editor'); }),
    h('h1', {}, 'Export'),
    exportBtn);
  refresh();
  const el = h('div', { class: 'screen' }, top, h('div', { class: 'content' }, settingsBox, runBox, doneBox));
  return { el };
}
