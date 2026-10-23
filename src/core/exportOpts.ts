import { FPS_STEPS, RES_STEPS, recommendedMbps, type Project, type Settings } from './types';

export interface ExportOpts {
  /** short side in pixels */
  res: number;
  fps: number;
  mbps: number;
  /** true while the bitrate follows the recommended value */
  auto: boolean;
  /** highest values the source videos allow (export never upscales or invents frames) */
  maxRes: number;
  maxFps: number;
}

/** Bitrate slider ticks and range, like CapCut: 5, 10, 20, 50, 100 Mbps. */
export const BITRATE_TICKS = [5, 10, 20, 50, 100];

export function sourceLimits(p: Project): { maxRes: number; maxFps: number } {
  const short = Math.min(p.host?.width ?? 0, p.host?.height ?? 0) || 1080;
  const fits = RES_STEPS.filter((r) => r <= short);
  const maxRes = fits.length ? fits[fits.length - 1] : RES_STEPS[0];
  const srcFps = Math.max(1, Math.min(60, Math.round(p.host?.fps || 30)));
  const fpsFits = FPS_STEPS.filter((f) => f <= srcFps);
  const maxFps = fpsFits.length ? fpsFits[fpsFits.length - 1] : srcFps;
  return { maxRes, maxFps };
}

/** The export values that will really be used for this project and these settings. */
export function resolveExport(p: Project, st: Settings): ExportOpts {
  const { maxRes, maxFps } = sourceLimits(p);
  const wantedRes = RES_STEPS.includes(st.resolution) ? st.resolution : 720;
  const wantedFps = FPS_STEPS.includes(st.fps) ? st.fps : 30;
  const res = Math.min(wantedRes, maxRes);
  const fps = Math.min(wantedFps, maxFps);
  const auto = !(st.bitrateMbps > 0);
  const mbps = auto ? recommendedMbps(res, fps) : Math.max(1, Math.min(100, Math.round(st.bitrateMbps)));
  return { res, fps, mbps, auto, maxRes, maxFps };
}

export function keptMs(p: Project): number {
  return p.segments.reduce((a, s) => a + (s.endMs - s.startMs), 0) || p.durationMs;
}

/** Video + 128 kbps audio over the kept length. */
export function estimateMb(p: Project, mbps: number): number {
  return Math.round(((mbps * 1_000_000 + 128_000) * (keptMs(p) / 1000)) / 8 / 1_000_000);
}

export function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${mb} MB`;
}

/** Bitrate slider position (0..100) <-> Mbps, piecewise linear between the ticks. */
export function mbpsToPos(m: number): number {
  const v = Math.max(BITRATE_TICKS[0], Math.min(BITRATE_TICKS[BITRATE_TICKS.length - 1], m));
  for (let i = 0; i < BITRATE_TICKS.length - 1; i++) {
    const a = BITRATE_TICKS[i], b = BITRATE_TICKS[i + 1];
    if (v <= b) return (i + (v - a) / (b - a)) * 25;
  }
  return 100;
}
export function posToMbps(pos: number): number {
  const x = Math.max(0, Math.min(100, pos)) / 25;
  const i = Math.min(BITRATE_TICKS.length - 2, Math.floor(x));
  const a = BITRATE_TICKS[i], b = BITRATE_TICKS[i + 1];
  return Math.round(a + (b - a) * (x - i));
}
