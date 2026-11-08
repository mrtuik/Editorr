import { buildPages, DEFAULT_CAPTION_STYLE, drawCaption, LOOKS, fxIsEmpty, lookOf, type CapLook, type CaptionStyle, type Fx } from '../core/captions';
import { needsRoman } from '../core/romanize';
import { LANGS, WHISTLE_MODELS, normLang } from '../core/transcribe';
import type { Project, Settings } from '../core/types';
import { saveSettings } from '../core/store';
import { isKept } from '../core/timeline';
import { h, icon, fmtClock, toast } from '../ui';
import { chips } from './faceOptions';
import { effectsPanel, fontsPanel, stylePanel, type FxModel } from './fxEditor';

export interface CaptionCtx {
  p: Project;
  settings: Settings;
  /** Runs Whistle (the editor shows the progress). true = captions were made. */
  generate: (lang: string) => Promise<boolean>;
  /** Style or text changed: redraw the preview and save. */
  changed: () => void;
  remove: () => void;
  seek: (ms: number) => void;
  /** Descript-style: cut this time range (ms, source time) out of the video. */
  cut: (startMs: number, endMs: number) => void;
  /** The word being edited (index in p.captions.words, -1 = none): the preview frames it. */
  onSelect?: (word: number) => void;
  onClosed?: () => void;
}
export interface CaptionSheetHandle { selectWord: (i: number) => void; close: () => void }

const COLORS = ['#FFFFFF', '#FFD60A', '#FF453A', '#30D158', '#0A84FF', '#FF9F0A', '#BF5AF2', '#000000'];

export function swatches(label: string, value: string, onPick: (c: string) => void): HTMLElement {
  const row = h('div', { class: 'cap-sw' });
  const render = (cur: string) => row.replaceChildren(...COLORS.map((c) =>
    h('button', { class: 'cap-dot' + (c.toLowerCase() === cur.toLowerCase() ? ' on' : ''), style: `background:${c}`, 'aria-label': c, onclick: () => { onPick(c); render(c); } })));
  render(value);
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), row);
}

