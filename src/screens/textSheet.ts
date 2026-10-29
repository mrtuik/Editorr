import { TEXT_LOOKS, type TextItem, type TextLook } from '../core/captions';
import type { Project } from '../core/types';
import { uid } from '../core/speaker';
import { h, icon, toast, fmtClock } from '../ui';
import { chips } from './faceOptions';

export interface TextCtx {
  p: Project;
  playMs: () => number;
  durationMs: () => number;
  /** Something changed: redraw the preview and save. */
  changed: () => void;
  seek: (ms: number) => void;
}

const LOOK_NAMES: Record<TextLook, string> = { classic: 'Classic', bold: 'Bold', box: 'Box', minimal: 'Minimal' };
const TABS = ['Templates', 'Fonts', 'Styles', 'Effects', 'Animations', 'Bubbles'] as const;
type Tab = typeof TABS[number];
const COLORS = ['#FFFFFF', '#B3B3B3', '#808080', '#3C3C3C', '#000000', '#F2C811', '#FF8A00', '#FF453A', '#30D158', '#0A84FF', '#BF5AF2'];

/** Text > Add text, laid out like CapCut: text field on top, tab row, then the controls of the open tab. */
export function openTextItemsSheet(ctx: TextCtx): void {
  const items = (): TextItem[] => (ctx.p.texts ??= []);
  let sel: string | null = null;
  let tab: Tab = 'Styles';
  const cur = () => items().find((t) => t.id === sel);

  const field = h('input', { type: 'text', class: 'ts-input', placeholder: 'Enter text', 'aria-label': 'Text' }) as HTMLInputElement;
  const tabsEl = h('div', { class: 'ts-tabs' });
  const body = h('div', { class: 'ts-body' });
  const close = () => { sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const done = () => {
    const text = field.value.trim();
    if (!cur()) {
      if (!text) { close(); return; }
      add(text);
    }
    close();
  };
  const sheet = h('div', { class: 'at-sheet ts', role: 'dialog' },
    h('div', { class: 'ts-top' },
      h('div', { class: 'ts-field' }, field, h('span', { class: 'ts-expand', 'aria-hidden': 'true' }, icon('expand', 20))),
      h('button', { class: 'ts-ok', 'aria-label': 'Done', onclick: done }, icon('check', 26))),
    h('div', { class: 'ts-grab' }),
    tabsEl, body);
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  field.addEventListener('input', () => {
    const it = cur();
    if (it) { it.text = field.value; ctx.changed(); return; }
    // first letters typed: the text appears at the playhead straight away, so you see it while you style it
    if (field.value.trim()) { add(field.value); }
  });
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });

  function add(text: string) {
    const dur = ctx.durationMs();
    const s = Math.max(0, Math.min(ctx.playMs(), Math.max(0, dur - 500)));
    const last = items()[items().length - 1];
    const it: TextItem = {
      id: uid(), text, s, e: Math.min(dur || s + 3000, s + 3000),
      look: last?.look ?? 'bold', size: last?.size ?? 0.07, y: last?.y ?? 0.5, color: last?.color ?? '#FFFFFF', opacity: last?.opacity,
    };
    items().push(it);
    sel = it.id;
    ctx.changed(); render(false);
  }

  /** A text must exist before it can be styled. */
  const need = (): TextItem | null => {
    const it = cur();
    if (!it) toast('Type a text first.');
    return it ?? null;
  };

  function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
    const out = h('b', {}, fmt(value));
    const r = h('input', { type: 'range', class: 'at-range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    r.addEventListener('input', () => { const v = Number(r.value); out.textContent = fmt(v); onInput(v); });
    return h('div', { class: 'ts-slide' }, h('span', { class: 'ts-slide-l' }, label), r, out);
  }

  function colorRow(it: TextItem | undefined): HTMLElement {
    const row = h('div', { class: 'ts-colors' });
    const set = (c: string) => { const t = need(); if (!t) return; t.color = c; ctx.changed(); paint(); };
    const picker = (cls: string, ic: Node | string) => {
      const inp = h('input', { type: 'color', class: 'ts-colorpick', value: it?.color ?? '#FFFFFF' }) as HTMLInputElement;
      inp.addEventListener('input', () => set(inp.value.toUpperCase()));
      return h('label', { class: 'ts-circle ' + cls }, ic, inp);
    };
    const paint = () => {
      const c = (cur()?.color ?? '#FFFFFF').toLowerCase();
      row.replaceChildren(
        picker('tool', icon('eyedrop', 20)),
        picker('wheel', ''),
        h('span', { class: 'ts-sep' }),
        ...COLORS.map((x) => h('button', { class: 'ts-circle' + (x.toLowerCase() === c ? ' on' : ''), style: `background:${x}`, 'aria-label': x, onclick: () => set(x) })));
    };
    paint();
    return row;
  }

  function renderStyles(): Node[] {
    const it = cur();
    const tiles = h('div', { class: 'ts-looks' },
      h('button', { class: 'ts-look none', 'aria-label': 'No style', onclick: () => { const t = need(); if (!t) return; t.look = 'minimal'; ctx.changed(); render(); } }, icon('nostyle', 26)),
      ...TEXT_LOOKS.map((l) => h('button', { class: `ts-look l-${l}` + (it?.look === l ? ' on' : ''), 'aria-label': LOOK_NAMES[l], onclick: () => { const t = need(); if (!t) return; t.look = l; ctx.changed(); render(); } }, 'Aa')));
    return [
      tiles,
      h('div', { class: 'ts-subtabs' }, h('span', { class: 'on' }, 'Text'), h('span', {}, 'Brand colors'), h('span', {}, 'Stroke'), h('span', {}, 'Glow'), h('span', {}, 'Background'), h('span', {}, 'Shadow')),
      colorRow(it),
      slider('Size', 0.03, 0.16, 0.005, it?.size ?? 0.07, (v) => String(Math.round(v * 1000)), (v) => { const t = need(); if (!t) return; t.size = v; ctx.changed(); }),
      slider('Opacity', 0.1, 1, 0.05, it?.opacity ?? 1, (v) => `${Math.round(v * 100)}%`, (v) => { const t = need(); if (!t) return; t.opacity = v >= 1 ? undefined : v; ctx.changed(); }),
    ];
  }

  function renderTemplates(): Node[] {
    const it = cur();
    const list = items().slice().sort((a, b) => a.s - b.s);
    const out: Node[] = [];
    if (list.length) {
      out.push(h('div', { class: 'ts-list' }, ...list.map((x) => h('div', { class: 'ts-item' + (x.id === sel ? ' on' : '') },
        h('button', { class: 'ts-item-main', onclick: () => { sel = x.id; field.value = x.text; ctx.seek(x.s); render(); } },
          h('span', { class: 'ts-item-t' }, fmtClock(x.s)), h('span', { class: 'ts-item-x' }, x.text || '(empty)')),
        h('button', { class: 'ts-item-del', 'aria-label': 'Remove', onclick: () => { ctx.p.texts = items().filter((y) => y.id !== x.id); if (sel === x.id) { sel = null; field.value = ''; } ctx.changed(); render(); } }, icon('trash', 18))))));
    }
    out.push(
      chips<string>('Place', '', [['0.15', 'Top'], ['0.5', 'Middle'], ['0.82', 'Bottom']], String(it?.y ?? 0.5), (v) => { const t = need(); if (t) { t.y = Number(v); ctx.changed(); } }),
      chips<string>('Shows for', it ? `Starts at ${fmtClock(it.s)}.` : 'The text shows from the playhead.', [['1500', '1.5 s'], ['3000', '3 s'], ['5000', '5 s'], ['8000', '8 s']], String(it ? it.e - it.s : 3000), (v) => {
        const t = need(); if (!t) return; t.e = Math.min(ctx.durationMs() || t.s + Number(v), t.s + Number(v)); ctx.changed();
      }));
    return out;
  }

  function renderSoon(): Node[] {
    return [h('div', { class: 'ts-soon' }, `${tab} are coming next. Styles and Templates work now.`)];
  }

  function render(retab = true) {
    if (retab) tabsEl.replaceChildren(...TABS.map((t) => h('button', { class: 'ts-tab' + (t === tab ? ' on' : ''), onclick: () => { tab = t; render(); } }, t)));
    body.replaceChildren(...(tab === 'Styles' ? renderStyles() : tab === 'Templates' ? renderTemplates() : renderSoon()));
  }
  render();
  setTimeout(() => field.focus(), 250);
}
