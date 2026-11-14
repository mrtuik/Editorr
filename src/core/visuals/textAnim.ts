/**
 * Text animation in the way open-motion does it (MIT, see THIRD_PARTY.md). Only the motion DATA and the idea were taken:
 *   kinetic   = kineticText   (word by word, translateY + opacity, snappy 600 ms, 120 ms stagger)
 *   wave      = set_text_animator + set_range_selector (per character, a smooth range window sweeps over the text)
 *   blur      = blurReveal on every word
 *   pop       = elasticScale on every word
 *   reveal    = textReveal    (clip-path wipe, ease-in-out)
 *   type      = typewriter    (linear, character by character, caret)
 *   scramble  = textScramble  (decoder reveal, letter-spacing 8 px -> 0, opacity .3 -> 1)
 *   splitReveal = splitText   (upper and lower halves of the line slide in from opposite sides and meet; 1000 ms ease-out after a 200 ms delay)
 *   glitchIn  = glitch        (600 ms linear: x-shake that dies out, flickering opacity, an accent-colour ghost)
 * Everything is a pure function of the time since the visual started, so a frame is always the same picture.
 */
import { easeFn, timed, type EaseName } from './ease';
import { esc, words, type Ctx } from './templates/util';

export type TextAnimId = 'kinetic' | 'wave' | 'blur' | 'pop' | 'reveal' | 'type' | 'scramble' | 'splitReveal' | 'glitchIn';
export const TEXT_ANIMS: TextAnimId[] = ['kinetic', 'wave', 'blur', 'pop', 'reveal', 'type', 'scramble', 'splitReveal', 'glitchIn'];
export const TEXT_ANIM_LABEL: Record<TextAnimId, string> = {
  kinetic: 'Kinetic words', wave: 'Wave (letters)', blur: 'Blur reveal', pop: 'Pop', reveal: 'Wipe reveal', type: 'Typewriter', scramble: 'Decode', splitReveal: 'Split reveal', glitchIn: 'Glitch in',
};

interface Spec {
  unit: 'word' | 'char' | 'block' | 'type' | 'scramble' | 'split' | 'glitch';
  /** time one unit takes, and the gap between neighbours (ms) */
  dur: number; stagger: number; ease: EaseName;
  /** start values, in em of the text size (b = blur) */
  y?: number; x?: number; s?: number; r?: number; b?: number;
  /** range selector smoothness 0..1 (wave) */
  smooth?: number;
  /** letter-spacing at the start, em (scramble) */
  ls?: number;
}
const SPECS: Record<TextAnimId, Spec> = {
  kinetic: { unit: 'word', dur: 600, stagger: 120, ease: 'snappy', y: 0.8 },
  wave: { unit: 'char', dur: 900, stagger: 0, ease: 'snappy', y: 0.55, s: 0.75, smooth: 0.5 },
  blur: { unit: 'word', dur: 700, stagger: 90, ease: 'ease-out', y: 0.25, b: 0.14 },
  pop: { unit: 'word', dur: 800, stagger: 100, ease: 'elastic', s: 0.55 },
  reveal: { unit: 'block', dur: 900, stagger: 0, ease: 'ease-in-out', x: -0.12, b: 0.06 },
  type: { unit: 'type', dur: 1100, stagger: 0, ease: 'linear' },
  scramble: { unit: 'scramble', dur: 1200, stagger: 0, ease: 'linear', ls: 0.25 },
  splitReveal: { unit: 'split', dur: 1000, stagger: 0, ease: 'ease-out', x: 0.6 },
  glitchIn: { unit: 'glitch', dur: 600, stagger: 0, ease: 'linear', x: 0.09 },
};
/** splitText waits 200 ms before the halves start to move */
const SPLIT_DELAY = 200;
export const isTextAnim = (s: string | undefined): s is TextAnimId => !!s && s in SPECS;

/** words in Bengali / Hindi etc. are never cut into letters (a matra on its own would break the shape) */
const isIndic = (s: string) => /[ऀ-෿]/.test(s);
export const DELAY = 140;
const MAX_TOTAL = 1500;

/** Gap between units and the time the whole text needs, with the stagger squeezed so long text still ends in about 1.5 s. */
export function timing(id: TextAnimId, text: string): { stagger: number; dur: number; total: number } {
  const sp = SPECS[id], n = Math.max(1, words(text).length);
  const wide = isIndic(text), unit = wide && (sp.unit === 'char' || sp.unit === 'scramble' || sp.unit === 'type') ? 'word' : sp.unit;
  if (unit === 'block' || unit === 'glitch') return { stagger: 0, dur: sp.dur, total: sp.dur };
  if (unit === 'split') return { stagger: 0, dur: sp.dur, total: sp.dur + SPLIT_DELAY };
  if (unit === 'type' || unit === 'scramble' || unit === 'char') {
    const chars = unit === 'char' || unit === 'type' || unit === 'scramble' ? Math.max(1, text.replace(/\s/g, '').length) : n;
    const dur = Math.min(1500, Math.max(sp.dur, 500 + chars * 20));
    return { stagger: 0, dur, total: dur };
  }
  const stagger = n > 1 ? Math.max(25, Math.min(sp.stagger, (MAX_TOTAL - sp.dur) / (n - 1))) : 0;
  return { stagger, dur: sp.dur, total: sp.dur + stagger * (n - 1) };
}
/** Time (ms from the start of the visual) at which the text has settled. */
export const textEndMs = (id: TextAnimId, text: string) => DELAY + timing(id, text).total;

