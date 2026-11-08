import type { CapWord } from '../core/captions';
import { fixDocuLayout } from '../core/docuApply';
import { planDocuBeats } from '../core/docuPlanner';
import { KALLAWAY_SHARES, makeKallawayBeats, syncStepStarts, type KallawaySpec } from '../core/kallaway';
import { planKallaway } from '../core/kallawayDirector';
import { autoBroll } from '../core/brollPlanner';
import { placeBroll } from '../core/brollTypes';
import { aspectValue } from '../core/types';
import {
  DEFAULT_CARD_RADIUS, DOCU_ACCENTS, DOCU_FONT_CSS, DOCU_FONT_LABEL, DOCU_FONT_SUB, DOCU_FONT_WEIGHT, DOCU_TEMPLATES, DOCU_TYPE_LABEL, MAX_CARD_RADIUS,
  defaultPos, docuLayoutFor, posChoices,
  type DocuBeat, type DocuFont, type DocuPos, type DocuStyle, type DocuTemplate, type DocuType,
} from '../core/docuTypes';
import { uid } from '../core/speaker';
import { buildBrollPane, type BrollPane } from './brollSheet';
import type { Project } from '../core/types';
import { h, icon, toast, slider as uiSlider, optionRow } from '../ui';

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
  return uiSlider(label, min, max, step, value, fmt, onInput);
}

