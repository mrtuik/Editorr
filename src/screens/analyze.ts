import { app } from '../app';
import { detectSpeakers } from '../core/speaker';
import { runtime, saveProject } from '../core/store';
import { h, progressBar } from '../ui';

export function analyzeScreen() {
  const p = app.project;
  let cancelled = false;
  const status = h('div', { class: 'title' }, 'Detecting who is speaking');
  const eta = h('div', { class: 'cap' }, 'Working...');
  const pb = progressBar();
  const t0 = Date.now();
  const timer = window.setInterval(() => { eta.textContent = `Working - ${Math.round((Date.now() - t0) / 1000)}s`; }, 500);

  async function run() {
    try {
      if (!runtime.hostPcm || !runtime.constPcm || !p.host || !p.constant) throw new Error('Audio is missing. Go back to Sync.');
      pb.set(30);
      // let the screen paint once, then compute
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      p.durationMs = Math.max(1000, Math.min(p.host.durationMs, p.constant.durationMs - p.offsetMs));
      if (cancelled) return;
      p.segments = detectSpeakers(runtime.hostPcm, runtime.constPcm, p.offsetMs, p.durationMs, app.settings);
      pb.set(100);
      clearInterval(timer);
      saveProject(p);
      if (!cancelled) app.go('editor');
    } catch (e) {
      clearInterval(timer);
      status.className = 'err';
      status.textContent = (e as Error).message;
    }
  }
  run();

  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' }, h('h1', {}, 'Analyzing')),
    h('div', { class: 'content' }, status, pb.el, eta,
      h('div', { class: 'cap', style: 'margin-top:16px' }, 'If two people sit close, one mic can pick up the other voice. You can fix any segment in the editor.')),
    h('div', { class: 'bottombar' },
      h('button', { class: 'btn', style: 'flex:1', onclick: () => { cancelled = true; clearInterval(timer); app.go('sync'); } }, 'Cancel')));
  return { el, destroy: () => { cancelled = true; clearInterval(timer); } };
}
