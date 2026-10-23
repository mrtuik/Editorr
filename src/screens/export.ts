import { Capacitor } from '@capacitor/core';
import { app, startNewProject } from '../app';
import { EditorrNative, isNative, toExportRequest } from '../core/native';
import { confirmDialog, h, icon, iconButton, toast } from '../ui';
import { LocalNotifications } from '@capacitor/local-notifications';
import { outputSize, resLabel } from '../core/types';
import { estimateMb, resolveExport } from '../core/exportOpts';

/** Share targets on the done screen. Several package names per app (TikTok has regional builds). */
const TARGETS: { label: string; pkgs: string[]; svg: string }[] = [
  { label: 'Instagram', pkgs: ['com.instagram.android'],
    svg: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor"/>' },
  { label: 'YouTube', pkgs: ['com.google.android.youtube'],
    svg: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor"/>' },
  { label: 'WhatsApp', pkgs: ['com.whatsapp', 'com.whatsapp.w4b'],
    svg: '<path d="M4 20l1.2-4A8 8 0 1 1 8.200 18.800z"/><path d="M9 8.500c0 3 2.500 6 6 6.500l1.200-1.500-2-1-1 .8c-1-.4-2-1.400-2.400-2.400l.8-1-1-2z" fill="currentColor"/>' },
  { label: 'Facebook', pkgs: ['com.facebook.katana'],
    svg: '<path d="M14 21v-8h2.700l.5-3.200H14V7.900c0-1 .4-1.700 1.800-1.700h1.500V3.300C17 3.200 16 3 15 3c-2.600 0-4.200 1.500-4.200 4.200v2.600H8V13h2.800v8z" fill="currentColor"/>' },
  { label: 'More', pkgs: [], svg: '<circle cx="5" cy="12" r="1.600" fill="currentColor"/><circle cx="12" cy="12" r="1.600" fill="currentColor"/><circle cx="19" cy="12" r="1.600" fill="currentColor"/>' },
];
const TIKTOK_PKGS = ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'];

export function exportScreen() {
  const p = app.project;
  const st = app.settings;
  // Values come from the export settings sheet in the editor (resolution, frame rate, bitrate), never above the source.
  const { res, fps, mbps } = resolveExport(p, st);
  let running = false;

  const sizeMb = () => estimateMb(p, mbps);

  // ------------------------------------------------------------ progress screen
  const pct = h('div', { class: 'xpct' }, '0%');
  const eta = h('div', { class: 'cap', style: 'text-align:center;margin-top:14px' }, '');
  const status = h('div', { class: 'xtitle' }, 'Exporting...');
  const sub = h('div', { class: 'xsub' }, "Please don't close Editorr or lock your screen.");
  const runBox = h('div', { class: 'xrun' }, status, sub, h('div', { class: 'xbox' }, pct), eta);
  const cancelBtn = h('button', { class: 'btn', style: 'display:none;margin:24px auto 0', onclick: () => { app.go('editor'); } }, 'Back');
  runBox.append(cancelBtn);
  const doneBox = h('div', { class: 'xdone', style: 'display:none' });
  const topbar = h('div', { class: 'topbar' }, iconButton('close', 'Cancel export', () => { void closeScreen(); }, 'plain'));
  let finished = false;

  // ONE percentage for the whole job. Noise reduction (when on) takes the first slice, the encode takes the rest.
  let noiseSlice = 0;
  let overall = 0;
  let lastShown = -1;
  let t0 = Date.now();
  function setOverall(v: number) {
    overall = Math.max(overall, Math.min(100, v)); // never goes backwards
    const n = Math.floor(overall * 10) / 10;
    if (n === lastShown) return; // no repaint when nothing changed (keeps the UI thread free for the encoder)
    lastShown = n;
    pct.textContent = `${n.toFixed(1)}%`;
    if (overall > 3) {
      const left = ((Date.now() - t0) / overall) * (100 - overall);
      eta.textContent = `About ${Math.max(1, Math.round(left / 60000))} min left`;
    }
  }

  async function start() {
    if (running) return;
    if (!isNative()) { toast('Export runs in the Android app. Install the APK to export.'); return; }
    const hostUri = p.host?.uri, constUri = p.constant?.uri;
    if (!hostUri || !constUri) { toast('Original video paths are missing. Re-import the videos, then export.'); return; }
    running = true;
    runBox.style.display = ''; cancelBtn.style.display = 'none';
    status.className = 'xtitle'; status.textContent = 'Exporting...'; sub.style.display = '';
    sub.textContent = "Please don't close Editorr or lock your screen.";
    let denoiseListener: { remove: () => Promise<void> } | undefined;
    let exportListener: { remove: () => Promise<void> } | undefined;
    try {
      const { mb } = await EditorrNative.freeSpaceMb();
      const noiseStrength = p.mainAudio === 'host' ? p.noiseHost : p.noiseConst;
      const denoiseTempMb = noiseStrength > 0 ? Math.ceil(((p.mainAudio === 'host' ? p.host?.durationMs : p.constant?.durationMs) ?? p.durationMs) / 1000 * 0.30) : 0;
      const needMb = Math.round(sizeMb() * 1.15) + denoiseTempMb + 50;
      if (mb < needMb) throw new Error(`Not enough storage. Free about ${needMb - mb} MB and try again.`);
      try { await LocalNotifications.requestPermissions(); } catch { /* optional */ }

      noiseSlice = noiseStrength > 0 ? 20 : 0; // % of the bar used by noise reduction
      overall = 0; lastShown = -1; t0 = Date.now();
      setOverall(0);

      const xl = await EditorrNative.addListener('exportProgress', (e: { percent: number }) => {
        setOverall(noiseSlice + (e.percent / 100) * (100 - noiseSlice));
      });
      exportListener = xl;
      let cleanAudioUri: string | undefined;
      if (noiseStrength > 0) {
        const dl = await EditorrNative.addListener('denoiseProgress', (e: { percent: number }) => {
          setOverall((e.percent / 100) * noiseSlice);
        });
        denoiseListener = dl;
        try {
          const path = p.mainAudio === 'host' ? hostUri : constUri;
          cleanAudioUri = (await EditorrNative.prepareDenoiseAudio({ path, strength: noiseStrength })).audioUri;
        } finally { await dl.remove(); denoiseListener = undefined; }
        setOverall(noiseSlice);
      }
      const request = toExportRequest(p, hostUri, constUri, res, fps, mbps);
      request.cleanAudioUri = cleanAudioUri;
      const out = await EditorrNative.exportProject(request);
      await xl.remove(); exportListener = undefined;
      finish(out.outputUri);
    } catch (e) {
      running = false;
      try { await denoiseListener?.remove(); } catch { /* ignore */ }
      try { await exportListener?.remove(); } catch { /* ignore */ }
      status.className = 'xtitle err'; status.textContent = (e as Error).message || 'Export failed.';
      sub.textContent = 'Try a lower resolution or bitrate in the export settings, or close other apps.'; sub.style.display = '';
      pct.textContent = '!'; eta.textContent = ''; cancelBtn.style.display = '';
    }
  }

  /** Cross button (and Android back): ask first while exporting, then stop. */
  async function closeScreen() {
    if (finished) { app.go('home'); return; }
    if (running) {
      if (!(await confirmDialog('Stop export?', 'The video will not be saved if you stop now.', 'Stop'))) return;
      await cancel();
      return;
    }
    app.go('editor');
  }

  async function cancel() {
    try { await EditorrNative.cancelExport(); } catch { /* ignore */ }
    running = false;
    app.go('editor');
  }

  // ------------------------------------------------------------ "Saved to device" screen
  async function share(pkgs: string[], uri: string) {
    try {
      await EditorrNative.shareVideo({ uri, pkgs });
    } catch (e) {
      const msg = (e as Error).message || '';
      toast(msg === 'not_installed' ? 'That app is not installed.' : 'Could not open the share sheet.');
    }
  }

  function finish(uri: string) {
    running = false; finished = true;
    runBox.style.display = 'none';
    doneBox.style.display = '';

    // topbar: back (to editor) · title · Done (home)
    topbar.replaceChildren(
      iconButton('back', 'Back to editor', () => app.go('editor'), 'plain'),
      h('div', { class: 'xbartitle' }, 'Saved to device'),
      h('button', { class: 'xdonebtn', onclick: () => app.go('home') }, 'Done'));

    // preview card with a play button, tap to play / pause
    const { w, h: oh } = outputSize(p.aspect, res);
    const video = h('video', { class: 'xvid', playsInline: true, preload: 'metadata', src: Capacitor.convertFileSrc(uri) + '#t=0.1' }) as HTMLVideoElement;
    video.setAttribute('playsinline', '');
    const playBtn = h('div', { class: 'xplay' }, icon('play', 28));
    const frame = h('div', { class: 'xframe', style: `aspect-ratio:${w} / ${oh}`, onclick: () => { if (video.paused) void video.play().catch(() => void EditorrNative.viewVideo({ uri }).catch(() => {})); else video.pause(); } }, video, playBtn);
    video.addEventListener('play', () => { playBtn.style.display = 'none'; });
    video.addEventListener('pause', () => { playBtn.style.display = ''; });
    video.addEventListener('ended', () => { playBtn.style.display = ''; });

    const targetBtn = (t: { label: string; pkgs: string[]; svg: string }) => {
      const ic = icon('more', 26); ic.innerHTML = t.svg;
      return h('button', { class: 'xtarget', onclick: () => void share(t.pkgs, uri) }, h('span', { class: 'xticon' }, ic), h('span', {}, t.label));
    };
    const quick = (label: string, ic: Parameters<typeof icon>[0], run: () => void) =>
      h('button', { class: 'xquick', onclick: run }, h('span', { class: 'xqicon' }, icon(ic, 26)), h('span', {}, label));

    doneBox.replaceChildren(
      h('div', { class: 'xcard' },
        frame,
        h('div', { class: 'cap', style: 'text-align:center;margin-top:12px' }, `${resLabel(res)} · ${fps} fps · ${mbps} Mbps · Movies/Editorr`),
        h('button', { class: 'xtiktok', onclick: () => void share(TIKTOK_PKGS, uri) }, 'Share to TikTok'),
        h('div', { class: 'xtargets' }, ...TARGETS.map(targetBtn))),
      h('div', { class: 'xhead' }, 'Quick actions'),
      h('div', { class: 'xquicks' },
        quick('New project', 'plus', () => { startNewProject(); app.go('import'); }),
        quick('Edit again', 'scissors', () => app.go('editor')),
        quick('Open in gallery', 'folder', () => void EditorrNative.viewVideo({ uri }).catch(() => toast('No gallery app found.')))));
    LocalNotifications.schedule({ notifications: [{ id: 1, title: 'Editorr', body: 'Your video is ready in the gallery.' }] }).catch(() => {});
  }

  const el = h('div', { class: 'screen' }, topbar, h('div', { class: 'content' }, runBox, doneBox));
  // Exporting begins as soon as the screen opens, but only after it has painted and the editor is torn down.
  // Starting in the same frame made the UI stutter while the encoder spun up.
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(start, 350)));
  app.onBack = () => { void closeScreen(); return true; };
  return { el };
}
