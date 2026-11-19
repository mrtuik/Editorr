import { BgEngine, BgFill } from '../core/bgremove';
import { samDownloaded } from '../core/bgremove/sam';
import { rvmDownloaded } from '../core/bgremove/rvm';
import { Role } from '../core/types';
import { h, icon } from '../ui';
import { chips } from './faceOptions';

export interface BgAsk { engine: BgEngine; role: Role; perSec: number; fill: BgFill; color: string }
export type BgAnswer = (BgAsk & { restore?: false }) | { restore: true; role: Role } | null;

/**
 * Bottom sheet for Remove BG: engine (SAM 2 now, RVM next), which video, quality and what goes behind the person.
 * `current` is set when the video already has its background removed (a Restore button appears).
 */
export function askRemoveBg(role: Role, current: { hostOn: boolean; constOn: boolean }, last: { perSec: number; fill: BgFill; color: string }): Promise<BgAnswer> {
  let engine: BgEngine = 'sam', r = role, perSec = last.perSec, fill = last.fill, color = last.color;
  return new Promise((resolve) => {
    const done = (v: BgAnswer) => { sheet.classList.add('out'); setTimeout(() => { box.remove(); resolve(v); }, 180); };
    const dl = h('span', { class: 'bg-sub' }, 'Checking model...');
    void samDownloaded().then((ok) => { dl.textContent = ok ? 'Model is on this phone. Heavy: strong phone, battery above 25%' : 'Heavy. Downloads about 150 MB. Strong phone, battery above 25%'; });
    const card = (id: BgEngine, title: string, sub: string | HTMLElement, disabled: boolean) => {
      const b = h('button', { class: 'bg-eng' + (engine === id ? ' sel' : '') + (disabled ? ' off' : ''), disabled, onclick: () => {
        if (disabled) return; engine = id; engCards.forEach((c, k) => c.classList.toggle('sel', k === (id === 'sam' ? 0 : 1))); fillQuality();
      } }, h('b', {}, title), typeof sub === 'string' ? h('span', { class: 'bg-sub' }, sub) : sub);
      return b;
    };
    const dl2 = h('span', { class: 'bg-sub' }, 'Checking model...');
    void rvmDownloaded().then((ok) => { dl2.textContent = ok ? 'Fast, made for video, small model' : 'Fast, made for video. Small download (15 MB)'; });
    const engCards = [
      card('sam', 'SAM 2', dl, false),
      card('rvm', 'RVM', dl2, false),
    ];
    const QUAL: Record<BgEngine, [string, string][]> = {
      sam: [['1', 'Fast'], ['2', 'Balanced'], ['4', 'Best']],
      rvm: [['5', 'Fast'], ['10', 'Balanced'], ['15', 'Best']],
    };
    const qualityBox = h('div', {});
    const fillQuality = () => {
      if (!QUAL[engine].some(([v]) => v === String(perSec))) perSec = Number(QUAL[engine][1][0]);
      qualityBox.replaceChildren(chips<string>('Quality', 'How many cut-outs are made per second of video. More = cleaner when people move, but slower. In between, the app blends them.',
        QUAL[engine], String(perSec), (v) => { perSec = Number(v); }));
    };
    const which = chips<Role>('Video', 'Which video gets the new background.', [['host', 'Host'], ['constant', 'Constant']], r, (v) => { r = v; syncRestore(); });
    const restore = h('button', { class: 'btn at-restore', onclick: () => done({ restore: true, role: r }) }, 'Restore original');
    const syncRestore = () => { restore.style.display = (r === 'host' ? current.hostOn : current.constOn) ? '' : 'none'; };
    syncRestore();
    fillQuality();
    const colorIn = h('input', { type: 'color', value: color, class: 'bg-color', 'aria-label': 'Background colour' }) as HTMLInputElement;
    colorIn.addEventListener('input', () => { color = colorIn.value; fill = 'color'; });
    const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
      h('div', { class: 'at-handle' }),
      h('div', { class: 'at-head' },
        h('button', { class: 'at-back', 'aria-label': 'Cancel', onclick: () => done(null) }, icon('back', 20)),
        h('div', { class: 'at-title' }, 'Remove BG'),
        h('span', { class: 'at-head-gap' })),
      h('div', { class: 'at-body' },
        h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Engine'), h('div', { class: 'bg-engs' }, ...engCards)),
        which,
        qualityBox,
        chips<BgFill>('Behind the person', 'Blur keeps the room but soft. Or pick a flat colour.',
          [['blur', 'Blur'], ['black', 'Black'], ['white', 'White'], ['green', 'Green'], ['color', 'Custom']], fill, (v) => { fill = v; if (v === 'color') colorIn.click(); }),
        h('div', { class: 'at-hint' }, 'RVM = made for video, steadier edges, finds people by itself, light. Try RVM first. SAM 2 = sharper on one person but heavy: it can overheat or switch off a weak or low-battery phone.'),
        h('div', { class: 'at-sec' }, restore, colorIn)),
      h('div', { class: 'at-foot' }, h('button', { class: 'btn primary at-go', onclick: () => done({ engine, role: r, perSec, fill, color }) }, icon('removeBg', 20), 'Remove background')));
    const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) done(null); } }, sheet);
    document.body.append(box);
  });
}
