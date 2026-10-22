import { app } from '../app';
import { clearAllStorage, saveSettings } from '../core/store';
import type { Sensitivity } from '../core/types';
import { confirmDialog, h, iconButton, toast } from '../ui';

function seg<T extends string | number>(opts: [T, string][], value: T, onPick: (v: T) => void) {
  const wrap = h('div', { class: 'seg' });
  const render = (cur: T) => {
    wrap.replaceChildren(...opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onclick: () => { onPick(v); render(v); } }, l)));
  };
  render(value);
  return wrap;
}

export function settingsScreen() {
  const s = app.settings;
  const save = () => saveSettings(s);
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => app.go('home')), h('h1', {}, 'Settings')),
    h('div', { class: 'content' },
      h('div', { class: 'field' }, h('label', {}, 'Speaker detect sensitivity'),
        seg<Sensitivity>([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.sensitivity, (v) => { s.sensitivity = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'Minimum segment length'),
        seg<number>([[1000, '1.0 s'], [1500, '1.5 s'], [2500, '2.5 s'], [4000, '4 s']], s.minSegmentMs, (v) => { s.minSegmentMs = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'When both people talk'),
        seg<'hold' | 'side'>([['hold', 'Keep last speaker'], ['side', 'Side by side']], s.bothSpeaking, (v) => { s.bothSpeaking = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'Default export resolution'),
        seg<number>([[720, '720p'], [1080, '1080p']], s.resolution, (v) => { s.resolution = v as 720 | 1080; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'Storage'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Clear all projects?', 'Saved projects are removed. Your videos are not touched.', 'Clear')) { clearAllStorage(); toast('Cleared'); } } }, 'Clear saved projects')),
      h('div', { class: 'cap' }, 'Editorr by Tuik')));
  return { el };
}
