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
}

export const DOCU_ACCENTS = ['#C6F277', '#38BDF8', '#FFD60A', '#F43F5E'] as const;
export const DOCU_THEMES: DocuTheme[] = ['noir', 'investigative', 'modern'];
export const DOCU_TYPE_LABEL: Record<DocuType, string> = { black_screen: 'Black screen', split_screen: 'Split card', kinetic_quote: 'Quote' };
export const DEFAULT_CARD_RADIUS = 20;
export const MAX_CARD_RADIUS = 40;
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
