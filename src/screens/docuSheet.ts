import type { CapWord } from '../core/captions';
import { fixDocuLayout } from '../core/docuApply';
import { planDocuBeats } from '../core/docuPlanner';
import {
  DEFAULT_CARD_RADIUS, DOCU_ACCENTS, DOCU_THEMES, DOCU_TYPE_LABEL, MAX_CARD_RADIUS, defaultPos, docuLayoutFor, posChoices,
  type DocuBeat, type DocuPos, type DocuTheme, type DocuType,
} from '../core/docuTypes';
import { uid } from '../core/speaker';
import type { Project } from '../core/types';
import { h, icon, toast } from '../ui';

export interface DocuCtx {
  p: Project;
  playMs: () => number;
  durationMs: () => number;
  /** Something changed: redraw the preview and save. */
  changed: () => void;
  seek: (ms: number) => void;
  /** Words with times for the AI director (captions or the agent's own transcript). */
  words: () => CapWord[];
  onClosed?: () => void;
}
export interface DocuSheetHandle { close: () => void }

const POS_LABEL: Record<DocuPos, string> = { left: 'Video left', right: 'Video right', top: 'Video top', bottom: 'Video bottom' };

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  const val = h('b', {}, fmt(value));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'at-range', 'aria-label': label }) as HTMLInputElement;
  r.addEventListener('input', () => { const v = Number(r.value); val.textContent = fmt(v); onInput(v); });
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label-row' }, h('div', { class: 'at-label' }, label), val), r);
}

function chipRow<T extends string>(label: string, opts: [T, string][], value: T, onPick: (v: T) => void, disabled = false): HTMLElement {
  const row = h('div', { class: 'schips' });
  const render = (cur: T) => row.replaceChildren(...opts.map(([v, l]) => {
    const b = h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => { onPick(v); render(v); } }, l) as HTMLButtonElement;
    b.disabled = disabled;
    return b;
  }));
  render(value);
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), row);
}

/**
 * Docu: documentary typography beats. AI picks the moments, you flip which side the video sits on, round the corners,
 * and edit the words. Shows on the video straight away; the export draws the same.
 */
