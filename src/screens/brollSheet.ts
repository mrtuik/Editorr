import type { CapWord } from '../core/captions';
import { downloadBroll, searchBroll, type BrollItem } from '../core/brollEngine';
import { autoBroll } from '../core/brollPlanner';
import {
  BROLL_DEFAULT_MS, BROLL_DEFAULT_RADIUS, BROLL_FRAME_LABEL, BROLL_MAX_MS, BROLL_MIN_MS, BROLL_MOTIONS, BROLL_MOTION_LABEL, placeBroll,
  type BrollBeat, type BrollFrame, type BrollMotion,
} from '../core/brollTypes';
import { isNative } from '../core/native';
import { uid } from '../core/speaker';
import type { Project } from '../core/types';
import { h, icon, toast } from '../ui';


export interface BrollCtx {
  p: Project;
  playMs: () => number;
  durationMs: () => number;
  /** Something changed: redraw the preview and save. */
  changed: () => void;
  seek: (ms: number) => void;
  /** Words with times (captions or the agent's own transcript). */
  words: () => CapWord[];
}
export interface BrollPane { el: HTMLElement; dispose: () => void }

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  const val = h('b', {}, fmt(value));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'at-range', 'aria-label': label }) as HTMLInputElement;
  r.addEventListener('input', () => { const v = Number(r.value); val.textContent = fmt(v); onInput(v); });
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label-row' }, h('div', { class: 'at-label' }, label), val), r);
}

function chipRow<T extends string>(label: string, opts: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const row = h('div', { class: 'schips' });
  const render = (cur: T) => row.replaceChildren(...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => { onPick(v); render(v); } }, l)));
  render(value);
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, label), row);
}

const SRC_LABEL = { wikimedia: 'Commons', wikipedia: 'Wiki', openverse: 'Openverse' } as const;

/**
 * The B-roll tab of the Docu sheet: Auto B-roll (a photo every ~2.5 s), a free search with a square grid, and the beats on the timeline.
 * Photos come from Wikimedia Commons, Wikipedia and Openverse (no key), and are saved on the phone so the export can use them.
 */
