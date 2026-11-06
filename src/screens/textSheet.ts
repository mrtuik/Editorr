import { lookOf, TEXT_LOOKS, type Fx, type TextAnim, type TextItem, type TextLook } from '../core/captions';
import type { Project } from '../core/types';
import { uid } from '../core/speaker';
import { h, icon, toast, fmtClock } from '../ui';
import { chips } from './faceOptions';
import { effectsPanel, fontsPanel, paintTile, stylePanel, tileCanvas, type FxModel } from './fxEditor';

export interface TextCtx {
  p: Project;
  playMs: () => number;
  durationMs: () => number;
  /** Something changed: redraw the preview and save. */
  changed: () => void;
  seek: (ms: number) => void;
  /** Which text is being edited (null = none): the preview draws a dashed frame around it. */
  onSelect?: (id: string | null) => void;
  onClosed?: () => void;
}
export interface TextSheetHandle { select: (id: string) => void; close: () => void }

const LOOK_NAMES: Record<TextLook, string> = { classic: 'Classic', bold: 'Bold', box: 'Box', minimal: 'Minimal' };
const TABS = ['Templates', 'Styles', 'Fonts', 'Effects', 'Animations', 'Place'] as const;
type Tab = typeof TABS[number];

interface Template { name: string; look: TextLook; color: string; size?: number; fx: Fx; anim?: TextAnim }
const NOFX = { stroke: null, glow: null, shadow: null, bg: null } as const;
const TEMPLATES: Template[] = [
  { name: 'Classic', look: 'classic', color: '#FFFFFF', fx: {} },
  { name: 'Impact', look: 'bold', color: '#FFFFFF', size: 0.09, fx: { font: 'condensed' } },
  { name: 'Neon', look: 'minimal', color: '#FFFFFF', fx: { ...NOFX, glow: { c: '#19C3D8', b: 0.55 } }, anim: 'pop' },
  { name: 'Retro', look: 'bold', color: '#FFD60A', fx: { ...NOFX, font: 'casual', stroke: { c: '#7A1F00', w: 0.12 }, shadow: { c: '#FF3B30', b: 0, d: 0.09, a: 45 } }, anim: 'pop' },
  { name: 'Label', look: 'box', color: '#FFFFFF', fx: { ...NOFX, bg: { c: '#000000', o: 0.7, r: 0.3 } } },
  { name: 'Marker', look: 'minimal', color: '#000000', fx: { ...NOFX, bg: { c: '#FFD60A', o: 1, r: 0.12 } }, anim: 'rise' },
  { name: 'Elegant', look: 'minimal', color: '#FFFFFF', size: 0.08, fx: { ...NOFX, font: 'serif', italic: true, shadow: { c: 'rgba(0,0,0,0.85)', b: 0.4, d: 0.07, a: 90 } }, anim: 'fade' },
  { name: 'Fire', look: 'bold', color: '#FFD60A', fx: { ...NOFX, glow: { c: '#FF6A00', b: 0.6 }, shadow: { c: 'rgba(120,0,0,0.8)', b: 0.1, d: 0.05, a: 90 } } },
  { name: 'Script', look: 'minimal', color: '#FFFFFF', size: 0.1, fx: { ...NOFX, font: 'script', shadow: { c: 'rgba(0,0,0,0.85)', b: 0.4, d: 0.07, a: 90 } }, anim: 'fade' },
  { name: 'Terminal', look: 'box', color: '#30D158', fx: { ...NOFX, font: 'mono', bg: { c: '#000000', o: 0.85, r: 0.1 } } },
];
const ANIMS: [TextAnim, string][] = [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['rise', 'Rise']];

/**
 * Text > Add text. Text field on top, tabs below (Templates, Styles, Fonts, Effects, Animations, Place).
 * Everything you change shows on the video straight away. Tap a text on the video to edit it, drag it to move it.
 */
