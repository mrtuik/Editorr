import { app } from '../app';
import { detectSpeakers } from '../core/speaker';
import { runtime, saveProject } from '../core/store';
import { h, progressBar } from '../ui';

export function analyzeScreen() {
  const p = app.project;
  let cancelled = false;
  const status = h('div', { class: 'title' }, 'Detecting who is speaking...');
  const eta = h('div', { class: 'cap' }, 'Usually under a minute');
  const pb = progressBar();

  async function run() {
    try {
      if (!runtime.hostPcm || !runtime.constPcm || !p.host || !p.constant) throw new Error('Audio is missing. Go back to Sync.');
      pb.set(15);
      await new Promise((r) => setTimeout(r, 30));
      const hostDur = p.host.durationMs, constDur = p.constant.durationMs;
      // Timeline time = Host time; stop where the Constant video ends.
      p.durationMs = Math.max(1000, Math.min(hostDur, constDur - p.offsetMs));
      pb.set(40);
      await new Promise((r) => setTimeout(r, 30));
      if (cancelled) return;
      p.segments = detectSpeakers(runtime.hostPcm, runtime.constPcm, p.offsetMs, p.durationMs, app.settings);
      pb.set(100);
      status.textContent = `Done: ${p.segments.length} segments`;
      saveProject(p);
      setTimeout(() => { if (!cancelled) app.go('editor'); }, 400);
    } catch (e) {
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
      h('button', { class: 'btn', style: 'flex:1', onclick: () => { cancelled = true; app.go('sync'); } }, 'Cancel')));
  return { el, destroy: () => { cancelled = true; } };
}
