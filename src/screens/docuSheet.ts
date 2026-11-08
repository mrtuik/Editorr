import type { CapWord } from '../core/captions';
import { fixDocuLayout } from '../core/docuApply';
import { planDocuBeats } from '../core/docuPlanner';
import {
  DEFAULT_CARD_RADIUS, DOCU_ACCENTS, DOCU_FONT_CSS, DOCU_FONT_LABEL, DOCU_FONT_SUB, DOCU_FONT_WEIGHT, DOCU_TEMPLATES, DOCU_TYPE_LABEL, MAX_CARD_RADIUS,
  defaultPos, docuLayoutFor, posChoices,
  type DocuBeat, type DocuFont, type DocuPos, type DocuStyle, type DocuTemplate, type DocuType,
} from '../core/docuTypes';
import { uid } from '../core/speaker';
import { buildBrollPane, type BrollPane } from './brollSheet';
import type { Project } from '../core/types';
import { h, icon, toast } from '../ui';

export interface DocuCtx {
  p: Project;
  playMs: () => number;
  durationMs: () => number;
  /** Something changed: redraw the preview and save. */
  changed: () => void;
  seek: (ms: number) => void;
  /** width / height of the output frame (B-roll cards are drawn in this shape) */
  aspect?: () => number;
  /** Words with times for the AI director (captions or the agent's own transcript). */
  words: () => CapWord[];
  onClosed?: () => void;
}
export interface DocuSheetHandle { close: () => void; select: (tab: DocuTab, id: string) => void }
export type DocuTab = 'beats' | 'templates' | 'layout' | 'fonts' | 'colors' | 'broll';
const TAB_LABEL: [DocuTab, string][] = [['beats', 'Beats'], ['templates', 'Templates'], ['layout', 'Layout'], ['fonts', 'Fonts'], ['colors', 'Colors'], ['broll', 'B-roll']];
const THEME_BG_HEX = { noir: '#0A0A0C', investigative: '#10141B', modern: '#14141A' } as const;
const THEME_CARD_HEX = { noir: '#121216', investigative: '#161C26', modern: '#1C1C24' } as const;

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
export function openDocuSheet(ctx: DocuCtx, startTab: DocuTab = 'beats', startId?: string, only?: 'docu' | 'broll'): DocuSheetHandle {
  let tab: DocuTab = only === 'broll' ? 'broll' : (only === 'docu' && startTab === 'broll') ? 'beats' : startTab;
  let brollPane: BrollPane | null = null;
  let scopeAll = false;
  const beats = (): DocuBeat[] => (ctx.p.docu ??= []);
  fixDocuLayout(ctx.p);
  const layout = () => docuLayoutFor(ctx.p.aspect);
  let sel: string | null = (startId && beats().some((b) => b.id === startId) ? startId : beats()[0]?.id) ?? null;
  let busy = false;
  const cur = () => beats().find((b) => b.id === sel);
  const body = h('div', { class: 'ts-body', style: 'padding:2px 16px 12px;overflow-y:auto' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.classList.add('out'); setTimeout(() => box.remove(), 180);
    brollPane?.dispose();
    ctx.onClosed?.();
  };
  const tabsEl = h('div', { class: 'br-tabs dt-tabs' });
  const renderTabs = () => {
    const shownTabs = only === 'docu' ? TAB_LABEL.filter(([k]) => k !== 'broll') : only === 'broll' ? TAB_LABEL.filter(([k]) => k === 'broll') : TAB_LABEL;
    tabsEl.replaceChildren(...shownTabs.map(([k, l]) =>
      h('button', { class: 'br-tab' + (tab === k ? ' on' : ''), onclick: () => { if (tab !== k) { tab = k; render(); } } }, l)));
    (tabsEl.querySelector('.on') as HTMLElement | null)?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  };
  const sheet = h('div', { class: 'at-sheet ts', role: 'dialog' },
    h('div', { class: 'at-head' }, tabsEl,
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

  // ------------------------------------------------------------ style helpers (templates, layout, fonts, colors)
  const targets = (): DocuBeat[] => (scopeAll ? beats() : cur() ? [cur()!] : []);
  const st = (b: DocuBeat): DocuStyle => (b.style ??= {});
  function patch(fn: (b: DocuBeat) => void) { for (const b of targets()) fn(b); ctx.changed(); }
  function loadFont(f: DocuFont) {
    const fam = DOCU_FONT_CSS[f].split(',')[0]!.replace(/"/g, '');
    void (document as any).fonts?.load?.(`${DOCU_FONT_WEIGHT[f]} 28px "${fam}"`).then(() => ctx.changed()).catch(() => { /* offline: fallback font stays */ });
  }
  const tileGrid = (...tiles: Node[]) => h('div', { class: 'dt-grid' }, ...tiles);
  const sec = (label: string, ...kids: (Node | null)[]) => h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), ...kids.filter(Boolean) as Node[]);
  function colorRow(label: string, value: string, onPick: (v: string) => void): HTMLElement {
    const inp = h('input', { type: 'color', value, class: 'dt-color', 'aria-label': label }) as HTMLInputElement;
    inp.addEventListener('input', () => onPick(inp.value));
    return h('label', { class: 'dt-colrow' }, h('span', {}, label), inp);
  }

  /** Top of the style tabs: which beat, and whether a change goes to this beat only or to all of them. */
  function styleHead(list: DocuBeat[]): Node[] {
    const out: Node[] = [];
    if (!list.length) {
      out.push(h('div', { class: 'at-hint', style: 'margin-top:14px' }, 'No beats yet. Add one at the playhead (or let AI pick the moments), then style it here.'),
        h('div', { class: 'at-sec' }, h('button', { class: 'btn primary', style: 'width:100%;min-height:46px', onclick: add }, 'Add at playhead')));
      return out;
    }
    out.push(h('div', { class: 'schips', style: 'margin-top:8px;flex-wrap:nowrap;overflow-x:auto' },
      ...list.map((x, i) => h('button', { class: 'chip' + (!scopeAll && x.id === sel ? ' on' : ''), onclick: () => { scopeAll = false; pick(x.id); } }, `${i + 1} · ${x.headline.slice(0, 12) || 'Beat'}`)),
      list.length > 1 ? h('button', { class: 'chip' + (scopeAll ? ' on' : ''), onclick: () => { scopeAll = !scopeAll; render(); } }, 'All beats') : (null as unknown as Node)));
    return out;
  }

  function renderTemplates(b: DocuBeat | undefined): Node[] {
    const now = b?.style?.template;
    return [
      h('div', { class: 'at-hint', style: 'margin-top:10px' }, scopeAll ? 'A template is applied to every beat.' : 'Tap a template to dress this beat. Your headline text stays.'),
      tileGrid(...DOCU_TEMPLATES.map((t: DocuTemplate) => {
        const fam = DOCU_FONT_CSS[t.style.font ?? 'inter'];
        const face = h('div', { class: 'dt-prev', style: `background:${t.style.bg};` },
          h('div', { class: t.style.lower ? 'dt-card low' : 'dt-card', style: `background:${t.style.card};${t.style.border ? `border:2px solid ${t.accent};` : ''}${t.style.shadow?.blur ? `box-shadow:0 ${t.style.shadow.dist}px ${t.style.shadow.blur}px ${t.style.shadow.color};` : ''}border-radius:${Math.min(12, t.radius / 3)}px` },
            h('b', { style: `color:${t.style.text};font-family:${fam};font-weight:${DOCU_FONT_WEIGHT[t.style.font ?? 'inter']}` }, t.style.caps === false ? 'Aa' : 'AA'),
            h('i', { style: `background:${t.accent}` })));
        return h('button', { class: 'dt-tile' + (now === t.id ? ' on' : ''), 'aria-label': t.label, onclick: () => {
          patch((x) => { const wasLower = !!x.style?.lower; x.style = { ...t.style }; x.accent_color = t.accent; x.card_radius = t.radius; x.type = t.style.lower ? 'kinetic_quote' : wasLower ? 'split_screen' : x.type; });
          loadFont(t.style.font ?? 'inter'); render();
        } }, face, h('span', { class: 'dt-name' }, t.label), h('span', { class: 'dt-sub' }, t.hint));
      })),
    ];
  }

  function miniLayout(pos: DocuPos, on: boolean): HTMLElement {
    const vert = pos === 'top' || pos === 'bottom';
    const videoFirst = pos === 'left' || pos === 'top';
    const video = h('div', { class: 'dt-mv' }), card = h('div', { class: 'dt-mc' });
    return h('div', { class: 'dt-mini' + (vert ? ' v' : '') + (on ? ' on' : '') }, ...(videoFirst ? [video, card] : [card, video]));
  }

  function renderLayout(b: DocuBeat | undefined): Node[] {
    if (!b) return [];
    const split = b.type === 'split_screen';
    const [pa, pb] = posChoices(layout());
    const wide = layout() === 'side';
    const posTile = (pos: DocuPos) => h('button', { class: 'dt-tile' + (b.video_position === pos ? ' on' : '') + (split ? '' : ' dim'), 'aria-label': POS_LABEL[pos], disabled: split ? undefined : 'true',
      onclick: () => { patch((x) => { x.video_position = pos; }); render(); } },
      h('div', { class: 'dt-prev' }, miniLayout(pos, true)), h('span', { class: 'dt-name' }, POS_LABEL[pos]), h('span', { class: 'dt-sub' }, wide ? '16:9 mode' : '9:16 mode'));
    const lookTile = (k: DocuType) => h('button', { class: 'dt-tile' + (b.type === k ? ' on' : ''), 'aria-label': DOCU_TYPE_LABEL[k],
      onclick: () => { patch((x) => { x.type = k; if (k !== 'kinetic_quote' && x.style) delete x.style.lower; }); render(); } },
      h('div', { class: 'dt-prev' }, h('div', { class: 'dt-look ' + k })), h('span', { class: 'dt-name' }, DOCU_TYPE_LABEL[k]));
    return [
      sec(wide ? 'Video side (wide frame)' : 'Video side (tall frame)', tileGrid(posTile(pa), posTile(pb))),
      sec('Look', tileGrid(...(Object.keys(DOCU_TYPE_LABEL) as DocuType[]).map(lookTile))),
      slider('Corner radius', 0, MAX_CARD_RADIUS, 1, b.card_radius, (v) => `${v}px`, (v) => { patch((x) => { x.card_radius = v; }); }),
      slider('Card padding', 0, 120, 2, b.style?.pad ?? 43, (v) => `${v}px`, (v) => { patch((x) => { st(x).pad = v; }); }),
      slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }),
    ];
  }

  function renderFonts(b: DocuBeat | undefined): Node[] {
    if (!b) return [];
    const fonts = Object.keys(DOCU_FONT_LABEL) as DocuFont[];
    return [
      sec('Font', tileGrid(...fonts.map((f) => h('button', { class: 'dt-tile' + ((b.style?.font ?? 'inter') === f ? ' on' : ''), 'aria-label': DOCU_FONT_LABEL[f], onclick: () => { patch((x) => { st(x).font = f; }); loadFont(f); render(); } },
        h('div', { class: 'dt-prev' }, h('b', { class: 'dt-aa', style: `font-family:${DOCU_FONT_CSS[f]};font-weight:${DOCU_FONT_WEIGHT[f]}` }, 'Aa')),
        h('span', { class: 'dt-name' }, DOCU_FONT_LABEL[f]), h('span', { class: 'dt-sub' }, DOCU_FONT_SUB[f]))))),
      slider('Text size', 70, 140, 5, Math.round((b.style?.textScale ?? 1) * 100), (v) => `${v}%`, (v) => { patch((x) => { st(x).textScale = v / 100; }); }),
      chipRow<'on' | 'off'>('Capital letters', [['on', 'ABC'], ['off', 'Abc']], b.style?.caps === false ? 'off' : 'on', (v) => { patch((x) => { st(x).caps = v === 'on'; }); }),
    ];
  }

  function renderColors(b: DocuBeat | undefined): Node[] {
    if (!b) return [];
    const s0 = b.style ?? {};
    const accent = /^#[0-9a-f]{6}$/i.test(b.accent_color) ? b.accent_color : '#C6F277';
    const sh = s0.shadow ?? { blur: 0, dist: 0, color: '#000000' };
    const glow = sh.color.toLowerCase() === accent.toLowerCase();
    return [
      sec('Colors',
        colorRow('Text', s0.text ?? '#FFFFFF', (v) => patch((x) => { st(x).text = v; })),
        colorRow('Accent', accent, (v) => patch((x) => { x.accent_color = v; })),
        colorRow('Card', s0.card ?? THEME_CARD_HEX[b.theme] ?? '#121216', (v) => patch((x) => { st(x).card = v; })),
        colorRow('Background', s0.bg ?? THEME_BG_HEX[b.theme] ?? '#0A0A0C', (v) => patch((x) => { st(x).bg = v; }))),
      chipRow<string>('Quick accent', DOCU_ACCENTS.map((c, i) => [c, ['Lime', 'Sky', 'Gold', 'Rose'][i]!] as [string, string]), accent, (v) => { patch((x) => { x.accent_color = v; }); render(); }),
      slider('Shadow blur', 0, 25, 1, sh.blur, (v) => `${v}px`, (v) => { patch((x) => { const o = st(x).shadow ??= { blur: 0, dist: 0, color: '#000000' }; o.blur = v; }); }),
      slider('Shadow distance', 0, 15, 1, sh.dist, (v) => `${v}px`, (v) => { patch((x) => { const o = st(x).shadow ??= { blur: 0, dist: 0, color: '#000000' }; o.dist = v; }); }),
      chipRow<'black' | 'glow'>('Shadow color', [['black', 'Deep black'], ['glow', 'Glow (accent)']], glow ? 'glow' : 'black', (v) => {
        patch((x) => { const o = st(x).shadow ??= { blur: 0, dist: 0, color: '#000000' }; o.color = v === 'glow' ? x.accent_color : '#000000'; });
      }),
      colorRow('Custom shadow color', sh.color.startsWith('#') && sh.color.length === 7 ? sh.color : '#000000', (v) => patch((x) => { const o = st(x).shadow ??= { blur: 0, dist: 0, color: '#000000' }; o.color = v; })),
    ];
  }

  function render() {
    renderTabs();
    if (tab === 'broll') {
      brollPane ??= buildBrollPane({ p: ctx.p, playMs: ctx.playMs, durationMs: ctx.durationMs, changed: ctx.changed, seek: ctx.seek, words: ctx.words, aspect: ctx.aspect, startId: tabBrollId });
      body.replaceChildren(brollPane.el);
      return;
    }
    const b = cur();
    const list = sorted();
    if (tab !== 'beats') {
      const kids = [...styleHead(list)];
      if (list.length) kids.push(...(tab === 'templates' ? renderTemplates(b) : tab === 'layout' ? renderLayout(b) : tab === 'fonts' ? renderFonts(b) : renderColors(b)));
      body.replaceChildren(...kids);
      return;
    }
    const kids: Node[] = [];
    kids.push(h('div', { class: 'at-sec', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px' },
      h('button', { class: 'btn primary', style: 'flex:1;min-height:46px', onclick: () => void runAi(), disabled: busy ? 'true' : undefined }, busy ? 'Finding moments...' : 'AI beats'),
      h('button', { class: 'btn', style: 'flex:1;min-height:46px', onclick: add }, 'Add at playhead'),
      b ? h('button', { class: 'btn danger', style: 'min-height:46px', 'aria-label': 'Delete beat', onclick: remove }, icon('trash', 20)) : (null as unknown as Node)));
    if (!list.length) {
      kids.push(h('div', { class: 'at-hint', style: 'margin-top:14px' }, 'Beats are short documentary moments: a black screen, a split card with the video on one side, or a big quote. Tap AI beats to let the director pick them from the transcript.'));
    } else {
      kids.push(h('div', { class: 'schips', style: 'margin-top:14px;flex-wrap:nowrap;overflow-x:auto' }, ...list.map((x, i) =>
        h('button', { class: 'chip' + (x.id === sel ? ' on' : ''), onclick: () => pick(x.id) }, `${i + 1} · ${x.headline.slice(0, 14) || 'Beat'}`))));
    }
    if (b) {
      kids.push(
        input('Headline', b.headline, (v) => { b.headline = v; ctx.changed(); }),
        input('Supporting line', b.subtext ?? '', (v) => { b.subtext = v || undefined; ctx.changed(); }),
        slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }),
        h('div', { class: 'at-hint' }, 'Look, video side and padding: Layout tab. Ready-made looks: Templates tab.'),
      );
    }
    body.replaceChildren(...kids);
  }
  let tabBrollId: string | undefined = tab === 'broll' ? startId : undefined;
  render();
  return {
    close,
    select: (t, id) => {
      if (t === 'broll') { if (only === 'docu') return; tabBrollId = id; tab = 'broll'; brollPane?.select(id); render(); return; }
      if (only === 'broll') return;
      if (beats().some((x) => x.id === id)) { sel = id; if (tab === 'broll') tab = 'beats'; render(); }
    },
  };
}
