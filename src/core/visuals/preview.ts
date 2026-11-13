/** One rendered frame of a template's own visual, for the Templates tab tiles. */
import { loadVisualFonts } from './fonts';
import { pickMotion } from './motion';
import { renderFrame } from './render';
import { getTheme } from './themes';
import type { Visual, VisualData, VisualType } from './types';

export const SAMPLE: Record<VisualType, VisualData> = {
  stat_counter: { big: '1,250', label: 'new users', trend: 'up' },
  quote_card: { quote: 'Small habits make big change', accent: 'big' },
  definition_card: { term: 'Habit', meaning: 'something you do daily' },
  list_card: { title: 'Steps', items: ['Start small', 'Stay steady', 'Repeat'] },
  versus_card: { left: 'Before', right: 'After' },
  bar_chart: { labels: ['Jan', 'Feb', 'Mar'], values: [30, 55, 80] },
  line_chart: { values: [3, 5, 4, 8, 12, 11, 18] },
  progress_ring: { percent: 72, label: 'done' },
  timeline: { items: ['Plan', 'Build', 'Launch'] },
  keyword_title: { title: 'Big idea' },
  code_window: { lang: 'javascript', code: 'const a = 1;\nrun(a);' },
  terminal: { lines: ['npm run build', 'done'] },
  post_card: { text: 'Small habits win', name: 'Someone', handle: '@someone' },
  receipt_card: { shop: 'Cafe', lines: ['Tea | 20', 'Toast | 40'], total: '60' },
  highlight_card: { text: 'Small habits make big change', accent: 'big' },
  stack_card: { items: ['Small', 'habits', 'big change'] },
  frame_card: { title: 'Stay steady', accent: 'steady' },
  title_stack: { title: 'The Perfect', accent: 'Solution', label: 'every time' },
  pill_row: { title: 'Get it as', items: ['Video', 'MP3', 'Transcript'] },
  flow_diagram: { title: 'Idea to reel', items: ['Idea', 'Edit', 'Post'] },
  geo_title: { title: 'Big idea' },
  cta_card: { title: 'Comment', accent: 'Guide', label: 'to get the link' },
  before_after: { left: 'Raw clip', right: 'Final reel' },
  arrow_callout: { title: 'Scroll up', trend: 'up' },
  window_card: { title: 'Just paste a link', label: 'youtube.com', items: ['Download'] },
  halftone_frame: { title: 'Who can edit' },
};

const cache = new Map<string, string>();
export async function previewUrl(themeId: string, type: VisualType, w = 216, h = 384): Promise<string> {
  const key = `${themeId}|${type}|${w}x${h}`, hit = cache.get(key);
  if (hit) return hit;
  await loadVisualFonts();
  const th = getTheme(themeId);
  const v: Visual = { id: 'pv', type, data: SAMPLE[type], themeId, motion: pickMotion(th, 0), startMs: 0, endMs: 3500 };
  const cv = await renderFrame(v, 1600, w, h), url = cv.toDataURL('image/png');
  cache.set(key, url); return url;
}
