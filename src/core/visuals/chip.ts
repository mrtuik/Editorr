/** Small progress chip over the editor: "Visual 3/11", Pause, Stop. Not a dialog: the editor stays usable. */
import type { RunCtrl } from './runner';

const CSS = `.vis-chip{position:fixed;left:50%;transform:translateX(-50%);bottom:260px;z-index:9999;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 14px;border-radius:999px;background:rgba(24,24,28,.94);color:#fff;font:600 13px Roboto,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.14)}
.vis-chip button{border:0;border-radius:999px;padding:7px 12px;font:600 12px Roboto,sans-serif;background:rgba(255,255,255,.14);color:#fff;cursor:pointer}
.vis-chip button.stop{background:#e5192b}
.vis-chip i{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;animation:vspin .8s linear infinite}
@keyframes vspin{to{transform:rotate(360deg)}}`;

export function showChip(ctrl: RunCtrl): { update: (n: number, total: number) => void; text: (s: string) => void; dispose: () => void } {
  if (!document.getElementById('vis-chip-css')) { const st = document.createElement('style'); st.id = 'vis-chip-css'; st.textContent = CSS; document.head.append(st); }
  const label = document.createElement('span'); label.textContent = 'Planning visuals...';
  const spin = document.createElement('i');
  const pause = document.createElement('button'); pause.textContent = 'Pause';
  const stop = document.createElement('button'); stop.textContent = 'Stop'; stop.className = 'stop';
  pause.onclick = () => { ctrl.paused = !ctrl.paused; pause.textContent = ctrl.paused ? 'Resume' : 'Pause'; spin.style.animationPlayState = ctrl.paused ? 'paused' : 'running'; };
  stop.onclick = () => { ctrl.stopped = true; ctrl.paused = false; label.textContent = 'Stopping...'; };
  const el = document.createElement('div'); el.className = 'vis-chip'; el.setAttribute('role', 'status');
  el.append(spin, label, pause, stop); document.body.append(el);
  // sit right above the play button, never over the picture
  const place = () => { const pb = document.querySelector('.playbtn') as HTMLElement | null; if (!pb) return; const r = pb.getBoundingClientRect(); if (r.height) el.style.bottom = `${Math.max(8, Math.round(window.innerHeight - r.top + 8))}px`; };
  place(); const iv = window.setInterval(place, 400); window.addEventListener('resize', place);
  return { update: (n, t) => { if (!ctrl.stopped) label.textContent = `Visual ${n}/${t}`; }, text: s => { label.textContent = s; }, dispose: () => { window.clearInterval(iv); window.removeEventListener('resize', place); el.remove(); } };
}
