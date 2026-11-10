/**
 * Creator templates: one tap dresses the whole video in the look of a creator.
 *   Kallaway  glass cards on an onyx dot grid, a red accent, a pop caption look, and one big kinetic word at a time on the card boundary
 *   Hormozi   black frame with a yellow card, heavy caps, big 2-word captions in the middle with the spoken word in yellow, punchy zooms
 * Applying changes: the caption look, every documentary beat that is not a finished Kallaway picture, and the move of every B-roll.
 */
import { DEFAULT_CAPTION_STYLE, type CapZone, type CaptionStyle } from './captions';
import { DOCU_TEMPLATES, type DocuTemplateId } from './docuTypes';
import { captionZones } from './docuRenderer';
import type { BrollMotion } from './brollTypes';
import { aspectValue, type Project } from './types';

export type CreatorId = 'kallaway' | 'hormozi';
export interface CreatorTemplate {
  id: CreatorId; name: string; hint: string;
  /** colours of the tile: [background, card, accent] */
  swatch: [string, string, string];
  caption: Partial<CaptionStyle>;
  docu: DocuTemplateId;
  /** one big word at a time on the card boundary */
  zones: boolean;
  motions: BrollMotion[];
}

export const CREATORS: CreatorTemplate[] = [
  { id: 'kallaway', name: 'Kallaway', hint: 'Glass cards, red accent, kinetic words', swatch: ['#060607', '#141418', '#D1121B'],
    caption: { look: 'pop', size: 0.056, y: 0.78, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#E5192B' },
    docu: 'glass', zones: true, motions: ['punch_in', 'slow_pan', 'drift', 'zoom_out', 'pan_right', 'zoom_in', 'pan_left'] },
  { id: 'hormozi', name: 'Hormozi', hint: 'Black + yellow, heavy caps, fast zooms', swatch: ['#000000', '#FFE600', '#FFE600'],
    caption: { look: 'karaoke', size: 0.075, y: 0.58, wordsPerLine: 2, upper: true, color: '#FFFFFF', highlight: '#FFE600' },
    docu: 'hormozi', zones: false, motions: ['punch_in', 'zoom_in', 'punch_in', 'slow_pan'] },
];
export const creatorOf = (id: CreatorId | undefined): CreatorTemplate => CREATORS.find((c) => c.id === id) ?? CREATORS[0]!;

/** The caption zones of this project (none for creators that keep their captions in one place). */
export function captionZonesFor(p: Pick<Project, 'creator' | 'docu' | 'aspect'>): CapZone[] {
  return creatorOf(p.creator).zones ? captionZones(p.docu, aspectValue(p.aspect)) : [];
}

/** Applies a creator template to the project. Finished Kallaway pictures keep their picture (redraw them from the sheet). Returns what changed, for the toast. */
export function applyCreator(p: Project, id: CreatorId): { beats: number; broll: number } {
  const c = creatorOf(id);
  p.creator = id;
  p.captionStyle = { ...(p.captionStyle ?? DEFAULT_CAPTION_STYLE), ...c.caption };
  const t = DOCU_TEMPLATES.find((x) => x.id === c.docu);
  let beats = 0;
  if (t) for (const b of p.docu ?? []) {
    if (b.kw) continue;
    const wasLower = !!b.style?.lower;
    b.style = { ...t.style };
    b.accent_color = t.accent; b.card_radius = t.radius;
    b.type = t.style.lower ? 'kinetic_quote' : wasLower ? 'split_screen' : b.type;
    beats++;
  }
  let broll = 0;
  (p.broll ?? []).forEach((br, i) => { if (br.kind !== 'video') { br.motion = c.motions[i % c.motions.length]!; broll++; } });
  return { beats, broll };
}
