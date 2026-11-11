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
import { KALLAWAY_THEME, type CardTheme, type KallawayKind } from './kallaway';

export type CreatorId = 'kallaway' | 'hormozi' | 'vox' | 'noir' | 'keynote' | 'swiss' | 'cyber' | 'breaking'
  | 'cinema' | 'neonhook' | 'cinedocu' | 'studio' | 'purpletech' | 'monodocu'
  | 'purpleshowcase' | 'dynhead' | 'aifilm' | 'minimal' | 'screentut' | 'techcommercial';

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
  /** frames the B-roll cuts rotate through (full screen, floating card, blurred backdrop): a template's own composition rhythm. Missing = `frame` for all. */
  frames?: BrollFrame[];
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
  /** look of the cards this template draws (Kallaway look when missing) */
  card?: CardTheme;
  /** card kinds this creator prefers (used when the director found enough of them) */
  cardKinds?: KallawayKind[];
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
  { id: 'cinedocu', name: 'Cine Docu', hint: 'Cinematic creator documentary: you + full-frame film cutaways', swatch: ['#0C1116', '#1B2530', '#FFFFFF'],
    caption: { look: 'minimal', size: 0.038, y: 0.5, wordsPerLine: 5, upper: false, color: '#FFFFFF', highlight: '#FFFFFF', fx: { font: 'soft' } },
    docu: 'noir', zones: false, motions: ['slow_zoom', 'drift', 'zoom_out', 'slow_pan'],
    recipe: { cards: false, docuBeats: false, lenMs: 3000, frame: 'full', frames: ['full', 'full', 'blur'], coverage: 'alternate', videoMode: 'video', fillGaps: false, grade: { contrast: 0.15, sat: -8, bright: -0.02 } } },
  { id: 'studio', name: 'Studio Agency', hint: 'Light studio, deep red type, floating cards', swatch: ['#ECE8EA', '#FFFFFF', '#E0122B'],
    caption: { look: 'pop', size: 0.058, y: 0.2, wordsPerLine: 3, upper: false, color: '#8B0012', highlight: '#E0122B', fx: { font: 'editorial', italic: true } },
    docu: 'rose', zones: false, motions: ['zoom_in', 'slow_pan', 'pan_right', 'zoom_out'],
    recipe: { cards: true, docuBeats: false, lenMs: 2200, frame: 'card', coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0.06, sat: 4, bright: 0.04 } },
    card: { bg: '#ECE8EA', dot: 'rgba(139,0,18,0.12)', vig: 'rgba(150,120,130,0.28)', accent: '#E0122B', text: '#7A0012', muted: '#9A7A82', surface: '#FFFFFF', surfaceOn: '#FFE3E7', line: '#D9C5CA',
      cardFill: 'rgba(255,255,255,0.97)', cardStroke: 'rgba(139,0,18,0.2)', edge: '255,255,255',
      sans: '"Inter","Noto Sans Bengali","Noto Sans Devanagari",system-ui,sans-serif', serif: '"Playfair Display","Georgia","Noto Serif Bengali",serif', titleW: 800, radius: 30, share: 0.5 } },
  { id: 'purpletech', name: 'Purple Tech', hint: 'Dark violet glow, condensed titles, tilted cards', swatch: ['#0B0720', '#1B1240', '#8B5CF6'],
    caption: { look: 'pill', size: 0.05, y: 0.8, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#8B5CF6', fx: { font: 'poppins' } },
    docu: 'purple', zones: false, motions: ['zoom_in', 'pan_right', 'slow_zoom', 'pan_left'],
    recipe: { cards: true, docuBeats: false, lenMs: 2500, frame: 'card', coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0.1, sat: 10, bright: 0 } },
    card: { bg: '#0B0720', dot: 'rgba(167,139,250,0.22)', vig: 'rgba(11,7,32,0.96)', accent: '#8B5CF6', text: '#F1ECFF', muted: '#9C93C4', surface: '#1B1240', surfaceOn: '#2A1B66', line: '#4B3B8F',
      cardFill: 'rgba(27,18,64,0.92)', cardStroke: 'rgba(167,139,250,0.35)', edge: '196,181,253',
      sans: 'Oswald,"Arial Narrow",Impact,"Noto Sans Bengali","Noto Sans Devanagari",sans-serif', serif: '"Playfair Display","Georgia","Noto Serif Bengali",serif', titleW: 700, radius: 36, share: 0.6 } },
  { id: 'monodocu', name: 'Mono Docu', hint: 'Black and white, archive photos, spotlight type', swatch: ['#0A0A0A', '#D9D9D4', '#FFFFFF'],
    caption: { look: 'minimal', size: 0.052, y: 0.2, wordsPerLine: 4, upper: false, color: '#F2F2EE', highlight: '#FFFFFF', fx: { font: 'sans' } },
    docu: 'mono', zones: false, motions: ['slow_zoom', 'drift', 'zoom_out', 'slow_pan'],
    recipe: { cards: false, docuBeats: true, lenMs: 2500, frame: 'blur', coverage: 'every', videoMode: 'photos', fillGaps: true, grade: { contrast: 0.16, sat: -100, bright: 0 } } },
  // ---- reference-video styles
  { id: 'purpleshowcase', name: 'Purple AI Showcase', hint: 'Dark violet world, floating panels over you, premium reveals', swatch: ['#0B0720', '#1B1240', '#8B5CF6'],
    caption: { look: 'pill', size: 0.05, y: 0.8, wordsPerLine: 3, upper: false, color: '#FFFFFF', highlight: '#8B5CF6', fx: { font: 'poppins' } },
    docu: 'purple', zones: false, motions: ['zoom_in', 'pan_right', 'slow_zoom', 'pan_left'],
    recipe: { cards: false, docuBeats: true, lenMs: 2400, frame: 'card', frames: ['card', 'card', 'blur'], coverage: 'alternate', videoMode: 'mix', fillGaps: false, grade: { contrast: 0.1, sat: 10, bright: 0 } } },
  { id: 'dynhead', name: 'Dynamic Talking Head', hint: 'Fast cuts, punchy emphasis words, quick cutaways', swatch: ['#000000', '#141414', '#FFE600'],
    caption: { look: 'bold', size: 0.06, y: 0.72, wordsPerLine: 2, upper: true, color: '#FFFFFF', highlight: '#FFE600', fx: { font: 'heavy' } },
    docu: 'hormozi', zones: false, motions: ['punch_in', 'zoom_in', 'punch_in', 'drift'],
    recipe: { cards: false, docuBeats: true, lenMs: 1400, frame: 'full', frames: ['card', 'full', 'full'], coverage: 'alternate', videoMode: 'mix', fillGaps: false, grade: { contrast: 0.12, sat: 14, bright: 0.03 } } },
  { id: 'aifilm', name: 'AI Cinematic Film', hint: 'Surreal film scenes, slow camera, atmospheric, long takes', swatch: ['#05080C', '#101820', '#C9A66B'],
    caption: { look: 'minimal', size: 0.045, y: 0.5, wordsPerLine: 4, upper: false, color: '#F2EBDD', highlight: '#C9A66B', fx: { font: 'soft' } },
    docu: 'noir', zones: false, motions: ['slow_zoom', 'drift', 'zoom_out', 'slow_pan'],
    recipe: { cards: false, docuBeats: true, lenMs: 3200, frame: 'full', frames: ['full', 'full', 'blur'], coverage: 'every', videoMode: 'video', fillGaps: true, grade: { contrast: 0.18, sat: -14, bright: -0.04 } } },
  { id: 'minimal', name: 'Minimal Studio Commercial', hint: 'Clean light studio, product-style photos, quiet type', swatch: ['#F2F2F0', '#FFFFFF', '#111111'],
    caption: { look: 'minimal', size: 0.045, y: 0.2, wordsPerLine: 4, upper: false, color: '#111111', highlight: '#111111', fx: { font: 'sans' } },
    docu: 'swiss', zones: false, motions: ['slow_zoom', 'zoom_out', 'drift'],
    recipe: { cards: false, docuBeats: true, lenMs: 2600, frame: 'card', frames: ['card', 'card', 'blur'], coverage: 'alternate', videoMode: 'photos', fillGaps: false, grade: { contrast: 0.04, sat: 2, bright: 0.05 } } },
  { id: 'screentut', name: 'Screen Tutorial', hint: 'You in a corner, interface-style cutaways and callouts', swatch: ['#06100C', '#0C1F18', '#2CFF8F'],
    caption: { look: 'pill', size: 0.045, y: 0.82, wordsPerLine: 4, upper: false, color: '#FFFFFF', highlight: '#2CFF8F', fx: { font: 'sans' } },
    docu: 'cyber', zones: false, motions: ['zoom_in', 'pan_right', 'zoom_in', 'pan_left'],
    recipe: { cards: false, docuBeats: true, lenMs: 2200, frame: 'card', frames: ['card', 'full', 'card'], coverage: 'alternate', videoMode: 'mix', fillGaps: false, grade: { contrast: 0.06, sat: 0, bright: 0.02 } } },
  { id: 'techcommercial', name: 'Premium Tech Commercial', hint: 'Black and violet, rapid product-style visuals, bold type', swatch: ['#050308', '#140C2A', '#A78BFA'],
    caption: { look: 'bold', size: 0.055, y: 0.5, wordsPerLine: 2, upper: true, color: '#FFFFFF', highlight: '#A78BFA', fx: { font: 'heavy' } },
    docu: 'purple', zones: false, motions: ['zoom_in', 'punch_in', 'pan_right', 'slow_zoom'],
    recipe: { cards: false, docuBeats: true, lenMs: 1800, frame: 'full', frames: ['card', 'blur', 'full'], coverage: 'every', videoMode: 'mix', fillGaps: true, grade: { contrast: 0.14, sat: 6, bright: -0.02 } } },
];

