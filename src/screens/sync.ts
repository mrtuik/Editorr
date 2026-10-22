import { app } from '../app';
import { decodeToMono16k, peaks } from '../core/audio';
import { findOffset } from '../core/sync';
import { runtime, saveProject } from '../core/store';
import { EditorrNative, isNative, loadPcm } from '../core/native';
import { fmtOffset, h, iconButton, progressBar, toast } from '../ui';

export const PEAKS_PER_SEC = 20;

export function syncScreen() {
  const p = app.project;
  let cancelled = false;
  let hostPeaks: Float32Array | null = null;
  let constPeaks: Float32Array | null = null;
  let timer = 0;
  let listener: { remove: () => Promise<void> } | null = null;

  const status = h('div', { class: 'title' }, 'Starting...');
  const detail = h('div', { class: 'cap' }, '');
  const pb = progressBar();
  const result = h('div');
  const canvas = h('canvas', { height: 160, style: 'height:160px' }) as HTMLCanvasElement;
  const nudgeBox = h('div', { class: 'nudges' });
  const confirmBtn = h('button', { class: 'btn primary', disabled: true, onclick: confirm }, 'Confirm sync');
  const viewCard = h('div', { class: 'card', style: 'display:none' }, h('div', { class: 'cap' }, 'First 30 seconds. Top = Host, bottom = Constant. Peaks should line up.'), canvas, nudgeBox);

  const tick = () => new Promise((r) => setTimeout(r, 0));

  // live "it is working" indicator: step name + elapsed seconds
  const t0 = Date.now();
  let step = 'Starting';
  let hostPct = 0, constPct = 0;
  const refreshDetail = () => {
    const secs = Math.round((Date.now() - t0) / 1000);
    detail.textContent = `${step} - ${secs}s`;
  };
  timer = window.setInterval(refreshDetail, 500);

  async function run() {
    try {
      const native = isNative();
      if (native ? !(runtime.hostPath && runtime.constPath) : !(runtime.hostFile && runtime.constFile)) throw new Error('Videos are missing. Go back and pick them again.');

      if (!runtime.hostPcm || !runtime.constPcm) {
        status.textContent = 'Reading audio from both videos';
        step = 'Extracting audio';
        if (native) {
          listener = await EditorrNative.addListener('audioProgress', (e: { path?: string; percent: number }) => {
            if (e.path === runtime.hostPath) hostPct = e.percent;
            else if (e.path === runtime.constPath) constPct = e.percent;
            pb.set(5 + ((hostPct + constPct) / 200) * 65);
            step = `Extracting audio (Host ${hostPct}%, Constant ${constPct}%)`;
          });
          // both videos at the same time
          const [h1, c1] = await Promise.all([
            runtime.hostPcm ? null : EditorrNative.extractAudio({ path: runtime.hostPath! }),
            runtime.constPcm ? null : EditorrNative.extractAudio({ path: runtime.constPath! }),
          ]);
          if (cancelled) return;
          step = 'Loading audio';
          pb.set(72);
          const [hp, cp] = await Promise.all([h1 ? loadPcm(h1.pcmPath) : null, c1 ? loadPcm(c1.pcmPath) : null]);
          if (hp) runtime.hostPcm = hp;
          if (cp) runtime.constPcm = cp;
        } else {
          pb.set(10); await tick();
          if (!runtime.hostPcm) runtime.hostPcm = await decodeToMono16k(runtime.hostFile!);
          pb.set(40); await tick();
          if (!runtime.constPcm) runtime.constPcm = await decodeToMono16k(runtime.constFile!);
        }
      }
      if (cancelled) return;
      status.textContent = 'Finding sync offset';
      step = 'Matching the two audio tracks'; pb.set(80); await tick();
      const r = findOffset(runtime.hostPcm!, runtime.constPcm!);
      p.offsetMs = r.offsetMs; p.syncConfidence = r.confidence;
      const hostDur = runtime.hostPcm!.length / 16000, constDur = runtime.constPcm!.length / 16000;
      hostPeaks = peaks(runtime.hostPcm!, Math.ceil(hostDur * PEAKS_PER_SEC));
      constPeaks = peaks(runtime.constPcm!, Math.ceil(constDur * PEAKS_PER_SEC));
      pb.set(100);
      stopTimer();
      status.textContent = `Sync done in ${Math.round((Date.now() - t0) / 1000)}s`;
      detail.textContent = '';
      pb.el.style.display = 'none';
      showResult();
      viewCard.style.display = '';
      confirmBtn.disabled = false;
      draw();
    } catch (e) {
      stopTimer();
      status.className = 'err';
      status.textContent = 'Sync failed';
      detail.className = 'err';
      detail.textContent = `${(e as Error).message || 'Could not read audio.'} Try MP4 (H.264 + AAC) videos.`;
    }
  }

  function stopTimer() { clearInterval(timer); listener?.remove().catch(() => {}); listener = null; }

  function showResult() {
    result.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'cap' }, 'Offset (Constant vs Host)'), h('div', { class: 'title', id: 'off' }, fmtOffset(p.offsetMs))),
          h('span', { class: `badge ${p.syncConfidence}` }, `${p.syncConfidence} confidence`)),
        p.syncConfidence === 'Low'
          ? h('div', { class: 'warn' }, 'Low confidence. Use the nudge buttons until the peaks line up before continuing.')
          : null));
    nudgeBox.replaceChildren(
      ...[[-1000, '-1s'], [-100, '-100ms'], [-10, '-10ms'], [10, '+10ms'], [100, '+100ms'], [1000, '+1s']].map(([d, l]) =>
        h('button', { class: 'btn', onclick: () => { p.offsetMs += d as number; showResult(); draw(); } }, l as string)));
  }

  function draw() {
    if (!hostPeaks || !constPeaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hgt = 160;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    const g = canvas.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, hgt);
    const secs = 30;
    const drawTrack = (arr: Float32Array, shiftMs: number, color: string, mid: number) => {
      g.fillStyle = color;
      const step = w / (secs * PEAKS_PER_SEC);
      for (let i = 0; i < secs * PEAKS_PER_SEC; i++) {
        const idx = i + Math.round((shiftMs / 1000) * PEAKS_PER_SEC);
        const v = arr[idx] ?? 0;
        const bh = Math.max(1, v * 60);
        g.fillRect(i * step, mid - bh / 2, Math.max(1, step - 0.5), bh);
      }
    };
    drawTrack(hostPeaks, 0, '#FFFFFF', 55);
    drawTrack(constPeaks, p.offsetMs, '#22C55E', 115);
    g.strokeStyle = '#262626';
    g.beginPath(); g.moveTo(0, 85); g.lineTo(w, 85); g.stroke();
  }

  function confirm() {
    saveProject(p);
    toast('Sync saved');
    app.go('analyze');
  }

  run();
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => { cancelled = true; stopTimer(); app.go('import'); }), h('h1', {}, 'Sync')),
    h('div', { class: 'content' }, status, detail, pb.el, result, viewCard),
    h('div', { class: 'bottombar' }, confirmBtn));
  return { el, destroy: () => { cancelled = true; stopTimer(); } };
}
