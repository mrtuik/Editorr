import type { Segment } from '../core/types';
import { h, icon, fmtClock } from '../ui';
import { chips } from './faceOptions';
import type { Settings } from '../core/types';
import { saveSettings } from '../core/store';

export interface ReactionCtx {
  settings: Settings;
  segments: () => Segment[];
  durationMs: () => number;
  /** Adds reactions with the current settings; returns how many exist now. */
  add: () => number;
  remove: (id: string) => void;
  removeAll: () => void;
  seek: (ms: number) => void;
}

/** Reaction tool: where cutaways are, with a small timeline on the right. */
export function openReactionSheet(ctx: ReactionCtx): void {
  const s = ctx.settings;
  const save = () => { void saveSettings(s); };
  const list = h('div', { class: 'rx-list' });
  const strip = h('div', { class: 'rx-strip' });
  const count = h('div', { class: 'at-hint' }, '');
  const close = () => { sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const render = () => {
    const rx = ctx.segments().filter((x) => x.reaction);
    const dur = Math.max(1, ctx.durationMs());
    count.textContent = rx.length ? `${rx.length} reaction${rx.length > 1 ? 's' : ''} added. Tap one to jump there.` : 'No reactions yet. Tap "Add reactions".';
    list.replaceChildren(...rx.map((r) => h('div', { class: 'rx-row' },
      h('button', { class: 'rx-go', onclick: () => ctx.seek(r.startMs) },
        h('b', {}, `${fmtClock(r.startMs)} – ${fmtClock(r.endMs)}`), h('span', {}, `shows ${r.main === 'host' ? 'Host' : 'Constant'}`)),
      h('button', { class: 'rx-del', 'aria-label': 'Remove', onclick: () => { ctx.remove(r.id); render(); } }, icon('trash', 18)))));
    strip.replaceChildren(h('div', { class: 'rx-line' }), ...rx.map((r) => h('button', {
      class: 'rx-dot', 'aria-label': `Reaction at ${fmtClock(r.startMs)}`,
      style: `top:${(r.startMs / dur) * 100}%;height:${Math.max(3, ((r.endMs - r.startMs) / dur) * 100)}%`,
      onclick: () => ctx.seek(r.startMs),
    })), h('span', { class: 'rx-t top' }, '0:00'), h('span', { class: 'rx-t bot' }, fmtClock(dur)));
  };
  const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
    h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Close', onclick: close }, icon('back', 20)), h('div', { class: 'at-title' }, 'Reactions'), h('span', { class: 'at-head-gap' })),
    h('div', { class: 'at-body' },
      h('div', { class: 'at-hint' }, 'While one person talks for a long time, the video shows the listener for a moment, at a short pause. The sound is not changed.'),
      chips<string>('After talking for', '', [['5000', '5 s'], ['8000', '8 s'], ['12000', '12 s']], String(s.reactAfterMs ?? 8000), (v) => { s.reactAfterMs = Number(v); save(); }),
      chips<string>('Show listener for', '', [['1000', '1 s'], ['1500', '1.5 s'], ['2000', '2 s']], String(s.reactLengthMs ?? 1500), (v) => { s.reactLengthMs = Number(v); save(); }),
      count,
      h('div', { class: 'rx-wrap' }, list, strip)),
    h('div', { class: 'at-foot rx-foot' },
      h('button', { class: 'btn at-go', onclick: () => { ctx.removeAll(); render(); } }, icon('trash', 20), 'Clear'),
      h('button', { class: 'btn primary at-go', onclick: () => { ctx.add(); render(); } }, icon('wand', 20), 'Add reactions')));
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);
  render();
}