export function openTextItemsSheet(ctx: TextCtx, startId?: string): TextSheetHandle {
  const items = (): TextItem[] => (ctx.p.texts ??= []);
  let sel: string | null = startId ?? null;
  let tab: Tab = 'Styles';
  const styleKeep = { sub: 'Text' as 'Text' | 'Stroke' | 'Glow' | 'Background' | 'Shadow' };
  const cur = () => items().find((t) => t.id === sel);
  let raf = 0;
  const animTiles: { cv: HTMLCanvasElement; anim: TextAnim; it: TextItem }[] = [];

  const field = h('input', { type: 'text', class: 'ts-input', placeholder: 'Enter text', 'aria-label': 'Text', enterkeyhint: 'done' }) as HTMLInputElement;
  const tabsEl = h('div', { class: 'ts-tabs' });
  const body = h('div', { class: 'ts-body' });
  const delBtn = h('button', { class: 'ts-del', 'aria-label': 'Delete this text', onclick: () => remove() }, icon('trash', 22));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    // a text with no letters is not a text
    const before = items().length;
    ctx.p.texts = items().filter((t) => t.text.trim());
    if (ctx.p.texts.length !== before) ctx.changed();
    ctx.onSelect?.(null);
    sheet.classList.add('out'); setTimeout(() => box.remove(), 180);
    ctx.onClosed?.();
  };
  const done = () => close();
  const sheet = h('div', { class: 'at-sheet ts', role: 'dialog' },
    h('div', { class: 'ts-top' },
      h('div', { class: 'ts-field' }, field),
      delBtn,
      h('button', { class: 'ts-ok', 'aria-label': 'Done', onclick: done }, icon('check', 26))),
    tabsEl, body);
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  field.addEventListener('input', () => {
    const it = cur();
    if (it) { it.text = field.value; ctx.changed(); return; }
    // first letters typed: the text appears at the playhead straight away, so you see it while you style it
    if (field.value.trim()) add(field.value);
  });
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });

  function pick(id: string | null) {
    sel = id; ctx.onSelect?.(id);
    const it = cur();
    field.value = it?.text ?? '';
    delBtn.style.display = it ? '' : 'none';
  }

  function add(text: string) {
    const dur = ctx.durationMs();
    const s = Math.max(0, Math.min(ctx.playMs(), Math.max(0, dur - 500)));
    const last = items()[items().length - 1];
    const it: TextItem = {
      id: uid(), text, s, e: Math.min(dur || s + 3000, s + 3000),
      look: last?.look ?? 'bold', size: last?.size ?? 0.07, y: last?.y ?? 0.5, color: last?.color ?? '#FFFFFF', opacity: last?.opacity,
      ...(last?.x !== undefined ? { x: last.x } : {}),
      ...(last?.fx ? { fx: JSON.parse(JSON.stringify(last.fx)) as Fx } : {}),
      ...(last?.anim ? { anim: last.anim } : {}),
    };
    items().push(it);
    pick(it.id);
    ctx.changed(); render(false);
  }

  function remove() {
    const it = cur(); if (!it) return;
    ctx.p.texts = items().filter((y) => y.id !== it.id);
    pick(null); ctx.changed(); render(false);
  }

  /** A text must exist before it can be styled. */
  const need = (): TextItem | null => {
    const it = cur();
    if (!it) { toast('Type a text first.'); field.focus(); }
    return it ?? null;
  };

  function modelOf(it: TextItem): FxModel {
    return {
      look: () => lookOf(it.look),
      color: () => it.color,
      setColor: (c) => { it.color = c; ctx.changed(); },
      own: () => (it.fx ??= {}),
      below: () => undefined,
      patch: (f) => { f((it.fx ??= {})); ctx.changed(); },
      size: { label: 'Size', min: 0.03, max: 0.16, step: 0.005, get: () => it.size, set: (v) => { it.size = v; ctx.changed(); }, fmt: (v) => String(Math.round(v * 1000)) },
      opacity: { label: 'Opacity', min: 0.1, max: 1, step: 0.05, get: () => it.opacity ?? 1, set: (v) => { it.opacity = v >= 1 ? undefined : v; ctx.changed(); }, fmt: (v) => `${Math.round(v * 100)}%` },
    };
  }

  // ------------------------------------------------------------------------------------------ tabs
  function templatesTab(it: TextItem): Node[] {
    return [h('div', { class: 'fx-grid' }, ...TEMPLATES.map((t) => h('button', { class: 'fx-tile', 'aria-label': t.name,
      onclick: () => {
        it.look = t.look; it.color = t.color; if (t.size) it.size = t.size;
        it.fx = JSON.parse(JSON.stringify(t.fx)) as Fx; it.anim = t.anim; it.opacity = undefined;
        ctx.changed(); render();
      } }, tileCanvas({ look: t.look, color: t.color, fx: t.fx, size: 0.34 }), h('span', {}, t.name))))];
  }

  function stylesTab(it: TextItem): Node[] {
    const tiles = h('div', { class: 'ts-looks' },
      h('button', { class: 'ts-look none', 'aria-label': 'Plain text', onclick: () => { it.look = 'minimal'; it.fx = { ...NOFX }; ctx.changed(); render(); } }, icon('nostyle', 26)),
      ...TEXT_LOOKS.map((l) => h('button', { class: 'ts-look' + (it.look === l ? ' on' : ''), 'aria-label': LOOK_NAMES[l],
        onclick: () => {
          // a new look starts clean: its own stroke / shadow / box, not the ones of the old look
          it.look = l; if (it.fx) { delete it.fx.stroke; delete it.fx.shadow; delete it.fx.bg; delete it.fx.glow; }
          ctx.changed(); render();
        } }, tileCanvas({ look: l, color: it.color, size: 0.4, fx: it.fx?.font ? { font: it.fx.font } : undefined }))));
    return [tiles, stylePanel(modelOf(it), styleKeep)];
  }

  function animationsTab(it: TextItem): Node[] {
    animTiles.length = 0;
    const grid = h('div', { class: 'fx-grid' }, ...ANIMS.map(([a, name]) => {
      const cv = tileCanvas({ look: it.look, color: it.color, fx: it.fx, size: 0.34, anim: a, ms: 1000, end: 1800 });
      animTiles.push({ cv, anim: a, it });
      return h('button', { class: 'fx-tile' + ((it.anim ?? 'none') === a ? ' on' : ''), 'aria-label': name,
        onclick: () => { it.anim = a === 'none' ? undefined : a; ctx.changed(); ctx.seek(it.s); render(); } }, cv, h('span', {}, name));
    }));
    return [grid, h('div', { class: 'at-hint fx-hint' }, 'The text comes in when it starts. Press play to see it on the video.')];
  }

  function placeTab(it: TextItem): Node[] {
    const list = items().slice().sort((a, b) => a.s - b.s);
    const row = h('div', { class: 'ts-list' }, ...list.map((x) => h('div', { class: 'ts-item' + (x.id === sel ? ' on' : '') },
      h('button', { class: 'ts-item-main', onclick: () => { pick(x.id); ctx.seek(x.s); render(false); } },
        h('span', { class: 'ts-item-t' }, fmtClock(x.s)), h('span', { class: 'ts-item-x' }, x.text || '(empty)')),
      h('button', { class: 'ts-item-del', 'aria-label': 'Remove', onclick: () => { ctx.p.texts = items().filter((y) => y.id !== x.id); if (sel === x.id) pick(null); ctx.changed(); render(false); } }, icon('trash', 18)))));
    const dur = ctx.durationMs();
    return [
      h('div', { class: 'at-hint fx-hint' }, 'Drag the text on the video to move it.'),
      chips<string>('Up and down', '', [['0.15', 'Top'], ['0.5', 'Middle'], ['0.82', 'Bottom']], String(it.y), (v) => { it.y = Number(v); ctx.changed(); }),
      chips<string>('Left and right', '', [['0.25', 'Left'], ['0.5', 'Centre'], ['0.75', 'Right']], String(it.x ?? 0.5), (v) => { it.x = Number(v); ctx.changed(); }),
      chips<string>('Shows for', `Starts at ${fmtClock(it.s)}.`, [['1500', '1.5 s'], ['3000', '3 s'], ['5000', '5 s'], ['8000', '8 s']], String(it.e - it.s), (v) => {
        it.e = Math.min(dur || it.s + Number(v), it.s + Number(v)); ctx.changed();
      }),
      h('div', { class: 'fx-two' },
        h('button', { class: 'btn', onclick: () => { it.s = Math.min(ctx.playMs(), Math.max(0, dur - 300)); if (it.e <= it.s + 200) it.e = Math.min(dur || it.s + 3000, it.s + 3000); ctx.changed(); render(); } }, 'Start at playhead'),
        h('button', { class: 'btn', onclick: () => { const t = ctx.playMs(); if (t > it.s + 200) { it.e = t; ctx.changed(); render(); } else toast('Move the playhead after the start first.'); } }, 'End at playhead')),
      ...(list.length > 1 ? [h('div', { class: 'at-label fx-lbl' }, 'All texts'), row] : []),
    ];
  }

  function render(retab = true) {
    cancelAnimationFrame(raf);
    if (retab) tabsEl.replaceChildren(...TABS.map((t) => h('button', { class: 'ts-tab' + (t === tab ? ' on' : ''), onclick: () => { tab = t; render(); } }, t)));
    const it = cur();
    delBtn.style.display = it ? '' : 'none';
    if (!it) {
      body.replaceChildren(h('div', { class: 'ts-empty' }, icon('text', 28), h('span', {}, 'Type your text above. It shows on the video as you type.')));
      return;
    }
    const m = modelOf(it);
    const nodes = tab === 'Templates' ? templatesTab(it)
      : tab === 'Styles' ? stylesTab(it)
      : tab === 'Fonts' ? [fontsPanel(m, () => render(false))]
      : tab === 'Effects' ? [effectsPanel(m, () => render(false))]
      : tab === 'Animations' ? animationsTab(it)
      : placeTab(it);
    const top = body.scrollTop;
    body.replaceChildren(...nodes);
    body.scrollTop = top;
    if (tab === 'Animations') loopAnims();
  }

  /** The animation tiles replay all the time, so you see what each one does. */
  function loopAnims() {
    const t0 = performance.now();
    const step = () => {
      const ms = (performance.now() - t0) % 2000;
      for (const a of animTiles) {
        if (!a.cv.isConnected) continue;
        paintTile(a.cv, { look: a.it.look, color: a.it.color, fx: a.it.fx, size: 0.34, anim: a.anim, ms, end: 1800 });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  pick(sel);
  render();
  // only a new text needs the keyboard right away; an existing text opens with its tools
  if (!cur()) setTimeout(() => field.focus(), 250);

  return {
    select: (id) => { if (items().some((t) => t.id === id)) { pick(id); render(); } },
    close,
  };
}
