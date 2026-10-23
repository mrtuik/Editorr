import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { effectiveGain } from './gain';
import { outputSize, type CropState, type Project } from './types';

export interface ExportRequest {
  hostUri: string;
  constUri: string;
  offsetMs: number;
  durationMs: number;
  /** short side in pixels (480 .. 2160) */
  height: number;
  /** target frame rate (the native side never goes above the source) */
  fps: number;
  /** video bitrate in bits per second */
  bitrate: number;
  /** output frame in pixels (from aspect ratio) */
  outW: number;
  outH: number;
  cropHost: CropState;
  cropConst: CropState;
  mirrorHost: boolean;
  mirrorConst: boolean;
  noiseHost: number;
  noiseConst: number;
  mainAudio: 'host' | 'constant';
  /** Native-generated, denoised full-sample-rate WAV mixed into the export composition. */
  cleanAudioUri?: string;
  normalize: boolean;
  /** Gain applied to the kept audio (volume x normalize), 1 = unchanged. */
  gain: number;
  segments: {
    startMs: number; endMs: number; style: string; main: string; corner: string; size: string;
  }[];
}

export interface PickedVideo {
  path: string;
  name: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  /** video codec mime, e.g. video/avc, video/hevc */
  codec?: string;
  /** average bits per second of the whole file */
  bitrate?: number;
}

export type NativeEvent = 'audioProgress' | 'denoiseProgress' | 'exportProgress' | 'proxyProgress' | 'copyProgress' | 'thumb';

export interface EditorrNativePlugin {
  /**
   * Opens the system picker, copies the chosen video(s) into the app files folder and returns path + metadata.
   * With multiple = true the user may pick two videos at once (extra ones are ignored).
   * Emits 'copyProgress' {index, count, percent} while copying.
   */
  pickVideos(opts: { multiple: boolean }): Promise<{ videos: PickedVideo[]; ignored: number }>;
  /** Decodes the audio track to mono 16 kHz PCM16 (little endian) in a cache file. */
  extractAudio(opts: { path: string }): Promise<{ pcmPath: string; samples: number }>;
  /** Builds a denoised mono WAV at the source audio sample rate in app cache for export. */
  prepareDenoiseAudio(opts: { path: string; strength: number }): Promise<{ audioUri: string }>;
  /** Runs Media3 Transformer composition. Emits 'exportProgress' events. */
  exportProject(req: ExportRequest): Promise<{ outputUri: string }>;
  /** Transcode to a small H.264 file so the WebView can preview formats/sizes it cannot play smoothly. Cached per source file. */
  makeProxy(opts: { path: string; height: number; outW?: number; outH?: number }): Promise<{ proxyPath: string }>;
  /** Picture strip for the timeline (and the first-frame tile): `count` frames spread over the video. Emits 'thumb' {path,index,count,file}. */
  makeThumbs(opts: { path: string; count: number; height: number }): Promise<{ files: string[] }>;
  cancelExport(): Promise<void>;
  addListener(eventName: NativeEvent, cb: (e: any) => void): Promise<PluginListenerHandle>;
  freeSpaceMb(): Promise<{ mb: number }>;
  fileExists(opts: { path: string }): Promise<{ exists: boolean }>;
  /** Delete picked videos (and their audio/preview copies). Only files in the app videos folder are removed. */
  deleteVideos(opts: { paths: string[] }): Promise<{ deleted: number }>;
  /** Delete videos that no saved project uses. */
  pruneVideos(opts: { keep: string[] }): Promise<{ deleted: number }>;
  storageInfo(): Promise<{ videosBytes: number; cacheBytes: number; freeMb: number }>;
  /** Empty the cache folder. Projects and videos stay. */
  clearCache(): Promise<{ freedBytes: number }>;
}

export const EditorrNative = registerPlugin<EditorrNativePlugin>('EditorrNative');

export const isNative = () => Capacitor.isNativePlatform();

export const fileSrc = (path: string) => Capacitor.convertFileSrc('file://' + path);

export async function tick(): Promise<void> {
  try { if (isNative()) await Haptics.impact({ style: ImpactStyle.Light }); } catch { /* ignore */ }
}

/** Load the native-extracted PCM16 file into Float32 samples. */
export async function loadPcm(pcmPath: string): Promise<Float32Array> {
  const res = await fetch(fileSrc(pcmPath));
  const i16 = new Int16Array(await res.arrayBuffer());
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

export function toExportRequest(p: Project, hostUri: string, constUri: string, height: number, fps: number, mbps: number): ExportRequest {
  const { w, h } = outputSize(p.aspect, height);
  return {
    hostUri, constUri,
    fps, bitrate: Math.round(mbps * 1_000_000),
    // whole numbers only: the native side reads these as integers
    offsetMs: Math.round(p.offsetMs || 0),
    durationMs: Math.round(p.durationMs || Math.max(0, ...p.segments.map((s) => s.endMs))),
    height,
    outW: w, outH: h,
    cropHost: p.cropHost, cropConst: p.cropConst,
    mirrorHost: p.mirrorHost, mirrorConst: p.mirrorConst,
    noiseHost: p.noiseHost, noiseConst: p.noiseConst,
    mainAudio: p.mainAudio,
    normalize: p.normalize,
    gain: effectiveGain(p, p.mainAudio),
    // sorted; parts removed by silence cut are simply not in this list
    segments: [...p.segments].sort((a, b) => a.startMs - b.startMs).map((s) => ({
      startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), style: s.style, main: s.main, corner: s.corner, size: s.size,
    })),
  };
}
