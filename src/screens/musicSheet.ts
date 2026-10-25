import type { Project } from '../core/types';
import { h, icon, fmtClock, toast } from '../ui';
import { mountYoutubeSearch } from './youtubeSheet';
import { MOOD_LABEL, type Mood, type MusicLang } from '../core/mood';

/** What Auto BGM chose: one song (or made music) for each part of the video. */
export type AutoPlan = { startMs: number; endMs: number; mood: Mood; title: string; source: 'youtube' | 'built-in'; note?: string }[];

export interface MusicCtx {
  p: Project;
  playMs: () => number;
  /** Picked songs / effects of this session (kept in memory; the baked file is what is saved). */
  songs: { name: string }[];
  sfx: { name: string; startMs: number }[];
  /** Songs placed by hand at the playhead (Music > Music). */
  clips: { name: string; startMs: number; endMs?: number; kind?: 'bgm' | 'music'; mood?: string }[];
  /** Auto BGM: mood of each part -> a song for it. Auto SFX: effects at the cuts (returns how many). */
  autoBgm: (o: { lang: MusicLang; status: (s: string) => void }) => Promise<AutoPlan | null>;
  autoSfx: () => number;
  /** Hear the first seconds of the n-th Auto BGM song. */
  previewAuto: (n: number) => boolean;
  stopPreview: () => void;
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

type MusicSettings = { musicLevelDb?: number; musicDuckDb?: number; musicFadeMs?: number; musicClipDb?: number; musicClipDuck?: boolean; musicLang?: MusicLang; sfxLevel?: number };

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
  const close = () => { alive = false; unmount(); ctx.stopPreview(); sheet.classList.add('out'); setTimeout(() => box.remove(), 180); };
  const sheet = h('div', { class: 'at-sheet lm', role: 'dialog' }, h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, back, title, h('span', { class: 'at-head-gap' })), body, foot);
  const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) close(); } }, sheet);
  document.body.append(box);
  let view: 'home' | 'bgm' | 'music' | 'sfx' = 'home';
  /** After Apply / Remove: back to the three tiles, or close when the sheet was opened straight from the toolbar. */
  const leave = () => { if (start === 'home') home(); else close(); };
  let alive = true, busy = false, status = '', lastNote = '', playing = -1;
  const lang = (): MusicLang => settings.musicLang ?? 'en';
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
        : h('div', { class: 'at-hint' }, 'Auto BGM: music for your video, chosen by its mood. Music: search or pick a song and place it at the playhead. SFX: sound effects. Then Apply.'),
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

  async function generate() {
    if (busy) return;
    busy = true; lastNote = ''; playing = -1; ctx.stopPreview();
    status = 'Starting...';
    render();
    let plan: AutoPlan | null = null;
    try {
      plan = await ctx.autoBgm({ lang: lang(), status: (s) => { status = s; const el = body.querySelector('#bgm-status'); if (el) el.textContent = s; } });
    } catch (error) {
      toast(`Auto BGM failed: ${error instanceof Error ? error.message : 'unknown error'}`, 6000);
    }
    busy = false;
    if (plan) lastNote = plan.find((x) => x.source === 'built-in' && x.note)?.note ?? '';
    if (alive && view === 'bgm') render();
  }

  const applyBtn = () => h('button', { class: 'btn primary at-go', onclick: () => void doApply() }, icon('wand', 20), 'Apply');

  function render() {
    unmount();
    if (view === 'bgm') {
      const autos = ctx.clips.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'bgm');
      const statusEl = h('div', { class: 'lm-hint' }, busy ? status : '');
      statusEl.id = 'bgm-status';
      const rows = autos.map((x, n) => {
        const on = playing === n;
        const mood = x.c.mood && x.c.mood in MOOD_LABEL ? MOOD_LABEL[x.c.mood as Mood] : 'Music';
        return h('div', { class: 'lm-row', style: 'cursor:default' },
          h('div', { class: 'lm-txt' }, h('b', {}, x.c.name), h('span', {}, `${mood}  ·  ${fmtClock(x.c.startMs)} to ${fmtClock(x.c.endMs ?? ctx.p.durationMs)}`)),
          h('button', { class: 'lm-end', style: 'border:0;color:inherit;cursor:pointer', 'aria-label': on ? 'Stop' : 'Play', onclick: () => {
            if (on) { ctx.stopPreview(); playing = -1; } else { playing = ctx.previewAuto(n) ? n : -1; }
            render();
          } }, icon(on ? 'pause' : 'play', 18)));
      });
      body.replaceChildren(
        h('div', { class: 'at-hint' }, 'The app listens to your video, finds the mood of each part and picks music for it. Tap Generate, listen, then Apply.'),
        h('div', { class: 'at-tiles', style: 'margin-top:10px' }, ...([['en', 'English'], ['hi', 'Hindi'], ['te', 'Telugu']] as [MusicLang, string][]).map(([k, label]) =>
          h('button', { class: `at-tile${lang() === k ? ' on' : ''}`, style: 'min-height:42px', disabled: busy ? 'true' : undefined, onclick: () => { settings.musicLang = k; persist(); render(); } }, h('span', {}, label)))),
        statusEl,
        ...(!busy && lastNote ? [h('div', { class: 'lm-hint err' }, `YouTube did not work (${lastNote}). Music made on the phone was used instead.`)] : []),
        ...(rows.length ? [h('div', { class: 'lm-list', style: 'margin-top:8px' }, ...rows)] : []),
        ...(ctx.songs.length ? [list(ctx.songs, ctx.removeSong)] : []),
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(true, async (f) => { await ctx.addSongs(f); render(); }) }, 'Use my own songs instead'),
        slider('Music level', -30, -10, 1, level(), (v) => `${v} dB`, (v) => { settings.musicLevelDb = v; persist(); }),
        slider('Drop while talking', 0, 24, 1, duck(), (v) => `${v} dB`, (v) => { settings.musicDuckDb = v; persist(); }),
        slider('Fade in / out', 0, 4000, 250, fade(), (v) => `${(v / 1000).toFixed(2)} s`, (v) => { settings.musicFadeMs = v; persist(); }),
        h('span', {}));
      const gen = h('button', { class: `btn at-go${rows.length || ctx.songs.length ? '' : ' primary'}`, style: rows.length || ctx.songs.length ? 'margin-bottom:8px' : '', disabled: busy ? 'true' : undefined, onclick: () => void generate() },
        icon('wand', 20), busy ? 'Working...' : rows.length ? 'Generate again' : 'Generate');
      foot.replaceChildren(
        ...(ctx.p.bgm && !busy ? [h('button', { class: 'btn at-go', style: 'margin-bottom:8px', onclick: () => { ctx.clear(); leave(); } }, icon('trash', 20), 'Remove music')] : []),
        gen,
        ...(!busy && (rows.length || ctx.songs.length) ? [applyBtn()] : []));
    } else if (view === 'music') {
      const placed = h('div', {});
      const redrawPlaced = () => {
        const shown = ctx.clips.map((c, i) => ({ c, i })).filter((x) => x.c.kind !== 'bgm');
        placed.replaceChildren(list(shown.map((x) => ({ name: x.c.name, extra: `starts at ${fmtClock(x.c.startMs)}` })), (j) => ctx.removeClip(shown[j]!.i)));
      };
      redrawPlaced();
      const host = h('div', { style: 'margin-top:6px' });
      body.replaceChildren(
        h('div', { class: 'at-hint' }, `The song starts where the playhead is now (${fmtClock(ctx.playMs())}). Add as many as you like, each at its own place. Then tap Apply.`),
        h('div', { class: 'at-sec', style: 'margin-top:4px' }, h('div', { class: 'at-label' }, 'Search on YouTube'), host),
        placed,
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(false, async (f) => { await ctx.addClip(f[0], ctx.playMs()); render(); }) }, 'Add song from phone'),
        slider('Music level', -30, -6, 1, clipDb(), (v) => `${v} dB`, (v) => { settings.musicClipDb = v; persist(); }),
        h('button', { class: `at-tile${clipDuck() ? ' on' : ''}`, style: 'min-height:44px;flex-direction:row;gap:8px;margin-top:12px;width:100%', onclick: () => { settings.musicClipDuck = !clipDuck(); persist(); render(); } },
          icon('check', 18), h('span', {}, clipDuck() ? 'Gets quieter while someone talks' : 'Stays the same while someone talks')),
        slider('Fade in / out', 0, 4000, 250, fade(), (v) => `${(v / 1000).toFixed(2)} s`, (v) => { settings.musicFadeMs = v; persist(); }));
      unmountSearch = mountYoutubeSearch(host, async (path, name) => { await ctx.addClipFromPath!(path, name, ctx.playMs()); redrawPlaced(); });
      foot.replaceChildren(
        ...(ctx.p.bgm ? [h('button', { class: 'btn at-go', style: 'margin-bottom:8px', onclick: () => { ctx.clear(); leave(); } }, icon('trash', 20), 'Remove music')] : []),
        applyBtn());
    } else if (view === 'sfx') {
      const level = settings.sfxLevel ?? 55;
      body.replaceChildren(
        h('div', { class: 'at-hint' }, 'Auto SFX puts a whoosh where the layout changes and a soft pop where the camera moves to the other person. You can also add your own sounds.'),
        h('button', { class: 'btn primary at-go', style: 'margin-top:10px', onclick: () => {
          const n = ctx.autoSfx();
          if (!n) toast('No layout changes or camera moves to put effects on. Add a sound by hand below.', 4500);
          render();
        } }, icon('wand', 20), ctx.sfx.some((s) => s.name) ? 'Auto add effects again' : 'Auto add effects'),
        slider('Effect volume', 20, 100, 5, level, (v) => `${v}%`, (v) => { settings.sfxLevel = v; persist(); }),
        list(ctx.sfx.map((s) => ({ name: s.name, extra: `at ${fmtClock(s.startMs)}` })), ctx.removeSfx),
        h('button', { class: 'btn', style: 'width:100%;min-height:46px;margin-top:8px', onclick: () => pick(false, async (f) => { await ctx.addSfx(f[0], ctx.playMs()); render(); }) }, `Add my own sound at ${fmtClock(ctx.playMs())}`));
      foot.replaceChildren(applyBtn());
    }
  }

  if (start === 'bgm') bgm(); else if (start === 'music') music(); else if (start === 'sfx') sfx(); else home();
}
