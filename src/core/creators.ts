/**
 * Creator templates: one tap dresses the whole video in the look of a creator.
 *   Kallaway  glass cards on an onyx dot grid, a red accent, a pop caption look, and one big kinetic word at a time on the card boundary
 *   Hormozi   black frame with a yellow card, heavy caps, big 2-word captions in the middle with the spoken word in yellow, punchy zooms
 *   Vox / Noir / Keynote / Swiss / Cyber / News  documentary and explainer looks (card colours, caption look, B-roll moves)
 * Applying changes: the caption look, every documentary beat that is not a finished Kallaway picture, and the move of every B-roll.
 */
import { DEFAULT_CAPTION_STYLE, type CapZone, type CaptionStyle } from './captions';
import { DOCU_TEMPLATES, type DocuTemplateId } from './docuTypes';
import { captionZones } from './docuRenderer';
import type { BrollMotion } from './brollTypes';
import { aspectValue, type Project } from './types';

export type CreatorId = 'kallaway' | 'hormozi' | 'vox' | 'noir' | 'keynote' | 'swiss' | 'cyber' | 'breaking';
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
  { id: 'vox', name: 'Vox Explainer', hint: 'Blue card, yellow key word', swatch: ['#0A2A8A', '#1239B8', '#FFD60A'],
    caption: { look: 'pop', size: 0.06, y: 0.74, wordsPerLine: 3, upper: true, color: '#FFFFFF', highlight: '#FFD60A', fx: { font: 'heavy' } },
    docu: 'vox', zones: false, motions: ['slow_pan', 'zoom_in', 'pan_right', 'zoom_out', 'pan_left'] },
  { id: 'noir', name: 'Noir Docu', hint: 'Black, red accent, slow push-ins', swatch: ['#000000', '#050505', '#E5192B'],
    caption: { look: 'minimal', size: 0.05, y: 0.84, wordsPerLine: 4, upper: false, color: '#F5F5F0', highlight: '#FFFFFF', fx: { font: 'editorial', italic: true } },
    docu: 'noir', zones: false, motions: ['slow_zoom', 'slow_pan', 'drift', 'zoom_out'] },
  { id: 'keynote', name: 'Keynote Tech', hint: 'Soft grey cards, blue accent', swatch: ['#161618', '#2A2A2D', '#0A84FF'],
    caption: { look: 'pill', size: 0.056, y: 0.78, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#0A84FF', fx: { font: 'poppins' } },
    docu: 'keynote', zones: false, motions: ['zoom_in', 'slow_zoom', 'pan_right', 'zoom_out'] },
  { id: 'swiss', name: 'Swiss Clean', hint: 'White card, plain subtitle', swatch: ['#E9E9E9', '#FFFFFF', '#000000'],
    caption: { look: 'classic', size: 0.045, y: 0.86, wordsPerLine: 5, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'soft', stroke: null, shadow: null, bg: { c: '#000000', o: 0.55, r: 0.25 } } },
    docu: 'swiss', zones: false, motions: ['slow_zoom', 'drift', 'pan_left'] },
  { id: 'cyber', name: 'Cyber Dossier', hint: 'Dark green glow, mono type', swatch: ['#020C08', '#04180F', '#2CFF8F'],
    caption: { look: 'box', size: 0.045, y: 0.8, wordsPerLine: 3, upper: false, color: '#B6FFD6', highlight: '#2CFF8F', fx: { font: 'typewriter' } },
    docu: 'cyber', zones: false, motions: ['punch_in', 'slow_pan', 'zoom_in', 'drift'] },
  { id: 'breaking', name: 'News Flash', hint: 'Lower third, red tag, bold caps', swatch: ['#000000', '#0E0E12', '#E5192B'],
    caption: { look: 'bold', size: 0.06, y: 0.8, wordsPerLine: 3, upper: true, color: '#FFFFFF', highlight: '#E5192B', fx: { font: 'heavy' } },
    docu: 'breaking', zones: false, motions: ['punch_in', 'zoom_in', 'pan_right'] },
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
