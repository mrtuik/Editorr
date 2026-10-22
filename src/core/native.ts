import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import type { Project } from './types';

export interface ExportRequest {
  hostUri: string;
  constUri: string;
  offsetMs: number;
  durationMs: number;
  height: 720 | 1080;
  mainAudio: 'host' | 'constant';
  normalize: boolean;
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
}

export interface EditorrNativePlugin {
  /** Opens the system picker, copies the video into app cache, returns its path + metadata. */
  pickVideo(): Promise<PickedVideo>;
  /** Decodes the audio track to mono 16 kHz PCM16 (little endian) in a cache file. */
  extractAudio(opts: { path: string }): Promise<{ pcmPath: string; samples: number }>;
  /** Runs Media3 Transformer composition. Emits 'exportProgress' events. */
  exportProject(req: ExportRequest): Promise<{ outputUri: string }>;
  cancelExport(): Promise<void>;
  addListener(eventName: 'audioProgress' | 'exportProgress', cb: (e: { path?: string; percent: number }) => void): Promise<PluginListenerHandle>;
  freeSpaceMb(): Promise<{ mb: number }>;
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

export function toExportRequest(p: Project, hostUri: string, constUri: string, height: 720 | 1080): ExportRequest {
  return {
    hostUri, constUri,
    offsetMs: p.offsetMs,
    durationMs: p.durationMs,
    height,
    mainAudio: p.mainAudio,
    normalize: p.normalize,
    segments: p.segments.map((s) => ({
      startMs: s.startMs, endMs: s.endMs, style: s.style, main: s.main, corner: s.corner, size: s.size,
    })),
  };
}
