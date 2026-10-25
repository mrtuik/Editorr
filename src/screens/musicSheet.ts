import type { Project } from '../core/types';
import { h, icon, fmtClock } from '../ui';
import { youtubeAvailable } from '../core/native';
import { mountYoutubeSearch, openYoutubeSheet } from './youtubeSheet';

export interface MusicCtx {
  p: Project;
  playMs: () => number;
  /** Picked songs / effects of this session (kept in memory; the baked file is what is saved). */
  songs: { name: string }[];
  sfx: { name: string; startMs: number }[];
  /** Songs placed by hand at the playhead (Music > Music). */
  clips: { name: string; startMs: number }[];
  addSongs: (files: File[]) => Promise<void>;
  addSfx: (file: File, startMs: number) => Promise<void>;
  addClip: (file: File, startMs: number) => Promise<void>;
  /** Add a song that is already a file on the phone (YouTube module). */
  addSongFromPath?: (path: string, title: string) => Promise<void>;
  addClipFromPath?: (path: string, title: string, startMs: number) => Promise<void>;
  removeSong: (i: number) => void;
  removeSfx: (i: number) => void;
  removeClip: (i: number) => void;
  /** Make the track (shows progress). */
  apply: (o: { levelDb: number; duckDb: number; fadeMs: number; clipDb: number; clipDuck: boolean }) => Promise<boolean>;
  clear: () => void;
  preview: () => void;
}

type MusicSettings = { musicLevelDb?: number; musicDuckDb?: number; musicFadeMs?: number; musicClipDb?: number; musicClipDuck?: boolean };

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

