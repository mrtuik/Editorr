/** HTML/CSS visuals: no photos, no stock clips. Every visual is a type + a little data + a theme + a motion set. */

export type VisualType =
  | 'stat_counter' | 'quote_card' | 'definition_card' | 'list_card' | 'versus_card'
  | 'bar_chart' | 'line_chart' | 'progress_ring' | 'timeline' | 'keyword_title'
  | 'code_window' | 'terminal' | 'post_card' | 'receipt_card'
  | 'highlight_card' | 'stack_card' | 'frame_card'
  | 'title_stack' | 'pill_row' | 'flow_diagram' | 'geo_title' | 'cta_card' | 'before_after' | 'arrow_callout' | 'window_card' | 'halftone_frame';

export const VISUAL_TYPES: VisualType[] = [
  'stat_counter', 'quote_card', 'definition_card', 'list_card', 'versus_card',
  'bar_chart', 'line_chart', 'progress_ring', 'timeline', 'keyword_title',
  'code_window', 'terminal', 'post_card', 'receipt_card',
  'highlight_card', 'stack_card', 'frame_card',
  'title_stack', 'pill_row', 'flow_diagram', 'geo_title', 'cta_card', 'before_after', 'arrow_callout', 'window_card', 'halftone_frame',
];

export const VISUAL_LABEL: Record<VisualType, string> = {
  stat_counter: 'Stat', quote_card: 'Quote', definition_card: 'Definition', list_card: 'List', versus_card: 'Versus',
  bar_chart: 'Bars', line_chart: 'Line', progress_ring: 'Ring', timeline: 'Timeline', keyword_title: 'Keyword',
  code_window: 'Code', terminal: 'Terminal', post_card: 'Post', receipt_card: 'Receipt',
  highlight_card: 'Highlight', stack_card: 'Stack', frame_card: 'Frame',
  title_stack: 'Title', pill_row: 'Pills', flow_diagram: 'Flow', geo_title: 'Shapes', cta_card: 'CTA', before_after: 'Before/After', arrow_callout: 'Arrow', window_card: 'Window', halftone_frame: 'Halftone',
};

/** All fields optional; each template reads only what it needs. Lists: list_card/timeline use `items`, bar_chart `labels`+`values`,
 *  line_chart `values` (points), terminal/receipt_card `lines` (receipt line = "name | price"). */
export interface VisualData {
  title?: string; big?: string; label?: string; trend?: 'up' | 'down' | 'flat';
  quote?: string; accent?: string; term?: string; meaning?: string;
  items?: string[]; left?: string; right?: string;
  labels?: string[]; values?: number[]; percent?: number;
  lang?: 'html' | 'css' | 'javascript' | 'terminal'; code?: string; lines?: string[];
  text?: string; name?: string; handle?: string; shop?: string; total?: string;
}

export type MotionGroup = 'entrance' | 'emphasis' | 'transition' | 'exit';

/** Values at one keyframe. x/y are a share of the short side, s = scale, r = degrees, o = opacity, b = blur as a share of the short side. */
export interface MotionProps { x: number; y: number; s: number; r: number; o: number; b: number }
import type { EaseName } from './ease';
export type { EaseName };

export interface MotionPreset {
  id: string; group: MotionGroup; durationMs: number; delayMs: number; easing: EaseName;
  keyframes: { offset: number; properties: Partial<MotionProps> }[];
}
/** in/hold/out = whole-card presets; text = how the words inside move (see textAnim.ts), optional so older beats still load */
export interface MotionSelection { in: string; hold: string; out: string; text?: string }

export interface VisualTheme {
  id: string; name: string;
  /** colour behind the card text (the card itself); the frame around the card stays transparent over the video */
  bg: string; card: string; text: string; muted: string; accent: string; highlight: string;
  font: string; serif: string; mono: string;
  radius: number; shadow: string; border: string; dot?: string;
  /** plain colour for the Canvas 2D fallback when `card` is a gradient */
  cardSolid?: string;
  /** several ids per slot so neighbouring visuals do not move the same way */
  motionSet: { in: string[]; hold: string[]; out: string[]; text?: string[] };
}

/** A visual on the timeline (timeline ms). */
export interface Visual {
  id: string; type: VisualType; data: VisualData; themeId: string; motion: MotionSelection;
  startMs: number; endMs: number;
}

/** Step A result: one empty slot of the plan. */
export interface VisualSlot { id: string; startMs: number; endMs: number; type: VisualType; intent: string }

export interface TWord { text: string; startMs: number; endMs: number }