// ---- card looks for every creator (Studio and Purple have theirs inline); a card drawn under any template follows that template
const mk = (o: Partial<CardTheme>): CardTheme => ({ ...KALLAWAY_THEME, ...o });
const SANS_UI = '"Inter","Noto Sans Bengali","Noto Sans Devanagari",system-ui,sans-serif';
const SANS_OSW = 'Oswald,"Arial Narrow",Impact,"Noto Sans Bengali","Noto Sans Devanagari",sans-serif';
const SANS_MONO = '"JetBrains Mono","Roboto Mono","Courier New","Noto Sans Bengali",monospace';
const CARD_THEMES: Partial<Record<CreatorId, CardTheme>> = {
  purpleshowcase: mk({ bg: '#0B0720', dot: 'rgba(167,139,250,0.2)', vig: 'rgba(11,7,32,0.96)', accent: '#8B5CF6', text: '#F1ECFF', muted: '#9C93C4', surface: '#1B1240', surfaceOn: '#2A1B66', line: '#4B3B8F', cardFill: 'rgba(27,18,64,0.92)', cardStroke: 'rgba(167,139,250,0.35)', edge: '196,181,253', sans: SANS_OSW, titleW: 700, radius: 36 }),
  techcommercial: mk({ bg: '#050308', dot: 'rgba(167,139,250,0.14)', vig: 'rgba(5,3,8,0.97)', accent: '#A78BFA', text: '#FFFFFF', muted: '#8E86AE', surface: '#140C2A', surfaceOn: '#22164A', line: '#43358A', cardFill: 'rgba(20,12,42,0.94)', cardStroke: 'rgba(167,139,250,0.4)', edge: '196,181,253', sans: SANS_UI, titleW: 900, radius: 28 }),
  dynhead: mk({ bg: '#000000', dot: 'rgba(255,230,0,0.12)', vig: 'rgba(0,0,0,0.96)', accent: '#FFE600', surface: '#1A1A1A', surfaceOn: '#2B2A00', line: '#6B6200', cardFill: 'rgba(18,18,0,0.95)', cardStroke: 'rgba(255,230,0,0.55)', edge: '255,230,0', sans: SANS_UI, titleW: 900, radius: 14 }),
  aifilm: mk({ bg: '#05080C', dot: 'rgba(201,166,107,0.1)', vig: 'rgba(2,4,6,0.97)', accent: '#C9A66B', text: '#F2EBDD', muted: '#9A9078', surface: '#101820', surfaceOn: '#18242E', line: '#4A5A66', cardFill: 'rgba(16,24,32,0.92)', sans: SANS_UI, titleW: 600, radius: 6 }),
  minimal: mk({ bg: '#F2F2F0', dot: 'rgba(0,0,0,0.08)', vig: 'rgba(130,130,130,0.18)', accent: '#111111', text: '#111111', muted: '#7A7A78', surface: '#FFFFFF', surfaceOn: '#EDEDEB', line: '#C8C8C6', cardFill: 'rgba(255,255,255,1)', cardStroke: 'rgba(0,0,0,0.25)', sans: SANS_UI, titleW: 700, radius: 22 }),
  screentut: mk({ bg: '#06100C', dot: 'rgba(44,255,143,0.14)', vig: 'rgba(2,8,6,0.96)', accent: '#2CFF8F', text: '#E8FFF3', muted: '#5FA27F', surface: '#0C1F18', surfaceOn: '#12382A', line: '#1E7A4B', cardFill: 'rgba(12,31,24,0.94)', cardStroke: 'rgba(44,255,143,0.45)', edge: '44,255,143', sans: SANS_MONO, titleW: 700, radius: 12 }),
  hormozi: mk({ bg: '#000000', dot: 'rgba(255,230,0,0.12)', vig: 'rgba(0,0,0,0.96)', accent: '#FFE600', muted: '#B8B8B8', surface: '#1A1A1A', surfaceOn: '#2B2A00', line: '#6B6200', cardFill: 'rgba(18,18,0,0.95)', cardStroke: 'rgba(255,230,0,0.55)', edge: '255,230,0', sans: SANS_UI, titleW: 900, radius: 14 }),
  vox: mk({ bg: '#0A2A8A', dot: 'rgba(255,255,255,0.14)', vig: 'rgba(5,20,80,0.9)', accent: '#FFD60A', muted: '#B9C6F5', surface: '#1239B8', surfaceOn: '#1C4DE0', line: '#4F73E8', cardFill: 'rgba(18,57,184,0.95)', cardStroke: 'rgba(255,214,10,0.45)', sans: SANS_UI, titleW: 900, radius: 20 }),
  noir: mk({ bg: '#000000', dot: 'rgba(255,255,255,0.1)', vig: 'rgba(0,0,0,0.98)', accent: '#E5192B', text: '#F5F5F0', muted: '#9B9B9B', surface: '#0E0E0E', surfaceOn: '#1A1A1A', line: '#3A3A3A', cardFill: 'rgba(5,5,5,0.96)', cardStroke: 'rgba(255,255,255,0.1)', sans: SANS_OSW, titleW: 700, radius: 4 }),
  keynote: mk({ bg: '#161618', dot: 'rgba(255,255,255,0.08)', vig: 'rgba(10,10,12,0.9)', accent: '#0A84FF', text: '#F5F5F7', muted: '#98989D', surface: '#2A2A2D', surfaceOn: '#3A3A3E', line: '#58585D', cardFill: 'rgba(42,42,45,0.94)', cardStroke: 'rgba(255,255,255,0.1)', sans: SANS_UI, titleW: 700, radius: 40 }),
  swiss: mk({ bg: '#E9E9E9', dot: 'rgba(0,0,0,0.1)', vig: 'rgba(120,120,120,0.2)', accent: '#000000', text: '#0A0A0A', muted: '#6A6A6A', surface: '#FFFFFF', surfaceOn: '#EFEFEF', line: '#BDBDBD', cardFill: 'rgba(255,255,255,1)', cardStroke: 'rgba(0,0,0,0.6)', sans: SANS_UI, titleW: 800, radius: 0 }),
  cyber: mk({ bg: '#020C08', dot: 'rgba(44,255,143,0.18)', vig: 'rgba(2,12,8,0.96)', accent: '#2CFF8F', text: '#B6FFD6', muted: '#5FA27F', surface: '#04180F', surfaceOn: '#07301F', line: '#1E7A4B', cardFill: 'rgba(4,24,15,0.94)', cardStroke: 'rgba(44,255,143,0.5)', edge: '44,255,143', sans: SANS_MONO, titleW: 800, radius: 8 }),
  breaking: mk({ bg: '#000000', dot: 'rgba(229,25,43,0.12)', vig: 'rgba(0,0,0,0.96)', accent: '#E5192B', surface: '#14141A', surfaceOn: '#22222C', line: '#3C3C48', cardFill: 'rgba(14,14,18,0.95)', cardStroke: 'rgba(229,25,43,0.5)', sans: SANS_OSW, titleW: 700, radius: 6 }),
  cinema: mk({ bg: '#04121A', dot: 'rgba(120,200,220,0.12)', vig: 'rgba(2,10,14,0.95)', accent: '#E5192B', surface: '#0B2A36', surfaceOn: '#123A4A', line: '#2C5E72', cardFill: 'rgba(11,42,54,0.9)', sans: SANS_UI, titleW: 800, radius: 24 }),
  neonhook: mk({ bg: '#000000', dot: 'rgba(215,255,0,0.14)', vig: 'rgba(0,0,0,0.96)', accent: '#D7FF00', muted: '#9AA05A', surface: '#121212', surfaceOn: '#1E2200', line: '#4A5200', cardFill: 'rgba(14,14,14,0.95)', cardStroke: 'rgba(215,255,0,0.5)', edge: '215,255,0', sans: SANS_UI, titleW: 900, radius: 10 }),
  cinedocu: mk({ bg: '#0C1116', dot: 'rgba(255,255,255,0.08)', vig: 'rgba(4,7,10,0.95)', accent: '#FFFFFF', muted: '#8FA0B0', surface: '#1B2530', surfaceOn: '#26333F', line: '#4A5B6B', cardFill: 'rgba(27,37,48,0.9)', sans: SANS_UI, titleW: 600, radius: 18 }),
  monodocu: mk({ bg: '#0A0A0A', dot: 'rgba(255,255,255,0.1)', vig: 'rgba(0,0,0,0.97)', accent: '#FFFFFF', text: '#F2F2EE', muted: '#9A9A96', surface: '#1A1A1A', surfaceOn: '#2A2A2A', line: '#555555', cardFill: 'rgba(24,24,24,0.95)', cardStroke: 'rgba(255,255,255,0.3)', sans: SANS_UI, titleW: 800, radius: 10 }),
};
const CARD_KINDS: Partial<Record<CreatorId, KallawayKind[]>> = {
  studio: ['steps', 'quote', 'photo', 'tweet', 'script'],
  purpletech: ['steps', 'loop', 'stat', 'versus'],
};
/** the seven styles made from reference videos come first in the template library */
export const REFERENCE_STYLES: CreatorId[] = ['purpleshowcase', 'cinedocu', 'dynhead', 'aifilm', 'minimal', 'screentut', 'techcommercial'];
/** short list of what a template does to the edit, shown on its tile */
export function traitsOf(cr: CreatorTemplate): string[] {
  const r = cr.recipe, t: string[] = [];
  t.push(r.videoMode === 'video' ? 'Film clips' : r.videoMode === 'photos' ? 'Photos' : 'Clips + photos');
  const fr = new Set(r.frames ?? [r.frame]);
  t.push([...fr].map((f) => (f === 'full' ? 'Full frame' : f === 'card' ? 'Floating' : 'Blur backdrop')).join(' / '));
  t.push(`${(r.lenMs / 1000).toFixed(1)}s cuts`);
  if (r.grade.sat <= -90) t.push('Black & white'); else if (r.grade.contrast >= 0.14) t.push('Cinematic grade');
  if (r.cards) t.push('Cards'); else if (r.docuBeats) t.push('Typography');
  if (r.fillGaps) t.push('Non-stop visuals');
  return t;
}
for (const cr of CREATORS) { cr.card ??= CARD_THEMES[cr.id]; cr.cardKinds ??= CARD_KINDS[cr.id]; }
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
