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

  const status = h('div', { class: 'sec' }, 'Reading audio...');
  const pb = progressBar();
  const result = h('div');
  const canvas = h('canvas', { height: 160, style: 'height:160px' }) as HTMLCanvasElement;
  const nudgeBox = h('div', { class: 'nudges' });
  const confirmBtn = h('button', { class: 'btn primary', disabled: true, onclick: confirm }, 'Confirm sync');
  const viewCard = h('div', { class: 'card', style: 'display:none' }, h('div', { class: 'cap' }, 'First 30 seconds. Blue = Host, green = Constant. Peaks should line up.'), canvas, nudgeBox);

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function run() {
    try {
      const native = isNative();
      if (native ? !(runtime.hostPath && runtime.constPath) : !(runtime.hostFile && runtime.constFile)) throw new Error('Videos are missing. Go back and pick them again.');
      const getPcm = async (role: 'host' | 'constant') => {
        if (native) {
          const r = await EditorrNative.extractAudio({ path: (role === 'host' ? runtime.hostPath : runtime.constPath)! });
          return loadPcm(r.pcmPath);
        }
        return decodeToMono16k((role === 'host' ? runtime.hostFile : runtime.constFile)!);
      };
      if (!runtime.hostPcm) { status.textContent = 'Reading Host audio...'; pb.set(10); await tick(); runtime.hostPcm = await getPcm('host'); }
      if (cancelled) return;
      if (!runtime.constPcm) { status.textContent = 'Reading Constant audio...'; pb.set(40); await tick(); runtime.constPcm = await getPcm('constant'); }
      if (cancelled) return;
      status.textContent = 'Finding sync offset...'; pb.set(70); await tick();
      const r = findOffset(runtime.hostPcm, runtime.constPcm);
      p.offsetMs = r.offsetMs; p.syncConfidence = r.confidence;
      const hostDur = runtime.hostPcm.length / 16000, constDur = runtime.constPcm.length / 16000;
      hostPeaks = peaks(runtime.hostPcm, Math.ceil(hostDur * PEAKS_PER_SEC));
      constPeaks = peaks(runtime.constPcm, Math.ceil(constDur * PEAKS_PER_SEC));
      pb.set(100);
      status.textContent = 'Sync done';
      pb.el.style.display = 'none';
      showResult();
      viewCard.style.display = '';
      confirmBtn.disabled = false;
      draw();
    } catch (e) {
      status.className = 'err';
      status.textContent = `${(e as Error).message || 'Could not decode audio.'} Try MP4 (H.264 + AAC) videos.`;
    }
  }

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
    g.globalAlpha = 0.9;
    drawTrack(hostPeaks, 0, '#3B82F6', 55);
    drawTrack(constPeaks, p.offsetMs, '#22C55E', 115);
    g.globalAlpha = 0.35;
    // overlay line connecting visual alignment
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
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => { cancelled = true; app.go('import'); }), h('h1', {}, 'Sync')),
    h('div', { class: 'content' }, status, pb.el, result, viewCard),
    h('div', { class: 'bottombar' }, confirmBtn));
  return { el, destroy: () => { cancelled = true; } };
}
