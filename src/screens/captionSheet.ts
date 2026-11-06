import { buildPages, DEFAULT_CAPTION_STYLE, drawCaption, LOOKS, type CapLook, type CaptionStyle } from '../core/captions';
import { needsRoman } from '../core/romanize';
import { LANGS, WHISTLE_MODELS, normLang } from '../core/transcribe';
import type { Project, Settings } from '../core/types';
import { saveSettings } from '../core/store';
import { isKept } from '../core/timeline';
import { h, icon } from '../ui';
import { chips } from './faceOptions';

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
}

const COLORS = ['#FFFFFF', '#FFD60A', '#FF453A', '#30D158', '#0A84FF', '#FF9F0A', '#BF5AF2', '#000000'];

export function swatches(label: string, value: string, onPick: (c: string) => void): HTMLElement {
  const row = h('div', { class: 'cap-sw' });
  const render = (cur: string) => row.replaceChildren(...COLORS.map((c) =>
    h('button', { class: 'cap-dot' + (c.toLowerCase() === cur.toLowerCase() ? ' on' : ''), style: `background:${c}`, 'aria-label': c, onclick: () => { onPick(c); render(c); } })));
  render(value);
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), row);
}

/** Text > Caption. First time: pick language, make captions. Then: looks and settings. */
export function openCaptionSheet(ctx: CaptionCtx): void {
  const { p, settings: s } = ctx;
  const save = () => { void saveSettings(s); };
  const body = h('div', { class: 'at-body' });
  const foot = h('div', { class: 'at-foot' });
  const title = h('div', { class: 'at-title' }, 'Captions');
  const close = () => { sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
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

    // Descript-style transcript: tap a word to cut that part out of the video.
    const trans = h('div', { class: 'cap-trans' });
    const drawTrans = () => {
      const c = p.captions; if (!c) return;
      trans.replaceChildren(...c.words.map((w) => {
        const gone = !isKept(p.segments, (w.s + w.e) / 2);
        const t = st.roman ? w.w : (w.orig || w.w);
        return h('button', { class: 'cap-tw' + (gone ? ' gone' : ''), style: gone ? 'text-decoration:line-through;opacity:.4' : '',
          onclick: () => { if (gone) { ctx.seek(w.s); return; } ctx.cut(w.s, w.e); drawTrans(); drawList(); } }, t);
      }));
    };
    trans.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;max-height:220px;overflow:auto';
    const list = h('div', { class: 'cap-pages' });
    const drawList = () => {
      const pages = buildPages(p.captions, st);
      list.replaceChildren(...pages.map((pg) => {
        const input = h('input', { type: 'text', class: 'cap-input', value: pg.words.map((x) => x.t).join(' ') }) as HTMLInputElement;
        input.addEventListener('change', () => {
          const c = p.captions!;
          const parts = input.value.trim().split(/\s+/).filter(Boolean);
          const a = c.words[pg.from], b = c.words[pg.to];
          if (!a || !b) return;
          const span = Math.max(100, b.e - a.s);
          const neu = parts.map((t, i) => ({ w: t, orig: t, s: Math.round(a.s + (span * i) / parts.length), e: Math.round(a.s + (span * (i + 1)) / parts.length) }));
          c.words.splice(pg.from, pg.to - pg.from + 1, ...neu);
          ctx.changed(); drawList();
        });
        return h('div', { class: 'cap-row' }, h('button', { class: 'cap-time', onclick: () => ctx.seek(pg.s) }, `${Math.floor(pg.s / 60000)}:${String(Math.floor(pg.s / 1000) % 60).padStart(2, '0')}`), input);
      }));
    };
    drawList(); drawTrans();

    body.replaceChildren(
      h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Style'), looks),
      chips<string>('Words on screen', 'How many words show at one time.', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], String(st.wordsPerLine), (v) => { st.wordsPerLine = Number(v); ctx.changed(); drawList(); }),
      chips<string>('Size', '', [['0.04', 'Small'], ['0.055', 'Medium'], ['0.075', 'Large']], String(st.size), (v) => { st.size = Number(v); ctx.changed(); }),
      chips<string>('Position', '', [['0.2', 'Top'], ['0.5', 'Middle'], ['0.78', 'Bottom']], String(st.y), (v) => { st.y = Number(v); ctx.changed(); }),
      ...(hasScript ? [chips<string>('Writing', 'Banglish / Hinglish or the original script.', [['roman', 'Banglish / Hinglish'], ['orig', 'Original']], st.roman ? 'roman' : 'orig', (v) => { st.roman = v === 'roman'; ctx.changed(); drawList(); })] : []),
      chips<string>('Letters', '', [['n', 'Normal'], ['u', 'CAPITALS']], st.upper ? 'u' : 'n', (v) => { st.upper = v === 'u'; ctx.changed(); drawList(); }),
      swatches('Text colour', st.color, (c) => { st.color = c; ctx.changed(); drawLooks(); }),
      swatches('Highlight colour', st.highlight, (c) => { st.highlight = c; ctx.changed(); drawLooks(); }),
      h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Cut by text'), h('div', { class: 'at-hint' }, 'Tap a word to remove it from the video. Use Undo to bring it back.'), trans),
      h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Edit words'), h('div', { class: 'at-hint' }, 'Tap the time to jump there. Change a line to fix a word.'), list));
    foot.replaceChildren(
      h('button', { class: 'btn at-go', onclick: () => { ctx.remove(); renderMake(); } }, icon('trash', 20), 'Remove captions'));
  }

  if (p.captions?.words.length) renderStyle(); else renderMake();
}