/** Text > Caption. First time: pick language, make captions. Then: looks and settings. */
export function openCaptionSheet(ctx: CaptionCtx, startWord = -1): CaptionSheetHandle {
  const { p, settings: s } = ctx;
  const save = () => { void saveSettings(s); };
  const body = h('div', { class: 'at-body' });
  const foot = h('div', { class: 'at-foot' });
  const title = h('div', { class: 'at-title' }, 'Captions');
  let closed = false;
  const close = () => { if (closed) return; closed = true; ctx.onSelect?.(-1); sheet.classList.add('out'); setTimeout(() => box.remove(), 180); ctx.onClosed?.(); };
  const sheet = h('div', { class: 'at-sheet cs', role: 'dialog' },
    h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Close', onclick: close }, icon('back', 20)), title, h('span', { class: 'at-head-gap' })),
    body, foot);
  const box = h('div', { class: 'at-scrim clear', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);

  const style = (): CaptionStyle => (p.captionStyle ??= { ...DEFAULT_CAPTION_STYLE });

  function renderMake() {
    title.textContent = 'Auto captions';
    foot.replaceChildren(h('button', { class: 'btn primary at-go', onclick: async () => {
      sheet.classList.add('out'); box.style.display = 'none';
      const ok = await ctx.generate(normLang(s.captionLang));
      box.style.display = ''; sheet.classList.remove('out');
      if (ok) renderStyle();
    } }, icon('wand', 20), 'Generate captions'));
    const tokenBox = h('div', { class: 'at-sec' },
      h('div', { class: 'at-label' }, 'Hugging Face token (Bangla model)'),
      h('input', { type: 'password', class: 'cap-input', placeholder: 'hf_...', value: s.whistleHfToken ?? '',
        onchange: (e: Event) => { s.whistleHfToken = (e.target as HTMLInputElement).value.trim(); save(); } }),
      h('div', { class: 'at-hint' }, 'The Bangla Whistle model is gated and research-only (non-commercial). Accept its license on huggingface.co/ehzawad/whistle-bn-BD-2bit, make a read token, paste it here once.'));
    const sync = () => { tokenBox.style.display = normLang(s.captionLang) === 'bengali' ? '' : 'none'; };
    const langName = (l?: string) => { const m = WHISTLE_MODELS[normLang(l)]; return `${m.name}, ${m.sizeMb} MB, downloads once`; };
    sync();
    body.replaceChildren(
      chips<string>('Spoken language', 'Whistle is a tiny speech engine (17-30 MB) that runs on the phone. ' + langName(s.captionLang),
        LANGS.map(([v, l]) => [v, l] as [string, string]), normLang(s.captionLang), (v) => { s.captionLang = v; save(); sync(); }),
      tokenBox,
      h('div', { class: 'at-hint' }, 'Bangla is shown as Banglish and Hindi as Hinglish. You can switch to the original script later.'));
  }

  let selWord = -1;
  let scope: 'word' | 'all' = 'word';
  let tapMode: 'edit' | 'cut' = 'edit';
  type WTab = 'Styles' | 'Fonts' | 'Effects';
  let wordTab: WTab = 'Styles';
  type STab = 'Style' | 'Layout' | 'Text' | 'Words';
  let styleTab: STab = 'Style';
  /** where Done in the word editor goes back to */
  let backTo: 'style' | 'caption' = 'style';
  let capRange: { from: number; to: number } | null = null;
  const styleKeep = { sub: 'Text' as 'Text' | 'Stroke' | 'Glow' | 'Background' | 'Shadow' };

  /** Tap on a word: the video jumps there, the word gets a frame, and its tools open. */
  function selectWord(i: number, back: 'style' | 'caption' = 'style') {
    const w = p.captions?.words[i]; if (!w) return;
    tidyFx();
    backTo = back;
    selWord = i; scope = 'word';
    ctx.seek(w.s); ctx.onSelect?.(i);
    renderWord();
  }
  /** Empty style objects are not kept in the project. */
  function tidyFx() {
    for (const w of p.captions?.words ?? []) if (w.fx && fxIsEmpty(w.fx)) delete w.fx;
    const st = style(); if (st.fx && fxIsEmpty(st.fx)) delete st.fx;
  }
  function wordModel(i: number): FxModel {
    const st = style(); const w = p.captions!.words[i];
    return {
      look: () => lookOf(st.look),
      color: () => w.fx?.color ?? st.color,
      setColor: (c) => { (w.fx ??= {}).color = c; ctx.changed(); },
      own: () => (w.fx ??= {}),
      below: () => st.fx,
      patch: (f) => { f((w.fx ??= {})); ctx.changed(); },
      size: { label: 'Size', min: 0.5, max: 2, step: 0.05, get: () => w.fx?.scale ?? 1, set: (v) => { (w.fx ??= {}).scale = v; ctx.changed(); }, fmt: (v) => `${Math.round(v * 100)}%` },
    };
  }
  function allModel(): FxModel {
    const st = style();
    return {
      look: () => lookOf(st.look),
      color: () => st.color,
      setColor: (c) => { st.color = c; ctx.changed(); },
      own: () => (st.fx ??= {}),
      below: () => undefined,
      patch: (f) => { f((st.fx ??= {})); ctx.changed(); },
      size: { label: 'Size', min: 0.03, max: 0.12, step: 0.005, get: () => st.size, set: (v) => { st.size = v; ctx.changed(); }, fmt: (v) => String(Math.round(v * 1000)) },
    };
  }

  /** One word (or all words): text, tabs Styles / Fonts / Effects, then Cut / Reset / Done. */
  function renderWord() {
    const c = p.captions; if (!c) { renderMake(); return; }
    if (scope === 'word' && !c.words[selWord]) { scope = 'all'; }
    const w = scope === 'word' ? c.words[selWord] : undefined;
    const st = style();
    title.textContent = scope === 'word' ? 'Edit word' : 'All words';
    const m = scope === 'word' ? wordModel(selWord) : allModel();

    const leave = () => {
      tidyFx(); ctx.changed();
      if (scope === 'word' && backTo === 'caption' && capRange && p.captions?.words[capRange.from]) { selWord = capRange.from; ctx.onSelect?.(selWord); renderCaption(capRange.from, capRange.to); return; }
      selWord = -1; ctx.onSelect?.(-1); renderStyle();
    };
    const input = h('input', { type: 'text', class: 'ts-input cs-word', value: w ? (st.roman ? w.w : (w.orig || w.w)) : 'All words', 'aria-label': 'Word', disabled: !w }) as HTMLInputElement;
    if (w) input.addEventListener('input', () => { w.w = input.value; w.orig = input.value; ctx.changed(); });
    const scopeRow = h('div', { class: 'cs-mode' },
      h('button', { class: 'cs-mode-b' + (scope === 'word' ? ' on' : ''), disabled: !c.words[selWord] && selWord < 0, onclick: () => { if (selWord < 0) { toast('Tap a word first.'); return; } scope = 'word'; renderWord(); } }, 'This word'),
      h('button', { class: 'cs-mode-b' + (scope === 'all' ? ' on' : ''), onclick: () => { scope = 'all'; renderWord(); } }, 'All words'));
    const tabs = h('div', { class: 'ts-tabs' }, ...(['Styles', 'Fonts', 'Effects'] as WTab[]).map((t) => h('button', { class: 'ts-tab' + (t === wordTab ? ' on' : ''), onclick: () => { wordTab = t; renderWord(); } }, t)));
    const panel = wordTab === 'Styles' ? stylePanel(m, styleKeep) : wordTab === 'Fonts' ? fontsPanel(m, renderWord) : effectsPanel(m, renderWord);

    body.replaceChildren(
      h('div', { class: 'cs-top' },
        h('div', { class: 'ts-field' }, input),
        ...(w ? [h('span', { class: 'cs-time' }, fmtClock(w.s))] : [])),
      scopeRow, tabs, h('div', { class: 'cs-panel' }, panel));
    foot.replaceChildren(h('div', { class: 'cs-actions' },
      ...(w ? [h('button', { class: 'btn', onclick: () => { ctx.cut(w.s, w.e); toast('Word cut from the video. Undo brings it back.'); leave(); } }, icon('scissors', 18), 'Cut')] : []),
      h('button', { class: 'btn', onclick: () => {
        if (scope === 'word' && w) delete w.fx; else delete style().fx;
        ctx.changed(); renderWord();
      } }, 'Reset'),
      h('button', { class: 'btn primary cs-done', onclick: leave }, icon('check', 20), 'Done')));
  }

  /** The caption (page) a word belongs to. */
  function pageOf(i: number) { return buildPages(p.captions, style()).find((pg) => i >= pg.from && i <= pg.to); }

  /** Tap on one caption: only that caption opens for editing. */
  function selectCaption(i: number) {
    const pg = pageOf(i); if (!pg) return;
    tidyFx();
    ctx.seek(pg.s); ctx.onSelect?.(pg.from);
    selWord = pg.from;
    renderCaption(pg.from, pg.to);
  }

  /** One caption: fix its text (a wrong transcription), jump to the next / previous one, cut it, or style one of its words. Other captions are not touched. */
  function renderCaption(from: number, to: number) {
    const c = p.captions; if (!c) { renderMake(); return; }
    capRange = { from, to };
    const st = style();
    const shown = (w: { w: string; orig?: string }) => (st.roman ? w.w : (w.orig || w.w));
    const range = () => c.words.slice(capRange!.from, capRange!.to + 1);
    title.textContent = 'Edit caption';
    const input = h('input', { type: 'text', class: 'ts-input cs-word', value: range().map(shown).join(' '), 'aria-label': 'Caption text', enterkeyhint: 'done' }) as HTMLInputElement;

    /** Same number of words: change them in place (timing and word styles stay). Different number: re-time just this caption. */
    function apply(final: boolean) {
      const parts = input.value.trim().split(/\s+/).filter(Boolean);
      const cur = range();
      if (!parts.length) return;
      if (parts.length === cur.length) {
        let any = false;
        parts.forEach((t, k) => { if (shown(cur[k]!) !== t) { cur[k]!.w = t; cur[k]!.orig = t; any = true; } });
        if (any) ctx.changed();
        return;
      }
      if (!final) return;
      const a = cur[0]!, b = cur[cur.length - 1]!;
      const span = Math.max(100, b.e - a.s);
      const neu = parts.map((t, k) => ({ w: t, orig: t, s: Math.round(a.s + (span * k) / parts.length), e: Math.round(a.s + (span * (k + 1)) / parts.length) }));
      c!.words.splice(capRange!.from, cur.length, ...neu);
      capRange = { from: capRange!.from, to: capRange!.from + neu.length - 1 };
      ctx.changed();
    }
    input.addEventListener('input', () => apply(false));
    input.addEventListener('change', () => { apply(true); renderCaption(capRange!.from, capRange!.to); });

    const pages = buildPages(c, st);
    const idx = Math.max(0, pages.findIndex((pg) => capRange!.from >= pg.from && capRange!.from <= pg.to));
    const go = (k: number) => { apply(true); const pg = buildPages(c, st)[k]; if (pg) selectCaption(pg.from); };
    const chipsEl = h('div', { class: 'cap-trans' }, ...range().map((w, k) => h('button', { class: 'cap-tw' + (!fxIsEmpty(w.fx) ? ' styled' : ''), onclick: () => { apply(true); selectWord(capRange!.from + k, 'caption'); } }, shown(w))));
    const done = () => { apply(true); tidyFx(); selWord = -1; capRange = null; ctx.onSelect?.(-1); ctx.changed(); styleTab = 'Text'; renderStyle(); };

    body.replaceChildren(
      h('div', { class: 'cs-top' }, h('div', { class: 'ts-field' }, input), h('span', { class: 'cs-time' }, fmtClock(c.words[capRange.from]?.s ?? 0))),
      h('div', { class: 'at-hint' }, `Caption ${idx + 1} of ${pages.length}. Fix the words here. Only this caption changes.`),
      h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Style one word'), chipsEl));
    foot.replaceChildren(h('div', { class: 'cs-actions' },
      h('button', { class: 'btn', 'aria-label': 'Previous caption', disabled: idx <= 0 ? 'true' : undefined, onclick: () => go(idx - 1) }, icon('back', 18)),
      h('button', { class: 'btn', 'aria-label': 'Next caption', disabled: idx >= pages.length - 1 ? 'true' : undefined, onclick: () => go(idx + 1) }, icon('chevR', 18)),
      h('button', { class: 'btn', onclick: () => { apply(true); const a = c.words[capRange!.from], b = c.words[capRange!.to]; if (a && b) { ctx.cut(a.s, b.e); toast('Caption cut from the video. Undo brings it back.'); } done(); } }, icon('scissors', 18), 'Cut'),
      h('button', { class: 'btn primary cs-done', onclick: done }, icon('check', 20), 'Done')));
  }

  function renderStyle() {
    title.textContent = 'Captions';
    const st = style();
    const hasScript = !!p.captions?.words.some((w) => needsRoman(w.orig));
    const looks = h('div', { class: 'cap-looks' });
    const drawLooks = () => looks.replaceChildren(...LOOKS.map((lk) => {
      const cv = h('canvas', { width: '240', height: '120', class: 'cap-cv' }) as HTMLCanvasElement;
      const g = cv.getContext('2d')!;
      g.fillStyle = '#2a2a2e'; g.fillRect(0, 0, 240, 120);
      drawCaption(g, 240, 120, { s: 0, e: 1, from: 0, to: 1, words: [{ t: 'Your', s: 0, e: 1 }, { t: 'words', s: 2, e: 3 }] }, 2.5,
        { ...st, look: lk.id, size: 0.2, y: 0.55 });
      return h('button', { class: 'cap-look' + (st.look === lk.id ? ' on' : ''), onclick: () => { st.look = lk.id as CapLook; ctx.changed(); drawLooks(); } }, cv, h('span', {}, lk.name));
    }));
    drawLooks();

    // Transcript: tap a word to style it (font, colour, shadow...). Switch to "Cut" to remove words from the video, Descript-style.
    const trans = h('div', { class: 'cap-trans' });
    const drawTrans = () => {
      const c = p.captions; if (!c) return;
      trans.replaceChildren(...c.words.map((w, i) => {
        const gone = !isKept(p.segments, (w.s + w.e) / 2);
        const t = st.roman ? w.w : (w.orig || w.w);
        const styled = !fxIsEmpty(w.fx);
        return h('button', { class: 'cap-tw' + (gone ? ' gone' : '') + (styled ? ' styled' : '') + (i === selWord ? ' on' : ''),
          onclick: () => {
            if (tapMode === 'cut') { if (gone) { ctx.seek(w.s); return; } ctx.cut(w.s, w.e); drawTrans(); drawList(); return; }
            selectWord(i, 'style');
          } }, t);
      }));
    };
    const list = h('div', { class: 'cap-pages' });
    const drawList = () => {
      const pages = buildPages(p.captions, st);
      list.replaceChildren(...pages.map((pg, n) => h('button', { class: 'cap-line', onclick: () => selectCaption(pg.from) },
        h('span', { class: 'cap-time' }, `${Math.floor(pg.s / 60000)}:${String(Math.floor(pg.s / 1000) % 60).padStart(2, '0')}`),
        h('span', { class: 'cap-line-t' }, pg.words.map((x) => x.t).join(' ') || `Caption ${n + 1}`))));
    };
    drawList(); drawTrans();

    const tabsBar = h('div', { class: 'ts-tabs', style: 'padding:0;margin:0 0 4px' }, ...(['Style', 'Layout', 'Text', 'Words'] as STab[]).map((t) =>
      h('button', { class: 'ts-tab' + (t === styleTab ? ' on' : ''), onclick: () => { styleTab = t; renderStyle(); } }, t)));
    const pane: Node[] = styleTab === 'Style' ? [
      h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Style'), looks),
      swatches('Text colour', st.color, (c) => { st.color = c; ctx.changed(); drawLooks(); }),
      swatches('Highlight colour', st.highlight, (c) => { st.highlight = c; ctx.changed(); drawLooks(); }),
    ] : styleTab === 'Layout' ? [
      chips<string>('Words on screen', 'How many words show at one time.', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], String(st.wordsPerLine), (v) => { st.wordsPerLine = Number(v); ctx.changed(); drawList(); }),
      chips<string>('Size', '', [['0.04', 'Small'], ['0.055', 'Medium'], ['0.075', 'Large']], String(st.size), (v) => { st.size = Number(v); ctx.changed(); }),
      chips<string>('Position', '', [['0.2', 'Top'], ['0.5', 'Middle'], ['0.78', 'Bottom']], String(st.y), (v) => { st.y = Number(v); ctx.changed(); }),
      ...(hasScript ? [chips<string>('Writing', 'Banglish / Hinglish or the original script.', [['roman', 'Banglish / Hinglish'], ['orig', 'Original']], st.roman ? 'roman' : 'orig', (v) => { st.roman = v === 'roman'; ctx.changed(); drawList(); })] : []),
      chips<string>('Letters', '', [['n', 'Normal'], ['u', 'CAPITALS']], st.upper ? 'u' : 'n', (v) => { st.upper = v === 'u'; ctx.changed(); drawList(); }),
    ] : styleTab === 'Text' ? [
      h('div', { class: 'at-sec' }, h('div', { class: 'at-hint' }, 'Tap a caption (here or on the video) to fix its text. Only that caption changes.'), list),
    ] : [
      h('div', { class: 'at-sec' },
        h('div', { class: 'at-hint' }, 'Tap a word to change its font, colour, shadow, glow and more.'),
        h('button', { class: 'btn cs-all', onclick: () => { selWord = -1; scope = 'all'; wordTab = 'Styles'; renderWord(); } }, icon('text', 20), 'Style all words'),
        h('div', { class: 'cs-mode' }, ...(['edit', 'cut'] as const).map((m) => h('button', { class: 'cs-mode-b' + (tapMode === m ? ' on' : ''),
          onclick: (e: Event) => { tapMode = m; (e.currentTarget as HTMLElement).parentElement?.querySelectorAll('.cs-mode-b').forEach((n, k) => n.classList.toggle('on', (k === 0) === (m === 'edit'))); } }, m === 'edit' ? 'Tap to style' : 'Tap to cut'))),
        trans),
    ];
    body.replaceChildren(tabsBar, ...pane);
    foot.replaceChildren(
      h('button', { class: 'btn at-go', onclick: () => { ctx.remove(); renderMake(); } }, icon('trash', 20), 'Remove captions'));
  }

  if (p.captions?.words.length) {
    if (startWord >= 0 && p.captions.words[startWord]) selectCaption(startWord); else renderStyle();
  } else renderMake();
  return {
    selectWord: (i) => { if (p.captions?.words[i]) { if (!closed) selectCaption(i); } },
    close,
  };
}
