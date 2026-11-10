import type { CapWord } from '../core/captions';
import { planDocuBeats } from '../core/docuPlanner';
import { KALLAWAY_SHARES, isFullScreen, makeKallawayBeats, parseReceiptLines, receiptLinesText, syncStepStarts, type KallawaySpec } from '../core/kallaway';
import { planKallaway } from '../core/kallawayDirector';
import { autoBroll } from '../core/brollPlanner';
import { placeBroll } from '../core/brollTypes';
import { aspectValue } from '../core/types';
import { applyCreator, CREATORS, type CreatorId } from '../core/creators';
import {
  DEFAULT_CARD_RADIUS, DOCU_ACCENTS, DOCU_FONT_CSS, DOCU_FONT_LABEL, DOCU_FONT_SUB, DOCU_FONT_WEIGHT, DOCU_TEMPLATES, DOCU_TYPE_LABEL, MAX_CARD_RADIUS,
  defaultPos, docuLayoutFor, posChoices,
  type DocuBeat, type DocuFont, type DocuPos, type DocuStyle, type DocuTemplate, type DocuType,
} from '../core/docuTypes';
import { uid } from '../core/speaker';
import { buildBrollPane, type BrollPane } from './brollSheet';
import type { Project } from '../core/types';
import { h, icon, toast, spinner, slider as uiSlider, optionRow } from '../ui';

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
  /** Opens the separate Kallaway bottom sheet (new card, or edit the card of beat `id`). */
  openKallaway?: (id?: string) => void;
}
export interface DocuSheetHandle { close: () => void; select: (tab: DocuTab, id: string) => void }
export type DocuTab = 'beats' | 'templates' | 'layout' | 'fonts' | 'colors' | 'broll' | 'kallaway';
const TAB_LABEL: [DocuTab, string][] = [['beats', 'Beats'], ['templates', 'Templates'], ['layout', 'Layout'], ['fonts', 'Fonts'], ['colors', 'Colors']];
const THEME_BG_HEX = { noir: '#0A0A0C', investigative: '#10141B', modern: '#14141A' } as const;
const THEME_CARD_HEX = { noir: '#121216', investigative: '#161C26', modern: '#1C1C24' } as const;

const POS_LABEL: Record<DocuPos, string> = { left: 'Video left', right: 'Video right', top: 'Video top', bottom: 'Video bottom' };