function chipRow<T extends string>(label: string, opts: [T, string][], value: T, onPick: (v: T) => void, _disabled = false): HTMLElement {
  return optionRow(label, opts, value, onPick);
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

  // ------------------------------------------------------------ Kallaway frame (dot grid, step list / script card, video in a rounded window)
  const kw: KallawaySpec = { kind: 'steps', a: 'The', b: 'Desire Hook', c: 'Method', steps: ['Lead with the desired outcome', 'Tie the outcome to a relatable character', 'Hook formula one', 'Hook formula two', 'Hook formula three'], handle: '' };
  let kwSeconds = 10;
  let kwSync = true;
  let kwPhotoName = '';

  async function addKallaway() {
    if (busy) return;
    busy = true; render();
    try {
      const dur = ctx.durationMs();
      const start = Math.max(0, Math.min(ctx.playMs(), Math.max(0, dur - 3000)));
      const end = Math.min(dur || start + kwSeconds * 1000, start + Math.round(kwSeconds * 1000));
      // steps follow the speech when captions exist (or the agent's words) and the switch is on
      const spec: KallawaySpec = { ...kw, stepStarts: undefined };
      let synced = false;
      if (kw.kind === 'steps' && kwSync) {
        const words = ctx.p.captions?.words.length ? ctx.p.captions.words : ctx.p.agentWords?.words;
        const st = syncStepStarts(kw.steps.filter((x) => x.trim()).slice(0, 5), words, start, end);
        if (st) { spec.stepStarts = st; synced = true; }
      }
      const nb = await makeKallawayBeats(ctx.p.aspect, spec, start, end);
      // the new frame wins over documentary beats it overlaps
      ctx.p.docu = [...beats().filter((x) => x.end <= start || x.start >= end), ...nb].sort((a, b) => a.start - b.start);
      sel = nb[0]!.id;
      ctx.changed(); ctx.seek(start + 200);
      toast(`${nb.length} Kallaway frame${nb.length > 1 ? 's' : ''} added${synced ? ', timed to your words' : kw.kind === 'steps' && kwSync ? ' (no captions to time them, equal shares used)' : ''}.`, 4000);
    } catch (e) { toast(`Could not add it: ${(e as Error).message || 'failed'}`, 5000); }
    finally { busy = false; render(); }
  }

  /** The director picks the moments and templates from the transcript; every card is drawn and put on the timeline. */
  async function runKallawayAi() {
    if (busy) return;
    const words = ctx.words();
    if (!words.length) { toast('No transcript yet. Make Auto captions first, then tap Generate.', 5000); return; }
    busy = true; render();
    try {
      const r = await planKallaway(words, ctx.durationMs(), true);
      if (!r.picks.length) { toast('No good moments found for cards. Add one by hand at the playhead.', 5000); return; }
      const made: DocuBeat[] = [];
      for (const pk of r.picks) {
        const spec: KallawaySpec = { ...pk.spec, handle: kw.handle, share: kw.share, speaker: kw.speaker };
        made.push(...await makeKallawayBeats(ctx.p.aspect, spec, pk.start, pk.end));
      }
      ctx.p.docu = [...beats().filter((x) => r.picks.every((pk) => x.end <= pk.start || x.start >= pk.end)), ...made].sort((a, b) => a.start - b.start);
      sel = made[0]?.id ?? null;
      ctx.changed(); ctx.seek((r.picks[0]?.start ?? 0) + 200);
      // rhythm cascade: fill every gap between the cards with B-roll so a visual changes every 1.5 to 3 s
      let filled = 0, fillNote = '';
      try {
        const asp = aspectValue(ctx.p.aspect);
        const gap = await autoBroll({
          words, durationMs: ctx.durationMs(), lenMs: 2500, frame: 'full', coverage: 'every', fillGaps: true, maxBeats: 200,
          busy: beats().map((d) => ({ start: d.start, end: d.end })), videoMode: 'mix', aspect: asp > 0 ? asp : 9 / 16, useAntigravity: true,
          signal: { cancelled: false }, onProgress: (d, t) => toast(`Filling gaps with B-roll ${d}/${t}...`, 1500),
        });
        let next = ctx.p.broll ?? [];
        for (const b of gap.beats) next = placeBroll(next, b);
        ctx.p.broll = next; filled = gap.beats.length; ctx.changed();
      } catch (e) { fillNote = ` B-roll fill failed: ${(e as Error).message || 'error'}.`; }
      toast((r.note ?? `${r.picks.length} Kallaway cards + ${filled} B-roll cuts added (${r.source === 'llm' ? 'Antigravity' : 'built-in rules'}).`) + fillNote, r.note || fillNote ? 7000 : 4500);
    } catch (e) { toast(`Could not make the cards: ${(e as Error).message || 'failed'}`, 6000); }
    finally { busy = false; render(); }
  }

  function svgBox(): Node {
    const el = h('textarea', { class: 'ts-input', rows: 6, 'aria-label': 'SVG markup', placeholder: '<svg viewBox="0 0 400 300">...</svg>', style: 'width:100%;margin-top:6px;background:#242424;border-radius:2px;padding:10px;resize:none;font-family:monospace;font-size:12px' }) as HTMLTextAreaElement;
    el.value = kw.svg ?? '';
    el.addEventListener('input', () => { kw.svg = el.value; });
    return el;
  }

  function pickPhoto() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { kw.photo = String(rd.result); kwPhotoName = f.name; render(); };
      rd.readAsDataURL(f);
    };
    inp.click();
  }

  function kallawayForm(): Node {
    const text = (label: string, value: string, onInput: (v: string) => void) => {
      const el = h('input', { type: 'text', class: 'ts-input', value, 'aria-label': label, placeholder: label, enterkeyhint: 'done', style: 'width:100%;margin-top:6px' }) as HTMLInputElement;
      el.addEventListener('input', () => onInput(el.value));
      return el;
    };
    const stepsBox = h('textarea', { class: 'ts-input', rows: 5, 'aria-label': 'Points, one per line', placeholder: 'One point per line (up to 5)', style: 'width:100%;margin-top:6px;background:#242424;border-radius:2px;padding:10px;resize:none' }) as HTMLTextAreaElement;
    stepsBox.value = kw.steps.join('\n');
    stepsBox.addEventListener('input', () => { kw.steps = stepsBox.value.split('\n'); });
    return h('div', { class: 'at-sec', style: 'margin-top:18px;border-top:1px solid #2c2c2e;padding-top:14px' },
      h('div', { class: 'at-label' }, 'Kallaway frame'),
      h('div', { class: 'at-hint' }, 'Dot-grid background, a card on top and you in a rounded window. The card pops in, the red bar wipes to each point as you say it, and numbers count up.'),
      h('button', { class: 'btn primary', style: 'width:100%;min-height:46px;margin-top:8px', disabled: busy ? 'true' : undefined, onclick: () => void runKallawayAi() }, busy ? 'Working...' : 'Generate Kallaway cards (AI)'),
      h('div', { class: 'at-hint', style: 'margin-top:4px' }, 'Reads your captions, picks 2 to 4 moments and the best card for each. Or make one by hand below.'),
      chipRow<KallawaySpec['kind']>('Card', [['steps', 'Step list'], ['script', 'Script card'], ['stat', 'Number'], ['quote', 'Quote'], ['photo', 'Picture'], ['svg', 'Graphic']], kw.kind, (v) => { kw.kind = v; render(); }),
      chipRow<string>('Card size', KALLAWAY_SHARES.map(([v, l]) => [String(v), l] as [string, string]), String(kw.share ?? (docuLayoutFor(ctx.p.aspect) === 'updown' ? 0.6 : 0.52)), (v) => { kw.share = Number(v); render(); }),
      chipRow<string>('You sit', (docuLayoutFor(ctx.p.aspect) === 'updown' ? [['bottom', 'Bottom'], ['top', 'Top']] : [['right', 'Right'], ['left', 'Left']]) as [string, string][], kw.speaker ?? (docuLayoutFor(ctx.p.aspect) === 'updown' ? 'bottom' : 'right'), (v) => { kw.speaker = v as KallawaySpec['speaker']; render(); }),
      kw.kind === 'photo' ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn', style: 'width:100%;min-height:44px', onclick: pickPhoto }, kw.photo ? `Picture: ${kwPhotoName || 'chosen'} (tap to change)` : 'Pick a picture')) : (null as unknown as Node),
      kw.kind === 'steps' ? chipRow<string>('Timing', [['on', 'Follow my words'], ['off', 'Equal parts']], kwSync ? 'on' : 'off', (v) => { kwSync = v === 'on'; render(); }) : (null as unknown as Node),
      kw.kind === 'stat' ? h('div', {},
        h('div', { class: 'at-label', style: 'margin-top:10px' }, 'Number card'),
        text('Big number, e.g. 40% or $1.2M', kw.stat?.big ?? '', (v) => { kw.stat = { ...(kw.stat ?? { big: '' }), big: v }; }),
        text('Line under it (optional)', kw.stat?.label ?? '', (v) => { kw.stat = { ...(kw.stat ?? { big: '' }), label: v || undefined }; }),
        chipRow<string>('Trend', [['none', 'None'], ['up', 'Up'], ['down', 'Down']], kw.stat?.trend ?? 'none', (v) => { kw.stat = { ...(kw.stat ?? { big: '' }), trend: v === 'none' ? undefined : (v as 'up' | 'down') }; render(); })) : (null as unknown as Node),
      kw.kind === 'quote' ? h('div', {}, text('Supporting line under the headline', kw.sub ?? '', (v) => { kw.sub = v; })) : (null as unknown as Node),
      kw.kind === 'svg' ? h('div', {},
        h('div', { class: 'at-hint', style: 'margin-top:10px' }, 'Paste one <svg> with a viewBox (plain shapes and text). Scripts, pictures and links are removed.'),
        svgBox()) : (null as unknown as Node),
      h('div', { class: 'at-label', style: 'margin-top:10px' }, kw.kind === 'quote' ? 'Headline (bold + italic + bold)' : 'Title (bold + italic + bold)'),
      text('Bold start, e.g. The', kw.a, (v) => { kw.a = v; }),
      text('Italic part, e.g. Desire Hook', kw.b, (v) => { kw.b = v; }),
      text('Second line, e.g. Method', kw.c, (v) => { kw.c = v; }),
      kw.kind === 'steps' ? h('div', {}, h('div', { class: 'at-label', style: 'margin-top:10px' }, 'Points'), stepsBox) : (null as unknown as Node),
      h('div', { style: 'margin-top:10px' }, text('@handle above the video (optional)', kw.handle, (v) => { kw.handle = v; })),
      slider('Total length', 3, 40, 1, kwSeconds, (v) => `${v}s`, (v) => { kwSeconds = v; }),
      h('button', { class: 'btn primary', style: 'width:100%;min-height:46px;margin-top:6px', disabled: busy ? 'true' : undefined, onclick: () => void addKallaway() }, busy ? 'Drawing...' : 'Add at playhead'));
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
    if (b && b.image) {
      kids.push(
        h('div', { class: 'at-hint', style: 'margin-top:10px' }, 'This is a Kallaway frame (a finished picture). To change its words, delete the frames and add it again below.'),
        slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }));
    } else if (b) {
      kids.push(
        input('Headline', b.headline, (v) => { b.headline = v; ctx.changed(); }),
        input('Supporting line', b.subtext ?? '', (v) => { b.subtext = v || undefined; ctx.changed(); }),
        slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }),
        h('div', { class: 'at-hint' }, 'Look, video side and padding: Layout tab. Ready-made looks: Templates tab.'),
      );
    }
    kids.push(kallawayForm());
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
