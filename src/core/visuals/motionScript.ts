/**
 * Motion mode of the B-roll pane: the scene list model, planning (Antigravity or the built-in rules), render-and-place and file clean-up.
 * Scenes are the visuals engine's own `Visual`. Rendering turns each one into a short clip (encode.ts) that sits on the timeline as a
 * normal full-frame video B-roll beat, so preview and the Media3 export need no new code.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { CapWord } from '../captions';
import { BROLL_MIN_MS, MOTION_MAX_MS, placeBroll, type BrollBeat } from '../brollTypes';
import { isNative } from '../native';
import { uid } from '../speaker';
import type { MotionScript, Project } from '../types';
import { agyProblem, makeAi, planAi, withTimeout } from './ai';
import { NoEncoderError, RenderCancelled, estimateBytes, outSize, renderSceneToVideo } from './encode';
import { makeLocal, planLocal } from './local';
import { pickMotion } from './motion';
import { makeVisualBeat } from './beat';
import { getTheme } from './themes';
import { toTWords, type RunCtrl } from './runner';
import { visualTitle } from './render';
import type { MotionSelection, Visual, VisualSlot, VisualType } from './types';

export const MOTION_MIN_MS = BROLL_MIN_MS;
const PENDING = 'mp_';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const plain = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const sentenceIn = (ws: CapWord[], a: number, b: number) => ws.filter(w => w.e > a - 100 && w.s < b + 100).map(w => w.orig || w.w).join(' ').trim();
export const sceneTitle = (v: Visual) => plain(visualTitle(v)).slice(0, 40) || v.type;

// ------------------------------------------------------------------ model

export function ensureScript(p: Project, themeId: string): MotionScript {
  return (p.motion ??= { id: uid(), createdAt: Date.now(), themeId, scenes: [], renderedBeatIds: [] });
}
export const scenesOf = (p: Project): Visual[] => (p.motion?.scenes ?? []).slice().sort((a, b) => a.startMs - b.startMs);

/** What a rendered file depends on: the scene, the size and the frame rate. A different signature means the clip is out of date. */
export function sceneSig(v: Visual, w: number, h: number): string {
  const s = JSON.stringify([v.type, v.data, v.themeId, v.motion, v.startMs, v.endMs, !!v.full, w, h]);
  let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
  return (x >>> 0).toString(36);
}
export const beatOfScene = (p: Project, sceneId: string) => (p.broll ?? []).find(b => b.motionSceneId === sceneId && !isPending(b));
export const needsRender = (p: Project, v: Visual, w: number, h: number): boolean => { const b = beatOfScene(p, v.id); return !b || b.motionSig !== sceneSig(v, w, h); };

// ------------------------------------------------------------------ timeline placeholders (grey blocks)

export const motionPlaceholder = (v: { id: string; startMs: number; endMs: number }, n: number): BrollBeat => ({
  id: PENDING + v.id, start: v.startMs, end: v.endMs, keyword: `Motion ${n}`, url: '', thumb: '', title: `Motion ${n}`, source: 'card',
  motion: 'slow_zoom', frame: 'full', radius: 0, kind: 'card', motionSceneId: v.id,
});
export const isPending = (b: BrollBeat) => b.id.startsWith(PENDING) && !b.path;

/** One grey block per scene that has no clip yet; blocks of scenes that are gone disappear. */
export function syncPlaceholders(p: Project) {
  const scenes = scenesOf(p);
  let list = (p.broll ?? []).filter(b => !(isPending(b) && !scenes.some(s => s.id === b.motionSceneId)));
  scenes.forEach((v, i) => {
    if (list.some(b => b.motionSceneId === v.id && !isPending(b))) { list = list.filter(b => !(isPending(b) && b.motionSceneId === v.id)); return; }
    list = placeBroll(list.filter(b => !(isPending(b) && b.motionSceneId === v.id)), motionPlaceholder(v, i + 1));
  });
  p.broll = list;
}

