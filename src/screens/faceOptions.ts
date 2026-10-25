import { app } from '../app';
import { saveSettings } from '../core/store';
import { Aspect, ASPECTS } from '../core/types';
import { h, icon } from '../ui';

type Opt<T> = [T, string];

export function chips<T extends string>(label: string, hint: string, opts: Opt<T>[], value: T, onPick: (v: T) => void): HTMLElement {
  const row = h('div', { class: 'schips' });
  const render = (cur: T) => {
    row.replaceChildren(...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => { onPick(v); render(v); } }, l)));
  };
  render(value);
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), h('div', { class: 'at-hint' }, hint), row);
}

/**
 * Bottom sheet for Faces: ratio, who to follow, glide or cut, glide speed, how close the face is.
 * Settings are saved as the default. Resolves with the picked ratio (or null when cancelled).
 */
export function askFaceOptions(aspect: Aspect): Promise<{ aspect: Aspect } | null> {
  const s = app.settings;
  const save = () => { void saveSettings(s); };
  let asp = aspect;
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      sheet.classList.add('out');
      setTimeout(() => { box.remove(); resolve(ok ? { aspect: asp } : null); }, 180);
    };
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    const value = h('b', {}, secs(s.faceSpeedMs ?? 600));
    const range = h('input', { type: 'range', min: '200', max: '1500', step: '100', value: String(s.faceSpeedMs ?? 600), class: 'at-range', 'aria-label': 'Glide time' }) as HTMLInputElement;
    range.addEventListener('input', () => { s.faceSpeedMs = Number(range.value); value.textContent = secs(s.faceSpeedMs); save(); });
    const speed = h('div', { class: 'at-sec' },
      h('div', { class: 'at-label-row' }, h('div', { class: 'at-label' }, 'Glide time'), value),
      h('div', { class: 'at-hint' }, 'Short = fast slide, long = slow and soft.'),
      range,
      h('div', { class: 'at-scale' }, h('span', {}, '0.2 s'), h('span', {}, '1.5 s')));
    const showSpeed = () => { speed.style.display = (s.faceMode ?? 'smooth') === 'smooth' ? '' : 'none'; };
    showSpeed();
    const ratios = (Object.keys(ASPECTS) as Aspect[]).map((a): Opt<Aspect> => [a, a]);
    const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
      h('div', { class: 'at-handle' }),
      h('div', { class: 'at-head' },
        h('button', { class: 'at-back', 'aria-label': 'Cancel', onclick: () => done(false) }, icon('back', 20)),
        h('div', { class: 'at-title' }, 'Faces'),
        h('span', { class: 'at-head-gap' })),
      h('div', { class: 'at-body' },
        chips<Aspect>('Ratio', 'Shape of the video. The face is centred for it.', ratios, asp, (v) => { asp = v; }),
        chips<'lips' | 'both' | 'audio'>('Autoframe cuts by', 'Which video shows: lips + audio together (best), lips only, or audio only like Auto switch.',
          [['both', 'Lips + audio'], ['lips', 'Lips only'], ['audio', 'Audio only']], s.autoframeBy ?? 'both', (v) => { s.autoframeBy = v; save(); }),
        chips<string>('Lead-in', 'The camera switches a little BEFORE the new person starts talking.',
          [['0', 'Off'], ['200', '0.2 s'], ['300', '0.3 s'], ['400', '0.4 s']], String(s.leadInMs ?? 300), (v) => { s.leadInMs = Number(v); save(); }),
        chips<string>('Ignore short replies', '"Hmm", "haan" or a laugh shorter than this does not switch the camera.',
          [['0', 'Off'], ['1000', '1.0 s'], ['1500', '1.5 s'], ['2000', '2.0 s']], String(s.ignoreShortMs ?? 1500), (v) => { s.ignoreShortMs = Number(v); save(); }),
        chips<'speaker' | 'picked'>('Who to follow', 'Speaker = the frame goes to whoever talks (also inside one camera). Picked = only the person you tap.',
          [['speaker', 'Active speaker'], ['picked', 'Picked person']], s.faceFollow ?? 'speaker', (v) => { s.faceFollow = v; save(); }),
        chips<'smooth' | 'cut'>('Move between people', 'Glide slides the frame smoothly. Cut jumps at once.',
          [['smooth', 'Smooth glide'], ['cut', 'Hard cut']], s.faceMode ?? 'smooth', (v) => { s.faceMode = v; save(); showSpeed(); }),
        speed,
        chips<'wide' | 'medium' | 'close'>('Face size', 'How close the face is framed.',
          [['wide', 'Wide'], ['medium', 'Medium'], ['close', 'Close']], s.faceTight ?? 'medium', (v) => { s.faceTight = v; save(); })),
      h('div', { class: 'at-foot' }, h('button', { class: 'btn primary at-go', onclick: () => done(true) }, icon('autoframe', 20), 'Apply')));
    const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) done(false); } }, sheet);
    document.body.append(box);
  });
}