export function buildBrollPane(ctx: BrollCtx): BrollPane {
  const list = (): BrollBeat[] => (ctx.p.broll ??= []);
  let lenMs = BROLL_DEFAULT_MS;
  let coverage: 'every' | 'alternate' = 'every';
  let newMotion: BrollMotion = 'zoom_in';
  let newFrame: BrollFrame = 'card';
  let results: BrollItem[] = [];
  let searching = false, searched = false;
  let addingId: string | null = null;
  let sel: string | null = list()[0]?.id ?? null;
  let replaceId: string | null = null;
  let run: { cancelled: boolean } | null = null;
  let progress = '';
  let disposed = false;

  const cur = () => list().find((b) => b.id === sel);
  const autoBox = h('div', {});
  const gridBox = h('div', {});
  const beatsBox = h('div', {});
  const input = h('input', { type: 'text', class: 'ts-input', placeholder: 'Search photos: Elon Musk, Black Monday 1987...', enterkeyhint: 'search', 'aria-label': 'Search photos', style: 'flex:1;min-width:0' }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); void doSearch(input.value); } });
  const searchRow = h('div', { class: 'br-search' }, input,
    h('button', { class: 'btn primary', style: 'min-height:44px;padding:0 14px', 'aria-label': 'Search', onclick: () => void doSearch(input.value) }, icon('search', 20)));

  // ------------------------------------------------------------ auto
  async function runAuto() {
    if (run) return;
    const words = ctx.words();
    if (!words.length) { toast('No transcript yet. Make Auto captions first, then tap Auto B-roll.', 5000); return; }
    const busy = [...(ctx.p.docu ?? []).map((d) => ({ start: d.start, end: d.end })), ...list().map((b) => ({ start: b.start, end: b.end }))];
    const signal = { cancelled: false };
    run = signal; progress = 'Starting...'; renderAuto();
    try {
      const r = await autoBroll({
        words, durationMs: ctx.durationMs(), lenMs, frame: newFrame, coverage, busy, useAntigravity: true, signal,
        onProgress: (d, t, label) => { progress = `${d}/${t} · ${label}`; if (!disposed) renderAuto(); },
      });
      let next = list();
      for (const b of r.beats) next = placeBroll(next, b);
      ctx.p.broll = next;
      if (r.beats.length) { sel = r.beats[0]!.id; ctx.seek(r.beats[0]!.start); }
      ctx.changed();
      const parts = [`${r.beats.length} photos added`];
      if (r.missed) parts.push(`${r.missed} beats found nothing`);
      if (signal.cancelled) parts.push('stopped');
      toast(`${parts.join(', ')}.${r.note ? ' ' + r.note : ''}`, r.note ? 8000 : 4000);
    } catch (e) { toast(`Auto B-roll failed: ${(e as Error).message || 'unknown error'}`, 6000); }
    finally { run = null; if (!disposed) renderAll(); }
  }

  function renderAuto() {
    const running = !!run;
    autoBox.replaceChildren(
      h('div', { class: 'at-sec', style: 'display:flex;gap:8px;margin-top:6px' },
        h('button', { class: 'btn primary', style: 'flex:1;min-height:46px', onclick: () => void runAuto(), disabled: running ? 'true' : undefined }, running ? 'Finding photos...' : 'Auto B-roll'),
        running ? h('button', { class: 'btn danger', style: 'min-height:46px', onclick: () => { if (run) run.cancelled = true; } }, 'Stop') : (null as unknown as Node)),
      running ? h('div', { class: 'at-hint' }, progress) : (null as unknown as Node),
    );
  }

  // ------------------------------------------------------------ search + grid
  async function doSearch(qs: string) {
    const query = qs.trim();
    if (!query || searching) return;
    searching = true; searched = true; renderGrid();
    try { results = await searchBroll(query, { limit: 12 }); }
    catch (e) { results = []; toast((e as Error).message || 'Search failed', 4500); }
    finally { searching = false; renderGrid(); }
  }

  async function pickItem(it: BrollItem) {
    if (addingId) return;
    addingId = it.id; renderGrid();
    const path = await downloadBroll(it);
    addingId = null;
    if (disposed) return;
    const fields = { url: it.url, thumb: it.thumb, title: it.title, source: it.source, credit: it.credit };
    if (replaceId) {
      const b = list().find((x) => x.id === replaceId);
      replaceId = null;
      if (b) {
        Object.assign(b, fields);
        if (path) b.path = path; else delete b.path;
        ctx.changed(); toast(path || !isNative() ? 'Photo swapped.' : 'Could not save this photo. It shows in the preview but will not be in the export.', 4500);
        renderAll(); return;
      }
    }
    const dur = ctx.durationMs();
    const start = Math.max(0, Math.min(Math.round(ctx.playMs()), Math.max(0, dur - 800)));
    const end = Math.min(dur || start + lenMs, start + lenMs);
    if (end - start < 500) { toast('Not enough room at the end of the video.'); renderGrid(); return; }
    const nb: BrollBeat = {
      id: uid(), start, end, keyword: input.value.trim() || it.title, ...fields, ...(path ? { path } : {}),
      motion: newMotion, frame: newFrame, radius: BROLL_DEFAULT_RADIUS,
    };
    ctx.p.broll = placeBroll(list(), nb);
    sel = nb.id;
    if (!path && isNative()) toast('Could not save this photo. It shows in the preview but will not be in the export.', 5000);
    ctx.changed(); ctx.seek(nb.start);
    renderAll();
  }

  function renderGrid() {
    if (searching) { gridBox.replaceChildren(h('div', { class: 'at-hint', style: 'margin-top:14px' }, 'Searching...')); return; }
    if (!results.length) {
      gridBox.replaceChildren(h('div', { class: 'at-hint', style: 'margin-top:12px' }, searched
        ? 'Nothing found. Try the name in English or a simpler word.'
        : replaceId ? 'Search a new photo, then tap it to swap.' : 'Search a person, place or event. Tap a photo to put it on the timeline at the playhead.'));
      return;
    }
    gridBox.replaceChildren(
      replaceId ? h('div', { class: 'at-hint', style: 'margin-top:10px' }, 'Tap a photo to swap it in.') : (null as unknown as Node),
      h('div', { class: 'br-grid' }, ...results.map((it) => {
        const img = h('img', { src: it.thumb, alt: it.title, loading: 'lazy', referrerpolicy: 'no-referrer' }) as HTMLImageElement;
        img.addEventListener('error', () => { tile.style.display = 'none'; });
        const tile = h('button', { class: 'br-tile' + (addingId === it.id ? ' busy' : ''), 'aria-label': it.title, onclick: () => void pickItem(it) },
          img, h('span', { class: 'src' }, SRC_LABEL[it.source]));
        return tile;
      })));
  }

  // ------------------------------------------------------------ placed beats
  function renderBeats() {
    const all = list();
    const b = cur();
    const kids: Node[] = [];
    if (all.length) {
      kids.push(h('div', { class: 'schips', style: 'margin-top:16px;flex-wrap:nowrap;overflow-x:auto' }, ...all.map((x, i) =>
        h('button', { class: 'chip' + (x.id === sel ? ' on' : ''), onclick: () => { sel = x.id; replaceId = null; ctx.seek(Math.min(ctx.durationMs(), x.start + 400)); renderAll(); } }, `${i + 1} · ${(x.keyword || x.title).slice(0, 14)}${!x.path && isNative() ? ' !' : ''}`))));
    }
    if (b) {
      kids.push(
        h('div', { class: 'at-hint', style: 'margin-top:8px' }, `${b.title} · ${SRC_LABEL[b.source]}${!b.path && isNative() ? ' · not saved on the phone, left out of the export' : ''}`),
        slider('Length', BROLL_MIN_MS / 1000, BROLL_MAX_MS / 1000, 0.5, (b.end - b.start) / 1000, (v) => `${v}s`, (v) => {
          b.end = Math.min(ctx.durationMs() || b.start + v * 1000, b.start + Math.round(v * 1000));
          ctx.changed();
        }),
        chipRow<BrollMotion>('Motion', BROLL_MOTIONS.map((m) => [m, BROLL_MOTION_LABEL[m]] as [BrollMotion, string]), b.motion, (v) => { b.motion = v; ctx.changed(); }),
        chipRow<BrollFrame>('Frame', (Object.keys(BROLL_FRAME_LABEL) as BrollFrame[]).map((f) => [f, BROLL_FRAME_LABEL[f]] as [BrollFrame, string]), b.frame, (v) => { b.frame = v; ctx.changed(); }),
        h('div', { class: 'at-sec', style: 'display:flex;gap:8px' },
          h('button', { class: 'btn', style: 'flex:1;min-height:44px', onclick: () => { input.value = b.keyword || b.title; void doSearch(input.value); } }, 'Find similar'),
          h('button', { class: 'btn' + (replaceId ? ' primary' : ''), style: 'flex:1;min-height:44px', onclick: () => { replaceId = replaceId ? null : b.id; renderAll(); } }, replaceId ? 'Swapping...' : 'Swap photo'),
          h('button', { class: 'btn danger', style: 'min-height:44px', 'aria-label': 'Delete photo beat', onclick: () => { ctx.p.broll = list().filter((x) => x.id !== b.id); sel = list()[0]?.id ?? null; replaceId = null; ctx.changed(); renderAll(); } }, icon('trash', 20))));
    }
    if (all.length) {
      kids.push(h('div', { class: 'at-sec', style: 'display:flex;gap:8px' },
        h('button', { class: 'btn', style: 'flex:1;min-height:44px', onclick: () => void copyCredits() }, 'Copy credits'),
        h('button', { class: 'btn', style: 'flex:1;min-height:44px', onclick: () => { ctx.p.broll = []; sel = null; replaceId = null; ctx.changed(); renderAll(); } }, 'Clear all')));
    }
    beatsBox.replaceChildren(...kids);
  }

  async function copyCredits() {
    const seen = new Set<string>(), lines: string[] = [];
    for (const b of list()) {
      const l = `${b.title}${b.credit ? ' - ' + b.credit : ''}`;
      if (!seen.has(l)) { seen.add(l); lines.push(l); }
    }
    try { await navigator.clipboard.writeText('Photo credits:\n' + lines.join('\n')); toast('Credits copied. Paste them in the video description.', 3500); }
    catch { toast('Could not copy.'); }
  }

  const renderAll = () => { renderAuto(); renderGrid(); renderBeats(); };

  const el = h('div', {},
    autoBox,
    slider('Beat length', BROLL_MIN_MS / 1000, BROLL_MAX_MS / 1000, 0.5, lenMs / 1000, (v) => `${v}s`, (v) => { lenMs = Math.round(v * 1000); }),
    chipRow<'every' | 'alternate'>('Auto coverage', [['every', 'Every beat'], ['alternate', 'Every other beat']], coverage, (v) => { coverage = v; }),
    chipRow<BrollMotion>('New photo motion', BROLL_MOTIONS.map((m) => [m, BROLL_MOTION_LABEL[m]] as [BrollMotion, string]), newMotion, (v) => { newMotion = v; }),
    chipRow<BrollFrame>('New photo frame', (Object.keys(BROLL_FRAME_LABEL) as BrollFrame[]).map((f) => [f, BROLL_FRAME_LABEL[f]] as [BrollFrame, string]), newFrame, (v) => { newFrame = v; }),
    searchRow, gridBox, beatsBox);
  renderAll();
  return { el, dispose: () => { disposed = true; if (run) run.cancelled = true; } };
}
