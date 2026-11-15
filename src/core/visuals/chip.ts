/** Progress bar docked between the play row and the timeline: "Visual 3 of 11", a thin progress line, Pause, Stop. Full width, not a dialog: the editor stays usable. */
import type { RunCtrl } from './runner';

const CSS = `.vis-chip{position:fixed;left:0;right:0;bottom:200px;height:40px;z-index:9999;display:flex;align-items:center;gap:6px;padding:0 6px 0 14px;background:#141414;color:#f2f2f2;font:500 13px Roboto,sans-serif;border-top:1px solid #2a2a2a;border-bottom:1px solid #2a2a2a;box-sizing:border-box}
.vis-chip .vc-bar{position:absolute;left:0;top:-1px;height:2px;width:0;background:#10B981;transition:width .35s ease}
.vis-chip .vc-lab{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.vis-chip .vc-lab b{font-weight:700}.vis-chip .vc-lab span{color:#8d8d92;margin-left:8px}
.vis-chip button{border:0;background:transparent;color:#d8d8dc;font:600 13px Roboto,sans-serif;min-height:40px;padding:0 14px;cursor:pointer}
.vis-chip button.stop{color:#ff5a5f}
.vis-chip button:active{background:rgba(255,255,255,.08)}`;

export function showChip(ctrl: RunCtrl): { update: (n: number, total: number) => void; text: (s: string) => void; dispose: () => void } {
  if (!document.getElementById('vis-chip-css')) { const st = document.createElement('style'); st.id = 'vis-chip-css'; st.textContent = CSS; document.head.append(st); }
  const bar = document.createElement('div'); bar.className = 'vc-bar';
  const label = document.createElement('div'); label.className = 'vc-lab'; label.textContent = 'Planning visuals...';
  const pause = document.createElement('button'); pause.textContent = 'Pause';
  const stop = document.createElement('button'); stop.textContent = 'Stop'; stop.className = 'stop';
  pause.onclick = () => { ctrl.paused = !ctrl.paused; pause.textContent = ctrl.paused ? 'Resume' : 'Pause'; };
  stop.onclick = () => { ctrl.stopped = true; ctrl.paused = false; label.textContent = 'Stopping...'; };
  const el = document.createElement('div'); el.className = 'vis-chip'; el.setAttribute('role', 'status');
  el.append(bar, label, pause, stop); document.body.append(el);
  // dock right under the play row (between it and the timeline), never over the picture
  const place = () => { const pb = document.querySelector('.playbtn') as HTMLElement | null; if (!pb) return; const r = pb.getBoundingClientRect(); if (r.height) el.style.bottom = `${Math.max(0, Math.round(window.innerHeight - r.bottom - 44))}px`; };
  place(); const iv = window.setInterval(place, 400); window.addEventListener('resize', place);
  return {
    update: (n, t) => {
      if (ctrl.stopped) return;
      label.replaceChildren();
      const b = document.createElement('b'); b.textContent = `Visual ${n} of ${t}`;
      const sp = document.createElement('span'); sp.textContent = `${Math.round((n / Math.max(1, t)) * 100)}%`;
      label.append(b, sp); bar.style.width = `${(n / Math.max(1, t)) * 100}%`;
    },
    text: s => { label.textContent = s; },
    dispose: () => { window.clearInterval(iv); window.removeEventListener('resize', place); el.remove(); },
  };
}
