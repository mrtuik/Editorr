import { app } from '../app';
import { saveSettings } from '../core/store';
import type { Sensitivity } from '../core/types';
import { h, icon } from '../ui';

/** Label (+ hint) on top, chips below. Used in Settings and in the auto edit sheet. */
export function option<T extends string | number>(label: string, hint: string, opts: [T, string][], value: T, onPick: (v: T) => void) {
  const chips = h('div', { class: 'schips' });
  const render = (cur: T) => {
    chips.replaceChildren(...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => { onPick(v); render(v); } }, l)));
  };
  render(value);
  return h('div', { class: 'srow' }, h('div', { class: 'slabel' }, label), hint ? h('div', { class: 'sdesc' }, hint) : null, chips);
}

type Ic = Parameters<typeof icon>[0];

/** Row of icon tiles (icon on top, short name below). */
function tiles<T extends string>(label: string, hint: string, opts: [T, string, Ic][], value: T, onPick: (v: T) => void) {
  const row = h('div', { class: 'at-tiles' });
  const render = (cur: T) => {
    row.replaceChildren(...opts.map(([v, l, ic]) => h('button', { class: 'at-tile' + (v === cur ? ' on' : ''), 'aria-label': l, onclick: () => { onPick(v); render(v); } }, icon(ic, 26), h('span', {}, l))));
  };
  render(value);
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), h('div', { class: 'at-hint' }, hint), row);
}

/**
 * Bottom sheet shown before the videos are synced and auto edited. What is picked here is used for this project
 * and stays selected as the default the next time.
 */
export function askAutoEdit(): Promise<boolean> {
  const s = app.settings;
  const save = () => { void saveSettings(s); };
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      sheet.classList.add('out');
      setTimeout(() => { box.remove(); resolve(ok); }, 180);
    };
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    const value = h('b', {}, secs(s.minSegmentMs));
    const range = h('input', { type: 'range', min: '500', max: '3000', step: '500', value: String(s.minSegmentMs), class: 'at-range', 'aria-label': 'Minimum segment length' }) as HTMLInputElement;
    range.addEventListener('input', () => { s.minSegmentMs = Number(range.value); value.textContent = secs(s.minSegmentMs); save(); });
    const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
      h('div', { class: 'at-handle' }),
      h('div', { class: 'at-head' },
        h('button', { class: 'at-back', 'aria-label': 'Cancel', onclick: () => done(false) }, icon('back', 20)),
        h('div', { class: 'at-title' }, 'Auto edit options'),
        h('span', { class: 'at-head-gap' })),
      h('div', { class: 'at-body' },
        tiles<Sensitivity>('Speaker switch sensitivity', 'How easily the switch follows a new speaker.',
          [['low', 'Low', 'sensLow'], ['medium', 'Medium', 'sensMed'], ['high', 'High', 'sensHigh']], s.sensitivity, (v) => { s.sensitivity = v; save(); }),
        h('div', { class: 'at-sec' },
          h('div', { class: 'at-label-row' }, h('div', { class: 'at-label' }, 'Minimum segment length'), value),
          h('div', { class: 'at-hint' }, 'Shorter parts are merged into their neighbour.'),
          range,
          h('div', { class: 'at-scale' }, h('span', {}, '0.5 s'), h('span', {}, '3.0 s'))),
        tiles<'hold' | 'side' | 'updown' | 'popup'>('When both speakers talk', 'Layout style when both voices are active.',
          [['hold', 'Keep last', 'one'], ['side', 'Side', 'side'], ['updown', 'Top / Bottom', 'updown'], ['popup', 'Popup', 'popup']], s.bothSpeaking, (v) => { s.bothSpeaking = v; save(); })),
      h('div', { class: 'at-foot' }, h('button', { class: 'btn primary at-go', onclick: () => done(true) }, icon('switchSlider', 20), 'Start')));
    const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) done(false); } }, sheet);
    document.body.append(box);
  });
}
