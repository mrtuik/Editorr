import { app } from '../app';
import { saveSettings } from '../core/store';
import type { Sensitivity } from '../core/types';
import { h } from '../ui';

/** Label (+ hint) on top, chips below. Used in Settings and in the auto edit sheet. */
export function option<T extends string | number>(label: string, hint: string, opts: [T, string][], value: T, onPick: (v: T) => void) {
  const chips = h('div', { class: 'schips' });
  const render = (cur: T) => {
    chips.replaceChildren(...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => { onPick(v); render(v); } }, l)));
  };
  render(value);
  return h('div', { class: 'srow' }, h('div', { class: 'slabel' }, label), hint ? h('div', { class: 'sdesc' }, hint) : null, chips);
}

/**
 * Shown before the videos are synced and auto edited. What is picked here is used for this project
 * and stays selected as the default the next time.
 */
export function askAutoEdit(): Promise<boolean> {
  const s = app.settings;
  const save = () => { void saveSettings(s); };
  return new Promise((resolve) => {
    const done = (ok: boolean) => { box.remove(); resolve(ok); };
    const box = h('div', { class: 'dialog', onclick: (e: Event) => { if (e.target === box) done(false); } },
      h('div', { class: 'box autobox' },
        h('div', { class: 'title' }, 'Auto edit options'),
        h('div', { class: 'sdesc', style: 'margin:2px 0 10px' }, 'Used to sync and auto switch these videos. Your choice stays selected next time.'),
        h('div', { class: 'scard' },
          option<Sensitivity>('Speaker switch sensitivity', 'How easily the switch follows a new speaker.', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.sensitivity, (v) => { s.sensitivity = v; save(); }),
          option<number>('Minimum segment length', 'Shorter parts are merged into their neighbour.', [[500, '0.5 s'], [1000, '1.0 s'], [1500, '1.5 s'], [2000, '2.0 s'], [3000, '3.0 s']], s.minSegmentMs, (v) => { s.minSegmentMs = v; save(); }),
          option<'hold' | 'side' | 'updown' | 'popup'>('When both speakers talk', 'Layout style when both voices are active.', [['hold', 'Keep last speaker'], ['side', 'Side by side'], ['updown', 'Top / Bottom'], ['popup', 'Picture-in-picture']], s.bothSpeaking, (v) => { s.bothSpeaking = v; save(); })),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => done(true) }, 'Start'))));
    document.body.append(box);
  });
}
