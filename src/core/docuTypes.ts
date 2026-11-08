/**
 * Documentary typography beats (Vox / Johnny Harris / Keynote style).
 * A beat is a short moment on the timeline (timeline ms, like texts) where the picture changes:
 *   black_screen   full black frame, one bold line in the middle
 *   split_screen   the talking head sits in a rounded window on one side, a typography card fills the other side
 *   kinetic_quote  big quote over the video with a dark scrim
 * Preview (docuRenderer.ts) and the native export (EditorrNativePlugin.DocuOverlay) draw the same numbers.
 */
import type { Aspect } from './types';
import { aspectValue } from './types';

export type DocuType = 'black_screen' | 'split_screen' | 'kinetic_quote';
export type DocuLayout = 'side' | 'updown' | 'one';
export type DocuPos = 'left' | 'right' | 'top' | 'bottom';
export type DocuTheme = 'noir' | 'investigative' | 'modern';

export interface DocuBeat {
  id: string;
  type: DocuType;
  /** timeline ms */
  start: number;
  end: number;
  /** side = left/right split (wide video), updown = top/bottom split (tall video) */
  layout: DocuLayout;
  /** where the talking head sits; the typography card takes the other side */
  video_position: DocuPos;
  /** corner radius in px of a 1080-short-side frame (scaled for other sizes) */
  card_radius: number;
  headline: string;
  subtext?: string;
  accent_color: string;
  theme: DocuTheme;
  /** Optional look set by the Templates / Fonts / Colors tabs. Missing = the old theme look. */
  style?: DocuStyle;
  /** Share of the frame the card takes (missing = CARD_SHARE_SIDE / CARD_SHARE_UPDOWN). Kallaway beats make the video window smaller. */
  share?: number;
  /** A finished picture of the whole frame with the video window cut out (Kallaway step list / script card). It replaces the drawn card. */
  image?: { url: string; path?: string };
  /** Kallaway motion: baked pictures that play over the first `framesMs` of the beat (pop, red wipe, count-up), then `image` stays. */
  frames?: { url: string; path?: string }[];
  framesMs?: number;
}

export type DocuFont = 'inter' | 'oswald' | 'playfair' | 'jetbrains';
export type DocuTemplateId = 'vox' | 'noir' | 'swiss' | 'cyber' | 'keynote' | 'breaking';
export interface DocuShadow { blur: number; dist: number; color: string }
export interface DocuStyle {
  template?: DocuTemplateId;
  font?: DocuFont;
  /** 0.7 .. 1.4, 1 = normal */
  textScale?: number;
  /** headline in CAPITALS (default on) */
  caps?: boolean;
  /** headline colour */
  text?: string;
  /** colour of the full-frame background (black screen, and around the card) */
  bg?: string;
  /** colour of the card */
  card?: string;
  /** space inside the card, px of a 1080 short side */
  pad?: number;
  /** border around the card, px of a 1080 short side */
  border?: number;
  shadow?: DocuShadow;
  /** Breaking News: a slab along the bottom of the video with a red tag, instead of a split */
  lower?: boolean;
  tag?: string;
}
export const DOCU_FONT_LABEL: Record<DocuFont, string> = { inter: 'Inter', oswald: 'Oswald', playfair: 'Playfair', jetbrains: 'JetBrains' };
export const DOCU_FONT_SUB: Record<DocuFont, string> = { inter: 'Modern', oswald: 'Heavy', playfair: 'Editorial', jetbrains: 'Dossier' };
export const DOCU_FONT_CSS: Record<DocuFont, string> = {
  inter: 'Inter, Roboto, "Noto Sans", Arial, sans-serif',
  oswald: 'Oswald, "Arial Narrow", Impact, sans-serif',
  playfair: '"Playfair Display", Georgia, "Times New Roman", serif',
  jetbrains: '"JetBrains Mono", "Roboto Mono", "Courier New", monospace',
};
export const DOCU_FONT_WEIGHT: Record<DocuFont, number> = { inter: 900, oswald: 700, playfair: 800, jetbrains: 800 };

