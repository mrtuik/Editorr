/**
 * Caption templates: one tap sets the whole look of the captions (look, colours, size, place, font, dual font, effects).
 * Everything here uses what the preview AND the Android export both draw, so a template renders the same in the exported video.
 * A template keeps the person's choice of writing (Banglish / original / both).
 */
import { DEFAULT_CAPTION_STYLE, type CaptionStyle } from './captions';

export interface CaptionTemplate { id: string; name: string; hint: string; style: Partial<CaptionStyle> }

const dark = (b: number, d = 0.07, a = 90) => ({ c: 'rgba(0,0,0,0.8)', b, d, a });

export const CAPTION_TEMPLATES: CaptionTemplate[] = [
  { id: 'kallaway', name: 'Kallaway', hint: 'Pop bounce, red word', style: { look: 'pop', size: 0.056, y: 0.78, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#E5192B', fx: { font: 'heavy' } } },
  { id: 'hormozi', name: 'Hormozi', hint: 'Big caps, yellow word', style: { look: 'karaoke', size: 0.075, y: 0.58, wordsPerLine: 2, upper: true, color: '#FFFFFF', highlight: '#FFE600', fx: { font: 'heavy', stroke: { c: '#000000', w: 0.2 }, shadow: dark(0.2, 0.08) } } },
  { id: 'duo', name: 'Duo Serif', hint: 'Heavy + italic serif key word', style: { look: 'pop', size: 0.06, y: 0.7, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#FFD60A', fx: { font: 'heavy' }, pair: { font: 'editorial', mode: 'key', italic: true, color: '#FFD60A' } } },
  { id: 'duoalt', name: 'Duo Mix', hint: 'Two fonts, every other word', style: { look: 'karaoke', size: 0.062, y: 0.72, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#30D158', fx: { font: 'poppins' }, pair: { font: 'typewriter', mode: 'alt', color: '#30D158' } } },
  { id: 'pill', name: 'Pill', hint: 'Spoken word on a pill', style: { look: 'pill', size: 0.058, y: 0.76, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#FFD60A', fx: { font: 'poppins' } } },
  { id: 'neon', name: 'Neon Glow', hint: 'Soft cyan glow', style: { look: 'karaoke', size: 0.06, y: 0.7, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#00E5FF', fx: { font: 'poppins', stroke: null, shadow: null, glow: { c: '#00E5FF', b: 0.5 } } } },
  { id: 'cinema', name: 'Cinema', hint: 'Italic serif, quiet', style: { look: 'minimal', size: 0.05, y: 0.84, wordsPerLine: 4, upper: false, color: '#F5F5F0', highlight: '#FFFFFF', fx: { font: 'editorial', italic: true } } },
  { id: 'typewriter', name: 'Typewriter', hint: 'Mono on a dark box', style: { look: 'box', size: 0.045, y: 0.8, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'typewriter' } } },
  { id: 'clean', name: 'Clean Sub', hint: 'Plain subtitle on a soft box', style: { look: 'classic', size: 0.045, y: 0.86, wordsPerLine: 5, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'soft', stroke: null, shadow: null, bg: { c: '#000000', o: 0.55, r: 0.25 } } } },
  { id: 'retro', name: 'Retro Hard', hint: 'Slab with a hard red shadow', style: { look: 'bold', size: 0.065, y: 0.72, wordsPerLine: 2, upper: true, color: '#FFE9A8', highlight: '#FFE9A8', fx: { font: 'slab', stroke: { c: '#000000', w: 0.12 }, shadow: { c: '#FF3B30', b: 0, d: 0.09, a: 45 } } } },
  { id: 'comic', name: 'Comic', hint: 'Fat outline, yellow', style: { look: 'pop', size: 0.07, y: 0.62, wordsPerLine: 2, upper: true, color: '#FFE600', highlight: '#FF3B30', fx: { font: 'casual', stroke: { c: '#000000', w: 0.22 } } } },
  { id: 'soft', name: 'Soft', hint: 'Light, lowercase, calm', style: { look: 'minimal', size: 0.05, y: 0.8, wordsPerLine: 4, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'soft' } } },
  { id: 'baskerville', name: 'Editorial', hint: 'Baskerville, centred', style: { look: 'classic', size: 0.055, y: 0.5, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'baskerville', stroke: { c: '#000000', w: 0.08 } } } },
];

/** The captions' style after a template: its numbers, the person's writing choice kept, nothing left over from the old template. */
export function applyCaptionTemplate(old: CaptionStyle | undefined, t: CaptionTemplate): CaptionStyle {
  const cur = old ?? DEFAULT_CAPTION_STYLE;
  return { ...DEFAULT_CAPTION_STYLE, roman: cur.roman, ...(cur.dual ? { dual: true } : {}), ...structuredClone(t.style) } as CaptionStyle;
}
