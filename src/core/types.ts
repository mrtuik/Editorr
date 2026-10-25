export type Role = 'host' | 'constant';
export type LayoutStyle = 'one' | 'side' | 'updown' | 'popup';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export type PopupSize = 'S' | 'M' | 'L';
export type Sensitivity = 'low' | 'medium' | 'high';
export type Confidence = 'High' | 'Medium' | 'Low';
export type Aspect = '16:9' | '9:16' | '1:1' | '4:5' | '3:4' | '4:3';
export type SilenceSens = 'low' | 'medium' | 'high';
export type CropRatio = 'custom' | '9:16' | '16:9' | '1:1' | '4:3' | '2:3';

/** Pan/zoom of one video inside its frame. zoom 1 = no crop. x,y in -1..1 move the picture. */
export interface CropState {
  zoom: number;
  x: number;
  y: number;
  rotate: number;
  ratio?: CropRatio;
  frameRatio?: number;
  radius?: number;
  strokeWidth?: number;
  strokeColor?: string;
  /** Free placement of the whole clip box: move (fraction of its slot size) and size. Not the crop. */
  px?: number;
  py?: number;
  ps?: number;
}
export const NO_CROP: CropState = { zoom: 1, x: 0, y: 0, rotate: 0, ratio: 'custom', radius: 0, strokeWidth: 0, strokeColor: '#ffffff' };

export const ASPECTS: Record<Aspect, [number, number]> = {
  '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '3:4': [3, 4], '4:3': [4, 3],
};
export const aspectValue = (a: Aspect) => ASPECTS[a][0] / ASPECTS[a][1];

/** Output pixel size. `short` (720/1080) is the short side, like phone editors do. Always even numbers. */
export function outputSize(a: Aspect, short: number): { w: number; h: number } {
  const [aw, ah] = ASPECTS[a];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return aw >= ah ? { w: even((short * aw) / ah), h: even(short) } : { w: even(short), h: even((short * ah) / aw) };
}

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
  /** Video codec mime from the phone, e.g. video/avc or video/hevc (native app only). */
  codec?: string;
  /** Average bits per second, whole file. */
  bitrate?: number;
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
  /** Own crop of this clip. Missing = use the project crop. */
  cropHost?: CropState;
  cropConst?: CropState;
  /** A cutaway to the listener made by the Reaction tool. */
  reaction?: boolean;
}

export interface Settings {
  sensitivity: Sensitivity;
  minSegmentMs: number;
  /** Export short side in pixels: 480, 720, 1080, 1440 (2K) or 2160 (4K). */
  resolution: number;
  /** Export frame rate: 24, 25, 30, 50 or 60. The real rate never goes above the source. */
  fps: number;
  /** Export bitrate in Mbps. 0 = automatic (recommended for the picked size). */
  bitrateMbps: number;
  bothSpeaking: 'hold' | 'side' | 'updown' | 'popup';
  /** Silence cut: both people quiet for at least this long gets removed. */
  silenceMinMs: number;
  /** Keep this much quiet time next to speech so words are not clipped. */
  silencePadMs: number;
  silenceSens: SilenceSens;
  preferredAudio?: 'auto' | 'host' | 'constant';
  /** Faces / Autoframe: follow whoever talks in a camera ('speaker') or only the person picked ('picked'). */
  faceFollow?: 'speaker' | 'picked';
  /** How the frame moves from one person to the other: glide or instant cut. */
  faceMode?: 'smooth' | 'cut';
  /** Glide time in ms when faceMode is 'smooth'. */
  faceSpeedMs?: number;
  /** How close the face is framed. */
  faceTight?: 'wide' | 'medium' | 'close';
  /** What Autoframe uses to cut between Host and Constant. */
  autoframeBy?: 'lips' | 'both' | 'audio';
  /** Autoframe: the camera switches this long BEFORE the new speaker starts (ms). 0 = off. */
  leadInMs?: number;
  /** Autoframe: a short answer ("hmm", a laugh) shorter than this does not switch the camera (ms). 0 = off. */
  ignoreShortMs?: number;
  /** Captions: Whisper size and spoken language ('' = auto). */
  whisperModel?: 'base' | 'small';
  captionLang?: string;
  /** Reaction tool: talk time before a cutaway and its length (ms). */
  reactAfterMs?: number;
  reactLengthMs?: number;
  /** Auto zoom. */
  zoomStrength?: 'soft' | 'medium' | 'strong';
  /** Auto zoom shape: how much (1.15 = 15%), ease in / hold / ease out in ms, and the easing curve [x1,y1,x2,y2]. */
  zoomAmount?: number;
  zoomInMs?: number;
  zoomHoldMs?: number;
  zoomOutMs?: number;
  zoomEase?: number[];
  /** Music: level under the voice (dB), drop while talking (dB), fade in/out (ms). */
  musicLevelDb?: number;
  musicDuckDb?: number;
  musicFadeMs?: number;
  /** Music > Music (by hand): level compared with the voice (dB) and whether it drops while someone talks. */
  musicClipDb?: number;
  musicClipDuck?: boolean;
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
  /** Volume of each mic in percent, 0 to 1000 (100 = unchanged). */
  volumeHost: number;
  volumeConst: number;
  durationMs: number;
  aspect: Aspect;
  cropHost: CropState;
  cropConst: CropState;
  mirrorHost: boolean;
  mirrorConst: boolean;
  /** Which person to follow in each video (a point on the frame, 0..1). Missing = the main person. */
  faceHost?: { x: number; y: number };
  faceConst?: { x: number; y: number };
  /** Noise reduction strength, 0 (off) to 100, per source video. */
  noiseHost: number;
  noiseConst: number;
  /** The preview of this video runs on a small H.264 copy (set once one was needed). */
  proxyHost?: boolean;
  proxyConst?: boolean;
  /** Auto captions (words with times) and how they look. */
  captions?: import('./captions').CaptionData;
  captionStyle?: import('./captions').CaptionStyle;
  /** Baked background music + sound effects (one wav at timeline time) and the settings it was made with. */
  bgm?: { path: string; names: string[]; levelDb: number; duckDb: number; fadeMs: number; sfx: { name: string; startMs: number }[] };
  /** small jpeg data URL for Home */
  thumb?: string;
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
  oneHost: '#E5E5E5',
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

export const RES_STEPS = [480, 720, 1080, 1440, 2160];
export const FPS_STEPS = [24, 25, 30, 50, 60];
export const BITRATE_STEPS = [5, 10, 20, 50, 100];
export const resLabel = (r: number) => (r === 1440 ? '2K' : r === 2160 ? '4K' : `${r}p`);

/** Recommended bitrate (Mbps) for a short side and frame rate, like CapCut's "Recommended for this video". */
export function recommendedMbps(short: number, fps: number): number {
  const base = short >= 2160 ? 40 : short >= 1440 ? 22 : short >= 1080 ? 10 : short >= 720 ? 6 : 3;
  return Math.round(base * (fps > 30 ? 1.5 : 1));
}
