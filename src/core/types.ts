export type Role = 'host' | 'constant';
export type LayoutStyle = 'one' | 'side' | 'updown' | 'popup';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export type PopupSize = 'S' | 'M' | 'L';
export type Sensitivity = 'low' | 'medium' | 'high';
export type Confidence = 'High' | 'Medium' | 'Low';

export interface VideoRef {
  /** Display name */
  name: string;
  /** Object URL for web preview (not persisted) */
  url: string;
  /** Native content/file URI if known (persisted) */
  uri?: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
}

export interface Segment {
  id: string;
  startMs: number;
  endMs: number;
  style: LayoutStyle;
  /** Which video is full-screen (one / popup). */
  main: Role;
  corner: Corner;
  size: PopupSize;
}

export interface Settings {
  sensitivity: Sensitivity;
  minSegmentMs: number;
  resolution: 720 | 1080;
  bothSpeaking: 'hold' | 'side';
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  host?: Omit<VideoRef, 'url'>;
  constant?: Omit<VideoRef, 'url'>;
  /** constantTime = hostTime + offsetMs */
  offsetMs: number;
  syncConfidence?: Confidence;
  segments: Segment[];
  mainAudio: Role;
  normalize: boolean;
  durationMs: number;
}

export interface SyncResult {
  offsetMs: number;
  confidence: Confidence;
  score: number;
}

export const STYLE_LABEL: Record<LayoutStyle, string> = {
  one: 'One-to-one',
  side: 'Side by side',
  updown: 'Up / Down',
  popup: 'Popup',
};

export const STYLE_COLOR = {
  oneHost: '#3B82F6',
  oneConstant: '#22C55E',
  side: '#A855F7',
  updown: '#F97316',
  popup: '#EC4899',
};

export function segmentColor(s: Segment): string {
  if (s.style === 'one') return s.main === 'host' ? STYLE_COLOR.oneHost : STYLE_COLOR.oneConstant;
  if (s.style === 'side') return STYLE_COLOR.side;
  if (s.style === 'updown') return STYLE_COLOR.updown;
  return STYLE_COLOR.popup;
}