export function openDocuSheet(ctx: DocuCtx): DocuSheetHandle {
  const beats = (): DocuBeat[] => (ctx.p.docu ??= []);
  fixDocuLayout(ctx.p);
  const layout = () => docuLayoutFor(ctx.p.aspect);
  let sel: string | null = beats()[0]?.id ?? null;
  let busy = false;
  const cur = () => beats().find((b) => b.id === sel);
  const body = h('div', { class: 'ts-body', style: 'padding:2px 16px 12px;overflow-y:auto' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.classList.add('out'); setTimeout(() => box.remove(), 180);
    ctx.onClosed?.();
  };
  const sheet = h('div', { class: 'at-sheet ts', role: 'dialog' },
    h('div', { class: 'at-head' }, h('div', { class: 'at-title' }, 'Docu beats'), h('span', { class: 'at-head-gap' }),
      h('button', { class: 'ts-ok', 'aria-label': 'Done', onclick: close }, icon('check', 26))),
    body);
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  const sorted = () => beats().sort((a, b) => a.start - b.start);
  const pick = (id: string | null) => {
    sel = id;
    const b = cur();
    if (b) ctx.seek(Math.min(ctx.durationMs(), b.start + 400));
    render();
  };

  async function runAi() {
    if (busy) return;
    const words = ctx.words();
    if (!words.length) { toast('No transcript yet. Make Auto captions first, then tap AI beats.', 5000); return; }
    busy = true; render();
    try {
      const r = await planDocuBeats(words, ctx.p.aspect, ctx.durationMs(), true);
      if (!r.beats.length) { toast('No strong moments found. Add a beat by hand at the playhead.', 5000); return; }
      ctx.p.docu = r.beats;
      sel = r.beats[0]!.id;
      ctx.changed();
      toast(r.note ?? `${r.beats.length} beats added (${r.source === 'llm' ? 'Antigravity' : 'built-in rules'}).`, r.note ? 7000 : 3500);
      ctx.seek(r.beats[0]!.start + 400);
    } catch (e) { toast(`Could not plan beats: ${(e as Error).message || 'failed'}`, 6000); }
    finally { busy = false; render(); }
  }

  function add() {
    const dur = ctx.durationMs();
    const start = Math.max(0, Math.min(ctx.playMs(), Math.max(0, dur - 2500)));
    const lay = layout();
    const b: DocuBeat = {
      id: uid(), type: 'split_screen', start, end: Math.min(dur || start + 3500, start + 3500), layout: lay, video_position: defaultPos(lay),
      card_radius: DEFAULT_CARD_RADIUS, headline: 'Your headline', subtext: 'Supporting line', accent_color: DOCU_ACCENTS[beats().length % DOCU_ACCENTS.length]!, theme: 'noir',
    };
    beats().push(b);
    sel = b.id; ctx.changed(); render();
  }

  function remove() {
    const b = cur(); if (!b) return;
    ctx.p.docu = beats().filter((x) => x.id !== b.id);
    sel = sorted()[0]?.id ?? null;
    ctx.changed(); render();
  }

  const input = (label: string, value: string, onInput: (v: string) => void) => {
    const el = h('input', { type: 'text', class: 'ts-input', value, 'aria-label': label, placeholder: label, enterkeyhint: 'done', style: 'width:100%;margin-top:6px' }) as HTMLInputElement;
    el.addEventListener('input', () => onInput(el.value));
    return h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), el);
  };

  function render() {
    const b = cur();
    const list = sorted();
    const kids: Node[] = [];
    kids.push(h('div', { class: 'at-sec', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px' },
      h('button', { class: 'btn primary', style: 'flex:1;min-height:46px', onclick: () => void runAi(), disabled: busy ? 'true' : undefined }, busy ? 'Finding moments...' : 'AI beats'),
      h('button', { class: 'btn', style: 'flex:1;min-height:46px', onclick: add }, 'Add at playhead'),
      b ? h('button', { class: 'btn danger', style: 'min-height:46px', 'aria-label': 'Delete beat', onclick: remove }, icon('trash', 20)) : (h('span') as Node)));
    if (!list.length) {
      kids.push(h('div', { class: 'at-hint', style: 'margin-top:14px' }, 'Beats are short documentary moments: a black screen, a split card with the video on one side, or a big quote. Tap AI beats to let the director pick them from the transcript.'));
    } else {
      kids.push(h('div', { class: 'schips', style: 'margin-top:14px;flex-wrap:nowrap;overflow-x:auto' }, ...list.map((x, i) =>
        h('button', { class: 'chip' + (x.id === sel ? ' on' : ''), onclick: () => pick(x.id) }, `${i + 1} · ${x.headline.slice(0, 14) || 'Beat'}`))));
    }
    if (b) {
      const split = b.type === 'split_screen';
      const [pa, pb] = posChoices(layout());
      kids.push(
        input('Headline', b.headline, (v) => { b.headline = v; ctx.changed(); }),
        input('Supporting line', b.subtext ?? '', (v) => { b.subtext = v || undefined; ctx.changed(); }),
        chipRow<DocuType>('Look', (Object.keys(DOCU_TYPE_LABEL) as DocuType[]).map((k) => [k, DOCU_TYPE_LABEL[k]]), b.type, (v) => { b.type = v; ctx.changed(); render(); }),
        chipRow<DocuPos>('Video position', [[pa, POS_LABEL[pa]], [pb, POS_LABEL[pb]]], b.video_position, (v) => { b.video_position = v; ctx.changed(); }, !split),
        slider('Corner radius', 0, MAX_CARD_RADIUS, 1, b.card_radius, (v) => `${v}px`, (v) => { b.card_radius = v; ctx.changed(); }),
        slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }),
        chipRow<string>('Accent', DOCU_ACCENTS.map((c, i) => [c, ['Lime', 'Sky', 'Gold', 'Rose'][i]!] as [string, string]), b.accent_color, (v) => { b.accent_color = v; ctx.changed(); }),
        chipRow<DocuTheme>('Theme', DOCU_THEMES.map((t) => [t, t[0]!.toUpperCase() + t.slice(1)] as [DocuTheme, string]), b.theme, (v) => { b.theme = v; ctx.changed(); }),
      );
    }
    body.replaceChildren(...kids);
  }
  render();
  return { close };
}
