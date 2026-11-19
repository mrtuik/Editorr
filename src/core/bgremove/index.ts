/**
 * Remove BG: shared types, mask-track storage and the live compositor used by the preview.
 * A mask track is a list of small alpha masks (256x256) at timeline times. The preview blends the two masks around
 * the playhead and draws person-over-background on a canvas that sits on top of the video.
 */
import { kvDelete, kvGet, kvPut } from '../store';

export type BgEngine = 'sam' | 'rvm';
export type BgFill = 'blur' | 'black' | 'white' | 'green' | 'color';

export interface BgCfg {
  engine: BgEngine;
  fill: BgFill;
  /** used when fill is 'color' */
  color: string;
  /** masks per second that were made */
  perSec: number;
  count: number;
  /** when the masks were made (a new one invalidates the baked export file) */
  stamp?: number;
}

export interface MaskTrack {
  w: number; h: number;
  /** timeline time (ms) of each mask */
  times: number[];
  masks: Uint8Array[];
}

const key = (projectId: string, role: string) => `bgmask:${projectId}:${role}`;

export async function saveMaskTrack(projectId: string, role: string, t: MaskTrack): Promise<void> {
  await kvPut(key(projectId, role), { w: t.w, h: t.h, times: t.times, masks: t.masks });
}
export async function loadMaskTrack(projectId: string, role: string): Promise<MaskTrack | undefined> {
  const r = await kvGet<MaskTrack>(key(projectId, role));
  return r && r.times?.length ? r : undefined;
}
export function deleteMaskTrack(projectId: string, role: string): Promise<void> { return kvDelete(key(projectId, role)); }

export const FILL_COLORS: Record<Exclude<BgFill, 'blur' | 'color'>, string> = { black: '#000000', white: '#ffffff', green: '#00b140' };

/** Person-over-background drawing from a mask track. Used by the live preview and by the export bake. */
export class Cutout {
  private fg = document.createElement('canvas');
  private mc = document.createElement('canvas');
  private mctx: CanvasRenderingContext2D;
  private img: ImageData;
  constructor(private track: MaskTrack, private cfg: () => BgCfg) {
    this.mc.width = track.w; this.mc.height = track.h;
    this.mctx = this.mc.getContext('2d')!;
    this.img = this.mctx.createImageData(track.w, track.h);
    for (let i = 0; i < this.img.data.length; i += 4) { this.img.data[i] = 255; this.img.data[i + 1] = 255; this.img.data[i + 2] = 255; }
  }

  private fillAlpha(tl: number): void {
    const { times, masks } = this.track;
    const n = times.length;
    let a = 0;
    while (a < n - 1 && times[a + 1] <= tl) a++;
    const b = Math.min(n - 1, a + 1);
    const span = times[b] - times[a];
    const f = span > 0 ? Math.min(1, Math.max(0, (tl - times[a]) / span)) : 0;
    const ma = masks[a], mb = masks[b], d = this.img.data, len = ma.length;
    for (let i = 0; i < len; i++) d[i * 4 + 3] = ma[i] + (mb[i] - ma[i]) * f;
    this.mctx.putImageData(this.img, 0, 0);
  }

  /** Draw `src` (a video frame) at timeline time `tl` onto `g` (size W x H, already sized). */
  draw(g: CanvasRenderingContext2D, src: CanvasImageSource, tl: number, W: number, H: number): void {
    if (this.fg.width !== W || this.fg.height !== H) { this.fg.width = W; this.fg.height = H; }
    this.fillAlpha(tl);
    const f = this.fg.getContext('2d')!;
    f.globalCompositeOperation = 'source-over';
    f.clearRect(0, 0, W, H);
    f.drawImage(src, 0, 0, W, H);
    f.globalCompositeOperation = 'destination-in';
    f.imageSmoothingEnabled = true; f.imageSmoothingQuality = 'high';
    f.drawImage(this.mc, 0, 0, W, H);
    f.globalCompositeOperation = 'source-over';
    const c = this.cfg();
    if (c.fill === 'blur') {
      g.filter = 'blur(16px) brightness(0.85)';
      g.drawImage(src, -24, -24, W + 48, H + 48);
      g.filter = 'none';
    } else {
      g.fillStyle = c.fill === 'color' ? c.color : FILL_COLORS[c.fill];
      g.fillRect(0, 0, W, H);
    }
    g.drawImage(this.fg, 0, 0);
  }
}

/** The live cut-out canvas on top of one video in the preview. The video keeps playing underneath (opacity 0). */
export class BgCutter {
  readonly canvas = document.createElement('canvas');
  private cut: Cutout;
  private raf = 0;
  private alive = true;
  private shown = true;

  constructor(
    private video: HTMLVideoElement,
    private box: HTMLElement,
    track: MaskTrack,
    cfg: () => BgCfg,
    /** video time (ms) that is timeline 0 */
    private startMs: () => number,
  ) {
    this.cut = new Cutout(track, cfg);
    this.canvas.className = 'bg-cut';
    video.after(this.canvas);
    video.addEventListener('seeked', this.onEvt);
    video.addEventListener('loadeddata', this.onEvt);
    video.addEventListener('timeupdate', this.onEvt);
    this.setShown(true);
    this.loop();
  }

  private onEvt = () => { this.render(); };

  private loop = () => {
    if (!this.alive) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { this.render(); this.loop(); });
    else this.raf = requestAnimationFrame(() => { this.render(); this.loop(); });
  };

  /** false = show the original video (Raw button) */
  setShown(on: boolean): void {
    this.shown = on;
    this.canvas.style.display = on ? '' : 'none';
    this.video.style.opacity = on ? '0' : '';
  }

  /** Same flip and colour filter as the video. */
  mirrorFilter(transform: string, filter: string): void {
    this.canvas.style.transform = transform;
    this.canvas.style.filter = filter;
  }

  render(): void {
    if (!this.alive || !this.shown) return;
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh || v.readyState < 2) return;
    const k = Math.min(1, 960 / Math.max(vw, vh));
    const W = Math.max(2, Math.round(vw * k)), H = Math.max(2, Math.round(vh * k));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.cut.draw(this.canvas.getContext('2d')!, v, v.currentTime * 1000 - this.startMs(), W, H);
  }

  dispose(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.video.removeEventListener('seeked', this.onEvt);
    this.video.removeEventListener('loadeddata', this.onEvt);
    this.video.removeEventListener('timeupdate', this.onEvt);
    this.video.style.opacity = '';
    this.canvas.remove();
  }
}
