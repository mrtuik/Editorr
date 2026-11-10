/**
 * Creator templates: one tap dresses the whole video in the look of a creator.
 *   Kallaway  glass cards on an onyx dot grid, a red accent, a pop caption look, and one big kinetic word at a time on the card boundary
 *   Hormozi   black frame with a yellow card, heavy caps, big 2-word captions in the middle with the spoken word in yellow, punchy zooms
 *   Vox / Noir / Keynote / Swiss / Cyber / News  documentary and explainer looks (card colours, caption look, B-roll moves)
 * Applying changes (captions are left alone): every documentary beat that is not a finished Kallaway picture, and the move of every B-roll.
 */
import { DEFAULT_CAPTION_STYLE, type CapZone, type CaptionStyle } from './captions';
import { DOCU_TEMPLATES, type DocuTemplateId } from './docuTypes';
import { captionZones } from './docuRenderer';
import type { BrollFrame, BrollMotion } from './brollTypes';
import type { VideoMode } from './brollRouter';
import { aspectValue, type Project } from './types';

export type CreatorId = 'kallaway' | 'hormozi' | 'vox' | 'noir' | 'keynote' | 'swiss' | 'cyber' | 'breaking'
  | 'cinema' | 'neonhook' | 'cinedocu' | 'studio' | 'purpletech' | 'monodocu';

/** Colour look of the talking head: contrast and brightness -1..1, saturation -100..100 (0 = unchanged). Preview = CSS filter, export = Media3 effects. */
export interface Grade { contrast: number; sat: number; bright: number }
export const gradeCss = (g: Grade | undefined): string =>
  g && (g.contrast || g.sat || g.bright) ? `contrast(${1 + g.contrast}) saturate(${Math.max(0, 1 + g.sat / 100)}) brightness(${1 + g.bright})` : '';

/** How Auto edit works for this creator: what is placed, how fast, and how the picture looks. */
export interface EditRecipe {
  /** Kallaway director cards (step lists, numbers, quotes, loops) at 2 to 4 moments */
  cards: boolean;
  /** documentary typography beats picked from the words (big word / number / black line) */
  docuBeats: boolean;
  /** B-roll between the beats: length of one cut, how it sits, how often, photo or clip */
  lenMs: number; frame: BrollFrame; coverage: 'every' | 'alternate'; videoMode: VideoMode;
  /** fill every gap (Kallaway pacing) instead of cutting along the words */
  fillGaps: boolean;
  /** colour look of the talking head */
  grade: Grade;
}
export interface CreatorTemplate {
  id: CreatorId; name: string; hint: string;
  /** colours of the tile: [background, card, accent] */
  swatch: [string, string, string];
  caption: Partial<CaptionStyle>;
  docu: DocuTemplateId;
  /** one big word at a time on the card boundary */
  zones: boolean;
  motions: BrollMotion[];
  recipe: EditRecipe;
}

