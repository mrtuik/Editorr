import type { Project } from '../core/types';
import { h, icon, fmtClock, toast } from '../ui';
import { mountSoundBrowser, sbBtn, sbRow, stopSound, type ExtraTab } from './soundBrowser';
import { MOOD_LABEL, type Mood, type MusicLang } from '../core/mood';

/** What Auto BGM chose: one song (or made music) for each part of the video. */
export type AutoPlan = { startMs: number; endMs: number; mood: Mood; title: string; source: 'youtube' | 'built-in'; note?: string }[];

export interface MusicCtx {
  p: Project;
  playMs: () => number;
  /** Picked songs / effects of this session (kept in memory; the baked file is what is saved). */
  songs: { name: string }[];
  sfx: { name: string; startMs: number; auto?: boolean }[];
  /** Songs placed by hand at the playhead (Music > Music). */
  clips: { name: string; startMs: number; endMs?: number; kind?: 'bgm' | 'music'; mood?: string }[];
  /** Auto BGM: mood of each part -> a song for it. Auto SFX: effects at the cuts (returns how many). */
  autoBgm: (o: { lang: MusicLang; status: (s: string) => void }) => Promise<AutoPlan | null>;
  autoSfx: (o: { status: (s: string) => void }) => Promise<{ count: number; fromYoutube: number; note?: string }>;
  /** Hear the n-th effect of the list (made or downloaded). */
  previewSfx: (n: number) => boolean;
  /** Add an effect that is already a file on the phone (YouTube). */
  addSfxFromPath: (path: string, title: string, startMs: number) => Promise<void>;
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
  let browser: { destroy: () => void; refresh: () => void } | null = null;
  const unmount = () => { if (browser) { browser.destroy(); browser = null; } stopSound(); };
  /** CapCut layout (see-through scrim, short sheet, no title bar) for Auto BGM, Music and SFX. */
  const setLayout = (sb: boolean) => { box.classList.toggle('clear', sb); sheet.classList.toggle('sb', sb); };
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
    unmount(); setLayout(false);
    view = 'home'; title.textContent = 'Music'; foot.className = 'at-foot'; foot.replaceChildren();
    body.replaceChildren(h('div', { class: 'at-tiles' },
      h('button', { class: 'at-tile', onclick: bgm }, icon('bgm', 26), h('span', {}, 'Auto BGM')),
      h('button', { class: 'at-tile', onclick: music }, icon('volume', 26), h('span', {}, 'Music')),
      h('button', { class: 'at-tile', onclick: sfx }, icon('bolt', 26), h('span', {}, 'SFX'))),
      ctx.p.bgm ? h('div', { class: 'at-hint' }, `Music is on this video (${ctx.p.bgm.names.length} item${ctx.p.bgm.names.length === 1 ? '' : 's'}).`)
        : h('div', { class: 'at-hint' }, 'Auto BGM: music for your video, chosen by its mood. Music: search or pick a song and place it at the playhead. SFX: sound effects. Then Apply.'),
      ...(ctx.p.bgm ? [h('button', { class: 'btn at-go', style: 'margin-top:8px', onclick: () => { ctx.clear(); leave(); } }, icon('trash', 20), 'Remove music')] : []));
  }

  function bgm() { unmount(); view = 'bgm'; title.textContent = 'Auto BGM'; render(); }
  function music() { unmount(); view = 'music'; title.textContent = 'Music'; render(); }
  function sfx() { unmount(); view = 'sfx'; title.textContent = 'SFX'; render(); }
  /** Where the chevron / back goes: the three tiles, or away when the sheet was opened straight from the toolbar. */
  const leaveView = () => (start === 'home' ? home() : close());

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

  const applyBtn = () => h('button', { class: 'btn primary at-go sb-apply', onclick: () => void doApply() }, icon('wand', 20), 'Apply');
  const paintBrowserFoot = () => {
    foot.className = 'at-foot sb-foot';
    foot.replaceChildren(...(hasAny() ? [applyBtn()] : []));
  };

  /** The same small "name + time + remove" row the browser uses, for the songs / effects already chosen. */
  function chosenRows(host: HTMLElement, kind: 'music' | 'sfx') {
    const rows: Node[] = [];
    if (kind === 'music') {
      ctx.clips.map((c, i) => ({ c, i })).filter((x) => x.c.kind !== 'bgm').forEach((x) =>
        rows.push(sbRow({ title: x.c.name, sub: `starts at ${fmtClock(x.c.startMs)}` }, sbBtn('trash', 'Remove', () => { ctx.removeClip(x.i); paintChosen(); }))));
    } else {
      ctx.sfx.map((c, i) => ({ c, i })).forEach((x) =>
        rows.push(sbRow({ title: x.c.name, sub: `at ${fmtClock(x.c.startMs)}`, onTap: () => { ctx.previewSfx(x.i); } }, sbBtn('trash', 'Remove', () => { ctx.removeSfx(x.i); paintChosen(); }))));
    }
    host.replaceChildren(...(rows.length ? rows : [h('div', { class: 'sb-msg' }, 'Nothing added yet. Tap + on a sound to put it at the playhead.')]));
    function paintChosen() { chosenRows(host, kind); paintBrowserFoot(); }
  }

  /** SFX > Auto tab: effects at the layout changes and camera moves, taken from YouTube. */
  function autoSfxTab(): ExtraTab {
    return {
      key: 'auto', label: 'Auto',
      render: (host) => {
        let working = false, status = '', note = '', fromYt = 0;
        const paint = () => {
          const autos = ctx.sfx.map((c, i) => ({ c, i })).filter((x) => x.c.auto);
          host.replaceChildren(
            h('div', { class: 'sb-msg' }, 'Puts a whoosh where the layout changes and a pop where the camera moves to the other person. The sounds come from YouTube.'),
            h('div', { class: 'sb-actions' }, h('button', { class: 'btn primary sb-gen', disabled: working ? 'true' : undefined, onclick: () => void gen() },
              icon('wand', 20), working ? 'Working...' : autos.length ? 'Auto add again' : 'Auto add effects')),
            ...(working && status ? [h('div', { class: 'sb-msg' }, h('span', { class: 'sb-spin' }), status)] : []),
            ...(!working && note ? [h('div', { class: 'sb-msg err' }, `YouTube did not work (${note}). Sounds made on the phone were used instead.`)] : []),
            ...(!working && fromYt ? [h('div', { class: 'sb-msg ok' }, `${fromYt} effect${fromYt === 1 ? '' : 's'} from YouTube.`)] : []),
            ...autos.map((x) => sbRow({ title: x.c.name, sub: `at ${fmtClock(x.c.startMs)}`, onTap: () => { ctx.previewSfx(x.i); } },
              sbBtn('trash', 'Remove', () => { ctx.removeSfx(x.i); paint(); paintBrowserFoot(); }))),
            slider('Effect volume', 20, 100, 5, settings.sfxLevel ?? 55, (v) => `${v}%`, (v) => { settings.sfxLevel = v; persist(); }));
        };
        async function gen() {
          if (working) return;
          working = true; status = 'Starting...'; note = ''; fromYt = 0; paint();
          try {
            const r = await ctx.autoSfx({ status: (t) => { status = t; if (working) paint(); } });
            note = r.note ?? ''; fromYt = r.fromYoutube;
            if (!r.count) toast('No layout changes or camera moves to put effects on. Add a sound by hand from the other tabs.', 4500);
          } catch (error) { toast(`Auto SFX failed: ${error instanceof Error ? error.message : 'unknown error'}`, 6000); }
          working = false; paint(); paintBrowserFoot();
        }
        paint();
        return () => { working = false; ctx.stopPreview(); };
      },
    };
  }

  function browse(mode: 'music' | 'sfx') {
    setLayout(true);
    const hostEl = h('div', { class: 'sb-host' });
    body.replaceChildren(hostEl);
    const extra: ExtraTab[] = [
      ...(mode === 'sfx' ? [autoSfxTab()] : []),
      { key: 'added', label: 'Added', at: 'end', render: (el) => { chosenRows(el, mode); } },
    ];
    const quietApply = async () => {
      box.style.display = 'none';
      const ok = await ctx.apply({ levelDb: level(), duckDb: duck(), fadeMs: fade(), clipDb: clipDb(), clipDuck: clipDuck() });
      box.style.display = '';
      if (ok) ctx.preview();
      paintBrowserFoot();
    };
    browser = mountSoundBrowser(hostEl, {
      mode, first: '0', extraTabs: extra, onClose: leaveView, onCloseAll: () => close(),
      autoToggle: {
        label: 'Add with auto',
        isOn: () => (mode === 'sfx' ? ctx.sfx.some((x) => x.auto) : ctx.clips.some((c) => c.kind === 'bgm')),
        run: async (on, status) => {
          if (on) {
            if (mode === 'sfx') {
              const r = await ctx.autoSfx({ status });
              if (!r.count) { toast('No place in this video needs an effect yet.', 4000); return; }
            } else {
              const plan = await ctx.autoBgm({ lang: lang(), status });
              if (!plan) return;
            }
            status('Making the track...');
            await quietApply();
          } else {
            if (mode === 'sfx') { for (let i = ctx.sfx.length - 1; i >= 0; i--) if (ctx.sfx[i]!.auto) ctx.removeSfx(i); }
            else { for (let i = ctx.clips.length - 1; i >= 0; i--) if (ctx.clips[i]!.kind === 'bgm') ctx.removeClip(i); }
            if (hasAny()) await quietApply(); else ctx.clear();
          }
        },
      },
      onAdd: async (path, name) => {
        if (mode === 'sfx') await ctx.addSfxFromPath(path, name, ctx.playMs());
        else await ctx.addClipFromPath!(path, name, ctx.playMs());
        toast(`Added at ${fmtClock(ctx.playMs())}. Tap Apply when you are done.`, 3000);
        paintBrowserFoot();
      },
    });
    paintBrowserFoot();
  }

  function render() {
    unmount();
    if (view === 'bgm') {
      setLayout(true);
      const autos = ctx.clips.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'bgm');
      const statusEl = h('div', { class: 'sb-msg' }, busy ? h('span', { class: 'sb-spin' }) : null, busy ? status : '');
      statusEl.id = 'bgm-status';
      const rows = autos.map((x, n) => {
        const on = playing === n;
        const mood = x.c.mood && x.c.mood in MOOD_LABEL ? MOOD_LABEL[x.c.mood as Mood] : 'Music';
        return sbRow({ title: x.c.name, sub: `${mood}  ·  ${fmtClock(x.c.startMs)} to ${fmtClock(x.c.endMs ?? ctx.p.durationMs)}`, active: on,
          onTap: () => { if (on) { ctx.stopPreview(); playing = -1; } else { playing = ctx.previewAuto(n) ? n : -1; } render(); } },
        sbBtn(on ? 'pause' : 'play', on ? 'Stop' : 'Play', () => { if (on) { ctx.stopPreview(); playing = -1; } else { playing = ctx.previewAuto(n) ? n : -1; } render(); }));
      });
      const top = h('div', { class: 'sb-search' },
        h('div', { class: 'sb-pill static' }, icon('bgm', 22), h('span', {}, 'Auto BGM')),
        h('button', { class: 'sb-collapse', 'aria-label': 'Close', onclick: leaveView }, icon('chevD', 26)));
      const tabs = h('div', { class: 'sb-tabs', role: 'tablist' }, ...([['en', 'English'], ['hi', 'Hindi'], ['te', 'Telugu']] as [MusicLang, string][]).map(([k, label]) =>
        h('button', { class: 'sb-tab' + (lang() === k ? ' on' : ''), role: 'tab', 'aria-selected': String(lang() === k), disabled: busy ? 'true' : undefined,
          onclick: () => { settings.musicLang = k; persist(); render(); } }, label)));
      const listEl = h('div', { class: 'sb-list' },
        ...(!busy && !rows.length && !ctx.songs.length ? [h('div', { class: 'sb-msg' }, 'The app listens to your video, finds the mood of each part and picks music for it from YouTube. Tap Generate, listen, then Apply.')] : []),
        statusEl,
        ...(!busy && lastNote ? [h('div', { class: 'sb-msg err' }, `YouTube did not work (${lastNote}). Music made on the phone was used instead.`)] : []),
        ...rows,
        ...ctx.songs.map((sg, i) => sbRow({ title: sg.name, sub: 'My song' }, sbBtn('trash', 'Remove', () => { ctx.removeSong(i); render(); }))),
        h('button', { class: 'sb-own', onclick: () => pick(true, async (f) => { await ctx.addSongs(f); render(); }) }, icon('plus', 20), 'Use my own songs instead'),
        ...(ctx.p.bgm && !busy ? [h('button', { class: 'sb-own danger', onclick: () => { ctx.clear(); leave(); } }, icon('trash', 20), 'Remove music')] : []),
        slider('Music level', -30, -10, 1, level(), (v) => `${v} dB`, (v) => { settings.musicLevelDb = v; persist(); }),
        slider('Drop while talking', 0, 24, 1, duck(), (v) => `${v} dB`, (v) => { settings.musicDuckDb = v; persist(); }),
        slider('Fade in / out', 0, 4000, 250, fade(), (v) => `${(v / 1000).toFixed(2)} s`, (v) => { settings.musicFadeMs = v; persist(); }));
      body.replaceChildren(h('div', { class: 'sb-host' }, top, tabs, listEl));
      const have = rows.length || ctx.songs.length;
      foot.className = 'at-foot sb-foot';
      foot.replaceChildren(
        h('button', { class: `btn at-go${have ? '' : ' primary'}`, disabled: busy ? 'true' : undefined, onclick: () => void generate() },
          icon('wand', 20), busy ? 'Working...' : rows.length ? 'Generate again' : 'Generate'),
        ...(!busy && have ? [applyBtn()] : []));
    } else if (view === 'music') {
      browse('music');
    } else if (view === 'sfx') {
      browse('sfx');
    }
  }

  if (start === 'bgm') bgm(); else if (start === 'music') music(); else if (start === 'sfx') sfx(); else home();
}