/** A project saved while Motion was running can hold grey blocks that no scene owns. */
export function dropStrayPlaceholders(p: Project) {
  const ids = new Set((p.motion?.scenes ?? []).map(s => s.id));
  p.broll = (p.broll ?? []).filter(b => !(isPending(b) && !ids.has(b.motionSceneId ?? '')));
}

// ------------------------------------------------------------------ files

const baseName = (path: string) => path.replace(/^file:\/\//, '').split('/').pop() ?? '';
const isOurs = (path?: string) => !!path && baseName(path).startsWith('motion_');
const usedPaths = (p: Project, except?: string) => new Set((p.broll ?? []).filter(b => b.id !== except && b.path).map(b => baseName(b.path!)));

/** Delete a rendered clip, but only a Motion one and only when no other beat uses the same file. */
export async function deleteClip(p: Project, path: string | undefined, exceptBeatId?: string) {
  if (!isNative() || !isOurs(path)) return;
  const name = baseName(path!);
  if (usedPaths(p, exceptBeatId).has(name)) return;
  try { await Filesystem.deleteFile({ path: `broll/${name}`, directory: Directory.Data }); } catch { /* already gone */ }
}

/** Delete every motion_* clip no beat points at (called when the sheet closes and after a render). */
export async function sweepClips(p: Project) {
  if (!isNative()) return;
  try {
    const used = usedPaths(p), list = await Filesystem.readdir({ path: 'broll', directory: Directory.Data });
    for (const f of list.files) { const name = typeof f === 'string' ? f : f.name; if (name.startsWith('motion_') && !used.has(name)) { try { await Filesystem.deleteFile({ path: `broll/${name}`, directory: Directory.Data }); } catch { /* ignore */ } } }
  } catch { /* no broll folder yet */ }
}

const toB64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const CHUNK = 3 * 1024 * 1024; // a multiple of 3 bytes, so the pieces of base64 join cleanly

/** Save a clip under broll/. Written in pieces (never one giant string). Browser build: an object URL and no path. */
export async function saveClip(blob: Blob, sceneId: string, ext: string): Promise<{ url: string; path?: string }> {
  if (!Capacitor.isNativePlatform()) return { url: URL.createObjectURL(blob) };
  const rel = `broll/motion_${sceneId}_${Date.now().toString(36)}.${ext}`;
  try {
    for (let off = 0, first = true; off < blob.size; off += CHUNK, first = false) {
      const data = toB64(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
      if (first) await Filesystem.writeFile({ path: rel, data, directory: Directory.Data, recursive: true });
      else await Filesystem.appendFile({ path: rel, data, directory: Directory.Data });
    }
  } catch (e) {
    try { await Filesystem.deleteFile({ path: rel, directory: Directory.Data }); } catch { /* nothing partial left */ }
    const msg = (e as Error).message || '';
    throw new Error(/space|ENOSPC|quota|full/i.test(msg) ? 'Not enough storage to save the clip' : `Could not save the clip (${msg || 'error'})`);
  }
  const uri = (await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri;
  return { url: Capacitor.convertFileSrc(uri), path: uri.replace(/^file:\/\//, '') };
}

/** Free-space check before a render (what the WebView can tell us; a failed write is still reported in plain words). */
export async function storageProblem(bytes: number): Promise<string | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (e?.quota && e.usage !== undefined && e.quota - e.usage < bytes * 2) return 'Not enough storage to save the clip';
  } catch { /* unknown: let the write decide */ }
  return null;
}

// ------------------------------------------------------------------ planning

export interface GenOpts {
  words: CapWord[]; durationMs: number; themeId: string; mix: VisualType[]; useAi: boolean;
  /** only slots from this moment (the playhead) */
  fromMs: number;
  /** skip the plan: make exactly these slots */
  slots?: VisualSlot[];
  /** ranges other layers own (docu / Kallaway beats): scenes keep out of them */
  busy: { start: number; end: number }[];
  full: boolean; ctrl: RunCtrl;
  /** after the plan, before the first scene (the caller clears what the new scenes replace) */
  onPlan?: (slots: VisualSlot[]) => void;
  onScene: (v: Visual, i: number, total: number) => void;
  onProgress?: (i: number, total: number) => void;
}
export interface GenResult { made: number; failed: number; planned: number; source: 'AI' | 'built-in rules'; note?: string; aiMade: number; aiFailed: number; aiError?: string }

/** 1.5 to 5 s, in order, inside the video, and clear of ranges that other layers own. */
export function clampSlots(slots: VisualSlot[], durationMs: number, busy: { start: number; end: number }[]): VisualSlot[] {
  const out: VisualSlot[] = []; let cursor = 0;
  for (const s of slots.slice().sort((a, b) => a.startMs - b.startMs)) {
    let st = Math.max(cursor, Math.round(s.startMs)), en = Math.min(durationMs || Infinity, Math.round(s.endMs), st + MOTION_MAX_MS);
    if (en - st < MOTION_MIN_MS) en = Math.min(durationMs || Infinity, st + MOTION_MIN_MS);
    for (const b of busy) {
      if (st < b.end && en > b.start) {
        if (st < b.start && b.start - st >= MOTION_MIN_MS) en = b.start;
        else if (en > b.end && en - b.end >= MOTION_MIN_MS) st = b.end;
        else { en = st; break; }
      }
    }
    if (!(en - st >= MOTION_MIN_MS - 1)) continue;
    out.push({ ...s, startMs: st, endMs: en }); cursor = en;
  }
  return out;
}

export async function generateScenes(o: GenOpts): Promise<GenResult> {
  const { ctrl } = o, theme = getTheme(o.themeId);
  let slots: VisualSlot[], source: GenResult['source'] = 'built-in rules', note: string | undefined, useAi = o.useAi;
  if (useAi) { const bad = await agyProblem(); if (bad) { useAi = false; note = `${bad}, built-in rules were used`; } }
  if (o.slots) slots = o.slots;
  else {
    slots = [];
    if (useAi) {
      try { slots = await withTimeout(planAi(o.words, o.durationMs, theme.name, o.mix), 45000); source = 'AI'; }
      catch (e) { note = `Antigravity failed (${(e as Error).message || 'no answer'}), built-in rules made the plan`; }
    }
    if (!slots.length) slots = planLocal(toTWords(o.words), o.durationMs, o.mix);
    if (o.fromMs > 0) slots = slots.filter(s => s.startMs >= o.fromMs - 200);
  }
  slots = clampSlots(slots, o.durationMs, o.busy).map((s, i) => ({ ...s, id: `mo${uid()}${i}` }));
  if (!slots.length) return { made: 0, failed: 0, planned: 0, source, note: note ?? 'Nothing to plan: no speech found here.', aiMade: 0, aiFailed: 0 };
  o.onPlan?.(slots);

  let made = 0, failed = 0, aiMade = 0, aiFailed = 0, aiError: string | undefined, prevIn: string | undefined, prevText: string | undefined, prev: { type: string; title: string } | undefined;
  const aiOn = useAi && (source === 'AI' || !!o.slots);
  for (let i = 0; i < slots.length; i++) {
    while (ctrl.paused && !ctrl.stopped) await sleep(200);
    if (ctrl.stopped) break;
    const slot = slots[i]!;
    o.onProgress?.(i + 1, slots.length);
    try {
      const sentence = sentenceIn(o.words, slot.startMs, slot.endMs) || slot.intent;
      const local = makeLocal(slot, sentence, o.themeId, i, prevIn);
      let data = local.data, motion: MotionSelection = local.motion, type: VisualType = local.type;
      if (aiOn) {
        try {
          const r = await withTimeout(makeAi(slot, theme.name, sentence, prev), 30000);
          const base = pickMotion(theme, i, prevIn, prevText);
          data = r.data; type = slot.type;
          motion = { in: r.motion?.in ?? base.in, hold: r.motion?.hold ?? base.hold, out: r.motion?.out ?? base.out, text: base.text };
          if (motion.in === prevIn) motion.in = base.in;
          aiMade++;
        } catch (e) { aiFailed++; aiError ??= (e as Error).message || 'no answer'; }
      }
      const v: Visual = { id: slot.id, type, data, themeId: o.themeId, motion, startMs: slot.startMs, endMs: slot.endMs, ...(o.full ? { full: true } : {}) };
      o.onScene(v, i, slots.length);
      made++; prevIn = motion.in; prevText = motion.text; prev = { type, title: sceneTitle(v) };
    } catch { failed++; }
  }
  return { made, failed, planned: slots.length, source, note, aiMade, aiFailed, aiError };
}

// ------------------------------------------------------------------ render and place

export interface PlaceOpts {
  p: Project; ctrl?: RunCtrl; aspect: number; short: 720 | 1080; signal: { cancelled: boolean };
  onProgress: (i: number, total: number, pct: number) => void;
  /** a beat was placed or changed: redraw and save */
  changed: () => void;
}
export interface PlaceResult { placed: number; slower: number; frames: number; failed: number; cancelled: boolean; notes: string[] }

export async function renderAndPlace(o: PlaceOpts): Promise<PlaceResult> {
  const { p } = o, size = outSize(o.aspect, o.short), res: PlaceResult = { placed: 0, slower: 0, frames: 0, failed: 0, cancelled: false, notes: [] };
  const todo = scenesOf(p).filter(v => needsRender(p, v, size.w, size.h));
  for (let i = 0; i < todo.length; i++) {
    while (o.ctrl?.paused && !o.ctrl.stopped) await sleep(200);
    if (o.signal.cancelled) { res.cancelled = true; break; }
    const v = todo[i]!;
    o.onProgress(i + 1, todo.length, 0);
    try {
      const bad = isNative() ? await storageProblem(estimateBytes(size.w, size.h, v.endMs - v.startMs)) : null;
      if (bad) { res.notes.push(bad); res.failed++; break; }
      let r;
      try { r = await renderSceneToVideo(v, { ...size, fps: 30, signal: o.signal, onProgress: (d, t) => o.onProgress(i + 1, todo.length, d / Math.max(1, t)) }); }
      catch (e) {
        if (e instanceof RenderCancelled) { res.cancelled = true; break; }
        if (!(e instanceof NoEncoderError)) throw e;
        // last fallback: the baked-frame picture in the docu lane, so the user still gets the scene
        const db = await makeVisualBeat(v, p.aspect);
        p.docu = [...(p.docu ?? []).filter(b => b.id !== v.id), db].sort((a, b) => a.start - b.start);
        p.broll = (p.broll ?? []).filter(b => !(b.motionSceneId === v.id));
        res.frames++; res.notes.push(`${e.message}. Scene ${i + 1} was placed as a picture beat instead of a clip`); o.changed(); continue;
      }
      if (r.via === 'recorder') res.slower++;
      if (r.note) res.notes.push(r.note);
      const saved = await saveClip(r.blob, v.id, r.ext);
      if (o.signal.cancelled) { await deleteClip(p, saved.path, '__none__'); res.cancelled = true; break; }
      const old = beatOfScene(p, v.id);
      const beat: BrollBeat = {
        id: uid(), start: v.startMs, end: Math.min(v.endMs, v.startMs + r.durationMs), keyword: sceneTitle(v), url: saved.url, thumb: '', ...(saved.path ? { path: saved.path } : {}),
        title: sceneTitle(v), source: 'card', motion: 'slow_zoom', frame: 'full', radius: 0, kind: 'video', inMs: 0, srcMs: r.durationMs, trans: 'fade',
        motionSceneId: v.id, renderFps: r.fps, motionSig: sceneSig(v, size.w, size.h),
      };
      // the new beat wins over what it overlaps; the old clip of this scene and its grey block go away
      p.broll = placeBroll((p.broll ?? []).filter(b => b.id !== old?.id && !(isPending(b) && b.motionSceneId === v.id)), beat);
      if (p.motion) p.motion.renderedBeatIds = [...p.motion.renderedBeatIds.filter(id => id !== old?.id), beat.id];
      if (old) await deleteClip(p, old.path, old.id);
      res.placed++; o.changed();
    } catch (e) {
      res.failed++; res.notes.push(`Scene ${i + 1}: ${(e as Error).message || 'failed'}`);
    }
  }
  await sweepClips(p);
  return res;
}
