/** Visual -> DocuBeat. The baked pictures go through the same path as Kallaway cards (image + frames + framesMs), so preview and export need no native change. */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { DocuBeat } from '../docuTypes';
import { kallawaySize } from '../kallaway';
import type { Aspect } from '../types';
import { loadVisualFonts } from './fonts';
import { bakeVisual, visualTitle } from './render';
import { getTheme } from './themes';
import type { Visual } from './types';

async function savePng(c: HTMLCanvasElement, id: string): Promise<{ url: string; path?: string }> {
  const png = c.toDataURL('image/png');
  if (!Capacitor.isNativePlatform()) return { url: png };
  const rel = `broll/${id}.png`;
  const wr = await Filesystem.writeFile({ path: rel, data: png.slice(png.indexOf(',') + 1), directory: Directory.Data, recursive: true });
  const uri = wr.uri || (await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri;
  return { url: Capacitor.convertFileSrc(uri), path: uri.replace(/^file:\/\//, '') };
}

const plain = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

/** Draw the entrance frames and the resting picture of `v` and wrap them in a beat. Reuses `beatId` when redrawing. */
export async function makeVisualBeat(v: Visual, aspect: Aspect): Promise<DocuBeat> {
  await loadVisualFonts();
  const { w, h } = kallawaySize(aspect);
  const baked = await bakeVisual(v, w, h);
  const tag = `${v.id}_${Date.now().toString(36)}`;
  const image = await savePng(baked.still, `vis_${tag}`);
  const frames: { url: string; path?: string }[] = [];
  for (let i = 0; i < baked.frames.length; i++) frames.push(await savePng(baked.frames[i]!, `vis_${tag}_f${i}`));
  const last = baked.framesMs[baked.framesMs.length - 1] ?? 600;
  return {
    id: v.id, type: 'split_screen', start: v.startMs, end: v.endMs, layout: 'one', video_position: 'left', card_radius: 0,
    headline: plain(visualTitle(v)).slice(0, 40) || v.type, accent_color: getTheme(v.themeId).accent, theme: 'noir',
    image, frames, framesMs: last, vis: v,
  };
}

/** Redraw a beat after its visual changed (text, type, theme, motion). The beat keeps its id and place on the timeline. */
export async function redrawVisualBeat(b: DocuBeat, patch: Partial<Visual>, aspect: Aspect): Promise<void> {
  if (!b.vis) return;
  const v: Visual = { ...b.vis, ...patch, startMs: b.start, endMs: b.end };
  const nb = await makeVisualBeat(v, aspect);
  b.vis = nb.vis; b.image = nb.image; b.frames = nb.frames; b.framesMs = nb.framesMs; b.headline = nb.headline; b.accent_color = nb.accent_color;
}

/** A grey slot on the timeline until its visual is ready. */
export const pendingBeat = (id: string, startMs: number, endMs: number, n: number): DocuBeat => ({
  id, type: 'split_screen', start: startMs, end: endMs, layout: 'one', video_position: 'left', card_radius: 0,
  headline: `Visual ${n}...`, accent_color: '#888888', theme: 'noir', pending: true,
});
