import { EditorrNative, fileSrc, isNative } from './native';
import type { VideoRef } from './types';

/** Short side of the preview copy. Small enough to play smoothly, big enough to look fine on a phone. */
const PROXY_SHORT = 540;

/**
 * Videos the WebView often cannot play smoothly next to a second one: HEVC / VP9 / AV1, 50-60 fps,
 * bigger than 1080p, or a very high bitrate. For these the preview copy is made up front (before playing),
 * so nothing stalls halfway through a video. Plain 1080p30 H.264 plays as it is.
 */
export function needsProxy(v: Omit<VideoRef, 'url'> | undefined): boolean {
  if (!v || !isNative()) return false;
  const codec = (v.codec || '').toLowerCase();
  if (codec && !/avc|h264/.test(codec)) return true;
  if (v.fps > 35) return true;
  if (Math.max(v.width, v.height) > 1920) return true;
  if ((v.bitrate ?? 0) > 30_000_000) return true;
  return false;
}

/** Preview copy size: short side PROXY_SHORT, same shape as the video, even numbers. */
function proxySize(v: Omit<VideoRef, 'url'> | undefined): { outW: number; outH: number } | Record<string, never> {
  if (!v || !v.width || !v.height) return {};
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const short = Math.min(v.width, v.height);
  if (short <= PROXY_SHORT) return {}; // already small
  const k = PROXY_SHORT / short;
  return { outW: even(v.width * k), outH: even(v.height * k) };
}

type Cb = (pct: number) => void;
const cbs = new Map<string, Cb>();
let listening = false;
const running = new Map<string, Promise<string>>();

function listen(): void {
  if (listening) return;
  listening = true;
  EditorrNative.addListener('proxyProgress', (e: { path?: string; percent: number }) => {
    if (e.path) cbs.get(e.path)?.(e.percent);
  }).catch(() => { listening = false; });
}

/**
 * Make (or find) the small preview copy of a video. Resolves with a URL the <video> element can load.
 * Copies are cached, so opening the project again is instant.
 */
export function ensureProxy(path: string, meta: Omit<VideoRef, 'url'> | undefined, onPct?: Cb): Promise<string> {
  let job = running.get(path);
  if (!job) {
    listen();
    cbs.set(path, (n) => onPct?.(n));
    job = EditorrNative.makeProxy({ path, height: PROXY_SHORT, ...proxySize(meta) })
      .then((r) => fileSrc(r.proxyPath))
      .finally(() => { running.delete(path); cbs.delete(path); });
    running.set(path, job);
  }
  return job;
}
