/**
 * Motion mode of the B-roll pane: Live Canvas Monitor, plan controls, scene list and editor.
 * Scenes are drawn by the visuals engine (HTML/CSS/JS, no photos). "Generate motion" plans and makes them one by one with
 * Antigravity (or the built-in rules); "Render and place" turns each into a clip and puts it on the timeline as a full-frame B-roll beat.
 */
import type { BrollCtx } from './brollSheet';
import {
  NoEncoderError, TEXT_ANIMS, TEXT_ANIM_LABEL, VISUAL_LABEL, VISUAL_THEMES, VISUAL_TYPES, classify, drawSceneFrame, ensureScript, generateScenes, getTheme, loadVisualFonts,
  makeLocal, motionIds, needsRender, outSize, motionPlaceholder, pickMotion, renderAndPlace, sceneTitle, scenesOf, showChip, slotAtPlayhead, sweepClips, syncPlaceholders, deleteClip,
  dropStrayPlaceholders, type RunCtrl, type Visual, type VisualSlot, type VisualType,
} from '../core/visuals';
import { placeBroll } from '../core/brollTypes';
import { h, toast, optionRow } from '../ui';

export interface MotionPane { el: HTMLElement; dispose: () => void }

const sec = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
const dur = (v: Visual) => Math.max(300, v.endMs - v.startMs);
void NoEncoderError; // re-exported by the engine; kept imported so a bundler keeps the encoder module in the same chunk as the pane