function isLightHex(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 150;
}

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
export function openDocuSheet(ctx: DocuCtx, startTab: DocuTab = 'beats', startId?: string, only?: 'docu' | 'broll' | 'kallaway'): DocuSheetHandle {
  // There is no separate B-roll tab any more: a tapped B-roll clip is edited at the bottom of the Beats tab.
  let tab: DocuTab = only === 'kallaway' ? 'kallaway' : startTab === 'broll' ? 'beats' : startTab;
  let brollPane: BrollPane | null = null;
  let selBroll: string | undefined = startTab === 'broll' ? startId : undefined;
  let scopeAll = false;
  const beats = (): DocuBeat[] => (ctx.p.docu ??= []);
  // (the layout of a beat is only reset when the ratio changes, so a chosen top/bottom or left/right side stays)
  const layout = () => docuLayoutFor(ctx.p.aspect);
  let sel: string | null = (startId && beats().some((b) => b.id === startId) ? startId : (only === 'kallaway' ? beats().find((b) => b.kw) : beats().find((b) => !b.kw))?.id) ?? null;
  let kwNew = only === 'kallaway' && !(sel && beats().find((b) => b.id === sel)?.kw);
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
    const shownTabs: [DocuTab, string][] = only === 'kallaway' ? [['kallaway', 'Kallaway']] : TAB_LABEL;
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
      card_radius: DEFAULT_CARD_RADIUS, headline: 'Your headline', accent_color: DOCU_ACCENTS[beats().length % DOCU_ACCENTS.length]!, theme: 'noir',
    };
    beats().push(b);
    sel = b.id; ctx.changed(); render();
  }

  // ------------------------------------------------------------ Kallaway frame (dot grid, step list / script card, video in a rounded window)
  const SIT_CHOICES: [string, string][] = [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']];
  let kwScreen: 'half' | 'full' | 'mixed' = 'half';
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
      if ((kw.kind === 'steps' || kw.kind === 'loop') && kwSync) {
        const words = ctx.p.captions?.words.length ? ctx.p.captions.words : ctx.p.agentWords?.words;
        const st = syncStepStarts(kw.steps.filter((x) => x.trim()).slice(0, 5), words, start, end);
        if (st) { spec.stepStarts = st; synced = true; }
      }
      const nb = await makeKallawayBeats(ctx.p.aspect, spec, start, end);
      // the new frame wins over documentary beats it overlaps
      ctx.p.docu = [...beats().filter((x) => x.end <= start || x.start >= end), ...nb].sort((a, b) => a.start - b.start);
      sel = nb[0]!.id; kwNew = false;
      ctx.changed(); ctx.seek(start + 200);
      toast(`${nb.length} Kallaway frame${nb.length > 1 ? 's' : ''} added${synced ? ', timed to your words' : kw.kind === 'steps' && kwSync ? ' (no captions to time them, equal shares used)' : ''}.`, 4000);
    } catch (e) { toast(`Could not add it: ${(e as Error).message || 'failed'}`, 5000); }
    finally { busy = false; render(); }
  }

  /** The director picks the moments and templates from the transcript; every card is drawn and put on the timeline. */
  async function runKallawayAi(auto = false) {
    if (busy) return;
    const words = ctx.words();
    if (!words.length) { toast('No transcript yet. Make Auto captions first, then tap Generate.', 5000); return; }
    if (auto && ((ctx.p.docu ?? []).length || (ctx.p.broll ?? []).length) && !window.confirm('Auto edit replaces the current cards and B-roll. Continue?')) return;
    busy = true; render();
    try {
      if (auto) { ctx.p.docu = []; ctx.p.broll = []; selBroll = undefined; toast('Auto edit: planning the moments...', 2500); }
      const r = await planKallaway(words, ctx.durationMs(), true);
      if (!r.picks.length && !auto) { toast('No good moments found for cards. Add one by hand at the playhead.', 5000); return; }
      const made: DocuBeat[] = [];
      for (const pk of r.picks) {
        // rhythm like the reference reels: scenes with a self-contained picture alternate between 'you in a window' and 'full screen'
        const idx = r.picks.indexOf(pk);
        const fullOk = ['loop', 'versus', 'stat', 'quote', 'steps'].includes(pk.spec.kind);
        const spec: KallawaySpec = { ...pk.spec, handle: kw.handle, share: kw.share, speaker: fullOk && (kwScreen === 'full' || ((auto || kwScreen === 'mixed') && idx % 2 === 1)) ? 'none' : (kw.speaker === 'none' ? undefined : kw.speaker) };
        made.push(...await makeKallawayBeats(ctx.p.aspect, spec, pk.start, pk.end));
      }
      ctx.p.docu = [...beats().filter((x) => r.picks.every((pk) => x.end <= pk.start || x.start >= pk.end)), ...made].sort((a, b) => a.start - b.start);
      sel = made[0]?.id ?? null; kwNew = false;
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
      // Auto edit also dresses everything in one look (the chosen one, else Kallaway): captions, cards, B-roll moves
      if (auto) { applyCreator(ctx.p, ctx.p.creator ?? 'kallaway'); ctx.changed(); }
      if (auto) { toast(`Auto edit done: ${r.picks.length} cards + ${filled} B-roll cuts.${fillNote}`, 6000); return; }
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

  const blankPost = (p?: KallawaySpec['post']) => ({ name: p?.name ?? '', handle: p?.handle ?? '', text: p?.text ?? '', likes: p?.likes, reposts: p?.reposts });
  const blankReceipt = (r?: KallawaySpec['receipt']) => ({ shop: r?.shop ?? '', lines: r?.lines ?? [], total: r?.total });
  /** One line per item: "Label | $amount". */
  function receiptBox(lines: { label: string; amount: string }[] | undefined, on: (l: { label: string; amount: string }[]) => void): Node {
    const el = h('textarea', { class: 'ts-input', rows: 5, 'aria-label': 'Receipt lines', placeholder: 'One item per line, like: Coffee | $4.50', style: 'width:100%;margin-top:6px;background:#242424;border-radius:2px;padding:10px;resize:none' }) as HTMLTextAreaElement;
    el.value = receiptLinesText(lines);
    el.addEventListener('input', () => on(parseReceiptLines(el.value)));
    return el;
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
    return h('div', { class: 'at-sec', style: 'margin-top:6px' },
      h('button', { class: 'btn primary', style: 'width:100%;min-height:46px', disabled: busy ? 'true' : undefined, onclick: () => void runKallawayAi() }, busy ? 'Working...' : 'Generate cards with AI'),
      h('div', { class: 'at-hint', style: 'margin-top:4px' }, 'Reads your captions and picks the best card for 2 to 4 moments.'),
      h('div', { class: 'at-label', style: 'margin-top:14px' }, 'Or make one by hand'),
      chipRow<KallawaySpec['kind']>('Card', [['steps', 'Step list'], ['script', 'Script card'], ['stat', 'Number'], ['quote', 'Quote'], ['loop', 'Loop'], ['versus', 'Versus'], ['tweet', 'Post'], ['receipt', 'Receipt'], ['photo', 'Picture'], ['svg', 'Graphic']], kw.kind, (v) => { kw.kind = v; render(); }),
      chipRow<string>('Card size', KALLAWAY_SHARES.map(([v, l]) => [String(v), l] as [string, string]), String(kw.share ?? (docuLayoutFor(ctx.p.aspect) === 'updown' ? 0.6 : 0.52)), (v) => { kw.share = Number(v); render(); }),
      chipRow<'half' | 'full' | 'mixed'>('Screen', [['half', 'Half screen'], ['full', 'Full screen'], ['mixed', 'Mixed']], kwScreen, (v) => { kwScreen = v; render(); }),
      kwScreen === 'full' ? (null as unknown as Node) : chipRow<string>('You sit', SIT_CHOICES, kw.speaker && kw.speaker !== 'none' ? kw.speaker : (docuLayoutFor(ctx.p.aspect) === 'updown' ? 'bottom' : 'right'), (v) => { kw.speaker = v as KallawaySpec['speaker']; render(); }),
      kw.kind === 'photo' ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn', style: 'width:100%;min-height:44px', onclick: pickPhoto }, kw.photo ? `Picture: ${kwPhotoName || 'chosen'} (tap to change)` : 'Pick a picture')) : (null as unknown as Node),
      kw.kind === 'steps' ? chipRow<string>('Timing', [['on', 'Follow my words'], ['off', 'Equal parts']], kwSync ? 'on' : 'off', (v) => { kwSync = v === 'on'; render(); }) : (null as unknown as Node),
      kw.kind === 'stat' ? h('div', {},
        h('div', { class: 'at-label', style: 'margin-top:10px' }, 'Number card'),
        text('Big number, e.g. 40% or $1.2M', kw.stat?.big ?? '', (v) => { kw.stat = { ...(kw.stat ?? { big: '' }), big: v }; }),
        text('Line under it (optional)', kw.stat?.label ?? '', (v) => { kw.stat = { ...(kw.stat ?? { big: '' }), label: v || undefined }; }),
        chipRow<string>('Trend', [['none', 'None'], ['up', 'Up'], ['down', 'Down']], kw.stat?.trend ?? 'none', (v) => { kw.stat = { ...(kw.stat ?? { big: '' }), trend: v === 'none' ? undefined : (v as 'up' | 'down') }; render(); })) : (null as unknown as Node),
      kw.kind === 'quote' ? h('div', {}, text('Supporting line under the headline', kw.sub ?? '', (v) => { kw.sub = v; })) : (null as unknown as Node),
      kw.kind === 'tweet' ? h('div', {},
        h('div', { class: 'at-label', style: 'margin-top:10px' }, 'Post card'),
        h('div', { class: 'at-hint' }, 'Use a made-up or generic name unless you really are quoting that account.'),
        text('Author name (optional)', kw.post?.name ?? '', (v) => { kw.post = { ...blankPost(kw.post), name: v }; }),
        text('@handle (optional)', kw.post?.handle ?? '', (v) => { kw.post = { ...blankPost(kw.post), handle: v }; }),
        text('What the post says', kw.post?.text ?? '', (v) => { kw.post = { ...blankPost(kw.post), text: v }; }),
        text('Likes, e.g. 12.4K (optional)', kw.post?.likes ?? '', (v) => { kw.post = { ...blankPost(kw.post), likes: v || undefined }; }),
        text('Reposts, e.g. 3.1K (optional)', kw.post?.reposts ?? '', (v) => { kw.post = { ...blankPost(kw.post), reposts: v || undefined }; })) : (null as unknown as Node),
      kw.kind === 'receipt' ? h('div', {},
        h('div', { class: 'at-label', style: 'margin-top:10px' }, 'Receipt'),
        text('Heading, e.g. The Math', kw.receipt?.shop ?? '', (v) => { kw.receipt = { ...blankReceipt(kw.receipt), shop: v }; }),
        receiptBox(kw.receipt?.lines, (lines) => { kw.receipt = { ...blankReceipt(kw.receipt), lines }; }),
        text('Total, e.g. $27.00 (optional)', kw.receipt?.total ?? '', (v) => { kw.receipt = { ...blankReceipt(kw.receipt), total: v || undefined }; })) : (null as unknown as Node),
      kw.kind === 'svg' ? h('div', {},
        h('div', { class: 'at-hint', style: 'margin-top:10px' }, 'Paste one <svg> with a viewBox (plain shapes and text). Scripts, pictures and links are removed.'),
        svgBox()) : (null as unknown as Node),
      h('div', { class: 'at-label', style: 'margin-top:10px' }, kw.kind === 'quote' ? 'Headline (bold + italic + bold)' : 'Title (bold + italic + bold)'),
      text('Bold start, e.g. The', kw.a, (v) => { kw.a = v; }),
      text('Italic part, e.g. Desire Hook', kw.b, (v) => { kw.b = v; }),
      text('Second line, e.g. Method', kw.c, (v) => { kw.c = v; }),
      kw.kind === 'steps' || kw.kind === 'loop' || kw.kind === 'versus' ? h('div', {}, h('div', { class: 'at-label', style: 'margin-top:10px' }, kw.kind === 'versus' ? 'Two sides (2 lines)' : 'Points'), stepsBox) : (null as unknown as Node),
      h('div', { style: 'margin-top:10px' }, text('@handle above the video (optional)', kw.handle, (v) => { kw.handle = v; })),
      slider('Total length', 3, 40, 1, kwSeconds, (v) => `${v}s`, (v) => { kwSeconds = v; }),
      h('button', { class: 'btn primary', style: 'width:100%;min-height:46px;margin-top:6px', disabled: busy ? 'true' : undefined, onclick: () => void addKallaway() }, busy ? 'Drawing...' : 'Add card at playhead'));
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

  // ------------------------------------------------------------ Kallaway beats: the picture is redrawn when anything about it changes
  const kwNote = () => h('div', { class: 'at-hint', style: 'margin-top:10px' }, 'This is a Kallaway scene (a finished picture). Its look is set in the Beats and Layout tabs; Templates, Fonts and Colors do not apply.');

  /** Draws one card again with `mut` applied to its recipe; returns its new beats. Words are re-timed to the captions. */
  async function bakeGroup(b: DocuBeat, mut: (s: KallawaySpec) => void): Promise<DocuBeat[]> {
    const old = b.kw!;
    const spec: KallawaySpec = { ...old.spec, stepStarts: undefined };
    mut(spec);
    if (spec.kind === 'steps' || spec.kind === 'loop') {
      const pts = spec.steps.filter((x) => x.trim()).slice(0, 5);
      const words = ctx.p.captions?.words.length ? ctx.p.captions.words : ctx.p.agentWords?.words;
      spec.stepStarts = syncStepStarts(pts, words, old.gStart, old.gEnd);
    }
    return makeKallawayBeats(ctx.p.aspect, spec, old.gStart, old.gEnd);
  }

  async function rebake(b: DocuBeat, mut: (s: KallawaySpec) => void) {
    if (busy || !b.kw) return;
    if (b.kw.spec.kind === 'photo') { toast('Picture cards cannot be redrawn. Delete it and add it again.', 4000); return; }
    const old = b.kw;
    busy = true; render();
    try {
      const nb = await bakeGroup(b, mut);
      ctx.p.docu = [...beats().filter((x) => x.kw?.gid !== old.gid), ...nb].sort((a, c) => a.start - c.start);
      sel = (nb.find((x) => b.start >= x.start && b.start < x.end) ?? nb[0])?.id ?? null;
      ctx.changed();
    } catch (e) { toast(`Could not redraw it: ${(e as Error).message || 'failed'}`, 5000); }
    finally { busy = false; render(); }
  }

  /** The same screen choice for EVERY scene: half screen (you in a window, on any side) or full screen. */
  async function applyAll(o: { screen?: 'half' | 'full'; sit?: 'left' | 'right' | 'top' | 'bottom' }) {
    if (busy) return;
    busy = true; render();
    try {
      const done = new Set<string>();
      let next: DocuBeat[] = [];
      for (const b of beats()) {
        if (b.kw) {
          if (done.has(b.kw.gid)) continue;
          done.add(b.kw.gid);
          if (b.kw.spec.kind === 'photo') { next.push(...beats().filter((x) => x.kw?.gid === b.kw!.gid)); continue; }
          const was = isFullScreen(b.kw.spec);
          next.push(...await bakeGroup(b, (sp) => {
            const keep = sp.speaker && sp.speaker !== 'none' ? sp.speaker : undefined;
            const screen = o.screen ?? (was ? 'full' : 'half');
            const sit = o.sit ?? keep;
            sp.speaker = screen === 'full' ? 'none' : sit ?? undefined;
          }));
        } else {
          const nb = { ...b };
          if (o.screen === 'full') nb.type = 'black_screen';
          else if (o.screen === 'half') nb.type = 'split_screen';
          if (o.sit) { nb.video_position = o.sit; nb.layout = o.sit === 'top' || o.sit === 'bottom' ? 'updown' : 'side'; }
          next.push(nb);
        }
      }
      ctx.p.docu = next.sort((a, c) => a.start - c.start);
      ctx.changed();
    } catch (e) { toast(`Could not change all scenes: ${(e as Error).message || 'failed'}`, 5000); }
    finally { busy = false; render(); }
  }

  /** "All scenes" block at the top of the Layout tab. */
  function allScenesBlock(): Node {
    return sec('All scenes at once',
      chipRow<'half' | 'full'>('Screen', [['half', 'Half screen'], ['full', 'Full screen']], 'half', (v) => { void applyAll({ screen: v }); }),
      chipRow<string>('You sit', SIT_CHOICES, '', (v) => { void applyAll({ screen: 'half', sit: v as 'left' | 'right' | 'top' | 'bottom' }); }));
  }

  /** Words of a Kallaway scene: title parts, points, number, supporting line. "Apply" redraws it. */
  function renderKwEdit(b: DocuBeat): Node[] {
    const sp = b.kw!.spec;
    const draft = { a: sp.a, b: sp.b, c: sp.c, steps: sp.steps.join('\n'), big: sp.stat?.big ?? '', label: sp.stat?.label ?? '', sub: sp.sub ?? '', pName: sp.post?.name ?? '', pHandle: sp.post?.handle ?? '', pText: sp.post?.text ?? '', pLikes: sp.post?.likes ?? '', pReposts: sp.post?.reposts ?? '', rShop: sp.receipt?.shop ?? '', rLines: sp.receipt?.lines ?? [], rTotal: sp.receipt?.total ?? '' };
    const field = (label: string, v: string, on: (x: string) => void) => {
      const el = h('input', { type: 'text', class: 'ts-input', value: v, 'aria-label': label, placeholder: label, enterkeyhint: 'done', style: 'width:100%;margin-top:6px' }) as HTMLInputElement;
      el.addEventListener('input', () => on(el.value)); return el;
    };
    const pts = sp.kind === 'steps' || sp.kind === 'loop' || sp.kind === 'versus';
    const box = pts ? (h('textarea', { class: 'ts-input', rows: 5, 'aria-label': 'Points, one per line', style: 'width:100%;margin-top:6px;background:#242424;border-radius:2px;padding:10px;resize:none' }) as HTMLTextAreaElement) : null;
    if (box) { box.value = draft.steps; box.addEventListener('input', () => { draft.steps = box.value; }); }
    return [
      h('div', { class: 'at-hint', style: 'margin-top:10px' }, `Kallaway scene · ${sp.kind}. Change the words, then tap Redraw.`),
      h('div', { class: 'at-label', style: 'margin-top:8px' }, 'Title'),
      field('Bold start', draft.a, (x) => { draft.a = x; }), field('Italic part', draft.b, (x) => { draft.b = x; }), field('Second line', draft.c, (x) => { draft.c = x; }),
      box ? h('div', {}, h('div', { class: 'at-label', style: 'margin-top:8px' }, sp.kind === 'versus' ? 'Two sides (2 lines)' : 'Points (1 per line)'), box) : (null as unknown as Node),
      sp.kind === 'stat' ? h('div', {}, field('Big number', draft.big, (x) => { draft.big = x; }), field('Line under it', draft.label, (x) => { draft.label = x; })) : (null as unknown as Node),
      sp.kind === 'quote' || sp.kind === 'loop' ? field(sp.kind === 'loop' ? 'Centre word' : 'Supporting line', draft.sub, (x) => { draft.sub = x; }) : (null as unknown as Node),
      sp.kind === 'tweet' ? h('div', {}, field('Author name', draft.pName, (x) => { draft.pName = x; }), field('@handle', draft.pHandle, (x) => { draft.pHandle = x; }), field('Post text', draft.pText, (x) => { draft.pText = x; }), field('Likes', draft.pLikes, (x) => { draft.pLikes = x; }), field('Reposts', draft.pReposts, (x) => { draft.pReposts = x; })) : (null as unknown as Node),
      sp.kind === 'receipt' ? h('div', {}, field('Heading', draft.rShop, (x) => { draft.rShop = x; }), receiptBox(draft.rLines, (l) => { draft.rLines = l; }), field('Total', draft.rTotal, (x) => { draft.rTotal = x; })) : (null as unknown as Node),
      h('button', { class: 'btn primary', style: 'width:100%;min-height:46px;margin-top:10px', disabled: busy ? 'true' : undefined, onclick: () => void rebake(b, (s) => {
        s.a = draft.a.trim(); s.b = draft.b.trim(); s.c = draft.c.trim();
        if (pts) s.steps = draft.steps.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, sp.kind === 'versus' ? 2 : 5);
        if (sp.kind === 'stat') s.stat = { ...(s.stat ?? { big: '' }), big: draft.big.trim() || s.stat?.big || '', label: draft.label.trim() || undefined };
        if (sp.kind === 'quote' || sp.kind === 'loop') s.sub = draft.sub.trim();
        if (sp.kind === 'tweet') s.post = { name: draft.pName.trim(), handle: draft.pHandle.trim(), text: draft.pText.trim() || s.post?.text || '', likes: draft.pLikes.trim() || undefined, reposts: draft.pReposts.trim() || undefined };
        if (sp.kind === 'receipt') s.receipt = { shop: draft.rShop.trim(), lines: draft.rLines.filter((l) => l.label || l.amount).length >= 2 ? draft.rLines : s.receipt?.lines ?? [], total: draft.rTotal.trim() || undefined };
      }) }, busy ? 'Drawing...' : 'Redraw'),
    ];
  }

  /** Layout of a Kallaway scene: with you in a window (side, size) or full screen. Every tap redraws the picture, so the video moves with it. */
  function renderKwLayout(b: DocuBeat): Node[] {
    const sp = b.kw!.spec, full = isFullScreen(sp), tall = layout() === 'updown';
    return [
      allScenesBlock(),
      chipRow<'win' | 'full'>('Scene', [['win', 'With you in a window'], ['full', 'Full screen']], full ? 'full' : 'win', (v) => { void rebake(b, (s) => { s.speaker = v === 'full' ? 'none' : tall ? 'bottom' : 'right'; }); }),
      full ? (null as unknown as Node) : chipRow<string>('You sit', SIT_CHOICES, sp.speaker && sp.speaker !== 'none' ? sp.speaker : tall ? 'bottom' : 'right', (v) => { void rebake(b, (s) => { s.speaker = v as KallawaySpec['speaker']; }); }),
      full ? (null as unknown as Node) : chipRow<string>('Card size', KALLAWAY_SHARES.map(([v, l]) => [String(v), l] as [string, string]), String(sp.share ?? (tall ? 0.6 : 0.52)), (v) => { void rebake(b, (s) => { s.share = Number(v); }); }),
      slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }),
    ];
  }

  function renderTemplates(b: DocuBeat | undefined): Node[] {
    if (b?.kw) return [kwNote()];
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
    if (b.kw) return renderKwLayout(b);
    const split = b.type === 'split_screen';
    const wide = layout() === 'side';
    const posTile = (pos: DocuPos) => h('button', { class: 'dt-tile' + (b.video_position === pos ? ' on' : '') + (split ? '' : ' dim'), 'aria-label': POS_LABEL[pos], disabled: split ? undefined : 'true',
      onclick: () => { patch((x) => { x.video_position = pos; x.layout = pos === 'top' || pos === 'bottom' ? 'updown' : 'side'; }); render(); } },
      h('div', { class: 'dt-prev' }, miniLayout(pos, true)), h('span', { class: 'dt-name' }, POS_LABEL[pos]));
    const lookTile = (k: DocuType) => h('button', { class: 'dt-tile' + (b.type === k ? ' on' : ''), 'aria-label': DOCU_TYPE_LABEL[k],
      onclick: () => { patch((x) => { x.type = k; if (k !== 'kinetic_quote' && x.style) delete x.style.lower; }); render(); } },
      h('div', { class: 'dt-prev' }, h('div', { class: 'dt-look ' + k })), h('span', { class: 'dt-name' }, DOCU_TYPE_LABEL[k]));
    return [
      allScenesBlock(),
      sec('You sit (half screen)', tileGrid(posTile('left'), posTile('right'), posTile('top'), posTile('bottom'))),
      sec('Look', tileGrid(...(Object.keys(DOCU_TYPE_LABEL) as DocuType[]).map(lookTile))),
      slider('Corner radius', 0, MAX_CARD_RADIUS, 1, b.card_radius, (v) => `${v}px`, (v) => { patch((x) => { x.card_radius = v; }); }),
      slider('Card padding', 0, 120, 2, b.style?.pad ?? 43, (v) => `${v}px`, (v) => { patch((x) => { st(x).pad = v; }); }),
      slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }),
    ];
  }

  function renderFonts(b: DocuBeat | undefined): Node[] {
    if (!b) return [];
    if (b.kw) return [kwNote()];
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
    if (b?.kw) return [kwNote()];
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

  /** One-tap creator looks (captions, cards, B-roll moves). */
  function creatorBlock(): Node {
    const none = h('button', { class: 'dt-tile' + (!ctx.p.creator ? ' on' : ''), 'aria-label': 'None', disabled: loadingTile ? 'true' : undefined, onclick: () => applyLook(null) },
      h('div', { class: 'dt-prev' }, icon('close', 30)), h('span', { class: 'dt-name' }, 'None'), h('span', { class: 'dt-sub' }, 'Remove the look'));
    return h('div', { class: 'at-sec', style: 'margin-top:6px' },
      tileGrid(none, ...CREATORS.map((c) => {
        const face = h('div', { class: 'dt-prev', style: `background:${c.swatch[0]};` },
          h('div', { class: 'dt-card', style: `background:${c.swatch[1]};border:1px solid rgba(255,255,255,.18);border-radius:6px` },
            h('b', { style: `color:${isLightHex(c.swatch[1]) ? '#000' : '#fff'}` }, 'AA'), h('i', { style: `background:${c.swatch[2]}` })),
          loadingTile === c.id ? h('div', { class: 'dt-load' }, spinner(26)) : (null as unknown as Node));
        return h('button', { class: 'dt-tile' + (ctx.p.creator === c.id ? ' on' : ''), 'aria-label': c.name, disabled: loadingTile ? 'true' : undefined, onclick: () => applyLook(c.id) },
          face, h('span', { class: 'dt-name' }, c.name), h('span', { class: 'dt-sub' }, c.hint));
      })));
  }
  /** Tap a look: the card shows a loading ring, then the look is on. None takes the whole look off (cards, B-roll, caption look). */
  let loadingTile: string | null = null;
  function applyLook(id: CreatorId | null) {
    if (loadingTile) return;
    loadingTile = id ?? 'none'; render();
    window.setTimeout(() => {
      if (id) {
        const r = applyCreator(ctx.p, id);
        toast(`${CREATORS.find((c) => c.id === id)!.name} applied${r.beats ? `, ${r.beats} card${r.beats > 1 ? 's' : ''}` : ''}.`, 2500);
      } else {
        ctx.p.docu = []; ctx.p.broll = []; delete ctx.p.creator; delete ctx.p.captionStyle;
        sel = null; kwNew = true;
        toast('Look removed.', 2000);
      }
      loadingTile = null; ctx.changed(); render();
    }, 450);
  }

  /** The Kallaway bottom sheet: one chip per card, edit words + layout of the chosen card, or make a new one. */
  function renderKallawayTab(): Node[] {
    const kids: Node[] = [];
    const seen = new Set<string>();
    const cards = sorted().filter((x) => x.kw && !seen.has(x.kw.gid) && !!seen.add(x.kw.gid));
    if (!kwNew && cards.length && !cur()?.kw) sel = cards[0]!.id;
    const b = cur()?.kw ? cur() : undefined;
    if (!cards.length) kwNew = true;
    kids.push(h('div', { class: 'schips', style: 'margin-top:8px;flex-wrap:nowrap;overflow-x:auto' },
      ...cards.map((x, i) => h('button', { class: 'chip' + (!kwNew && b?.kw?.gid === x.kw!.gid ? ' on' : ''), onclick: () => { kwNew = false; pick(x.id); } }, `${i + 1} · ${x.kw!.spec.kind}`)),
      h('button', { class: 'chip' + (kwNew ? ' on' : ''), onclick: () => { kwNew = true; render(); } }, '+ New card')));
    if (kwNew || !b) { kids.push(kallawayForm()); return kids; }
    if (b.kw!.spec.kind === 'photo') kids.push(h('div', { class: 'at-hint', style: 'margin-top:10px' }, 'This card is a picture. Change its side, size and length below, or delete it and add it again.'));
    else kids.push(...renderKwEdit(b));
    kids.push(h('div', { class: 'at-label', style: 'margin-top:14px' }, 'Layout'), ...renderKwLayout(b));
    return kids;
  }

  function render() {
    renderTabs();
    if (tab === 'kallaway') { body.replaceChildren(...renderKallawayTab()); return; }
    if (cur()?.kw && tab === 'beats') sel = beats().find((x) => !x.kw)?.id ?? null;
    const b = cur();
    const list = sorted();
    if (tab === 'templates') { body.replaceChildren(creatorBlock()); return; }
    if (tab !== 'beats') {
      const kids = [...styleHead(list)];
      if (list.length) kids.push(...(tab === 'layout' ? renderLayout(b) : tab === 'fonts' ? renderFonts(b) : renderColors(b)));
      body.replaceChildren(...kids);
      return;
    }
    // Beats tab: creator looks first, then the two ways to add visuals, then the plain beats (Kallaway cards live in their own sheet)
    const plain = list.filter((x) => !x.kw);
    const kids: Node[] = [
      h('button', { class: 'btn primary', style: 'width:100%;min-height:52px;font-size:16px;margin-top:4px', disabled: busy ? 'true' : undefined, onclick: () => void runKallawayAi(true) }, busy ? 'Editing...' : 'Auto edit'),
      h('div', { class: 'at-hint', style: 'margin-top:6px' }, 'One tap: cards, photos, clips and motion graphics are placed from your words, in the look chosen below (Kallaway if none).'),
      creatorBlock(),
    ];
    kids.push(h('div', { class: 'at-sec', style: 'display:flex;gap:8px;margin-top:10px' },
      h('button', { class: 'btn', style: 'flex:1;min-height:46px', onclick: () => ctx.openKallaway?.() }, 'Kallaway cards'),
      h('button', { class: 'btn', style: 'flex:1;min-height:46px', onclick: () => void runAi(), disabled: busy ? 'true' : undefined }, busy ? 'Finding moments...' : 'AI beats')));
    if (plain.length) kids.push(h('div', { class: 'schips', style: 'margin-top:12px;flex-wrap:nowrap;overflow-x:auto' },
      ...plain.map((x, i) => h('button', { class: 'chip' + (x.id === sel ? ' on' : ''), onclick: () => { selBroll = undefined; pick(x.id); } }, `${i + 1} · ${x.headline.slice(0, 14) || 'Beat'}`)),
      h('button', { class: 'chip', onclick: add }, '+ Add')));
    else kids.push(h('div', { class: 'at-hint', style: 'margin-top:12px' }, 'Tap a creator look, or let AI beats pick documentary moments from your words. Cards with numbers, steps and quotes are in Kallaway cards.'));
    if (b && !b.kw) kids.push(
      input('Headline', b.headline, (v) => { b.headline = v; ctx.changed(); }),
      slider('Length', 1, 10, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => { b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000)); ctx.changed(); }),
      h('div', { class: 'at-hint' }, 'Look, video side and padding: Layout tab.'));
    if (selBroll) {
      brollPane ??= buildBrollPane({ p: ctx.p, playMs: ctx.playMs, durationMs: ctx.durationMs, changed: ctx.changed, seek: ctx.seek, words: ctx.words, aspect: ctx.aspect, startId: selBroll });
      brollPane.select(selBroll);
      kids.push(h('div', { class: 'at-sec', style: 'margin-top:14px' }, brollPane.el));
    }
    body.replaceChildren(...kids);
  }
  render();
  return {
    close,
    select: (t, id) => {
      if (t === 'broll') { selBroll = id; tab = 'beats'; render(); return; }
      if (beats().some((x) => x.id === id)) { sel = id; selBroll = undefined; if (only === 'kallaway') kwNew = false; render(); }
    },
  };
}
