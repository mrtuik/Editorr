/**
 * One-by-one generation. Step A plans the slots (grey placeholders appear at once); Step B makes slot 1, 2, 3 ... each one
 * drawn, placed on the timeline and shown before the next starts. Stop keeps everything already made; a failed slot is skipped.
 */
import type { CapWord } from '../captions';
import type { DocuBeat } from '../docuTypes';
import type { Aspect } from '../types';
import { makeAi, planAi, withTimeout } from './ai';
import { makeVisualBeat, pendingBeat } from './beat';
import { makeLocal, planLocal } from './local';
import { pickMotion } from './motion';
import { getTheme } from './themes';
import type { MotionSelection, TWord, Visual, VisualSlot, VisualType } from './types';

export interface RunCtrl { stopped: boolean; paused: boolean }
export interface RunHost { aspect: Aspect; getBeats: () => DocuBeat[]; setBeats: (b: DocuBeat[]) => void; changed: () => void; seek: (ms: number) => void }
export interface RunOpts {
  host: RunHost; words: CapWord[]; durationMs: number; themeId: string; mix: VisualType[]; useAi: boolean;
  /** only slots that start at or after this moment (the playhead) */
  fromMs?: number;
  /** skip the plan: make exactly these slots (one visual by hand) */
  slots?: VisualSlot[];
  ctrl: RunCtrl;
  onProgress?: (done: number, total: number) => void;
}
export interface RunResult { made: number; failed: number; planned: number; source: 'AI' | 'built-in rules'; note?: string; aiMade: number; aiFailed: number; aiError?: string }

export const toTWords = (ws: CapWord[]): TWord[] => ws.map(w => ({ text: w.orig || w.w, startMs: w.s, endMs: w.e }));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const sentenceIn = (ws: CapWord[], a: number, b: number) => ws.filter(w => w.e > a - 100 && w.s < b + 100).map(w => w.orig || w.w).join(' ').trim();
const byStart = (l: DocuBeat[]) => l.sort((a, b) => a.start - b.start);

export async function runVisuals(o: RunOpts): Promise<RunResult> {
  const { host, ctrl } = o;
  const theme = getTheme(o.themeId);
  let slots: VisualSlot[], source: RunResult['source'] = 'built-in rules', note: string | undefined;
  if (o.slots) slots = o.slots;
  else {
    slots = [];
    if (o.useAi) {
      try { slots = await withTimeout(planAi(o.words, o.durationMs, theme.name, o.mix), 45000); source = 'AI'; }
      catch (e) { note = `ERROR: Antigravity NOT working (${(e as Error).message || 'no answer'}). No AI was used, built-in rules made these.`; }
    }
    if (!slots.length) slots = planLocal(toTWords(o.words), o.durationMs, o.mix);
    if (o.fromMs && o.fromMs > 0) slots = slots.filter(s => s.startMs >= o.fromMs! - 200);
  }
  if (!slots.length) return { made: 0, failed: 0, planned: 0, source, note: note ?? 'Nothing to plan: no speech found.', aiMade: 0, aiFailed: 0 };

  // Step A done: grey placeholders show the whole rhythm at once
  host.setBeats(byStart([...host.getBeats().filter(b => !slots.some(s => s.id === b.id)), ...slots.map((s, i) => pendingBeat(s.id, s.startMs, s.endMs, i + 1))]));
  host.changed();

  let made = 0, failed = 0, aiMade = 0, aiFailed = 0, aiError: string | undefined, aiOk = source === 'AI', prevIn: string | undefined, prev: { type: string; title: string } | undefined;
  for (let i = 0; i < slots.length; i++) {
    while (ctrl.paused && !ctrl.stopped) await sleep(200);
    if (ctrl.stopped) break;
    const slot = slots[i]!;
    o.onProgress?.(i + 1, slots.length);
    if (ctrl.stopped) break;
    try {
      const sentence = sentenceIn(o.words, slot.startMs, slot.endMs) || slot.intent;
      let data, motion: MotionSelection, type: VisualType = slot.type;
      const local = makeLocal(slot, sentence, o.themeId, i, prevIn);
      if (aiOk || (o.useAi && o.slots)) {
        try {
          const r = await withTimeout(makeAi(slot, theme.name, sentence, prev), 30000);
          data = r.data; const base = pickMotion(theme, i, prevIn); motion = { in: r.motion?.in ?? base.in, hold: r.motion?.hold ?? base.hold, out: r.motion?.out ?? base.out, text: base.text };
          if (motion.in === prevIn) motion.in = base.in;
          aiMade++;
        } catch (e) { aiFailed++; aiError ??= (e as Error).message || 'no answer'; data = local.data; motion = local.motion; type = local.type; }
      } else { data = local.data; motion = local.motion; type = local.type; }
      const v: Visual = { id: slot.id, type, data, themeId: o.themeId, motion, startMs: slot.startMs, endMs: slot.endMs };
      const beat = await makeVisualBeat(v, host.aspect);
      host.setBeats(byStart([...host.getBeats().filter(b => b.id !== slot.id), beat]));
      host.changed(); host.seek(slot.startMs + 400);
      made++; prevIn = motion.in; prev = { type, title: beat.headline };
    } catch {
      failed++;
      host.setBeats(host.getBeats().filter(b => b.id !== slot.id)); host.changed();
    }
  }
  // Stop or finish: remaining placeholders go away; nothing that was made is touched
  host.setBeats(host.getBeats().filter(b => !(b.pending && slots.some(s => s.id === b.id))));
  host.changed();
  return { made, failed, planned: slots.length, source, note, aiMade, aiFailed, aiError };
}

/** One visual at the playhead: the sentence being said there (or the next 3 s), type chosen or auto. */
export function slotAtPlayhead(ws: CapWord[], playMs: number, durationMs: number, type: VisualType | 'auto', classify: (s: string) => VisualType): VisualSlot {
  const hit = ws.findIndex(w => w.e >= playMs);
  let a = playMs, b = playMs + 3000;
  if (hit >= 0) {
    let i = hit; while (i > 0 && !/[.!?।]$/.test(ws[i - 1]!.orig || ws[i - 1]!.w) && ws[i]!.s - ws[i - 1]!.e < 600) i--;
    let j = hit; while (j < ws.length - 1 && !/[.!?।]$/.test(ws[j]!.orig || ws[j]!.w) && ws[j + 1]!.s - ws[j]!.e < 600 && j - i < 20) j++;
    a = Math.max(0, Math.min(ws[i]!.s, playMs)); b = Math.max(ws[j]!.e, a + 2000);
  }
  b = Math.min(durationMs || b, Math.max(a + 2000, Math.min(b, a + 5000)));
  const text = sentenceIn(ws, a, b);
  return { id: `vh${Date.now().toString(36)}`, startMs: Math.round(a), endMs: Math.round(b), type: type === 'auto' ? classify(text) : type, intent: text.split(' ').slice(0, 10).join(' ') };
}
