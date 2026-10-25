import type { Project } from '../core/types';
import { h, icon, fmtClock } from '../ui';
import { youtubeAvailable } from '../core/native';
import { openYoutubeSheet } from './youtubeSheet';

export interface MusicCtx {
  p: Project;
  playMs: () => number;
  /** Picked songs / effects of this session (kept in memory; the baked file is what is saved). */
  songs: { name: string }[];
  sfx: { name: string; startMs: number }[];
  addSongs: (files: File[]) => Promise<void>;
  addSfx: (file: File, startMs: number) => Promise<void>;
  /** Add a song that is already a file on the phone (YouTube module). */
  addSongFromPath?: (path: string, title: string) => Promise<void>;
  removeSong: (i: number) => void;
  removeSfx: (i: number) => void;
  /** Make the track (shows progress). */
  apply: (o: { levelDb: number; duckDb: number; fadeMs: number }) => Promise<boolean>;
  clear: () => void;
  preview: () => void;
}

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void): HTMLElement {
  const val = h('b', {}, fmt(value));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'at-range', 'aria-label': label }) as HTMLInputElement;
  r.addEventListener('input', () => { const v = Number(r.value); val.textContent = fmt(v); on(v); });
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label-row' }, h('div', { class: 'at-label' }, label), val), r);
}
function pick(multiple: boolean, onFiles: (f: File[]) => void) {
  const input = h('input', { type: 'file', accept: 'audio/*', ...(multiple ? { multiple: 'true' } : {}), style: 'display:none' }) as HTMLInputElement;
  input.addEventListener('change', () => { const f = Array.from(input.files ?? []); input.remove(); if (f.length) onFiles(f); });
  document.body.append(input);
  input.click();
}

/** Music tool: Auto BGM (songs under the voice) and SFX (short sounds at the playhead). */
export function openMusicSheet(ctx: MusicCtx, settings: { musicLevelDb?: number; musicDuckDb?: number; musicFadeMs?: number }, persist: () => void): void {
  const body = h('div', { class: 'at-body' });
  const foot = h('div', { class: 'at-foot' });
  const title = h('div', { class: 'at-title' }, 'Music');
  const back = h('button', { class: 'at-back', 'aria-label': 'Back', onclick: () => (view === 'home' ? close() : home()) }, icon('back', 20));
  const close = () => { sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const sheet = h('div', { class: 'at-sheet', role: 'dialog' }, h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, back, title, h('span', { class: 'at-head-gap' })), body, foot);
  const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);
  let view: 'home' | 'bgm' | 'sfx' = 'home';
  const level = () => settings.musicLevelDb ?? -20, duck = () => settings.musicDuckDb ?? 12, fade = () => settings.musicFadeMs ?? 1500;

  function home() {
    view = 'home'; title.textContent = 'Music'; foot.replaceChildren();
    body.replaceChildren(h('div', { class: 'at-tiles' },
      h('button', { class: 'at-tile', onclick: bgm }, icon('volume', 26), h('span', {}, 'Auto BGM')),
      h('button', { class: 'at-tile', onclick: sfx }, icon('wand', 26), h('span', {}, 'SFX'))),
      ctx.p.bgm ? h('div', { class: 'at-hint' }, `Music is on this video (${ctx.p.bgm.names.length} item${ctx.p.bgm.names.length === 1 ? '' : 's'}).`) : h('div', { class: 'at-hint' }, 'Add songs from your phone, then Apply. They play under the voice and get quieter while someone talks.'));
  }

  function list(items: { name: string; extra?: string }[], remove: (i: number) => void) {
    return h('div', { class: 'rx-list', style: 'max-height:none' }, ...items.map((s, i) => h('div', { class: 'rx-row' },
      h('div', { class: 'rx-go', style: 'cursor:default' }, h('b', {}, s.name), s.extra ? h('span', {}, s.extra) : h('span', {}, ' ')),
      h('button', { class: 'rx-del', 'aria-label': 'Remove', onclick: () => { remove(i); render(); } }, icon('trash', 18)))));
  }

  function bgm() {
    view = 'bgm'; title.textContent = 'Auto BGM';
    render();
  }
  function sfx() { view = 'sfx'; title.textContent = 'SFX'; render(); }

  function render() {
    if (view === 'bgm') {
      body.replaceChildren(
        h('div', { class: 'at-hint' }, 'Pick one or more songs. Several songs play one after another with a 2 s crossfade. One song loops and fades out at the end.'),
        list(ctx.songs, ctx.removeSong),
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(true, async (f) => { await ctx.addSongs(f); render(); }) }, 'Add songs from phone'),
        ...(ytOn ? [h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => openYoutubeSheet(async (path, title) => { await ctx.addSongFromPath!(path, title); render(); }) }, icon('search', 18), 'Add from YouTube')] : []),
        slider('Music level', -30, -10, 1, level(), (v) => `${v} dB`, (v) => { settings.musicLevelDb = v; persist(); }),
        slider('Drop while talking', 0, 24, 1, duck(), (v) => `${v} dB`, (v) => { settings.musicDuckDb = v; persist(); }),
        slider('Fade in / out', 0, 4000, 250, fade(), (v) => `${(v / 1000).toFixed(2)} s`, (v) => { settings.musicFadeMs = v; persist(); }),
        h('span', {}));
      foot.replaceChildren(
        ...(ctx.p.bgm ? [h('button', { class: 'btn at-go', style: 'margin-bottom:8px', onclick: () => { ctx.clear(); home(); } }, icon('trash', 20), 'Remove music')] : []),
        h('button', { class: 'btn primary at-go', onclick: async () => {
          if (!ctx.songs.length && !ctx.sfx.length) { return; }
          box.style.display = 'none';
          const ok = await ctx.apply({ levelDb: level(), duckDb: duck(), fadeMs: fade() });
          box.style.display = '';
          if (ok) { ctx.preview(); home(); }
        } }, icon('wand', 20), 'Apply'));
    } else if (view === 'sfx') {
      body.replaceChildren(
        h('div', { class: 'at-hint' }, 'Short sounds (whoosh, laugh, meme) from your phone. Each one is placed where the playhead is now. Then tap Apply in Auto BGM.'),
        list(ctx.sfx.map((s) => ({ name: s.name, extra: `at ${fmtClock(s.startMs)}` })), ctx.removeSfx),
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(false, async (f) => { await ctx.addSfx(f[0], ctx.playMs()); render(); }) }, `Add sound at ${fmtClock(ctx.playMs())}`));
      foot.replaceChildren(h('button', { class: 'btn primary at-go', onclick: async () => {
        if (!ctx.songs.length && !ctx.sfx.length) return;
        box.style.display = 'none';
        const ok = await ctx.apply({ levelDb: level(), duckDb: duck(), fadeMs: fade() });
        box.style.display = '';
        if (ok) { ctx.preview(); home(); }
      } }, icon('wand', 20), 'Apply'));
    }
  }
  let ytOn = false;
  void youtubeAvailable().then((v) => { ytOn = v && !!ctx.addSongFromPath; if (ytOn && view === 'bgm') render(); });
  home();
}
