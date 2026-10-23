import { EditorrNative, fileSrc, isNative } from './native';

/** Pictures for the timeline clip strip. `frames[i]` is the frame at (i + 0.5) / count of the video. */
export interface Strip {
  count: number;
  frames: (HTMLImageElement | undefined)[];
  /** width / height of one frame, known after the first one loaded */
  aspect: number;
  cancel: () => void;
}

/** Strip density: about one picture per 4 s, 12..200 pictures. */
export function stripCount(durationMs: number): number {
  return Math.max(12, Math.min(200, Math.ceil(durationMs / 4000)));
}

function loadImg(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

let thumbListener = false;
const thumbCbs = new Map<string, (index: number, file: string) => void>();
function listenThumbs(): void {
  if (thumbListener) return;
  thumbListener = true;
  EditorrNative.addListener('thumb', (e: { path: string; index: number; file: string }) => {
    thumbCbs.get(e.path)?.(e.index, e.file);
  }).catch(() => { thumbListener = false; });
}

/**
 * Start making the strip. `onFrame` is called each time one more picture is ready, so the timeline fills in
 * from left to right. Native app: MediaMetadataRetriever (works for any format). Browser: a hidden <video>.
 */
export function makeStrip(opts: { path?: string; url: string; durationMs: number; height: number; onFrame: () => void }): Strip {
  const count = stripCount(opts.durationMs);
  const strip: Strip = { count, frames: new Array(count).fill(undefined), aspect: 16 / 9, cancel: () => { stop = true; } };
  let stop = false;

  const put = (i: number, img: HTMLImageElement | undefined) => {
    if (!img || stop) return;
    strip.frames[i] = img;
    if (img.naturalWidth && img.naturalHeight) strip.aspect = img.naturalWidth / img.naturalHeight;
    opts.onFrame();
  };

  if (isNative() && opts.path) {
    const path = opts.path;
    listenThumbs();
    const cb = (i: number, file: string) => { loadImg(fileSrc(file)).then((img) => put(i, img)); };
    thumbCbs.set(path, cb);
    EditorrNative.makeThumbs({ path, count, height: opts.height })
      .then((r) => {
        // frames that arrived before the listener was ready (cached files) are picked up here
        r.files.forEach((f, i) => { if (f && !strip.frames[i]) loadImg(fileSrc(f)).then((img) => put(i, img)); });
      })
      .catch(() => { /* no pictures: the clip stays a plain block */ })
      .finally(() => { setTimeout(() => { if (thumbCbs.get(path) === cb) thumbCbs.delete(path); }, 3000); });
  } else {
    // browser preview: seek a hidden video and copy frames to small canvases
    (async () => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = opts.url;
      await new Promise<void>((res) => { v.onloadeddata = () => res(); v.onerror = () => res(); setTimeout(res, 6000); });
      if (!v.videoWidth) return;
      const hgt = opts.height, w = Math.max(1, Math.round((v.videoWidth / v.videoHeight) * hgt));
      const step = Math.max(1, Math.floor(count / 30)); // at most ~30 pictures in the browser
      for (let i = 0; i < count && !stop; i += step) {
        const t = ((i + 0.5) / count) * v.duration;
        await new Promise<void>((res) => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = t; setTimeout(done, 2000); });
        const c = document.createElement('canvas'); c.width = w; c.height = hgt;
        try { c.getContext('2d')!.drawImage(v, 0, 0, w, hgt); } catch { return; }
        const img = await loadImg(c.toDataURL('image/jpeg', 0.6));
        for (let k = i; k < Math.min(count, i + step); k++) put(k, img);
      }
    })();
  }
  return strip;
}

/** One picture for the Import tile. */
export async function firstFrame(path: string | undefined, url: string): Promise<string | undefined> {
  if (isNative() && path) {
    try {
      const r = await EditorrNative.makeThumbs({ path, count: 1, height: 360 });
      return r.files[0] ? fileSrc(r.files[0]) : undefined;
    } catch { return undefined; }
  }
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = url;
    const fin = (x?: string) => { resolve(x); };
    v.onerror = () => fin();
    v.onloadeddata = () => {
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas'); c.width = 320; c.height = Math.round(320 * (v.videoHeight / v.videoWidth)) || 180;
          c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
          fin(c.toDataURL('image/jpeg', 0.6));
        } catch { fin(); }
      };
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
    };
    setTimeout(() => fin(), 5000);
  });
}
