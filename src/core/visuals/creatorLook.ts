/** Every creator template gets a visual theme and the types it likes most (visualMix). */
import type { CreatorId } from '../creators';
import type { VisualType } from './types';

export interface VisualLook { theme: string; mix: VisualType[] }
const L = (theme: string, mix: VisualType[]): VisualLook => ({ theme, mix });
const HORMOZI = L('hormozi', ['stat_counter', 'keyword_title', 'list_card']);
const CODE = L('code', ['code_window', 'terminal', 'stat_counter']);
const VOX = L('vox', ['bar_chart', 'versus_card', 'definition_card']);
const KALLAWAY = L('kallaway', ['quote_card', 'list_card', 'stat_counter', 'timeline']);
const NOIR = L('noir', ['quote_card', 'keyword_title', 'timeline']);
const KEYNOTE = L('keynote', ['stat_counter', 'list_card', 'progress_ring']);
const SWISS = L('swiss', ['definition_card', 'versus_card', 'list_card']);
const CYBER = L('cyber', ['terminal', 'stat_counter', 'code_window']);
const MIN_L = L('minimal-light', ['keyword_title', 'quote_card', 'definition_card']);
const MIN_D = L('minimal-dark', ['keyword_title', 'quote_card', 'stat_counter']);

const MAP: Partial<Record<CreatorId, VisualLook>> = {
  kallaway: KALLAWAY, kallaway_pro: KALLAWAY, hormozi: HORMOZI, dynhead: HORMOZI, neonhook: HORMOZI,
  vox: VOX, vox_split: VOX, noir: NOIR, cinedocu: NOIR, cinema: NOIR, aifilm: NOIR, monodocu: NOIR, breaking: NOIR,
  keynote: KEYNOTE, techcommercial: KEYNOTE, purpletech: KEYNOTE, purpleshowcase: KEYNOTE,
  swiss: SWISS, studio: SWISS, minimal: MIN_L,
  cyber: CYBER, screentut: CYBER, tech_terminal: CYBER, code_revealer: CODE,
};
export const visualLookFor = (id: CreatorId | undefined): VisualLook => (id && MAP[id]) || MIN_D;