export function buildMotionPane(ctx: BrollCtx): MotionPane {
  const p = ctx.p;
  let themeId = p.motion?.themeId ?? 'paper-red';
  let pick: VisualType | 'auto' = 'auto';
  let short: 720 | 1080 = 720;
  let fullFrame = p.motion?.fullFrame ?? false;
  let selId: string | null = scenesOf(p)[0]?.id ?? null;
  let t = 0, playing = false, raf = 0, disposed = false;
  let running: RunCtrl | null = null, rendering: RunCtrl | null = null;
  let status = '';
  dropStrayPlaceholders(p);

  const scenes = () => scenesOf(p);
  const cur = () => scenes().find(v => v.id === selId);
  const aspect = () => { const a = ctx.aspect?.() ?? 16 / 9; return a > 0 ? a : 16 / 9; };
  const mon = outSize(aspect(), 360);
  const total = () => scenes().reduce((n, v) => n + dur(v), 0);

  // ------------------------------------------------------------ monitor
  const canvas = h('canvas', { class: 'mo-canvas', width: mon.w, height: mon.h, 'aria-label': 'Live Canvas Monitor' }) as HTMLCanvasElement;
  const g = canvas.getContext('2d', { alpha: false })!;
  const readPreview = h('b', {}, '0.0s'), readDur = h('b', {}, '0.0s');
  const scrub = h('div', { class: 'mo-scrub', role: 'slider', 'aria-label': 'Scrub the scene' });
  let drawing = false, wanted: number | null = null;

  /** Draws the frame at `ms` of the selected scene. A frame that is slow to arrive is skipped: the last one stays, the UI never waits. */
  async function draw(ms: number) {
    wanted = ms;
    if (drawing) return;
    drawing = true;
    try {
      while (wanted !== null && !disposed) {
        const tt = wanted; wanted = null;
        const v = cur();
        if (!v) { g.fillStyle = '#0b0b0d'; g.fillRect(0, 0, mon.w, mon.h); break; }
        await loadVisualFonts();
        await drawSceneFrame(g, v, Math.max(0, Math.min(dur(v), tt)), mon.w, mon.h);
      }
    } catch { /* a frame that fails keeps the last picture */ }
    finally { drawing = false; }
  }

  function readouts() {
    const v = cur();
    readPreview.textContent = sec(t);
    readDur.textContent = sec(v ? dur(v) : total());
    const segs = scrub.children;
    scenes().forEach((s, i) => {
      const seg = segs[i] as HTMLElement | undefined, fill = seg?.firstElementChild as HTMLElement | undefined;
      if (!fill) return;
      const before = scenes().findIndex(x => x.id === selId);
      fill.style.width = s.id === selId ? `${Math.min(100, (t / dur(s)) * 100)}%` : i < before ? '100%' : '0%';
    });
  }

  function renderScrub() {
    scrub.replaceChildren(...scenes().map(v => h('div', { class: 'mo-seg' + (v.id === selId ? ' on' : ''), style: `flex:${dur(v)} 1 0`, title: sceneTitle(v) }, h('i', {}))));
    readouts();
  }
  /** x on the scrub bar (0..1 of the script) -> which scene and the time inside it */
  function scrubAt(fx: number) {
    const all = scenes(); let at = Math.max(0, Math.min(1, fx)) * total(), acc = 0;
    for (const v of all) {
      if (at <= acc + dur(v) || v === all[all.length - 1]) {
        const same = v.id === selId; selId = v.id; t = Math.max(0, Math.min(dur(v), at - acc));
        if (!same) { renderList(); renderEditor(); renderScrub(); ctx.seek(v.startMs + 200); }
        readouts(); void draw(t); return;
      }
      acc += dur(v);
    }
  }
  let dragging = false;
  scrub.addEventListener('pointerdown', (e) => { if (!scenes().length) return; stop(); dragging = true; scrub.setPointerCapture(e.pointerId); const r = scrub.getBoundingClientRect(); scrubAt((e.clientX - r.left) / r.width); });
  scrub.addEventListener('pointermove', (e) => { if (!dragging) return; const r = scrub.getBoundingClientRect(); scrubAt((e.clientX - r.left) / r.width); });
  const endDrag = () => { dragging = false; };
  scrub.addEventListener('pointerup', endDrag); scrub.addEventListener('pointercancel', endDrag);

  const monitor = h('div', { class: 'mo-card' },
    h('div', { class: 'mo-head' }, h('span', { class: 'mo-dot' }), h('b', {}, 'Live Canvas Monitor'), h('span', { class: 'mo-fmt' }, `${p.aspect} · 30 FPS`)),
    h('div', { class: 'mo-stage' }, canvas),
    h('div', { class: 'mo-reads' }, h('span', {}, 'Preview: ', readPreview), h('span', {}, 'Duration: ', readDur)),
    scrub);

  // ------------------------------------------------------------ preview playback
  function stop() { playing = false; cancelAnimationFrame(raf); renderButtons(); }
  function play() {
    const v = cur(); if (!v || playing) return;
    const d = dur(v); if (t >= d - 30) t = 0;
    playing = true; renderButtons();
    const t0 = performance.now() - t;
    const step = () => {
      if (!playing || disposed) return;
      t = Math.min(d, performance.now() - t0);
      void draw(t); readouts();
      if (t >= d) { playing = false; renderButtons(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  const btnRow = h('div', { class: 'mo-btns' });
  function renderButtons() {
    const none = !scenes().length;
    btnRow.replaceChildren(
      h('button', { class: 'btn', style: 'flex:1;min-height:46px', disabled: none || rendering ? 'true' : undefined, onclick: () => (playing ? stop() : play()) }, playing ? 'Pause' : 'Play preview'),
      h('button', { class: 'btn primary', style: 'flex:1;min-height:46px', disabled: none || !!running || !!rendering ? 'true' : undefined, onclick: () => void renderPlace() }, rendering ? 'Rendering...' : 'Render and place'));
  }

  // ------------------------------------------------------------ plan controls
  const controls = h('div', { class: 'mo-plan' });
  function renderControls() {
    const typeSel = h('select', { class: 'mo-type', 'aria-label': 'Scene type', onchange: (e: Event) => { pick = (e.target as HTMLSelectElement).value as VisualType | 'auto'; } },
      h('option', { value: 'auto', selected: pick === 'auto' }, 'Auto: from what is said here'), ...VISUAL_TYPES.map(x => h('option', { value: x, selected: pick === x }, VISUAL_LABEL[x])));
    controls.replaceChildren(
      h('label', { class: 'vis-f' }, h('span', {}, 'Scene type'), typeSel),
      h('div', { class: 'at-label', style: 'margin-top:10px' }, 'Look for new scenes'),
      h('div', { class: 'schips', style: 'flex-wrap:nowrap;overflow-x:auto;margin-top:6px' }, ...VISUAL_THEMES.map(th => h('button', { class: 'chip' + (themeId === th.id ? ' on' : ''), onclick: () => { themeId = th.id; if (p.motion) p.motion.themeId = th.id; renderControls(); } }, th.name))),
      optionRow<720 | 1080>('Clip size', [[720, '720p'], [1080, '1080p']], short, (v) => { short = v; renderList(); }),
      optionRow<'safe' | 'full'>('Frame', [['safe', 'Above captions'], ['full', 'Use full frame']], fullFrame ? 'full' : 'safe', (v) => { fullFrame = v === 'full'; ensureScript(p, themeId).fullFrame = fullFrame; ctx.changed(); }),
      h('div', { style: 'display:flex;gap:8px;margin-top:12px' },
        h('button', { class: 'btn', style: 'min-height:46px;padding:0 14px', disabled: running || rendering ? 'true' : undefined, onclick: () => void generate(true) }, '+ Scene at playhead')),
      h('button', { class: 'btn primary', style: 'width:100%;min-height:48px;margin-top:8px', disabled: running || rendering ? 'true' : undefined, onclick: () => void generate(false) }, running ? 'Working...' : 'Generate motion'));
  }

  // ------------------------------------------------------------ status
  const statusEl = h('div', { class: 'at-hint mo-status', role: 'status' });
  const setStatus = (s: string) => { status = s; statusEl.textContent = s; statusEl.style.display = s ? '' : 'none'; };

  // ------------------------------------------------------------ scenes: generate, remove
  async function removeScenes(ids: Set<string>) {
    if (!p.motion || !ids.size) return;
    const gone = (p.broll ?? []).filter(b => b.motionSceneId && ids.has(b.motionSceneId));
    p.motion.scenes = p.motion.scenes.filter(v => !ids.has(v.id));
    p.motion.renderedBeatIds = p.motion.renderedBeatIds.filter(id => !gone.some(b => b.id === id));
    p.broll = (p.broll ?? []).filter(b => !(b.motionSceneId && ids.has(b.motionSceneId)));
    for (const b of gone) await deleteClip(p, b.path, b.id);
  }

  async function generate(onlyHere: boolean) {
    if (running || rendering) return;
    const words = ctx.words();
    if (!words.length) { toast('No transcript yet. Make Auto captions first.', 5000); return; }
    stop();
    const ctrl: RunCtrl = { stopped: false, paused: false };
    running = ctrl; renderControls(); renderButtons(); setStatus('Planning scenes...');
    const chip = showChip(ctrl); chip.text('Planning scenes...');
    const script = ensureScript(p, themeId); script.themeId = themeId; script.fullFrame = fullFrame;
    const from = !onlyHere && ctx.playMs() > 1000 ? ctx.playMs() : 0;
    const slot: VisualSlot | undefined = onlyHere ? slotAtPlayhead(words, ctx.playMs(), ctx.durationMs(), pick, classify) : undefined;
    try {
      const r = await generateScenes({
        words, durationMs: ctx.durationMs(), themeId, mix: pick === 'auto' ? [] : [pick], useAi: true, fromMs: from, slots: slot ? [slot] : undefined,
        busy: (p.docu ?? []).filter(d => !d.pending).map(d => ({ start: d.start, end: d.end })), full: fullFrame, ctrl,
        onPlan: (slots) => {
          // only what the new scenes replace is removed (scenes + their clips); grey blocks show the whole rhythm at once
          const hit = new Set(scenes().filter(v => slots.some(s => v.startMs < s.endMs && v.endMs > s.startMs)).map(v => v.id));
          void removeScenes(hit);
          let list = p.broll ?? [];
          slots.forEach((s, i) => { list = placeBroll(list, motionPlaceholder(s, i + 1)); });
          p.broll = list; ctx.changed();
        },
        onScene: (v, i, n) => {
          script.scenes.push(v); selId = v.id; t = 0;
          syncPlaceholders(p); ctx.changed(); ctx.seek(v.startMs + 400);
          chip.text(`Scene ${i + 1}/${n}`); renderList(); renderEditor(); renderScrub(); void draw(0);
        },
        onProgress: (i, n) => chip.text(`Scene ${i}/${n}`),
      });
      syncPlaceholders(p); ctx.changed();
      const agy = r.aiFailed ? ` Antigravity failed on ${r.aiFailed} scene${r.aiFailed > 1 ? 's' : ''} (${r.aiError}); built-in rules filled them.` : r.source === 'AI' || (slot && r.aiMade) ? ` Antigravity made ${r.aiMade}.` : '';
      const msg = r.made ? `${r.made} scene${r.made > 1 ? 's' : ''} made (${r.source})${r.failed ? `, ${r.failed} skipped` : ''}${ctrl.stopped ? ', stopped' : ''}.${agy}${r.note ? ` ${r.note}.` : ''}` : (r.note ?? 'No scene could be made.');
      setStatus(msg); toast(msg, 9000);
    } catch (e) { syncPlaceholders(p); ctx.changed(); setStatus(`Motion failed: ${(e as Error).message || 'error'}. What was made stays.`); toast(status, 6000); }
    finally { chip.dispose(); running = null; if (!disposed) { renderControls(); renderButtons(); renderList(); renderEditor(); renderScrub(); } }
  }

  async function renderPlace() {
    if (running || rendering || !scenes().length) return;
    stop();
    const ctrl: RunCtrl = { stopped: false, paused: false }, signal = { get cancelled() { return ctrl.stopped; } } as { cancelled: boolean };
    rendering = ctrl; renderButtons(); renderControls(); setStatus('Rendering...');
    const chip = showChip(ctrl); chip.text('Rendering...');
    try {
      const r = await renderAndPlace({
        p, ctrl, aspect: aspect(), short, signal, changed: () => { ctx.changed(); renderList(); },
        onProgress: (i, n, pct) => chip.text(`Rendering ${i}/${n}${pct > 0 ? ` · ${Math.round(pct * 100)}%` : ''}`),
      });
      const parts = [`${r.placed} scene${r.placed === 1 ? '' : 's'} placed`];
      if (r.slower) parts.push(`${r.slower} used the slower fallback`);
      if (r.frames) parts.push(`${r.frames} placed as pictures`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.cancelled) parts.push('cancelled, what was placed stays');
      const msg = `${parts.join(', ')}.${r.notes.length ? ' ' + [...new Set(r.notes)].join('. ') + '.' : ''}`;
      setStatus(msg); toast(msg, r.notes.length ? 10000 : 5000);
      const first = (p.broll ?? []).find(b => b.motionSceneId === selId && b.kind === 'video'); if (first) ctx.seek(first.start + 300);
    } catch (e) { setStatus(`Render failed: ${(e as Error).message || 'error'}`); toast(status, 6000); }
    finally { chip.dispose(); rendering = null; ctx.changed(); if (!disposed) { renderButtons(); renderControls(); renderList(); } }
  }

  // ------------------------------------------------------------ scene list + editor
  const listBox = h('div', { class: 'mo-list' });
  const editBox = h('div', {});
  function renderList() {
    const size = outSize(aspect(), short);
    listBox.replaceChildren(...scenes().map((v, i) => {
      const stale = (p.broll ?? []).some(b => b.motionSceneId === v.id && b.kind === 'video') ? needsRender(p, v, size.w, size.h) : null;
      return h('button', { class: 'mo-row' + (v.id === selId ? ' on' : ''), onclick: () => { stop(); selId = v.id; t = 0; renderList(); renderEditor(); renderScrub(); ctx.seek(v.startMs + 300); void draw(0); } },
        h('span', { class: 'mo-n' }, String(i + 1)), h('span', { class: 'mo-t' }, VISUAL_LABEL[v.type]), h('span', { class: 'mo-x' }, sceneTitle(v)),
        h('span', { class: 'mo-s' }, `${sec(v.startMs)}-${sec(v.endMs)}${stale ? ' · edited' : ''}`));
    }));
    if (!scenes().length) listBox.replaceChildren(h('div', { class: 'at-hint' }, 'No scenes yet. Tap Generate motion, or + Scene at playhead.'));
  }

  let timer = 0;
  const redraw = (patch: Partial<Visual>, now: boolean) => {
    const v = cur(); if (!v) return;
    Object.assign(v, patch);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void draw(t); ctx.changed(); renderList(); renderScrub(); if (now) renderEditor(); }, now ? 0 : 450);
  };

  function renderEditor() {
    const v = cur();
    if (!v) { editBox.replaceChildren(); return; }
    const field = (k: string, val: unknown): Node | null => {
      const set = (nv: unknown) => redraw({ data: { ...v.data, [k]: nv } }, false);
      if (typeof val === 'string') return h('label', { class: 'vis-f' }, h('span', {}, k), h('input', { type: 'text', value: val, oninput: (e: Event) => set((e.target as HTMLInputElement).value) }));
      if (typeof val === 'number') return h('label', { class: 'vis-f' }, h('span', {}, k), h('input', { type: 'number', value: String(val), oninput: (e: Event) => set(Number((e.target as HTMLInputElement).value) || 0) }));
      if (Array.isArray(val) && val.every(x => typeof x === 'number')) return h('label', { class: 'vis-f' }, h('span', {}, `${k} (comma)`), h('input', { type: 'text', value: val.join(', '), oninput: (e: Event) => set((e.target as HTMLInputElement).value.split(',').map(x => Number(x.trim())).filter(n => Number.isFinite(n))) }));
      if (Array.isArray(val)) return h('label', { class: 'vis-f' }, h('span', {}, `${k} (one per line)`), h('textarea', { rows: 3, value: val.join('\n'), oninput: (e: Event) => set((e.target as HTMLTextAreaElement).value.split('\n').filter(x => x.trim())) }));
      return null;
    };
    const sel = (label: string, ids: string[], now: string, on: (id: string) => void, names?: Record<string, string>) =>
      h('label', { class: 'vis-f' }, h('span', {}, label), h('select', { onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...ids.map(x => h('option', { value: x, selected: x === now }, names?.[x] ?? x))));
    const sentence = () => ctx.words().filter(w => w.e > v.startMs - 100 && w.s < v.endMs + 100).map(w => w.orig || w.w).join(' ').trim();
    const changeType = (ty: VisualType) => { const m = makeLocal({ id: v.id, startMs: v.startMs, endMs: v.endMs, type: ty, intent: '' }, sentence() || sceneTitle(v), v.themeId, 0, v.motion.in); redraw({ type: m.type, data: m.data }, true); };
    const redo = async () => {
      if (running || rendering) return;
      const order = VISUAL_TYPES.filter(x => x !== v.type), ty = order[(v.startMs / 1000 | 0) % order.length]!;
      const ctrl: RunCtrl = { stopped: false, paused: false }; running = ctrl; renderControls(); renderButtons();
      const chip = showChip(ctrl); chip.text('Scene 1/1');
      try {
        await generateScenes({
          words: ctx.words(), durationMs: ctx.durationMs(), themeId: v.themeId, mix: [], useAi: true, fromMs: 0, busy: [], full: !!v.full, ctrl,
          slots: [{ id: v.id, startMs: v.startMs, endMs: v.endMs, type: ty, intent: '' }],
          onScene: (nv) => { Object.assign(v, { type: nv.type, data: nv.data, motion: nv.motion }); },
          onProgress: () => { /* one scene */ },
        });
        ctx.changed();
      } finally { chip.dispose(); running = null; if (!disposed) { renderControls(); renderButtons(); renderList(); renderEditor(); void draw(t); } }
    };
    const restyle = () => { const i = VISUAL_THEMES.findIndex(x => x.id === v.themeId), nt = VISUAL_THEMES[(i + 1) % VISUAL_THEMES.length]!; redraw({ themeId: nt.id, motion: pickMotion(nt, i + 1, v.motion.in) }, true); };
    const del = async () => {
      if (running || rendering) return;
      stop(); const i = scenes().findIndex(x => x.id === v.id);
      await removeScenes(new Set([v.id])); selId = scenes()[Math.min(i, scenes().length - 1)]?.id ?? null; t = 0;
      syncPlaceholders(p); ctx.changed(); renderList(); renderEditor(); renderScrub(); void draw(0); renderButtons();
    };
    editBox.replaceChildren(h('div', { class: 'at-sec', style: 'margin-top:10px' },
      h('div', { style: 'display:flex;gap:8px' },
        h('button', { class: 'btn', style: 'flex:1;min-height:44px', disabled: running || rendering ? 'true' : undefined, onclick: () => void redo() }, 'Redo'),
        h('button', { class: 'btn', style: 'flex:1;min-height:44px', onclick: restyle }, 'Change style'),
        h('button', { class: 'btn', style: 'flex:1;min-height:44px;color:#ff6b6b', disabled: running || rendering ? 'true' : undefined, onclick: () => void del() }, 'Delete')),
      h('div', { class: 'schips', style: 'flex-wrap:nowrap;overflow-x:auto' }, ...VISUAL_TYPES.map(x => h('button', { class: 'chip' + (v.type === x ? ' on' : ''), onclick: () => { if (v.type !== x) changeType(x); } }, VISUAL_LABEL[x]))),
      ...(Object.entries(v.data).map(([k, val]) => field(k, val)).filter(Boolean) as Node[]),
      h('div', { class: 'schips', style: 'flex-wrap:nowrap;overflow-x:auto;margin-top:8px' }, ...VISUAL_THEMES.map(x => h('button', { class: 'chip' + (v.themeId === x.id ? ' on' : ''), onclick: () => { if (v.themeId !== x.id) redraw({ themeId: x.id, motion: pickMotion(x, 0, v.motion.in) }, true); } }, x.name))),
      sel('Text animation', TEXT_ANIMS as string[], v.motion.text ?? 'kinetic', id => redraw({ motion: { ...v.motion, text: id } }, true), TEXT_ANIM_LABEL as Record<string, string>),
      sel('Motion in', motionIds('entrance'), v.motion.in, id => redraw({ motion: { ...v.motion, in: id } }, true)),
      sel('Motion out', motionIds('exit'), v.motion.out, id => redraw({ motion: { ...v.motion, out: id } }, true))));
  }

  // ------------------------------------------------------------ assemble: plan controls first, then the monitor
  const el = h('div', { class: 'mo-pane' }, controls, monitor, btnRow, statusEl, listBox, editBox);
  setStatus('');
  void getTheme; // theme ids are validated by getTheme inside the engine
  renderControls(); renderButtons(); renderList(); renderEditor(); renderScrub(); void draw(0);

  return {
    el,
    dispose: () => {
      disposed = true; playing = false; cancelAnimationFrame(raf); window.clearTimeout(timer);
      if (running) running.stopped = true;
      if (rendering) rendering.stopped = true;
      canvas.width = canvas.height = 1; // release the pixels
      void sweepClips(p);
    },
  };
}