const GLYPHS = '!<>-_\\/[]{}=+*^?#%&';
const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0); };

export interface AnimTextOpts {
  color?: string; weight?: number; font?: string; align?: string; lh?: number; nowrap?: boolean;
  /** word (compared without punctuation, lower case) shown in the accent colour; or 'last' for the last word */
  accent?: string; accentColor?: string;
  /** extra delay in ms and a different animation than the card's */
  delay?: number; anim?: TextAnimId; italic?: boolean;
}
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A block of text whose words / letters move in with the card's text animation. */
export function animText(c: Ctx, text: string, size: number, o: AnimTextOpts = {}): string {
  const id: TextAnimId = o.anim ?? (isTextAnim(c.anim) ? c.anim : 'kinetic'), sp = SPECS[id];
  const delay = DELAY + (o.delay ?? 0), tm = timing(id, text), ms = c.ms - delay;
  const ws = words(text), nW = ws.length, wide = isIndic(text);
  const unit = wide && (sp.unit === 'char' || sp.unit === 'scramble' || sp.unit === 'type') ? 'word' : sp.unit;
  const accWord = o.accent === 'last' ? norm(ws[nW - 1] ?? '') : norm(o.accent ?? '');
  const colorOf = (w: string, i: number) => (accWord && (o.accent === 'last' ? i === nW - 1 : norm(w) === accWord)) ? (o.accentColor ?? c.t.accent) : (o.color ?? c.t.text);
  const f = easeFn(sp.ease);
  const frame = `${o.italic ? 'font-style:italic;' : ''}font-size:${size}px;line-height:${o.lh ?? 1.18};font-weight:${o.weight ?? 700};font-family:${o.font ?? c.t.font};text-align:${o.align ?? 'left'};${c.t.textShadow ? `text-shadow:${c.t.textShadow};` : ''}${o.nowrap ? 'white-space:pre;' : 'overflow-wrap:anywhere;'}`;
  const tf = (e: number) => {
    const y = (sp.y ?? 0) * (1 - e), x = (sp.x ?? 0) * (1 - e), s = 1 + ((sp.s ?? 1) - 1) * (1 - e), r = (sp.r ?? 0) * (1 - e), b = (sp.b ?? 0) * (1 - e);
    return `opacity:${Math.max(0, Math.min(1, e * 1.6)).toFixed(3)};transform:translate(${x.toFixed(3)}em,${y.toFixed(3)}em) scale(${s.toFixed(3)}) rotate(${r.toFixed(2)}deg);${b > 0.002 ? `filter:blur(${b.toFixed(3)}em);` : ''}`;
  };
  const wrapWord = (inner: string) => `<span style="display:inline-block;white-space:nowrap;">${inner}</span>`;

  if (unit === 'block') {
    const e = f(Math.max(0, Math.min(1, ms / tm.dur)));
    const spans = ws.map((w, i) => `<span style="color:${colorOf(w, i)};">${esc(w)}</span>`).join(' ');
    return `<div style="${frame}clip-path:inset(0 ${((1 - e) * 100).toFixed(2)}% 0 0);opacity:${Math.min(1, e * 3).toFixed(3)};transform:translateX(${((sp.x ?? 0) * (1 - e)).toFixed(3)}em);${(sp.b ?? 0) * (1 - e) > 0.002 ? `filter:blur(${((sp.b ?? 0) * (1 - e)).toFixed(3)}em);` : ''}">${spans}</div>`;
  }


  if (unit === 'split') {
    // upper half from the left, lower half from the right, both ease-out; each half is the same text clipped at the middle of the line box
    const e = f(Math.max(0, Math.min(1, (ms - SPLIT_DELAY) / sp.dur))), off = (sp.x ?? 0) * (1 - e), op = Math.min(1, e * 3).toFixed(3);
    const spans = ws.map((w, i) => `<span style="color:${colorOf(w, i)};">${esc(w)}</span>`).join(' ');
    const half = (clip: string, dx: number) => `<div style="${frame}position:absolute;left:0;right:0;top:0;clip-path:${clip};transform:translateX(${dx.toFixed(3)}em);opacity:${op};">${spans}</div>`;
    return `<div style="position:relative;"><div style="${frame}visibility:hidden;">${spans}</div>${half('inset(0 0 50% 0)', -off)}${half('inset(50% 0 0 0)', off)}</div>`;
  }

  if (unit === 'glitch') {
    // a deterministic shake: the offset comes from a hash of the 40 ms step, so a frame is always the same picture
    const q = Math.max(0, Math.min(1, ms / sp.dur)), step = Math.floor(ms / 40), amp = 1 - q;
    const r = (k: number) => (hash(step, k) % 1000) / 1000;
    const spans = (color?: string) => ws.map((w, i) => `<span style="color:${color ?? colorOf(w, i)};">${esc(w)}</span>`).join(' ');
    if (ms < 0) return `<div style="${frame}opacity:0;">${spans()}</div>`;
    if (q >= 1) return `<div style="${frame}">${spans()}</div>`;
    const dx = (r(1) - 0.5) * 2 * (sp.x ?? 0.09) * amp, on = r(2) < 0.35 + 0.65 * q ? 1 : 0.15;
    const ghost = `<div style="${frame}position:absolute;left:0;right:0;top:0;transform:translateX(${(-dx * 1.8 - 0.05 * amp).toFixed(3)}em);opacity:${(0.75 * amp).toFixed(3)};">${spans(c.t.accent)}</div>`;
    return `<div style="position:relative;">${ghost}<div style="${frame}position:relative;transform:translateX(${dx.toFixed(3)}em);opacity:${on};">${spans()}</div></div>`;
  }

  if (unit === 'word') {
    const spans = ws.map((w, i) => {
      const e = f(Math.max(0, Math.min(1, (ms - i * tm.stagger) / tm.dur)));
      return `<span style="display:inline-block;color:${colorOf(w, i)};${tf(e)}">${esc(w)}</span>`;
    }).join(' ');
    return `<div style="${frame}">${spans}</div>`;
  }

  if (unit === 'char') {
    // range selector: a window with soft edges travels over the letters; each letter's amount = how far the window is past it
    const all = Array.from(ws.join('')).length, sm = Math.max(0.05, sp.smooth ?? 0.5);
    const edge = easeFn('ease-in-out')(Math.max(0, Math.min(1, ms / tm.dur))) * (1 + sm);
    let k = 0;
    const out = ws.map((w, i) => {
      const chars = Array.from(w).map((ch) => {
        const pos = all > 1 ? k++ / (all - 1) : (k++, 0), e = f(Math.max(0, Math.min(1, (edge - pos) / sm)));
        return `<span style="display:inline-block;color:${colorOf(w, i)};${tf(e)}">${esc(ch)}</span>`;
      }).join('');
      return wrapWord(chars);
    }).join(' ');
    return `<div style="${frame}">${out}</div>`;
  }

  if (unit === 'type') {
    const total = Array.from(ws.join('')).length, shown = Math.floor(total * Math.max(0, Math.min(1, ms / tm.dur)) + (ms > 0 ? 0.001 : 0));
    const done = ms >= tm.dur, caretOn = !done && (Math.floor(c.ms / 260) % 2 === 0 || ms < tm.dur);
    let k = 0;
    const out = ws.map((w, i) => {
      const chars = Array.from(w).map((ch) => {
        const on = k++ < shown;
        return `<span style="color:${colorOf(w, i)};opacity:${on ? 1 : 0};">${esc(ch)}</span>`;
      }).join('');
      return wrapWord(chars);
    }).join(' ');
    const caretW = Math.round(size * 0.07), at = Math.min(shown, total);
    return `<div style="${frame}position:relative;">${out}${caretOn && ms > 0 ? `<span style="display:none;">${at}</span>` : ''}${done ? '' : `<span style="display:inline-block;width:${caretW}px;height:${Math.round(size * 0.9)}px;margin-left:${caretW}px;vertical-align:-0.1em;background:${c.t.accent};opacity:${caretOn ? 1 : 0.2};"></span>`}</div>`;
  }

  // scramble: letters flicker through random glyphs, then settle left to right; spacing closes from 0.25em to 0
  const total = Array.from(ws.join('')).length, prog = Math.max(0, Math.min(1, ms / tm.dur));
  const ls = (sp.ls ?? 0.25) * (1 - prog), op = 0.3 + 0.7 * Math.min(1, prog * 1.6);
  let k = 0;
  const out = ws.map((w, i) => {
    const chars = Array.from(w).map((ch) => {
      const idx = k++, at = (idx / Math.max(1, total)) * 0.75, settled = prog >= at + 0.2;
      const shown = settled || ms < 0 ? (ms < 0 ? ' ' : ch) : GLYPHS[hash(idx, Math.floor(c.ms / 55)) % GLYPHS.length]!;
      return `<span style="display:inline-block;color:${settled ? colorOf(w, i) : c.t.muted};">${esc(ms < 0 ? ' ' : shown)}</span>`;
    }).join('');
    return wrapWord(chars);
  }).join(' ');
  return `<div style="${frame}letter-spacing:${ls.toFixed(3)}em;opacity:${op.toFixed(3)};">${out}</div>`;
}

/** The text animation a visual should use: its own pick, else the theme's list rotated by index. */
export function pickText(list: string[] | undefined, index: number, prev?: string): TextAnimId {
  const ids = (list ?? []).filter(isTextAnim);
  if (!ids.length) return 'kinetic';
  let t = ids[index % ids.length]!;
  if (t === prev && ids.length > 1) t = ids[(index + 1) % ids.length]!;
  return t;
}