export interface DocuTemplate {
  id: DocuTemplateId; label: string; hint: string; type: DocuType; accent: string; style: DocuStyle; radius: number;
}
export const DOCU_TEMPLATES: DocuTemplate[] = [
  { id: 'vox', label: 'Vox Editorial', hint: 'Blue, yellow accent', type: 'split_screen', accent: '#FFD60A', radius: 20,
    style: { template: 'vox', font: 'inter', caps: true, text: '#FFFFFF', bg: '#0A2A8A', card: '#1239B8', pad: 43, border: 0, shadow: { blur: 12, dist: 4, color: '#000000' } } },
  { id: 'noir', label: 'Noir Files', hint: 'Black, red accent', type: 'split_screen', accent: '#E5192B', radius: 4,
    style: { template: 'noir', font: 'oswald', caps: true, text: '#FFFFFF', bg: '#000000', card: '#050505', pad: 43, border: 0, shadow: { blur: 0, dist: 0, color: '#000000' } } },
  { id: 'swiss', label: 'Swiss Clean', hint: 'White card, bold border', type: 'split_screen', accent: '#000000', radius: 0,
    style: { template: 'swiss', font: 'inter', caps: false, text: '#000000', bg: '#E9E9E9', card: '#FFFFFF', pad: 48, border: 8, shadow: { blur: 0, dist: 0, color: '#000000' } } },
  { id: 'cyber', label: 'Cyber Dossier', hint: 'Dark green glow, mono', type: 'split_screen', accent: '#2CFF8F', radius: 8,
    style: { template: 'cyber', font: 'jetbrains', caps: false, text: '#B6FFD6', bg: '#020C08', card: '#04180F', pad: 40, border: 2, shadow: { blur: 22, dist: 0, color: '#2CFF8F' } } },
  { id: 'keynote', label: 'Apple Keynote', hint: 'Soft grey, round, blur', type: 'split_screen', accent: '#0A84FF', radius: 40,
    style: { template: 'keynote', font: 'inter', caps: false, text: '#F5F5F7', bg: '#161618', card: '#2A2A2D', pad: 56, border: 0, shadow: { blur: 25, dist: 10, color: '#000000' } } },
  { id: 'breaking', label: 'Breaking News', hint: 'Lower third, red tag', type: 'kinetic_quote', accent: '#E5192B', radius: 6,
    style: { template: 'breaking', font: 'oswald', caps: true, text: '#FFFFFF', bg: '#000000', card: '#0E0E12', pad: 36, border: 0, lower: true, tag: 'BREAKING NEWS', shadow: { blur: 10, dist: 4, color: '#000000' } } },
];


export const DOCU_ACCENTS = ['#C6F277', '#38BDF8', '#FFD60A', '#F43F5E'] as const;
export const DOCU_THEMES: DocuTheme[] = ['noir', 'investigative', 'modern'];
export const DOCU_TYPE_LABEL: Record<DocuType, string> = { black_screen: 'Black screen', split_screen: 'Split card', kinetic_quote: 'Quote' };
export const DEFAULT_CARD_RADIUS = 20;
export const MAX_CARD_RADIUS = 48;
/** The card eases in over this long (preview and export use the same number). */
export const DOCU_FADE_MS = 250;

/** 'side' for wide projects (16:9, 4:3, 21:9 ...), 'updown' for tall ones (9:16, 4:5 ...). 1:1 counts as wide. */
export function docuLayoutFor(a: Aspect): 'side' | 'updown' {
  return aspectValue(a) >= 1 ? 'side' : 'updown';
}
export const defaultPos = (layout: DocuLayout): DocuPos => (layout === 'updown' ? 'top' : 'left');
/** Positions that fit a layout, in the order the switcher shows them. */
export const posChoices = (layout: DocuLayout): [DocuPos, DocuPos] => (layout === 'updown' ? ['top', 'bottom'] : ['left', 'right']);
export const flipPos = (p: DocuPos): DocuPos => (p === 'left' ? 'right' : p === 'right' ? 'left' : p === 'top' ? 'bottom' : 'top');

/** Share of the frame the typography card takes on a split beat. */
export const CARD_SHARE_SIDE = 0.48;
export const CARD_SHARE_UPDOWN = 0.45;

export function docuBeatAt(beats: DocuBeat[] | undefined, ms: number): DocuBeat | undefined {
  if (!beats) return undefined;
  for (const b of beats) if (ms >= b.start && ms < b.end) return b;
  return undefined;
}