/** Music tool: Auto BGM (songs under the voice), Music (a song you search or pick, placed at the playhead) and SFX (short sounds at the playhead). */
export function openMusicSheet(ctx: MusicCtx, settings: MusicSettings, persist: () => void, start: 'home' | 'bgm' | 'music' | 'sfx' = 'home'): void {
  const body = h('div', { class: 'at-body' });
  const foot = h('div', { class: 'at-foot' });
  const title = h('div', { class: 'at-title' }, 'Music');
  const back = h('button', { class: 'at-back', 'aria-label': 'Back', onclick: () => (view === 'home' || start !== 'home' ? close() : home()) }, icon('back', 20));
  const close = () => { unmount(); sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const sheet = h('div', { class: 'at-sheet', role: 'dialog' }, h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, back, title, h('span', { class: 'at-head-gap' })), body, foot);
  const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);
  let view: 'home' | 'bgm' | 'music' | 'sfx' = 'home';
  /** After Apply / Remove: back to the three tiles, or close when the sheet was opened straight from the toolbar. */
  const leave = () => { if (start === 'home') home(); else close(); };
  let ytOn = false;
  let unmountSearch: (() => void) | null = null;
  const unmount = () => { if (unmountSearch) { unmountSearch(); unmountSearch = null; } };
  const level = () => settings.musicLevelDb ?? -20, duck = () => settings.musicDuckDb ?? 12, fade = () => settings.musicFadeMs ?? 1500;
  const clipDb = () => settings.musicClipDb ?? -18, clipDuck = () => settings.musicClipDuck ?? true;
  const hasAny = () => ctx.songs.length > 0 || ctx.sfx.length > 0 || ctx.clips.length > 0;

  async function doApply() {
    if (!hasAny()) return;
    box.style.display = 'none';
    const ok = await ctx.apply({ levelDb: level(), duckDb: duck(), fadeMs: fade(), clipDb: clipDb(), clipDuck: clipDuck() });
    box.style.display = '';
    if (ok) { ctx.preview(); leave(); }
  }

  function home() {
    unmount();
    view = 'home'; title.textContent = 'Music'; foot.replaceChildren();
    body.replaceChildren(h('div', { class: 'at-tiles' },
      h('button', { class: 'at-tile', onclick: bgm }, icon('wand', 26), h('span', {}, 'Auto BGM')),
      h('button', { class: 'at-tile', onclick: music }, icon('volume', 26), h('span', {}, 'Music')),
      h('button', { class: 'at-tile', onclick: sfx }, icon('bolt', 26), h('span', {}, 'SFX'))),
      ctx.p.bgm ? h('div', { class: 'at-hint' }, `Music is on this video (${ctx.p.bgm.names.length} item${ctx.p.bgm.names.length === 1 ? '' : 's'}).`)
        : h('div', { class: 'at-hint' }, 'Auto BGM: songs play under the whole video. Music: pick one song and place it at the playhead. SFX: short sounds. Then Apply.'),
      ...(ctx.p.bgm ? [h('button', { class: 'btn at-go', style: 'margin-top:8px', onclick: () => { ctx.clear(); leave(); } }, icon('trash', 20), 'Remove music')] : []));
  }

  function list(items: { name: string; extra?: string }[], remove: (i: number) => void) {
    return h('div', { class: 'rx-list', style: 'max-height:none' }, ...items.map((s, i) => h('div', { class: 'rx-row' },
      h('div', { class: 'rx-go', style: 'cursor:default' }, h('b', {}, s.name), s.extra ? h('span', {}, s.extra) : h('span', {}, ' ')),
      h('button', { class: 'rx-del', 'aria-label': 'Remove', onclick: () => { remove(i); render(); } }, icon('trash', 18)))));
  }

  function bgm() { unmount(); view = 'bgm'; title.textContent = 'Auto BGM'; render(); }
  function music() { unmount(); view = 'music'; title.textContent = 'Music'; render(); }
  function sfx() { unmount(); view = 'sfx'; title.textContent = 'SFX'; render(); }

  const applyBtn = () => h('button', { class: 'btn primary at-go', onclick: () => void doApply() }, icon('wand', 20), 'Apply');

  function render() {
    if (view === 'bgm') {
      body.replaceChildren(
        h('div', { class: 'at-hint' }, 'Pick one or more songs. Several songs play one after another with a 2 s crossfade. One song loops and fades out at the end.'),
        list(ctx.songs, ctx.removeSong),
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(true, async (f) => { await ctx.addSongs(f); render(); }) }, 'Add songs from phone'),
        ...(ytOn ? [h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => openYoutubeSheet(async (path, name) => { await ctx.addSongFromPath!(path, name); render(); }) }, icon('search', 18), 'Add from YouTube')] : []),
        slider('Music level', -30, -10, 1, level(), (v) => `${v} dB`, (v) => { settings.musicLevelDb = v; persist(); }),
        slider('Drop while talking', 0, 24, 1, duck(), (v) => `${v} dB`, (v) => { settings.musicDuckDb = v; persist(); }),
        slider('Fade in / out', 0, 4000, 250, fade(), (v) => `${(v / 1000).toFixed(2)} s`, (v) => { settings.musicFadeMs = v; persist(); }),
        h('span', {}));
      foot.replaceChildren(
        ...(ctx.p.bgm ? [h('button', { class: 'btn at-go', style: 'margin-bottom:8px', onclick: () => { ctx.clear(); leave(); } }, icon('trash', 20), 'Remove music')] : []),
        applyBtn());
    } else if (view === 'music') {
      const placed = h('div', {});
      const redrawPlaced = () => {
        placed.replaceChildren(list(ctx.clips.map((c) => ({ name: c.name, extra: `starts at ${fmtClock(c.startMs)}` })), ctx.removeClip));
      };
      redrawPlaced();
      const host = h('div', { style: 'margin-top:6px' });
      body.replaceChildren(
        h('div', { class: 'at-hint' }, `The song starts where the playhead is now (${fmtClock(ctx.playMs())}). Add as many as you like, each at its own place. Then tap Apply.`),
        placed,
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(false, async (f) => { await ctx.addClip(f[0], ctx.playMs()); render(); }) }, 'Add song from phone'),
        slider('Music level', -30, -6, 1, clipDb(), (v) => `${v} dB`, (v) => { settings.musicClipDb = v; persist(); }),
        h('button', { class: `at-tile${clipDuck() ? ' on' : ''}`, style: 'min-height:44px;flex-direction:row;gap:8px;margin-top:12px;width:100%', onclick: () => { settings.musicClipDuck = !clipDuck(); persist(); render(); } },
          icon('check', 18), h('span', {}, clipDuck() ? 'Gets quieter while someone talks' : 'Stays the same while someone talks')),
        slider('Fade in / out', 0, 4000, 250, fade(), (v) => `${(v / 1000).toFixed(2)} s`, (v) => { settings.musicFadeMs = v; persist(); }),
        h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Search on YouTube'), host));
      if (ytOn) {
        unmountSearch = mountYoutubeSearch(host, async (path, name) => { await ctx.addClipFromPath!(path, name, ctx.playMs()); redrawPlaced(); });
      } else {
        host.append(h('div', { class: 'at-hint' }, 'YouTube search is not in this build. Pick songs from your phone, or build the app with the YouTube option (see README).'));
      }
      foot.replaceChildren(
        ...(ctx.p.bgm ? [h('button', { class: 'btn at-go', style: 'margin-bottom:8px', onclick: () => { ctx.clear(); leave(); } }, icon('trash', 20), 'Remove music')] : []),
        applyBtn());
    } else if (view === 'sfx') {
      body.replaceChildren(
        h('div', { class: 'at-hint' }, 'Short sounds (whoosh, laugh, meme) from your phone. Each one is placed where the playhead is now. Then tap Apply.'),
        list(ctx.sfx.map((s) => ({ name: s.name, extra: `at ${fmtClock(s.startMs)}` })), ctx.removeSfx),
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(false, async (f) => { await ctx.addSfx(f[0], ctx.playMs()); render(); }) }, `Add sound at ${fmtClock(ctx.playMs())}`));
      foot.replaceChildren(applyBtn());
    }
  }

  void youtubeAvailable().then((v) => { ytOn = v && !!ctx.addSongFromPath && !!ctx.addClipFromPath; if (ytOn && (view === 'bgm' || view === 'music')) { unmount(); render(); } });
  if (start === 'bgm') bgm(); else if (start === 'music') music(); else if (start === 'sfx') sfx(); else home();
}
