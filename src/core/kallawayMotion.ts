/**
 * Motion for Kallaway frames: a spring pop when the card first appears, a red wipe + un-blur when the spoken point changes,
 * and a count-up for number cards. Everything here is a plain function of elapsed ms, so the preview and the export
 * (which plays the same baked pictures) always agree.
 */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** Overshoots 1 a little and settles (0 -> 1). */
export function springOvershoot(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

/** How long the pop / wipe lasts, and how long a number counts up. */
export const POP_MS = 360;
export const WIPE_MS = 300;
export const COUNT_MS = 1000;

export interface Motion {
  /** whole-card scale (1 = rest) */
  pop: number;
  /** whole-frame opacity */
  alpha: number;
  /** 0..1 progress of the red wipe / un-blur of the active point */
  wipe: number;
  /** the point that was active just before (-1 = none): it wipes out while the new one wipes in */
  prev: number;
  /** 0..1 progress of the number count-up */
  count: number;
}

export const REST: Motion = { pop: 1, alpha: 1, wipe: 1, prev: -1, count: 1 };

/**
 * The look `elapsed` ms after a beat starts.
 * entry = the first frame of a card (it pops in); prev = the point that was active before this one; counting = number card.
 */
export function motionAt(elapsed: number, o: { entry: boolean; prev: number; counting?: boolean }): Motion {
  const e = Math.max(0, elapsed);
  const pt = Math.min(1, e / POP_MS);
  return {
    pop: o.entry ? 0.9 + 0.1 * springOvershoot(pt) : 1,
    alpha: o.entry ? Math.min(1, e / 120) : 1,
    wipe: easeOutCubic(e / WIPE_MS),
    prev: o.prev,
    count: o.counting ? easeOutCubic(e / COUNT_MS) : 1,
  };
}

/** How many baked pictures cover the start of a beat, and how long that start lasts. */
export function introPlan(counting: boolean, beatMs: number): { ms: number; n: number } {
  const ms = Math.max(120, Math.min(counting ? COUNT_MS : POP_MS, beatMs - 40));
  return { ms, n: counting ? 12 : 8 };
}
