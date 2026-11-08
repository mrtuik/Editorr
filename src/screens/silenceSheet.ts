import type { Range } from '../core/timeline';
import { app } from '../app';
import { h, icon, slider } from '../ui';

export interface SilenceItem { r: Range; orig: Range; on: boolean }

const clock = (ms: number) => { const t = Math.max(0, ms) / 1000, m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/**
 * Review of the silences Detect found, as a bottom sheet that leaves the preview and timeline visible.
 * Each silence can be played (with a little speech before and after), switched off, or made shorter / longer
 * with Start and End sliders. Everything is written straight into `items`; `onChange` redraws the red marks.
 */
export function openSilenceSheet(o: {
  items: SilenceItem[]; durationMs: number;
  onChange: () => void; seek: (ms: number) => void; playRange: (a: number, b: number) => void; stop: () => void; onClose: () => void;
}): void {
  const { items } = o;
  let open = -1;
  const list = h('div', { class: 'ss-list' });
  const sum = h('div', { class: 'at-hint ss-sum' }, '');

  const total = () => items.filter((i) => i.on).reduce((a, i) => a + (i.r.endMs - i.r.startMs), 0);
  const paintSum = () => {
    const n = items.filter((i) => i.on).length;
    sum.textContent = `${n} of ${items.length} will be cut · ${secs(total())} removed`;
  };

  function row(it: SilenceItem, n: number): HTMLElement {
    const dur = h('span', { class: 'ss-d' }, secs(it.r.endMs - it.r.startMs));
    const when = h('span', { class: 'ss-t' }, `${clock(it.r.startMs)} – ${clock(it.r.endMs)}`);
    const upd = () => { dur.textContent = secs(it.r.endMs - it.r.startMs); when.textContent = `${clock(it.r.startMs)} – ${clock(it.r.endMs)}`; paintSum(); o.onChange(); };
    const chk = h('button', {
      class: 'ss-chk' + (it.on ? ' on' : ''), role: 'checkbox', 'aria-checked': String(it.on), 'aria-label': `Cut silence ${n + 1}`,
      onclick: () => { it.on = !it.on; o.onChange(); render(); },
    }, it.on ? icon('check', 14) : '');
    const main = h('button', {
      class: 'ss-main', onclick: () => { open = open === n ? -1 : n; o.stop(); o.seek(it.r.startMs); render(); },
    }, h('b', {}, `#${n + 1}`), when, dur);
    const play = h('button', {
      class: 'ss-play', 'aria-label': 'Play this silence with a little speech around it',
      onclick: () => o.playRange(Math.max(0, it.r.startMs - 700), Math.min(o.durationMs, it.r.endMs + 700)),
    }, icon('play', 18));
    const kids: Node[] = [h('div', { class: 'ss-top' }, chk, main, play)];
    if (open === n) {
      const prev = items[n - 1]?.r.endMs ?? 0, next = items[n + 1]?.r.startMs ?? o.durationMs;
      const sMin = Math.max(prev, it.orig.startMs - 800), sMax = it.orig.endMs - 100;
      const eMin = it.orig.startMs + 100, eMax = Math.min(next, it.orig.endMs + 800);
      kids.push(h('div', { class: 'ss-adj' },
        slider('Start', sMin, Math.max(sMin + 50, sMax), 50, it.r.startMs, (v) => `${(v / 1000).toFixed(2)} s`, (v) => {
          it.r.startMs = Math.min(v, it.r.endMs - 100); o.stop(); o.seek(it.r.startMs); upd();
        }),
        slider('End', eMin, Math.max(eMin + 50, eMax), 50, it.r.endMs, (v) => `${(v / 1000).toFixed(2)} s`, (v) => {
          it.r.endMs = Math.max(v, it.r.startMs + 100); o.stop(); o.seek(it.r.endMs); upd();
        }),
        h('div', { class: 'at-hint' }, 'Move Start later or End earlier to keep more of the pause. Move them the other way to cut more.'),
        h('button', { class: 'btn', style: 'min-height:44px;width:100%', onclick: () => { it.r.startMs = it.orig.startMs; it.r.endMs = it.orig.endMs; o.onChange(); render(); } }, 'Reset this one')));
    }
    return h('div', { class: 'ss-item' + (it.on ? '' : ' off') + (open === n ? ' open' : '') }, ...kids);
  }

  function render() {
    list.replaceChildren(...(items.length ? items.map(row) : [h('div', { class: 'at-hint' }, 'No silence found.')]));
    paintSum();
  }

  const setAll = (on: boolean) => { items.forEach((i) => { i.on = on; }); o.onChange(); render(); };
  const prevBack = app.onBack;
  const close = () => { o.stop(); app.onBack = prevBack; sheet.classList.add('out'); setTimeout(() => box.remove(), 150); o.onClose(); };
  app.onBack = () => { close(); return true; };

  const sheet = h('div', { class: 'at-sheet ss', role: 'dialog', 'aria-label': 'Review silences' },
    h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Close', onclick: close }, icon('back', 20)), h('div', { class: 'at-title' }, 'Review silences'), h('span', { class: 'at-head-gap' })),
    h('div', { class: 'at-body' },
      sum,
      h('div', { class: 'ss-bar' },
        h('button', { class: 'btn', onclick: () => setAll(true) }, 'Select all'),
        h('button', { class: 'btn', onclick: () => setAll(false) }, 'Select none')),
      list),
    h('div', { class: 'at-foot' }, h('button', { class: 'btn primary at-go', onclick: close }, icon('check', 20), 'Done')));
  const box = h('div', { class: 'at-scrim clear' }, sheet);
  document.body.append(box);
  render();
}
