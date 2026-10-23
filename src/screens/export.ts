import { app } from '../app';
import { EditorrNative, isNative, toExportRequest } from '../core/native';
import { h, toast } from '../ui';
import { LocalNotifications } from '@capacitor/local-notifications';
import { resLabel } from '../core/types';
import { estimateMb, resolveExport } from '../core/exportOpts';

export function exportScreen() {
  const p = app.project;
  const st = app.settings;
  // Values come from the export settings sheet in the editor (resolution, frame rate, bitrate), never above the source.
  const { res, fps, mbps } = resolveExport(p, st);
  let running = false;

  const sizeMb = () => estimateMb(p, mbps);

  // ------------------------------------------------------------ progress + done screens
  const pct = h('div', { class: 'xpct' }, '0%');
  const eta = h('div', { class: 'cap', style: 'text-align:center;margin-top:14px' }, '');
  const status = h('div', { class: 'xtitle' }, 'Exporting...');
  const sub = h('div', { class: 'xsub' }, "Please don't close Editorr or lock your screen.");
  const runBox = h('div', { class: 'xrun' }, status, sub, h('div', { class: 'xbox' }, pct), eta);
  const doneBox = h('div', { class: 'xrun', style: 'display:none' });
  const cancelBtn = h('button', { class: 'btn', style: 'display:none;margin:24px auto 0', onclick: cancel }, 'Cancel export');
  runBox.append(cancelBtn);

  let lastPct = -1;
  async function start() {
    if (running) return;
    if (!isNative()) { toast('Export runs in the Android app. Install the APK to export.'); return; }
    const hostUri = p.host?.uri, constUri = p.constant?.uri;
    if (!hostUri || !constUri) { toast('Original video paths are missing. Re-import the videos, then export.'); return; }
    running = true;
    runBox.style.display = ''; cancelBtn.style.display = '';
    status.className = 'xtitle'; status.textContent = 'Exporting...'; sub.style.display = '';
    try {
      const { mb } = await EditorrNative.freeSpaceMb();
      const noiseStrength = p.mainAudio === 'host' ? p.noiseHost : p.noiseConst;
      const denoiseTempMb = noiseStrength > 0 ? Math.ceil(((p.mainAudio === 'host' ? p.host?.durationMs : p.constant?.durationMs) ?? p.durationMs) / 1000 * 0.30) : 0;
      const needMb = Math.round(sizeMb() * 1.15) + denoiseTempMb + 50;
      if (mb < needMb) throw new Error(`Not enough storage. Free about ${needMb - mb} MB and try again.`);
      try { await LocalNotifications.requestPermissions(); } catch { /* optional */ }
      let t0 = Date.now();
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
      let cleanAudioUri: string | undefined;
      if (noiseStrength > 0) {
        status.textContent = 'Preparing noise-reduced audio...';
        sub.textContent = 'Cleaning the selected mic track at its original sample rate.';
        pct.textContent = '0%';
        const listener = await EditorrNative.addListener('denoiseProgress', (e: { percent: number }) => {
          pct.textContent = `${Math.floor(e.percent)}%`;
        });
        try {
          const path = p.mainAudio === 'host' ? hostUri : constUri;
          cleanAudioUri = (await EditorrNative.prepareDenoiseAudio({ path, strength: noiseStrength })).audioUri;
        } finally { await listener.remove(); }
      }
      status.textContent = 'Exporting...';
      sub.textContent = "Please don't close Editorr or lock your screen.";
      pct.textContent = '0%';
      lastPct = -1;
      t0 = Date.now();
      const request = toExportRequest(p, hostUri, constUri, res, fps, mbps);
      request.cleanAudioUri = cleanAudioUri;
      const out = await EditorrNative.exportProject(request);
      finish(out.outputUri);
    } catch (e) {
      running = false;
      status.className = 'xtitle err'; status.textContent = (e as Error).message || 'Export failed.';
      sub.textContent = 'Try a lower resolution or bitrate in the export settings, or close other apps.'; sub.style.display = '';
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
      h('div', { class: 'xsub' }, `${resLabel(res)} · ${fps} fps · ${mbps} Mbps · Movies/Editorr`),
      h('div', { class: 'cap', style: 'text-align:center;word-break:break-all;margin-top:10px' }, uri),
      h('button', { class: 'btn primary', style: 'margin-top:28px;width:100%', onclick: () => app.go('home') }, 'Done'));
    LocalNotifications.schedule({ notifications: [{ id: 1, title: 'Editorr', body: 'Your video is ready in the gallery.' }] }).catch(() => {});
  }

  const el = h('div', { class: 'screen' }, h('div', { class: 'topbar' }, h('h1', {}, 'Export')), h('div', { class: 'content' }, runBox, doneBox));
  // Exporting begins as soon as the screen opens, but only after it has painted and the editor is torn down.
  // Starting in the same frame made the UI stutter while the encoder spun up.
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(start, 350)));
  return { el };
}
