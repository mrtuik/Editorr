import { TEXT_LOOKS, type TextItem, type TextLook } from '../core/captions';
import type { Project } from '../core/types';
import { uid } from '../core/speaker';
import { h, icon, toast, fmtClock } from '../ui';
import { chips } from './faceOptions';
import { swatches } from './captionSheet';

export interface TextCtx {
  p: Project;
  playMs: () => number;
  durationMs: () => number;
  /** Something changed: redraw the preview and save. */
  changed: () => void;
  seek: (ms: number) => void;
}

const LOOK_NAMES: Record<TextLook, string> = { classic: 'Classic', bold: 'Bold', box: 'Box', minimal: 'Minimal' };

/** Text > Add text: type a text, it appears at the playhead for a few seconds. Pick look, size, place, colour, length. */
export function openTextItemsSheet(ctx: TextCtx): void {
  const items = (): TextItem[] => (ctx.p.texts ??= []);
  let sel: string | null = null;
  const body = h('div', { class: 'at-body' });
  const close = () => { sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
    h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Close', onclick: close }, icon('back', 20)), h('div', { class: 'at-title' }, 'Add text'), h('span', { class: 'at-head-gap' })),
    body);
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  function add(text: string) {
    const dur = ctx.durationMs();
    const s = Math.max(0, Math.min(ctx.playMs(), Math.max(0, dur - 500)));
    const last = items().find((t) => t.id === sel) ?? items()[items().length - 1];
    const it: TextItem = {
      id: uid(), text, s, e: Math.min(dur || s + 3000, s + 3000),
      look: last?.look ?? 'bold', size: last?.size ?? 0.07, y: last?.y ?? 0.5, color: last?.color ?? '#FFFFFF',
    };
    items().push(it);
    sel = it.id;
    ctx.changed(); render();
  }

  function render() {
    const list = items().slice().sort((a, b) => a.s - b.s);
    const cur = list.find((t) => t.id === sel);
    const field = h('input', { type: 'text', placeholder: 'Type your text', 'aria-label': 'Text' }) as HTMLInputElement;
    const addBtn = h('button', { class: 'btn primary', style: 'min-height:48px;padding:0 14px;white-space:nowrap', onclick: () => {
      const text = field.value.trim();
      if (!text) { toast('Type a text first.'); return; }
      add(text);
    } }, `Add at ${fmtClock(ctx.playMs())}`);
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });

    const rows = list.map((it) => {
      const input = h('input', { type: 'text', class: 'cap-input', value: it.text }) as HTMLInputElement;
      input.addEventListener('change', () => { it.text = input.value; ctx.changed(); });
      input.addEventListener('focus', () => { if (sel !== it.id) { sel = it.id; render(); } });
      const row = h('div', { class: 'cap-row', style: it.id === sel ? 'outline:1px solid var(--accent, #C6F277);border-radius:2px' : '' },
        h('button', { class: 'cap-time', onclick: () => { sel = it.id; ctx.seek(it.s); render(); } }, fmtClock(it.s)),
        input,
        h('button', { class: 'rx-del', 'aria-label': 'Remove', onclick: () => { ctx.p.texts = items().filter((x) => x.id !== it.id); if (sel === it.id) sel = null; ctx.changed(); render(); } }, icon('trash', 18)));
      return row;
    });

    body.replaceChildren(
      h('div', { class: 'at-hint' }, 'The text shows from the playhead for 3 seconds. Change the length below.'),
      h('div', { style: 'display:flex;gap:8px' }, field, addBtn),
      h('div', { class: 'cap-pages', style: 'margin-top:10px' }, ...rows),
      ...(cur ? [
        chips<string>('Look', '', TEXT_LOOKS.map((l) => [l, LOOK_NAMES[l]] as [string, string]), cur.look, (v) => { cur.look = v as TextLook; ctx.changed(); }),
        chips<string>('Size', '', [['0.045', 'Small'], ['0.07', 'Medium'], ['0.1', 'Large'], ['0.14', 'Huge']], String(cur.size), (v) => { cur.size = Number(v); ctx.changed(); }),
        chips<string>('Place', '', [['0.15', 'Top'], ['0.5', 'Middle'], ['0.82', 'Bottom']], String(cur.y), (v) => { cur.y = Number(v); ctx.changed(); }),
        chips<string>('Shows for', `Starts at ${fmtClock(cur.s)}.`, [['1500', '1.5 s'], ['3000', '3 s'], ['5000', '5 s'], ['8000', '8 s']], String(cur.e - cur.s), (v) => {
          cur.e = Math.min(ctx.durationMs() || cur.s + Number(v), cur.s + Number(v)); ctx.changed();
        }),
        swatches('Colour', cur.color, (c) => { cur.color = c; ctx.changed(); }),
      ] : [h('div', { class: 'at-hint', style: 'margin-top:12px' }, list.length ? 'Tap a text to change how it looks.' : 'No text yet.')]));
  }
  render();
}