export const CREATORS: CreatorTemplate[] = [
  { id: 'kallaway', name: 'Kallaway', hint: 'Glass cards, red accent, kinetic words', swatch: ['#060607', '#141418', '#D1121B'],
    caption: { look: 'pop', size: 0.056, y: 0.78, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#E5192B' },
    docu: 'glass', zones: true, motions: ['punch_in', 'slow_pan', 'drift', 'zoom_out', 'pan_right', 'zoom_in', 'pan_left'], recipe: { cards: true, docuBeats: false, lenMs: 2500, frame: 'card', coverage: 'every', videoMode: 'mix', fillGaps: true, grade: { contrast: 0.08, sat: 4, bright: 0 } } },
  { id: 'hormozi', name: 'Hormozi', hint: 'Black + yellow, heavy caps, fast zooms', swatch: ['#000000', '#FFE600', '#FFE600'],
    caption: { look: 'karaoke', size: 0.075, y: 0.58, wordsPerLine: 2, upper: true, color: '#FFFFFF', highlight: '#FFE600' },
    docu: 'hormozi', zones: false, motions: ['punch_in', 'zoom_in', 'punch_in', 'slow_pan'], recipe: { cards: false, docuBeats: true, lenMs: 1800, frame: 'full', coverage: 'alternate', videoMode: 'mix', fillGaps: false, grade: { contrast: 0.12, sat: 14, bright: 0.02 } } },
  { id: 'vox', name: 'Vox Explainer', hint: 'Blue card, yellow key word', swatch: ['#0A2A8A', '#1239B8', '#FFD60A'],
    caption: { look: 'pop', size: 0.06, y: 0.74, wordsPerLine: 3, upper: true, color: '#FFFFFF', highlight: '#FFD60A', fx: { font: 'heavy' } },
    docu: 'vox', zones: false, motions: ['slow_pan', 'zoom_in', 'pan_right', 'zoom_out', 'pan_left'], recipe: { cards: false, docuBeats: true, lenMs: 2500, frame: 'blur', coverage: 'every', videoMode: 'mix', fillGaps: true, grade: { contrast: 0.06, sat: 6, bright: 0 } } },
  { id: 'noir', name: 'Noir Docu', hint: 'Black, red accent, slow push-ins', swatch: ['#000000', '#050505', '#E5192B'],
    caption: { look: 'minimal', size: 0.05, y: 0.84, wordsPerLine: 4, upper: false, color: '#F5F5F0', highlight: '#FFFFFF', fx: { font: 'editorial', italic: true } },
    docu: 'noir', zones: false, motions: ['slow_zoom', 'slow_pan', 'drift', 'zoom_out'], recipe: { cards: false, docuBeats: true, lenMs: 3000, frame: 'full', coverage: 'alternate', videoMode: 'video', fillGaps: false, grade: { contrast: 0.16, sat: -18, bright: -0.03 } } },
  { id: 'keynote', name: 'Keynote Tech', hint: 'Soft grey cards, blue accent', swatch: ['#161618', '#2A2A2D', '#0A84FF'],
    caption: { look: 'pill', size: 0.056, y: 0.78, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#0A84FF', fx: { font: 'poppins' } },
    docu: 'keynote', zones: false, motions: ['zoom_in', 'slow_zoom', 'pan_right', 'zoom_out'], recipe: { cards: false, docuBeats: true, lenMs: 2500, frame: 'card', coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0.05, sat: 4, bright: 0.03 } } },
  { id: 'swiss', name: 'Swiss Clean', hint: 'White card, plain subtitle', swatch: ['#E9E9E9', '#FFFFFF', '#000000'],
    caption: { look: 'classic', size: 0.045, y: 0.86, wordsPerLine: 5, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'soft', stroke: null, shadow: null, bg: { c: '#000000', o: 0.55, r: 0.25 } } },
    docu: 'swiss', zones: false, motions: ['slow_zoom', 'drift', 'pan_left'], recipe: { cards: false, docuBeats: true, lenMs: 3000, frame: 'card', coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0, sat: -4, bright: 0.04 } } },
  { id: 'cyber', name: 'Cyber Dossier', hint: 'Dark green glow, mono type', swatch: ['#020C08', '#04180F', '#2CFF8F'],
    caption: { look: 'box', size: 0.045, y: 0.8, wordsPerLine: 3, upper: false, color: '#B6FFD6', highlight: '#2CFF8F', fx: { font: 'typewriter' } },
    docu: 'cyber', zones: false, motions: ['punch_in', 'slow_pan', 'zoom_in', 'drift'], recipe: { cards: false, docuBeats: true, lenMs: 2200, frame: 'card', coverage: 'alternate', videoMode: 'mix', fillGaps: false, grade: { contrast: 0.14, sat: -6, bright: -0.02 } } },
  { id: 'breaking', name: 'News Flash', hint: 'Lower third, red tag, bold caps', swatch: ['#000000', '#0E0E12', '#E5192B'],
    caption: { look: 'bold', size: 0.06, y: 0.8, wordsPerLine: 3, upper: true, color: '#FFFFFF', highlight: '#E5192B', fx: { font: 'heavy' } },
    docu: 'breaking', zones: false, motions: ['punch_in', 'zoom_in', 'pan_right'], recipe: { cards: false, docuBeats: true, lenMs: 2200, frame: 'full', coverage: 'alternate', videoMode: 'mix', fillGaps: false, grade: { contrast: 0.1, sat: 8, bright: 0 } } },
  // ---- looks studied from reference reels
  { id: 'cinema', name: 'Cinematic Kinetic', hint: 'Full-frame film clips, big red-accent words', swatch: ['#04121A', '#0B2A36', '#E5192B'],
    caption: { look: 'pop', size: 0.07, y: 0.5, wordsPerLine: 2, upper: false, color: '#FFFFFF', highlight: '#E5192B', fx: { font: 'poppins' } },
    docu: 'noir', zones: false, motions: ['slow_zoom', 'drift', 'slow_pan', 'zoom_out', 'punch_in'],
    recipe: { cards: false, docuBeats: false, lenMs: 2200, frame: 'full', coverage: 'every', videoMode: 'video', fillGaps: true, grade: { contrast: 0.14, sat: -8, bright: -0.02 } } },
  { id: 'neonhook', name: 'Neon Hook', hint: 'Talking head, neon-yellow words and numbers, punch zooms', swatch: ['#000000', '#0E0E0E', '#D7FF00'],
    caption: { look: 'bold', size: 0.045, y: 0.8, wordsPerLine: 3, upper: false, color: '#D7FF00', highlight: '#FFFFFF', fx: { font: 'heavy' } },
    docu: 'neon', zones: false, motions: ['punch_in', 'zoom_in', 'punch_in', 'drift'],
    recipe: { cards: false, docuBeats: true, lenMs: 1800, frame: 'blur', coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0.1, sat: 12, bright: 0.03 } } },
  { id: 'cinedocu', name: 'Cine Docu', hint: 'You + full-frame film cutaways, tiny captions', swatch: ['#0C1116', '#1B2530', '#FFFFFF'],
    caption: { look: 'minimal', size: 0.038, y: 0.5, wordsPerLine: 5, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'soft' } },
    docu: 'noir', zones: false, motions: ['slow_zoom', 'drift', 'zoom_out', 'slow_pan'],
    recipe: { cards: false, docuBeats: false, lenMs: 3000, frame: 'full', coverage: 'alternate', videoMode: 'video', fillGaps: false, grade: { contrast: 0.15, sat: -8, bright: -0.02 } } },
  { id: 'studio', name: 'Studio Agency', hint: 'Light studio, deep red type, floating cards', swatch: ['#ECE8EA', '#FFFFFF', '#E0122B'],
    caption: { look: 'pop', size: 0.058, y: 0.2, wordsPerLine: 3, upper: false, color: '#8B0012', highlight: '#E0122B', fx: { font: 'editorial', italic: true } },
    docu: 'rose', zones: false, motions: ['zoom_in', 'slow_pan', 'pan_right', 'zoom_out'],
    recipe: { cards: true, docuBeats: false, lenMs: 2200, frame: 'card', coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0.06, sat: 4, bright: 0.04 } } },
  { id: 'purpletech', name: 'Purple Tech', hint: 'Dark violet glow, condensed titles, tilted cards', swatch: ['#0B0720', '#1B1240', '#8B5CF6'],
    caption: { look: 'pill', size: 0.05, y: 0.8, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#8B5CF6', fx: { font: 'poppins' } },
    docu: 'purple', zones: false, motions: ['zoom_in', 'pan_right', 'slow_zoom', 'pan_left'],
    recipe: { cards: true, docuBeats: false, lenMs: 2500, frame: 'card', coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0.1, sat: 10, bright: 0 } } },
  { id: 'monodocu', name: 'Mono Docu', hint: 'Black and white, archive photos, spotlight type', swatch: ['#0A0A0A', '#D9D9D4', '#FFFFFF'],
    caption: { look: 'minimal', size: 0.052, y: 0.2, wordsPerLine: 4, upper: false, color: '#F2F2EE', highlight: '#FFFFFF', fx: { font: 'sans' } },
    docu: 'mono', zones: false, motions: ['slow_zoom', 'drift', 'zoom_out', 'slow_pan'],
    recipe: { cards: false, docuBeats: true, lenMs: 2500, frame: 'blur', coverage: 'every', videoMode: 'photos', fillGaps: true, grade: { contrast: 0.16, sat: -100, bright: 0 } } },
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
  p.grade = { ...c.recipe.grade };
  // captions are NOT touched: their look belongs to the auto-captions templates
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
