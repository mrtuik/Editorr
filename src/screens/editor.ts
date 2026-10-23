import { app, type Intent } from '../app';
import { peaks, PEAKS_PER_SEC, SAMPLE_RATE } from '../core/audio';
import { startDenoise } from '../core/denoise';
import { detectSpeakers, lastMethod, lastSeparationDb, lastUsedLips, lastVoiceQuality } from '../core/speaker';
import { motionToActivity, scanMotion } from '../core/motion';
import { History, runtime, saveProject, saveSettings, type DenoiseCache, type Snapshot } from '../core/store';
import { detectSilence } from '../core/silence';
import { EditorrNative, fileSrc, isNative, tick } from '../core/native';
import { ensureAudio, nextPaint, runAutoSwitch, runSync } from '../core/pipeline';
import { ensureProxy, needsProxy } from '../core/proxy';
import { makeStrip, type Strip } from '../core/thumbs';
import { effectiveGain } from '../core/gain';
import { openExportSheet, resChipText } from './exportSheet';
import { endTask, minimizeAllDialogs, minimizeTask, onTasks, startTask, updateTask, type Task } from '../core/tasks';
import {
  coverage, defaultSegments, deleteSegment, dropSlivers, fitSegmentsToDuration, intersectRanges, isKept, keptMs, mergeWithPrev,
  moveBoundary, nextKeptStart, overlapDuration, segmentAt, splitAt, subtractRanges, updateSegment, type Range,
} from '../core/timeline';
import { Aspect, ASPECTS, aspectValue, Corner, CropRatio, CropState, LayoutStyle, NO_CROP, PopupSize, Role, Segment, segmentColor, SilenceSens, STYLE_LABEL } from '../core/types';
import { confirmDialog, fmtClock, h, ICON, icon, iconButton, spinner, toast } from '../ui';

type Panel = 'none' | 'ratio' | 'crop' | 'silence' | 'sync' | 'layout' | 'main' | 'audio';

// ---- timeline geometry (CSS px) ----
const G = 36;            // left column with the lane icons (like CapCut)
const RULER = 24;
const LANE = 54;         // video clip row (CapCut filmstrip height)
const AUD = 32;          // audio waveform row
const LAY = 28;          // layout row
const GAP = 4;
const HOST_Y = RULER + GAP;
const CONST_Y = HOST_Y + LANE + GAP;
const AUD_Y = CONST_Y + LANE + GAP;
const LAY_Y = AUD_Y + AUD + GAP;
const TL_H = LAY_Y + LAY + 8;
const CYAN = '#19e6c1';
const CROP_RATIOS: [CropRatio, string][] = [
  ['custom', 'Custom'], ['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '1:1'], ['4:3', '4:3'], ['2:3', '2:3'],
];
function cropRatioValue(ratio: CropRatio | undefined, base: number): number {
  if (!ratio || ratio === 'custom') return base;
  const [w, h] = ratio.split(':').map(Number);
  return h ? w / h : base;
}
function rotationCoverZoom(degrees: number, aspect: number): number {
  const rad = Math.abs(degrees) * Math.PI / 180;
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  return Math.max(c + s / aspect, c + s * aspect);
}

export function editorScreen() {
  const p = app.project;
  const hist = new History();
  let playMs = 0;
  let playing = false;
  let selectedId: string | null = null;
  let selClip: Role | null = null;
  let pxPerSec = 30;
  let raf = 0;
  let saveTimer = 0;
  let destroyed = false;
  let syncReady = p.segments.length > 0;
  let hasAudioError = false;

  if (!runtime.hostUrl || !runtime.constUrl || !p.host || !p.constant || runtime.projectId !== p.id) {
    // Video deleted or moved: black preview with a message, like CapCut.
    const noVideo = h('div', { class: 'missing' },
      h('div', { class: 'missing-ico' }, '\u{1F6AB}'),
      h('div', { class: 'missing-txt', style: 'font-size:17px;color:#fff' }, 'Video not found'),
      h('div', { class: 'missing-txt' }, 'The video or photo is deleted or moved on your device.'),
      h('div', { class: 'missing-txt' }, 'Add the videos again to keep editing.'));
    return { el: h('div', { class: 'screen' },
      h('div', { class: 'topbar' }, iconButton('close', 'Close', () => app.go('home'), 'plain')),
      h('div', { class: 'content', style: 'display:flex;flex-direction:column;align-items:center' },
        noVideo,
        h('button', { class: 'btn primary', style: 'margin-top:24px', onclick: () => app.go('import') }, 'Add videos again'))) };
  }
  const hostDur = p.host.durationMs, constDur = p.constant.durationMs;
  if (!p.durationMs) p.durationMs = overlapDuration(hostDur, constDur, p.offsetMs);

  // waveforms appear when the audio has been read (they are not saved with the project)
  let hostPeaks: Float32Array | undefined;
  let constPeaks: Float32Array | undefined;
  const audioReady = () => !!(runtime.hostPcm && runtime.constPcm);
  const sourcePcm = (role: Role) => role === 'host' ? runtime.hostPcm : runtime.constPcm;
  const noiseStrength = (role: Role) => role === 'host' ? p.noiseHost : p.noiseConst;
  function denoiseCache(role: Role, source: Float32Array, create = true): DenoiseCache | undefined {
    let cache = role === 'host' ? runtime.hostDenoiseCache : runtime.constDenoiseCache;
    if (cache?.source !== source) {
      if (!create) return undefined;
      cache = { source, values: new Map<number, Float32Array>() };
      if (role === 'host') runtime.hostDenoiseCache = cache; else runtime.constDenoiseCache = cache;
    }
    return cache;
  }
  function cleanedPcm(role: Role): Float32Array | undefined {
    const source = sourcePcm(role);
    if (!source || noiseStrength(role) <= 0) return source;
    return denoiseCache(role, source, false)?.values.get(noiseStrength(role)) ?? source;
  }
  function computePeaks() {
    const host = cleanedPcm('host'), constant = cleanedPcm('constant');
    if (host) hostPeaks = peaks(host, Math.ceil((host.length / SAMPLE_RATE) * PEAKS_PER_SEC));
    if (constant) constPeaks = peaks(constant, Math.ceil((constant.length / SAMPLE_RATE) * PEAKS_PER_SEC));
  }
  computePeaks();

  // ======================================================================= Preview
  // The WebView draws its own grey "play" picture on any video that has no poster or cannot load. A black poster replaces it.
  const BLACK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const hostV = h('video', { playsInline: true, preload: 'auto', poster: BLACK_POSTER, 'aria-label': 'Host video' }) as HTMLVideoElement;
  const constV = h('video', { playsInline: true, preload: 'auto', poster: BLACK_POSTER, 'aria-label': 'Constant video' }) as HTMLVideoElement;
  const hostMsg = h('div', { class: 'vmsg', style: 'display:none' }, 'Video not found');
  const constMsg = h('div', { class: 'vmsg', style: 'display:none' }, 'Video not found');
  hostV.muted = p.mainAudio !== 'host' || p.noiseHost > 0;
  constV.muted = p.mainAudio !== 'constant' || p.noiseConst > 0;
  const hostCell = h('div', { class: 'cell' }, hostV, hostMsg);
  const constCell = h('div', { class: 'cell' }, constV, constMsg);
  const stage = h('div', { class: 'stage' }, hostCell, constCell);
  const guideV = h('div', { class: 'guide v' });
  const guideH = h('div', { class: 'guide h' });
  const pillsEl = h('div', { class: 'pills' });
  const dialogHost = h('div', { class: 'taskdialog-wrap' });
  const hudTimeBadge = h('div', { class: 'hud-time-badge' }, `${fmtClock(playMs)} / ${fmtClock(p.durationMs)}`);
  const playRipple = h('div', { class: 'preview-play-ripple' }, icon('play', 28));
  const preview = h('div', { class: 'preview' }, stage, guideV, guideH, playRipple, pillsEl, dialogHost);

  function triggerPlayRipple(isPlaying: boolean) {
    playRipple.replaceChildren(icon(isPlaying ? 'play' : 'pause', 28));
    playRipple.classList.remove('animate');
    void playRipple.offsetWidth;
    playRipple.classList.add('animate');
  }

  // Selected video frame on preview with Reset button
  const selFrame = h('div', { class: 'sel-frame' });
  const resetCropBtn = h('button', {
    class: 'sel-reset-btn',
    'aria-label': 'Reset video crop',
    title: 'Reset crop',
    onclick: (ev: MouseEvent) => {
      ev.stopPropagation();
      if (selClip) resetCrop(selClip);
    },
  }, icon('undo', 12), h('span', {}, 'Reset'));
  selFrame.append(resetCropBtn);
  stage.append(selFrame);

  function resetCrop(role: Role) {
    hist.push(snap()); updateBtns();
    const c = role === 'host' ? p.cropHost : p.cropConst;
    c.zoom = 1;
    c.x = 0;
    c.y = 0;
    c.rotate = 0;
    c.ratio = 'custom';
    c.frameRatio = undefined;
    applyCrop(role);
    scheduleSave();
    if (panel === 'crop') { positionCropFrame(); renderPanel(); }
  }

  function updateSelFrame() {
    if (!selClip || panel === 'crop' || stage.classList.contains('full')) {
      selFrame.classList.remove('on');
      stage.style.touchAction = '';
      return;
    }
    const cell = selClip === 'host' ? hostCell : constCell;
    if (cell.style.display === 'none') {
      selFrame.classList.remove('on');
      stage.style.touchAction = '';
      return;
    }
    selFrame.style.left = cell.style.left;
    selFrame.style.top = cell.style.top;
    selFrame.style.width = cell.style.width;
    selFrame.style.height = cell.style.height;
    selFrame.style.zIndex = cell.classList.contains('pop') ? '6' : '3';
    selFrame.classList.add('on');
    stage.style.touchAction = 'none';
  }

  // Fixed responsive preview stage height (CapCut style)
  function applyPreviewHeight() {
    const screenH = window.innerHeight || 800;
    const hPx = Math.round(screenH * 0.40);
    preview.style.height = `${hPx}px`;
    preview.style.flex = 'none';
  }
  applyPreviewHeight();

  /** Fit the stage (project aspect ratio) inside the preview area, like a real editor. */
  function fitStage() {
    const full = stage.classList.contains('full');
    const cw = full ? window.innerWidth : preview.clientWidth;
    const ch = full ? window.innerHeight : preview.clientHeight;
    if (!cw || !ch) return;
    const ar = aspectValue(p.aspect);
    const w = Math.min(cw, ch * ar);
    stage.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor(w / ar)}px`;
    updateSelFrame();
  }
  const ro = new ResizeObserver(() => { applyPreviewHeight(); fitStage(); layoutCrop(); });
  ro.observe(preview);

  /** Crop = zoom + move inside the frame. Uniform scale, zero distortion. */
  function applyCrop(role: Role) {
    const c = role === 'host' ? p.cropHost : p.cropConst;
    const v = role === 'host' ? hostV : constV;
    const cell = v.parentElement;
    const aspect = cell && cell.clientWidth > 0 && cell.clientHeight > 0 ? cell.clientWidth / cell.clientHeight : aspectValue(p.aspect);
    const zoom = Math.max(0.2, Math.min(6.0, c.zoom || 1));
    const rotate = c.rotate ?? 0;
    const cover = rotationCoverZoom(rotate, aspect);
    const mirrored = role === 'host' ? p.mirrorHost : p.mirrorConst;
    const tx = zoom > 1 ? c.x * (zoom - 1) * 50 : c.x * 50;
    const ty = zoom > 1 ? c.y * (zoom - 1) * 50 : c.y * 50;
    v.style.transform = Math.abs(zoom - 1) < 0.001 && Math.abs(c.x) < 0.001 && Math.abs(c.y) < 0.001 && Math.abs(rotate) < 0.001 && !mirrored
      ? ''
      : `translate(${tx}%, ${ty}%) scale(${zoom}, ${zoom}) rotate(${rotate}deg) scale(${cover})${mirrored ? ' scaleX(-1)' : ''}`;
  }
  applyCrop('host'); applyCrop('constant');

  const POP: Record<PopupSize, number> = { S: 24, M: 32, L: 42 };
  function place(v: HTMLElement, x: number, y: number, w: number, hh: number, pop = false) {
    v.style.display = 'block';
    v.style.left = `${x}%`; v.style.top = `${y}%`; v.style.width = `${w}%`; v.style.height = `${hh}%`;
    v.style.zIndex = pop ? '2' : '1';
    v.classList.toggle('pop', pop);
  }
  function hide(v: HTMLElement) { v.style.display = 'none'; }

  function applyLayout(seg: Segment | undefined) {
    if (!seg) {
      place(hostCell, 0, 0, 100, 100); hide(constCell);
      applyCrop('host'); applyCrop('constant');
      return;
    } // nothing decided yet: show the Host
    const main = seg.main === 'host' ? hostCell : constCell;
    const other = seg.main === 'host' ? constCell : hostCell;
    if (seg.style === 'one') { place(main, 0, 0, 100, 100); hide(other); }
    else if (seg.style === 'side') { place(hostCell, 0, 0, 50, 100); place(constCell, 50, 0, 50, 100); }
    else if (seg.style === 'updown') { place(hostCell, 0, 0, 100, 50); place(constCell, 0, 50, 100, 50); }
    else {
      place(main, 0, 0, 100, 100);
      const w = POP[seg.size];
      const heightPct = w; // the small box has the same shape as the stage, so height% == width%
      const m = 3;
      const x = seg.corner === 'tl' || seg.corner === 'bl' ? m : 100 - w - m;
      const y = seg.corner === 'tl' || seg.corner === 'tr' ? m * 1.6 : 100 - heightPct - m * 1.6;
      place(other, x, y, w, heightPct, true);
    }
    applyCrop('host'); applyCrop('constant');
    updateSelFrame();
  }

  // ======================================================================= Preview gestures (move/zoom video inside frame)
  function hitRoleAt(x: number, y: number): Role | null {
    const seg = segmentAt(p.segments, playMs);
    const mainRole = seg?.main ?? 'host';
    const otherRole = mainRole === 'host' ? 'constant' : 'host';
    const mainCell = mainRole === 'host' ? hostCell : constCell;
    const otherCell = otherRole === 'host' ? hostCell : constCell;

    // Check popup cell first because it sits on top
    if (seg?.style === 'popup' && otherCell.style.display !== 'none') {
      const r = otherCell.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return otherRole;
      const mr = mainCell.getBoundingClientRect();
      if (x >= mr.left && x <= mr.right && y >= mr.top && y <= mr.bottom) return mainRole;
      return null;
    }
    if (seg?.style === 'side' || seg?.style === 'updown') {
      const hr = hostCell.getBoundingClientRect();
      if (x >= hr.left && x <= hr.right && y >= hr.top && y <= hr.bottom) return 'host';
      const cr = constCell.getBoundingClientRect();
      if (x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom) return 'constant';
      return null;
    }
    // single view ('one' or default)
    if (mainCell.style.display !== 'none') {
      const r = mainCell.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return mainRole;
    }
    return null;
  }

  const previewPtrs = new Map<number, { x: number; y: number }>();
  let previewDownX = 0, previewDownY = 0, previewDownT = 0;
  let previewMoved = false;
  let previewGestureRaf = 0;
  let gestureSnapshot: Snapshot | null = null;
  let gestureChanged = false;
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let startCropX = 0, startCropY = 0;
  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

  preview.addEventListener('pointerdown', (e: PointerEvent) => {
    if (panel === 'crop' || stage.classList.contains('full')) return;
    if ((e.target as HTMLElement)?.closest('.pill') || (e.target as HTMLElement)?.closest('.taskdialog') || (e.target as HTMLElement)?.closest('.sel-reset-btn')) return;

    preview.setPointerCapture(e.pointerId);
    previewPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    previewDownX = e.clientX;
    previewDownY = e.clientY;
    previewDownT = Date.now();
    previewMoved = false;

    if (previewPtrs.size === 1) {
      gestureSnapshot = snap();
      gestureChanged = false;
      const hitRole = hitRoleAt(e.clientX, e.clientY);
      if (hitRole) {
        if (selClip !== hitRole) {
          selClip = hitRole;
          selectedId = null;
          renderBar();
          draw();
          updateSelFrame();
        }
        const c = hitRole === 'host' ? p.cropHost : p.cropConst;
        startCropX = c.x;
        startCropY = c.y;
      }
    } else if (previewPtrs.size === 2 && selClip) {
      if (!gestureSnapshot) gestureSnapshot = snap();
      const [p1, p2] = [...previewPtrs.values()];
      pinchStartDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const c = selClip === 'host' ? p.cropHost : p.cropConst;
      pinchStartZoom = Math.max(0.2, c.zoom || 1);
    }
  });

  preview.addEventListener('pointermove', (e: PointerEvent) => {
    if (!previewPtrs.has(e.pointerId) || panel === 'crop' || stage.classList.contains('full')) return;
    previewPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dist = Math.hypot(e.clientX - previewDownX, e.clientY - previewDownY);
    if (dist > 6) previewMoved = true;
    if (!selClip) return;

    const cell = selClip === 'host' ? hostCell : constCell;
    const c = selClip === 'host' ? p.cropHost : p.cropConst;

    if (previewPtrs.size === 1 && previewMoved) {
      gestureChanged = true;
      const zoom = Math.max(0.2, Math.min(6.0, c.zoom || 1));
      const shiftRangeX = Math.max(cell.clientWidth / 2, (zoom - 1) * cell.clientWidth / 2);
      const shiftRangeY = Math.max(cell.clientHeight / 2, (zoom - 1) * cell.clientHeight / 2);
      const dx = e.clientX - previewDownX;
      const dy = e.clientY - previewDownY;
      if (shiftRangeX > 0) {
        c.x = Math.max(-2, Math.min(2, startCropX + dx / shiftRangeX));
      }
      if (shiftRangeY > 0) {
        c.y = Math.max(-2, Math.min(2, startCropY + dy / shiftRangeY));
      }
      if (!previewGestureRaf) {
        const roleToUpdate = selClip;
        previewGestureRaf = requestAnimationFrame(() => {
          previewGestureRaf = 0;
          applyCrop(roleToUpdate);
        });
      }
    } else if (previewPtrs.size === 2) {
      gestureChanged = true;
      const [p1, p2] = [...previewPtrs.values()];
      const currentDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const factor = currentDist / (pinchStartDist || 1);
      c.zoom = Math.max(0.2, Math.min(6.0, pinchStartZoom * factor));
      if (!previewGestureRaf) {
        const roleToUpdate = selClip;
        previewGestureRaf = requestAnimationFrame(() => {
          previewGestureRaf = 0;
          applyCrop(roleToUpdate);
        });
      }
    }
  });

  const onPreviewEnd = (e: PointerEvent) => {
    if (!previewPtrs.has(e.pointerId)) return;
    previewPtrs.delete(e.pointerId);
    if (preview.hasPointerCapture(e.pointerId)) preview.releasePointerCapture(e.pointerId);

    if (previewPtrs.size === 0) {
      if (previewGestureRaf) {
        cancelAnimationFrame(previewGestureRaf);
        previewGestureRaf = 0;
      }
      if (selClip) applyCrop(selClip);

      if (gestureChanged && gestureSnapshot) {
        hist.push(gestureSnapshot);
        updateBtns();
        scheduleSave();
      }
      gestureSnapshot = null;
      gestureChanged = false;
    }

    if (!previewMoved && Date.now() - previewDownT < 350 && previewPtrs.size === 0) {
      const hitRole = hitRoleAt(previewDownX, previewDownY);
      if (!hitRole) {
        selClip = null;
        selectedId = null;
        renderBar();
        draw();
        updateSelFrame();
      } else {
        const now = Date.now();
        if (now - lastTapTime < 300 && Math.hypot(previewDownX - lastTapX, previewDownY - lastTapY) < 25) {
          resetCrop(hitRole);
          lastTapTime = 0;
        } else {
          lastTapTime = now;
          lastTapX = previewDownX;
          lastTapY = previewDownY;
        }
      }
    }
  };
  preview.addEventListener('pointerup', onPreviewEnd);
  preview.addEventListener('pointercancel', onPreviewEnd);

  // ---------- video sources: original, or a small preview copy when the phone's format is heavy ----------
  const ready: Record<Role, boolean> = { host: false, constant: false };
  const failed: Record<Role, boolean> = { host: false, constant: false };
  const proxying: Record<Role, boolean> = { host: false, constant: false };
  const usingProxy: Record<Role, boolean> = { host: false, constant: false };
  const vid = (r: Role) => (r === 'host' ? hostV : constV);
  const curUrl: Record<Role, string> = { host: '', constant: '' };
  const posterSet: Record<Role, boolean> = { host: false, constant: false };
  /** Black cell with "Video not found" while a video cannot be shown; hides the moment it plays again. */
  function showMissing(role: Role, on: boolean) {
    (role === 'host' ? hostMsg : constMsg).style.display = on ? '' : 'none';
    const v = vid(role);
    if (on) { v.style.visibility = 'hidden'; } else { v.style.visibility = ''; }
  }
  function markFailed(role: Role) {
    failed[role] = true; ready[role] = true;
    showMissing(role, true);
    if (!destroyed) updatePlayState();
  }
  const label = (r: Role) => (r === 'host' ? 'Host' : 'Constant');

  function setSource(role: Role, url: string) {
    const v = vid(role);
    ready[role] = false;
    curUrl[role] = url;
    v.src = url;
    v.load();
    v.addEventListener('loadedmetadata', () => {
      ready[role] = true; failed[role] = false; showMissing(role, false);
      if (!destroyed) { seekVideo(v, role === 'host' ? playMs / 1000 : (playMs + p.offsetMs) / 1000); updatePlayState(); requestDraw(); }
    }, { once: true });
  }

  /** Make the small preview copy (shows a pill), then switch that video to it. Keeps the play position. */
  async function useProxy(role: Role, wasPlaying = false) {
    const path = role === 'host' ? runtime.hostPath : runtime.constPath;
    const meta = role === 'host' ? p.host : p.constant;
    if (!path || proxying[role]) return;
    proxying[role] = true;
    const id = `proxy-${role}`;
    startTask(id, `Optimizing ${label(role)} preview`, 0);
    try {
      const url = await ensureProxy(path, meta, (n) => updateTask(id, undefined, n));
      if (destroyed) return;
      usingProxy[role] = true;
      if (role === 'host') p.proxyHost = true; else p.proxyConst = true;
      scheduleSave();
      setSource(role, url);
      if (wasPlaying) vid(role).addEventListener('loadedmetadata', () => { if (!destroyed) setPlaying(true); }, { once: true });
    } catch (e) {
      markFailed(role); // do not block playing forever
      toast(`${label(role)} video: could not make a smooth preview. ${(e as Error).message || ''}`.trim());
    } finally {
      proxying[role] = false;
      endTask(id);
      if (!destroyed) updatePlayState();
    }
  }

  function startSource(role: Role) {
    const meta = role === 'host' ? p.host : p.constant;
    const flagged = role === 'host' ? p.proxyHost : p.proxyConst;
    const url = role === 'host' ? runtime.hostUrl! : runtime.constUrl!;
    const v = vid(role);
    v.addEventListener('error', () => {
      if (destroyed) return;
      if (isNative() && !usingProxy[role] && !proxying[role]) {
        // the WebView could not play it (or stopped halfway): pause cleanly, make a preview copy, carry on where we were
        const was = playing;
        if (playing) setPlaying(false);
        useProxy(role, was);
      } else if (!proxying[role] && !failed[role]) {
        markFailed(role);
        toast(`${label(role)} video cannot be played in the preview. Export may still work.`);
      }
    });
    const begin = () => {
      if (isNative() && (flagged || needsProxy(meta))) useProxy(role); // before playing: no stall in the middle of a video
      else setSource(role, url);
    };
    const path = role === 'host' ? runtime.hostPath : runtime.constPath;
    if (isNative() && path) {
      // file deleted or moved: show "Video not found" straight away instead of a broken picture
      EditorrNative.fileExists({ path }).then((r) => { if (destroyed) return; if (r.exists) begin(); else markFailed(role); }, () => { if (!destroyed) begin(); });
    } else begin();
  }

  /** The system can drop a video's decoder while the app is in the background (or the phone is busy). Load it again when we come back. */
  function reviveVideos() {
    if (destroyed) return;
    for (const role of ['host', 'constant'] as Role[]) {
      const v = vid(role);
      const lost = !!v.error || (ready[role] && !failed[role] && v.readyState === 0);
      if (!lost || proxying[role] || !curUrl[role]) continue;
      const t = v.currentTime || 0;
      setSource(role, curUrl[role]);
      v.addEventListener('loadedmetadata', () => { if (!destroyed) { try { v.currentTime = t; } catch { /* ignore */ } } }, { once: true });
    }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') reviveVideos(); };
  document.addEventListener('visibilitychange', onVisible);

  // ---------- seeking (never queue seeks: only the latest one counts) ----------
  // ---------- seeking (never queue seeks: only the latest one counts, fastSeek when available) ----------
  const pendingSeek = new Map<HTMLVideoElement, number>();
  function seekVideo(v: HTMLVideoElement, t: number) {
    if (!isFinite(t) || t < 0) return;
    const dur = isFinite(v.duration) ? v.duration : Infinity;
    t = Math.min(t, Math.max(0, dur - 0.05));
    if (v.readyState < 1) return; // metadata not there yet; loadedmetadata seeks again
    if (Math.abs(v.currentTime - t) < 0.025) return;
    if (v.seeking) { pendingSeek.set(v, t); return; }
    try {
      if (typeof (v as any).fastSeek === 'function') {
        (v as any).fastSeek(t);
      } else {
        v.currentTime = t;
      }
    } catch {
      try { v.currentTime = t; } catch { /* ignore */ }
    }
  }
  for (const v of [hostV, constV]) {
    v.addEventListener('seeked', () => {
      const t = pendingSeek.get(v);
      if (t === undefined) return;
      pendingSeek.delete(v);
      if (Math.abs(v.currentTime - t) < 0.025) return;
      try {
        if (typeof (v as any).fastSeek === 'function') {
          (v as any).fastSeek(t);
        } else {
          v.currentTime = t;
        }
      } catch {
        try { v.currentTime = t; } catch { /* ignore */ }
      }
    });
  }

  // Smooth seek-lock / RAF debouncer during timeline scrubbing (CapCut 60fps responsiveness)
  let scrubPendingMs: number | null = null;
  let scrubRafId = 0;
  function executeScrub() {
    if (scrubPendingMs === null) return;
    const target = scrubPendingMs;
    scrubPendingMs = null;
    playMs = target;
    syncHost(false);
    syncConst(false);
  }
  function scheduleScrub(ms: number) {
    playMs = Math.max(0, Math.min(p.durationMs, ms));
    scrubPendingMs = playMs;
    refresh();
    if (!scrubRafId) {
      scrubRafId = requestAnimationFrame(() => {
        scrubRafId = 0;
        executeScrub();
      });
    }
  }

  let lastConstSeek = 0;
  /** Keep the Constant video on its sync position with Master-Slave Virtual Clock (playbackRate micro-adjustments). */
  function syncConst(force = false) {
    const ct = (playMs + p.offsetMs) / 1000;
    const inRange = ct >= 0 && ct < (isFinite(constV.duration) ? constV.duration : Infinity);
    constV.style.visibility = inRange ? '' : 'hidden';
    if (!inRange) {
      if (!constV.paused) constV.pause();
      constV.playbackRate = 1.0;
      if (ct < 0 && Math.abs(constV.currentTime) > 0.03) seekVideo(constV, 0);
      return;
    }
    const drift = constV.currentTime - ct; // positive = ahead, negative = behind
    const absDrift = Math.abs(drift);

    if (force || !playing) {
      constV.playbackRate = 1.0;
      if (force || absDrift > 0.033) {
        seekVideo(constV, ct);
      }
    } else {
      // While playing: Master-Slave virtual clock micro-adjustments without hard seeks
      if (absDrift >= 1.2) {
        // Severe drift (>1.2s): hard seek throttled to at most once per 1.2 seconds
        const now = performance.now();
        if (now - lastConstSeek > 1200) {
          lastConstSeek = now;
          seekVideo(constV, ct);
        }
      } else if (absDrift > 0.03) {
        // Micro-adjust playback rate to gently resync within ±30ms
        if (drift < -0.3) constV.playbackRate = 1.10;
        else if (drift < -0.05) constV.playbackRate = 1.05;
        else if (drift > 0.3) constV.playbackRate = 0.90;
        else if (drift > 0.05) constV.playbackRate = 0.95;
      } else {
        if (constV.playbackRate !== 1.0) constV.playbackRate = 1.0;
      }
    }
    if (playing && constV.paused && ready.constant && inRange) constV.play().catch(() => {});
  }
  function syncHost(force = false) {
    const t = playMs / 1000;
    const inRange = t >= 0 && t < (isFinite(hostV.duration) ? hostV.duration : Infinity);
    hostV.style.visibility = inRange ? '' : 'hidden';
    if (!inRange) {
      if (!hostV.paused) hostV.pause();
      hostV.playbackRate = 1.0;
      if (t < 0 && Math.abs(hostV.currentTime) > 0.03) seekVideo(hostV, 0);
      return;
    }
    if (force || Math.abs(hostV.currentTime - t) > 0.033) seekVideo(hostV, t);
  }

  const firstStart = () => (p.segments.length ? Math.min(...p.segments.map((s) => s.startMs)) : 0);
  const lastEnd = () => (p.segments.length ? Math.max(...p.segments.map((s) => s.endMs)) : p.durationMs);

  function playReason(): string | null {
    if (!syncReady) return 'Still syncing the two videos...';
    if (!ready.host || (!ready.constant && !failed.constant)) {
      return proxying.host || proxying.constant ? 'Still preparing the preview...' : 'The videos are still loading...';
    }
    return null;
  }

  // ----- volume: Web Audio gain (HTML video.volume stops at 100 %) + soft limiter -----
  let actx: AudioContext | null = null;
  const gainNodes: Partial<Record<Role, GainNode>> = {};
  const mediaSources = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>();
  let cleanSource: AudioBufferSourceNode | null = null;
  const audioBuffers = new WeakMap<Float32Array, AudioBuffer>();

  // Ensure AudioContext is resumed on the first user interaction
  const unlockAudio = () => {
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('click', unlockAudio, { passive: true });

  function updateVideoAudioMute() {
    hostV.muted = p.mainAudio !== 'host' || (!!actx && p.noiseHost > 0);
    constV.muted = p.mainAudio !== 'constant' || (!!actx && p.noiseConst > 0);
  }
  function ensureGraph(): boolean {
    if (actx) return true;
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new AC();
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -12; lim.knee.value = 6; lim.ratio.value = 4; lim.attack.value = 0.01; lim.release.value = 0.25;
      lim.connect(ctx.destination);
      (['host', 'constant'] as Role[]).forEach((r) => {
        const v = vid(r);
        const g = ctx.createGain();
        let src = mediaSources.get(v);
        if (!src) {
          src = ctx.createMediaElementSource(v);
          mediaSources.set(v, src);
        }
        try { src.connect(g); } catch { /* ignore if connected */ }
        g.connect(lim);
        gainNodes[r] = g;
      });
      actx = ctx;
      return true;
    } catch { return false; }
  }
  /** Push the current volumes (and normalize) to the preview. Only builds the audio graph once a gain other than 100 % is needed. */
  function applyVolume() {
    const roles: Role[] = ['host', 'constant'];
    const denoiseOn = p.noiseHost > 0 || p.noiseConst > 0;
    if (!actx && !denoiseOn && roles.every((r) => Math.abs(effectiveGain(p, r) - 1) < 0.01)) { updateVideoAudioMute(); return; }
    if (!ensureGraph()) {
      roles.forEach((r) => { vid(r).volume = Math.min(1, effectiveGain(p, r)); });
      hostV.muted = p.mainAudio !== 'host';
      constV.muted = p.mainAudio !== 'constant';
      return;
    }
    roles.forEach((r) => { if (gainNodes[r]) gainNodes[r]!.gain.value = effectiveGain(p, r); });
    updateVideoAudioMute();
    if (actx!.state === 'suspended') actx!.resume().catch(() => {});
  }

  function stopCleanAudio() {
    const source = cleanSource;
    cleanSource = null;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
    try { source.disconnect(); } catch { /* already disconnected */ }
  }
  function startCleanAudio() {
    stopCleanAudio();
    if (!playing) return;
    const role = p.mainAudio;
    const raw = sourcePcm(role), pcm = cleanedPcm(role);
    if (noiseStrength(role) <= 0 || !raw || !pcm || pcm === raw) return;
    if (!ensureGraph() || !actx || !gainNodes[role]) return;
    let buffer = audioBuffers.get(pcm);
    if (!buffer) {
      buffer = actx.createBuffer(1, pcm.length, SAMPLE_RATE);
      buffer.getChannelData(0).set(pcm);
      audioBuffers.set(pcm, buffer);
    }
    const source = actx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNodes[role]!);
    const sourceMs = playMs + (role === 'constant' ? p.offsetMs : 0);
    const delay = Math.max(0, -sourceMs) / 1000;
    const offset = Math.max(0, sourceMs) / 1000;
    const remaining = Math.max(0, p.durationMs - playMs) / 1000 - delay;
    const duration = Math.min(buffer.duration - offset, remaining);
    if (duration <= 0) { source.disconnect(); return; }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    cleanSource = source;
    source.onended = () => {
      if (cleanSource === source) cleanSource = null;
      try { source.disconnect(); } catch { /* already disconnected */ }
    };
    source.start(actx.currentTime + delay, offset, duration);
  }

  function setPlaying(on: boolean) {
    if (on && actx && actx.state === 'suspended') actx.resume().catch(() => {});
    if (on && playReason()) { toast(playReason()!); on = false; }
    playing = on;
    triggerPlayRipple(on);
    if (on) {
      if (playMs >= lastEnd() - 50) playMs = firstStart();
      if (!isKept(p.segments, playMs) && p.segments.length) { const nx = nextKeptStart(p.segments, playMs); if (nx !== null) playMs = nx; }
      syncHost(true); syncConst(true);
      hostV.play().then(() => {
        if (!playing) return;
        playMs = hostV.currentTime * 1000;
        syncConst(true);
        startCleanAudio();
      }).catch(() => {});
    } else { stopCleanAudio(); hostV.pause(); constV.pause(); }
    updatePlayState();
  }

  function seek(ms: number) {
    playMs = Math.max(0, Math.min(p.durationMs, ms));
    syncHost(true); syncConst(true);
    refresh();
  }

  // ---------- pills over the preview (like CapCut's "Applying 2 features") ----------
  let offTasks: () => void = () => {};

  /** Small picture for the Home screen. */
  function captureThumb() {
    try {
      if (!hostV.videoWidth) return;
      const c = document.createElement('canvas'); c.width = 240; c.height = 240;
      const g = c.getContext('2d')!;
      const s = Math.min(hostV.videoWidth, hostV.videoHeight);
      g.drawImage(hostV, (hostV.videoWidth - s) / 2, (hostV.videoHeight - s) / 2, s, s, 0, 0, 240, 240);
      p.thumb = c.toDataURL('image/jpeg', 0.6);
      scheduleSave();
    } catch { /* thumbnail is optional */ }
  }
  if (!p.thumb) hostV.addEventListener('loadeddata', () => window.setTimeout(captureThumb, 500), { once: true });

  // ======================================================================= Timeline canvas
  const canvas = h('canvas') as HTMLCanvasElement;
  const tl = h('div', { class: 'timeline' }, canvas);
  tl.style.height = `${TL_H}px`;
  let W = 0, H = 0;
  let pendingCuts: Range[] = [];
  let snapMs: number | null = null; // cyan guide while a clip snaps

  let hostStrip: Strip | undefined, constStrip: Strip | undefined;
  let drawQueued = false;
  function requestDraw() { if (drawQueued || destroyed) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); }

  const xOf = (ms: number) => W / 2 + ((ms - playMs) / 1000) * pxPerSec;
  const msOf = (x: number) => playMs + ((x - W / 2) / pxPerSec) * 1000;
  const minPx = () => Math.max(0.4, ((W || 360) * 0.9) / Math.max(1, p.durationMs / 1000));

  function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
    g.beginPath(); g.roundRect(x, y, Math.max(1, w), hh, r);
  }

  /** One video clip row: thumbnails ONLY, no waveform or darkening. Clamped to [0 .. p.durationMs]. */
  function drawVideoRow(g: CanvasRenderingContext2D, role: Role, y: number, durMs: number, strip: Strip | undefined, offsetMs: number) {
    const bx1 = xOf(0), bx2 = xOf(p.durationMs);
    if (bx2 < G || bx1 > W) return;
    const bw = bx2 - bx1;

    g.save();
    rrect(g, bx1, y, bw, LANE, 3);
    g.clip();

    // Plain dark strip background (shows through where there is no video content)
    g.fillStyle = role === 'host' ? '#181818' : '#141d17';
    g.fillRect(bx1, y, bw, LANE);

    // Picture strip (content slides inside the fixed block based on offsetMs)
    if (strip) {
      const x1 = xOf(-offsetMs);
      const x2 = x1 + (durMs / 1000) * pxPerSec;
      const vx1 = Math.max(bx1, G, x1);
      const vx2 = Math.min(bx2, W, x2);
      if (vx2 > vx1) {
        const tw = Math.max(16, Math.round(LANE * strip.aspect));
        const k0 = Math.max(0, Math.floor((vx1 - x1) / tw));
        const k1 = Math.floor((vx2 - x1) / tw);
        for (let k = k0; k <= k1; k++) {
          const tMs = ((k + 0.5) * tw / pxPerSec) * 1000;
          if (tMs < 0 || tMs >= durMs) continue;
          const idx = Math.max(0, Math.min(strip.count - 1, Math.floor((tMs / durMs) * strip.count)));
          const img = strip.frames[idx] ?? strip.frames.find((f) => !!f);
          if (img) {
            g.globalAlpha = strip.frames[idx] ? 1 : 0.45;
            g.drawImage(img, x1 + k * tw, y, tw, LANE);
            g.globalAlpha = 1;
          }
        }
      }
    }

    // Small label pill in the top-left corner
    const label = `${role === 'host' ? 'Host' : 'Constant'}  ${fmtClock(durMs)}`;
    g.font = '600 9px Roboto, sans-serif';
    g.textBaseline = 'middle';
    const lw = g.measureText(label).width;
    const tx = Math.max(bx1, G) + 4;
    if (tx + lw + 22 < bx2) {
      rrect(g, tx, y + 3, lw + 20, 14, 3);
      g.fillStyle = role === 'host' ? 'rgba(0,0,0,0.65)' : 'rgba(10,30,16,0.75)';
      g.fill();
      if (role === 'constant') {
        g.strokeStyle = 'rgba(74,222,128,0.45)';
        g.lineWidth = 0.8;
        g.stroke();
      }
      if (role === 'host') {
        micGlyph(g, tx + 7.5, y + 10, '#ffffff');
      } else {
        cameraGlyph(g, tx + 7.5, y + 10, '#4ade80');
      }
      g.fillStyle = role === 'host' ? '#ffffff' : '#4ade80';
      g.fillText(label, tx + 16, y + 10);
    }

    g.restore();

    // Outer border
    if (selClip === role) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      rrect(g, bx1 + 1, y + 1, bw - 2, LANE - 2, 3);
      g.stroke();
    } else {
      g.strokeStyle = role === 'host' ? 'rgba(255,255,255,0.16)' : 'rgba(74,222,128,0.32)';
      g.lineWidth = 1;
      rrect(g, bx1 + 0.5, y + 0.5, bw - 1, LANE - 1, 3);
      g.stroke();
    }
  }

  /** Single audio waveform row for the selected sound (p.mainAudio). Centered mirrored bars. */
  function drawAudioRow(g: CanvasRenderingContext2D) {
    const bx1 = xOf(0), bx2 = xOf(p.durationMs);
    if (bx2 < G || bx1 > W) return;
    const bw = bx2 - bx1;

    g.save();
    rrect(g, bx1, AUD_Y, bw, AUD, 3);
    g.clip();

    g.fillStyle = '#141414';
    g.fillRect(bx1, AUD_Y, bw, AUD);

    const isHost = p.mainAudio === 'host';
    const arr = isHost ? hostPeaks : constPeaks;
    const offset = isHost ? 0 : p.offsetMs;
    const durMs = isHost ? hostDur : constDur;
    const color = isHost ? '#ffffff' : '#4ade80';

    if (arr) {
      g.fillStyle = color;
      const cy = AUD_Y + AUD / 2;
      const maxBh = (AUD - 6) / 2;
      const vx1 = Math.max(bx1, G);
      const vx2 = Math.min(bx2, W);
      for (let x = Math.floor(vx1); x < vx2; x += 2) {
        const ms = msOf(x);
        if (ms < 0 || ms > p.durationMs) continue;
        const localMs = ms + offset;
        if (localMs < 0 || localMs >= durMs) continue;
        const peakIdx = Math.round((localMs / 1000) * PEAKS_PER_SEC);
        const v = arr[peakIdx];
        if (v === undefined || v <= 0) continue;
        const bh = Math.max(1, Math.min(maxBh, v * maxBh));
        g.fillRect(x, cy - bh, 1.5, bh * 2);
      }
    }

    g.restore();

    g.strokeStyle = p.mainAudio === 'constant' ? 'rgba(74,222,128,0.25)' : 'rgba(255,255,255,0.16)';
    g.lineWidth = 1;
    rrect(g, bx1 + 0.5, AUD_Y + 0.5, bw - 1, AUD - 1, 3);
    g.stroke();
  }

  function drawGlyph(g: CanvasRenderingContext2D, s: Segment, cx: number, cy: number) {
    g.save(); g.translate(cx, cy); g.scale(0.52, 0.52); cx = 0; cy = 0;
    g.fillStyle = '#000000'; g.strokeStyle = '#000000'; g.lineWidth = 2;
    if (s.style === 'one') {
      g.beginPath(); g.arc(cx, cy - 4, 4, 0, 6.3); g.fill();
      g.beginPath(); g.arc(cx, cy + 10, 8, Math.PI, 0); g.fill();
    } else if (s.style === 'side') { g.fillRect(cx - 9, cy - 6, 8, 12); g.fillRect(cx + 1, cy - 6, 8, 12); }
    else if (s.style === 'updown') { g.fillRect(cx - 8, cy - 9, 16, 8); g.fillRect(cx - 8, cy + 1, 16, 8); }
    else { g.strokeRect(cx - 9, cy - 6, 18, 12); g.fillRect(cx + 1, cy + 1, 7, 4); }
    g.restore();
  }

  let actSrc: [Float32Array | undefined, Float32Array | undefined] = [undefined, undefined];
  let actH: Float32Array | undefined, actC: Float32Array | undefined;
  function drawMotion(g: CanvasRenderingContext2D) {
    if (!runtime.hostMotion || !runtime.constMotion) return;
    if (actSrc[0] !== runtime.hostMotion || actSrc[1] !== runtime.constMotion) {
      actSrc = [runtime.hostMotion, runtime.constMotion];
      actH = motionToActivity(runtime.hostMotion); actC = motionToActivity(runtime.constMotion);
    }
    const bars = (arr: Float32Array, y: number, offsetMs: number) => {
      g.fillStyle = 'rgba(245,158,11,.9)';
      const maxBh = 5;
      const bx1 = Math.max(G, xOf(0)), bx2 = Math.min(W, xOf(p.durationMs));
      for (let x = Math.floor(bx1); x < bx2; x += 3) {
        const ms = msOf(x); if (ms < 0 || ms > p.durationMs) continue;
        const local = ms + offsetMs; if (local < 0) continue;
        const v = Math.max(0, Math.min(1.5, arr[Math.round(local / 100)] ?? 0)) / 1.5;
        const bh = v * maxBh; if (bh > 0.5) g.fillRect(x, y + LANE - 2 - bh, 2, bh);
      }
    };
    bars(actH!, HOST_Y, 0); bars(actC!, CONST_Y, p.offsetMs);
  }

  const micGlyph = (g: CanvasRenderingContext2D, cx: number, cy: number, color: string) => {
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.3;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    rrect(g, cx - 3, cy - 7, 6, 8.5, 3);
    g.fill();
    g.beginPath();
    g.arc(cx, cy - 2.5, 5.2, 0.1 * Math.PI, 0.9 * Math.PI);
    g.stroke();
    g.beginPath();
    g.moveTo(cx, cy + 2.7);
    g.lineTo(cx, cy + 6);
    g.moveTo(cx - 3.5, cy + 6);
    g.lineTo(cx + 3.5, cy + 6);
    g.stroke();
    g.restore();
  };
  const cameraGlyph = (g: CanvasRenderingContext2D, cx: number, cy: number, color: string) => {
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.3;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    rrect(g, cx - 6.5, cy - 4.5, 8.5, 9, 2);
    g.fill();
    g.beginPath();
    g.moveTo(cx + 2.8, cy - 2);
    g.lineTo(cx + 6.8, cy - 4.2);
    g.lineTo(cx + 6.8, cy + 4.2);
    g.lineTo(cx + 2.8, cy + 2);
    g.closePath();
    g.fill();
    g.restore();
  };
  const speakerGlyph = (g: CanvasRenderingContext2D, cx: number, cy: number, color: string) => {
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = 1.4; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - 4.5, cy - 2.5); g.lineTo(cx - 2, cy - 2.5); g.lineTo(cx + 1, cy - 5); g.lineTo(cx + 1, cy + 5); g.lineTo(cx - 2, cy + 2.5); g.lineTo(cx - 4.5, cy + 2.5);
    g.closePath(); g.fill();
    g.beginPath(); g.arc(cx + 1, cy, 3.5, -0.85, 0.85); g.stroke();
    g.beginPath(); g.arc(cx + 1, cy, 6, -0.85, 0.85); g.stroke();
  };

  const stepFor = () => [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].find((s) => s * pxPerSec >= 72) ?? 3600;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = tl.clientWidth, ch = tl.clientHeight;
    if (!cw || !ch) return;
    if (W !== cw || H !== ch || canvas.width !== Math.round(cw * dpr)) { W = cw; H = ch; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // ---- ruler: 00:00 • 00:01 • (labels with a dot half way)
    const step = stepFor();
    const startS = Math.max(0, Math.floor(msOf(G) / 1000 / step) * step - step);
    g.font = '9px Roboto, sans-serif'; g.textBaseline = 'middle';
    for (let s = startS; s * 1000 <= Math.min(p.durationMs + step * 1000, msOf(W)); s += step) {
      const x = xOf(s * 1000);
      g.fillStyle = '#8a8a8a'; g.fillText(fmtClock(s * 1000), x + 3, RULER / 2);
      g.fillRect(x, RULER - 5, 1, 5);
      const mx = x + (step * pxPerSec) / 2;
      g.beginPath(); g.arc(mx, RULER / 2, 1.4, 0, 6.3); g.fill();
    }

    // ---- video and audio rows (all clipped to 0 .. p.durationMs)
    drawVideoRow(g, 'host', HOST_Y, hostDur, hostStrip, 0);
    drawVideoRow(g, 'constant', CONST_Y, constDur, constStrip, p.offsetMs);
    drawAudioRow(g);
    drawMotion(g);

    // ---- layout lane
    const lbx1 = xOf(0), lbx2 = xOf(p.durationMs);
    const lbw = lbx2 - lbx1;
    if (lbx2 >= G && lbx1 <= W) {
      g.save();
      rrect(g, lbx1, LAY_Y, lbw, LAY, 3);
      g.clip();
      g.fillStyle = '#0d0d0d';
      g.fillRect(lbx1, LAY_Y, lbw, LAY);
      {
        const kept = coverage(p.segments);
        const holes: Range[] = [];
        let at = 0;
        for (const r of kept) { if (r.startMs > at) holes.push({ startMs: at, endMs: r.startMs }); at = r.endMs; }
        if (kept.length && at < p.durationMs) holes.push({ startMs: at, endMs: p.durationMs });
        for (const r of holes) {
          const x1 = Math.max(G, xOf(r.startMs)), x2 = Math.min(W, xOf(r.endMs));
          if (x2 - x1 < 2) continue;
          g.save(); g.beginPath(); g.rect(x1, LAY_Y, x2 - x1, LAY); g.clip();
          g.strokeStyle = '#3a3a3a'; g.lineWidth = 1;
          for (let k = x1 - LAY; k < x2; k += 6) { g.beginPath(); g.moveTo(k, LAY_Y + LAY); g.lineTo(k + LAY, LAY_Y); g.stroke(); }
          g.restore();
        }
      }
      for (const s of p.segments) {
        const x1 = xOf(s.startMs), x2 = xOf(s.endMs);
        if (x2 < G || x1 > W) continue;
        g.fillStyle = segmentColor(s);
        rrect(g, x1 + 0.5, LAY_Y + 1, x2 - x1 - 1, LAY - 2, 3); g.fill();
        if (s.id === selectedId) {
          g.strokeStyle = '#FFFFFF'; g.lineWidth = 2;
          rrect(g, x1 + 1, LAY_Y + 1, x2 - x1 - 2, LAY - 2, 3); g.stroke();
          // CapCut style active clip selection pill handles
          const hw = Math.min(10, Math.max(6, (x2 - x1) / 4));
          g.fillStyle = '#FFFFFF';
          rrect(g, x1, LAY_Y + 1, hw, LAY - 2, 2); g.fill();
          rrect(g, x2 - hw, LAY_Y + 1, hw, LAY - 2, 2); g.fill();
          g.fillStyle = '#000000';
          g.fillRect(x1 + hw / 2 - 0.75, LAY_Y + 6, 1.5, LAY - 14);
          g.fillRect(x2 - hw / 2 - 0.75, LAY_Y + 6, 1.5, LAY - 14);
        }
        if (x2 - x1 > 24) drawGlyph(g, s, Math.max(x1, G) + 14, LAY_Y + LAY / 2);
      }
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,.16)';
      g.lineWidth = 1;
      rrect(g, lbx1 + 0.5, LAY_Y + 0.5, lbw - 1, LAY - 1, 3);
      g.stroke();
    }

    // silence found but not cut yet
    if (pendingCuts.length) {
      g.fillStyle = 'rgba(239,68,68,.38)';
      for (const r of pendingCuts) {
        const x1 = Math.max(G, xOf(r.startMs)), x2 = Math.min(W, xOf(r.endMs));
        if (x2 > x1) g.fillRect(x1, HOST_Y, x2 - x1, LAY_Y + LAY - HOST_Y);
      }
    }

    // sync snap guide
    if (snapMs !== null) {
      const sx = xOf(snapMs);
      g.fillStyle = CYAN; g.fillRect(sx - 0.75, HOST_Y - 2, 1.5, CONST_Y + LANE - HOST_Y + 4);
    }

    // ---- left column (lane icons), drawn over the clips
    g.fillStyle = '#000'; g.fillRect(0, RULER, G, H - RULER);
    g.fillStyle = '#262626'; g.fillRect(G - 1, RULER, 1, H - RULER);
    const audioHost = p.mainAudio === 'host';
    micGlyph(g, G / 2, HOST_Y + LANE / 2, '#ffffff');
    cameraGlyph(g, G / 2, CONST_Y + LANE / 2, '#4ade80');
    speakerGlyph(g, G / 2, AUD_Y + AUD / 2, audioHost ? '#ffffff' : '#4ade80');
    const lx = G / 2, ly = LAY_Y + LAY / 2;
    g.strokeStyle = '#d6d6d6'; g.lineWidth = 1.4;
    g.strokeRect(lx - 6, ly - 6, 5, 5); g.strokeRect(lx + 1, ly - 6, 5, 5);
    g.strokeRect(lx - 6, ly + 1, 5, 5); g.strokeRect(lx + 1, ly + 1, 5, 5);

    // ---- time (top left, like CapCut): 00:34 / 10:22
    const cur = fmtClock(playMs), tot = ` / ${fmtClock(p.durationMs)}`;
    const kept = keptMs(p.segments);
    const note = p.segments.length && p.durationMs - kept > 500 ? `  (${fmtClock(kept)} kept)` : '';
    g.font = '10px Roboto, sans-serif';
    const wCur = g.measureText(cur).width, wTot = g.measureText(tot).width, wNote = g.measureText(note).width;
    g.fillStyle = '#000'; g.fillRect(0, 0, 10 + wCur + wTot + wNote, RULER);
    g.textBaseline = 'middle';
    g.fillStyle = '#fff'; g.fillText(cur, 6, RULER / 2);
    g.fillStyle = '#8a8a8a'; g.fillText(tot + note, 6 + wCur, RULER / 2);

    // ---- playhead needle (fixed at the center, CapCut style with top triangle and cyan snap glow)
    const phX = Math.round(W / 2);
    if (snapMs !== null) {
      g.save();
      g.shadowColor = CYAN;
      g.shadowBlur = 8;
      g.fillStyle = CYAN;
      g.fillRect(phX - 1.5, 0, 3, H);
      g.restore();
    } else {
      g.fillStyle = '#FFFFFF';
      g.fillRect(phX - 1, 0, 2, H);
    }
    // CapCut playhead needle top triangle indicator
    g.fillStyle = snapMs !== null ? CYAN : '#FFFFFF';
    g.beginPath();
    g.moveTo(phX - 6, 0);
    g.lineTo(phX + 6, 0);
    g.lineTo(phX, 10);
    g.closePath();
    g.fill();
  }

  // ======================================================================= Gestures
  type Ptr = { x: number; y: number };
  const ptrs = new Map<number, Ptr>();
  let mode: 'none' | 'scrub' | 'boundary' | 'pinch' | 'clip' = 'none';
  let startX = 0, startY = 0, startT = 0, moved = false, boundaryIdx = -1, pinchDist = 0, pinchZoom = 0, lpTimer = 0;
  let clipStartMs0 = 0, clipPushed = false, clipBefore: Snapshot | null = null;

  let lastClientY = 0;
  const localX = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;
  const localY = (e: PointerEvent) => e.clientY - canvas.getBoundingClientRect().top;
  type Lane = 'ruler' | 'host' | 'const' | 'audio' | 'lay' | 'none';
  function laneAt(y: number): Lane {
    if (y < RULER) return 'ruler';
    if (y < HOST_Y + LANE + GAP / 2) return 'host';
    if (y < CONST_Y + LANE + GAP / 2) return 'const';
    if (y < AUD_Y + AUD + GAP / 2) return 'audio';
    if (y < LAY_Y + LAY + 6) return 'lay';
    return 'none';
  }
  function hitSegment(x: number): Segment | undefined {
    const ms = msOf(x);
    return p.segments.find((s) => ms >= s.startMs && ms < s.endMs);
  }
  function hitBoundary(x: number, y: number): number {
    if (y < LAY_Y - 8 || y > LAY_Y + LAY + 8) return -1;
    for (let i = 0; i < p.segments.length - 1; i++) {
      if (Math.abs(p.segments[i].endMs - p.segments[i + 1].startMs) > 1) continue; // cut part between them
      if (Math.abs(xOf(p.segments[i].endMs) - x) < 16) return i;
    }
    return -1;
  }

  tl.addEventListener('pointerdown', (e) => {
    tl.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: localX(e), y: localY(e) });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y); pinchZoom = pxPerSec; mode = 'pinch';
      clearTimeout(lpTimer); return;
    }
    if (playing) setPlaying(false);
    startX = localX(e); startY = localY(e); startT = Date.now(); moved = false; lastClientY = e.clientY;
    const lane = laneAt(startY);
    const bi = startX >= G ? hitBoundary(startX, startY) : -1;
    if (bi >= 0) { mode = 'boundary'; boundaryIdx = bi; hist.push(snap()); }
    else if (lane === 'const' && selClip === 'constant' && startX >= G) {
      // the green clip is selected: dragging it moves it (that is how you sync by hand)
      mode = 'clip'; clipStartMs0 = -p.offsetMs; clipPushed = false; clipBefore = structuredClone(snap());
    }
    else mode = 'scrub';
    clearTimeout(lpTimer);
    lpTimer = window.setTimeout(() => {
      if (moved || mode !== 'scrub' || laneAt(startY) !== 'lay' || startX < G) return;
      const s = hitSegment(startX);
      if (s) { selectSeg(s.id); tick(); }
    }, 550);
  });

  tl.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const x = localX(e);
    const prev = ptrs.get(e.pointerId)!;
    ptrs.set(e.pointerId, { x, y: localY(e) });
    if (mode === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      pxPerSec = Math.max(minPx(), Math.min(300, pinchZoom * (d / (pinchDist || 1))));
      draw(); return;
    }
    if (Math.abs(x - startX) > 8) { moved = true; clearTimeout(lpTimer); }
    if (mode === 'scrub') {
      const targetMs = Math.max(0, Math.min(p.durationMs, playMs - ((x - prev.x) / pxPerSec) * 1000));
      scheduleScrub(targetMs);
      if (tlWrap.scrollHeight > tlWrap.clientHeight) {
        tlWrap.scrollTop -= (e.clientY - lastClientY);
      }
      lastClientY = e.clientY;
    } else if (mode === 'boundary') {
      p.segments = moveBoundary(p.segments, boundaryIdx, msOf(x));
      applyLayout(segmentAt(p.segments, playMs));
      draw();
    } else if (mode === 'clip' && moved) {
      if (!clipPushed) { clipPushed = true; hist.push(clipBefore!); }
      let start = clipStartMs0 + ((x - startX) / pxPerSec) * 1000;
      // snap: Constant start = Host start, = playhead, or both videos end together
      const thr = (8 / pxPerSec) * 1000;
      snapMs = null;
      for (const c of [0, playMs, hostDur - constDur]) {
        if (Math.abs(c - start) <= thr) { if (snapMs !== c) tick(); start = c; snapMs = c; break; }
      }
      p.offsetMs = Math.round(-start);
      syncConst(true);
      draw();
      renderPanelSoft();
    }
  });

  const end = (e: PointerEvent) => {
    ptrs.delete(e.pointerId);
    clearTimeout(lpTimer);
    if (ptrs.size === 1 && mode === 'pinch') { mode = 'none'; return; }
    if (ptrs.size > 0) return;
    if (mode === 'scrub' && !moved && Date.now() - startT < 400) onTap(startX, startY);
    if (mode === 'boundary') scheduleSave();
    if (mode === 'clip') {
      snapMs = null;
      if (clipPushed) commitOffset(clipBefore!.durationMs);
      draw();
    }
    mode = 'none';
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);

  function onTap(x: number, y: number) {
    const lane = laneAt(y);
    if (x < G) {
      // left column: tap the speaker icon in the audio row to toggle sound
      if (lane === 'audio') {
        setAudio(p.mainAudio === 'host' ? 'constant' : 'host');
      } else if (lane === 'host') {
        setAudio('host');
      } else if (lane === 'const') {
        setAudio('constant');
      }
      return;
    }
    if (lane === 'lay' || lane === 'ruler' || lane === 'audio' || lane === 'none') {
      const s = lane === 'lay' ? hitSegment(x) : undefined;
      if (s) { if (panel !== 'none') closePanel(); selectSeg(s.id); tick(); }
      else if (lane !== 'ruler') { selClip = null; selectedId = null; renderBar(); draw(); updateSelFrame(); }
      return;
    }
    // a video clip: tap selects it and switches sound; tapping the green clip opens Sync
    const bx1 = xOf(0), bx2 = xOf(p.durationMs);
    if (x >= bx1 && x <= bx2) {
      if (lane === 'const') {
        selClip = 'constant';
        selectedId = null;
        setAudio('constant');
        tick();
        openPanel('sync');
        updateSelFrame();
        return;
      }
      if (lane === 'host') {
        if (panel !== 'none') closePanel();
        selClip = 'host';
        selectedId = null;
        setAudio('host');
        renderBar();
        draw();
        tick();
        updateSelFrame();
        return;
      }
    }
    selClip = null; renderBar(); draw(); updateSelFrame();
  }

  // ======================================================================= Controls (CapCut layout)
  const playBtn = h('button', { class: 'playbtn', 'aria-label': 'Play', onclick: () => setPlaying(!playing) }) as HTMLButtonElement;
  const undoBtn = iconButton('undo', 'Undo', () => { const r = hist.undo(snap()); if (r) restore(r); });
  const redoBtn = iconButton('redo', 'Redo', () => { const r = hist.redo(snap()); if (r) restore(r); });
  const fsBtn = iconButton('full', 'Full screen preview', () => {
    stage.classList.toggle('full');
    fitStage();
    if (stage.classList.contains('full')) {
      stage.addEventListener('click', exitFull, { once: true });
      (screen.orientation as any)?.lock?.('landscape').catch(() => {});
    }
  });
  function exitFull() { stage.classList.remove('full'); fitStage(); (screen.orientation as any)?.unlock?.(); }

  function updatePlayState() {
    const busy = !!playReason();
    playBtn.classList.toggle('wait', busy && !playing);
    playBtn.replaceChildren(busy && !playing ? spinner(18) : icon(playing ? 'pause' : 'play', 20));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  const controls = h('div', { class: 'edcontrols' },
    h('div', { class: 'left' }, fsBtn, hudTimeBadge),
    h('div', { class: 'center' }, playBtn),
    h('div', { class: 'right' }, undoBtn, redoBtn));

  // ---------- history ----------
  const snap = (): Snapshot => ({
    segments: p.segments, offsetMs: p.offsetMs, durationMs: p.durationMs,
    cropHost: p.cropHost, cropConst: p.cropConst, mirrorHost: p.mirrorHost, mirrorConst: p.mirrorConst,
    noiseHost: p.noiseHost, noiseConst: p.noiseConst,
  });
  function restore(s: Snapshot) {
    p.segments = s.segments; p.offsetMs = s.offsetMs; p.durationMs = s.durationMs;
    p.cropHost = s.cropHost; p.cropConst = s.cropConst;
    p.mirrorHost = s.mirrorHost; p.mirrorConst = s.mirrorConst;
    p.noiseHost = s.noiseHost; p.noiseConst = s.noiseConst;
    playMs = Math.min(playMs, p.durationMs);
    applyCrop('host'); applyCrop('constant');
    applyVolume(); computePeaks();
    if (playing && !hostV.seeking) startCleanAudio();
    void restoreNoiseCaches(p.noiseHost, p.noiseConst);
    syncHost(true); syncConst(true);
    afterEdit();
    if (panel === 'crop') { drawCropCanvas(); positionCropFrame(); renderPanel(); }
    if (panel === 'audio') renderPanel();
  }
  function toggleMirror(role: Role) {
    hist.push(snap()); updateBtns();
    if (role === 'host') p.mirrorHost = !p.mirrorHost; else p.mirrorConst = !p.mirrorConst;
    applyCrop(role);
    if (panel === 'crop' && cropRole === role) { drawCropCanvas(); positionCropFrame(); renderPanel(); }
    scheduleSave();
  }
  function toggleMirrorForScreen() {
    const role = segmentAt(p.segments, playMs)?.main ?? 'host';
    toggleMirror(role);
  }
  function edit(next: Segment[]) { hist.push(snap()); p.segments = next; afterEdit(); }
  function afterEdit() {
    applyLayout(segmentAt(p.segments, playMs));
    if (!selected()) selectedId = selClip ? null : segmentAt(p.segments, playMs)?.id ?? null;
    renderBar(); refresh(); updateBtns(); scheduleSave();
    if (panel === 'sync') renderPanel();
  }
  function updateBtns() { undoBtn.disabled = !hist.canUndo; redoBtn.disabled = !hist.canRedo; }

  /** The offset changed (drag, nudge, auto sync): the edit gets longer or shorter, so the segments follow. */
  function commitOffset(oldDuration: number) {
    const nd = overlapDuration(hostDur, constDur, p.offsetMs);
    p.segments = fitSegmentsToDuration(p.segments, oldDuration, nd);
    p.durationMs = nd;
    playMs = Math.min(playMs, nd);
    if (!selected() && !selClip) selectedId = segmentAt(p.segments, playMs)?.id ?? null;
    syncConst(true);
    updateBtns(); scheduleSave(); refresh();
    if (panel === 'sync') renderPanel();
  }

  // ======================================================================= Bottom toolbar (icon + label)
  const toolbar = h('div', { class: 'toolbar' });
  function tool(name: keyof typeof ICON, text: string, run: () => void, o: { sel?: boolean; cls?: string; ring?: string; disabled?: boolean } = {}) {
    const b = h('button', { class: 'tool' + (o.sel ? ' sel' : '') + (o.cls ? ' ' + o.cls : ''), 'aria-label': text, disabled: !!o.disabled, onclick: run },
      icon(name, 22), h('span', {}, text));
    if (o.ring) b.append(h('i', { class: 'ring', style: `background:${o.ring}` }));
    return b;
  }
  const sepEl = () => h('div', { class: 'sep' });
  const backTool = () => h('button', { class: 'tool back', 'aria-label': 'Back', onclick: () => { selectedId = null; selClip = null; renderBar(); draw(); updateSelFrame(); tick(); } }, icon('back', 20));
  /** The segment the layout tools act on: the selected one, else the one under the playhead. */
  const target = (): Segment | undefined => selected() ?? segmentAt(p.segments, playMs);

  function selected(): Segment | undefined { return p.segments.find((s) => s.id === selectedId); }
  function selectSeg(id: string) { selectedId = id; selClip = null; renderBar(); draw(); updateSelFrame(); }

  function setStyle(st: LayoutStyle) {
    const s = target();
    if (!s) return;
    edit(updateSegment(p.segments, s.id, { style: st })); if (panel !== 'none') renderPanel(); tick();
  }
  function patch(pt: Partial<Segment>) { const s = target(); if (s) { edit(updateSegment(p.segments, s.id, pt)); if (panel !== 'none') renderPanel(); } }

  const needAudio = (): boolean => {
    if (audioReady()) return true;
    toast(hasAudioError ? 'This video has no readable audio, so this tool is off.' : 'Still reading the audio. Try again in a moment.');
    return false;
  };

  let denoiseCancel: (() => void) | null = null;
  let denoiseRun = 0;
  function cancelDenoiseJob() {
    if (!denoiseCancel) return;
    denoiseCancel();
    denoiseCancel = null;
    endTask('denoise');
  }
  type NoiseOptions = { history?: boolean; persist?: boolean; resetOnFailure?: boolean };
  function commitNoise(role: Role, strength: number, options: NoiseOptions = {}) {
    const key = role === 'host' ? 'noiseHost' : 'noiseConst';
    if (p[key] !== strength && options.history !== false) { hist.push(snap()); updateBtns(); }
    p[key] = strength;
    applyVolume();
    computePeaks();
    draw();
    if (playing) startCleanAudio();
    if (options.persist !== false) scheduleSave();
  }
  async function applyNoiseReduction(role: Role, requested: number, options: NoiseOptions = {}) {
    const strength = Math.max(0, Math.min(100, Math.round(requested)));
    const source = sourcePcm(role);
    if (!source) {
      if (options.resetOnFailure) {
        commitNoise(role, 0, { history: false, persist: true });
      } else toast('Audio is still being read. Try again in a moment.');
      return;
    }

    const cache = denoiseCache(role, source);
    if (strength === 0 || cache?.values.has(strength)) {
      denoiseRun++;
      cancelDenoiseJob();
      commitNoise(role, strength, options);
      if (panel === 'audio') renderPanel();
      return;
    }

    const runId = ++denoiseRun;
    cancelDenoiseJob();
    const job = startDenoise(source, strength, (percent) => updateTask('denoise', undefined, percent));
    denoiseCancel = job.cancel;
    startTask('denoise', 'Reducing noise', 0, { modal: true, cancel: () => job.cancel() });
    try {
      const cleaned = await job.promise;
      if (runId !== denoiseRun || source !== sourcePcm(role)) return;
      const currentCache = denoiseCache(role, source)!;
      currentCache.values.set(strength, cleaned);
      while (currentCache.values.size > 3) {
        const oldest = currentCache.values.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        currentCache.values.delete(oldest);
      }
      commitNoise(role, strength, options);
    } catch (error) {
      if (runId === denoiseRun) {
        const cancelled = error instanceof Error && error.message.includes('cancel');
        if (options.resetOnFailure) commitNoise(role, 0, { history: false, persist: true });
        else if (!cancelled) toast(error instanceof Error ? error.message : 'Noise reduction failed.');
      }
    } finally {
      if (runId === denoiseRun) {
        denoiseCancel = null;
        endTask('denoise');
        if (panel === 'audio') renderPanel();
      }
    }
  }
  async function restoreNoiseCaches(hostStrength: number, constStrength: number) {
    if (noiseStrength('host') === hostStrength && hostStrength > 0
        && sourcePcm('host') && cleanedPcm('host') === sourcePcm('host')) {
      await applyNoiseReduction('host', hostStrength, { history: false, persist: false });
    }
    if (noiseStrength('constant') === constStrength && constStrength > 0
        && sourcePcm('constant') && cleanedPcm('constant') === sourcePcm('constant')) {
      await applyNoiseReduction('constant', constStrength, { history: false, persist: false });
    }
  }

  function doAutoSwitch(useLips: boolean) {
    if (!needAudio()) return;
    const motion = useLips && runtime.hostMotion && runtime.constMotion ? { host: runtime.hostMotion, constant: runtime.constMotion } : undefined;
    const keep = coverage(p.segments); // parts removed by silence cut stay removed
    let segs = detectSpeakers(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs, app.settings, p.mainAudio, motion);
    const clipped = keep.length ? intersectRanges(segs, keep) : segs;
    if (clipped.length) segs = clipped;
    edit(segs); selectedId = segs[0]?.id ?? null; afterEdit();
    if (segs.length <= 1) toast('Could not tell the two people apart. Try the lips scan or cut by hand.');
    else if (lastUsedLips) toast(`Auto switch with lips + voice: ${segs.length} segments. Undo to go back.`);
    else if (lastMethod === 'voice') toast(`Auto switch by voice: ${segs.length} segments (quality ${lastVoiceQuality.toFixed(1)}). Wrong way round? Tap swap.`);
    else toast(`Auto switch by mic loudness: ${segs.length} segments (${lastSeparationDb.toFixed(1)} dB). Undo to go back.`);
  }

  let scanning = false, scanCancel = false;
  async function doSmartSwitch() {
    if (scanning || !needAudio()) return;
    if (!runtime.hostMotion || !runtime.constMotion) {
      scanning = true; scanCancel = false;
      setPlaying(false);
      startTask('lips', 'Scanning lips', 0, { modal: true, cancel: () => { scanCancel = true; } });
      try {
        const dur = p.durationMs;
        const a = await scanMotion(hostV.currentSrc || hostV.src, 0, dur, (x) => updateTask('lips', undefined, x / 2), () => scanCancel);
        const b = a ? await scanMotion(constV.currentSrc || constV.src, p.offsetMs, dur, (x) => updateTask('lips', undefined, 50 + x / 2), () => scanCancel) : null;
        if (a && b) { runtime.hostMotion = a; runtime.constMotion = b; }
      } catch { /* fall through */ }
      endTask('lips'); scanning = false;
      if (!runtime.hostMotion || !runtime.constMotion) {
        if (scanCancel) { toast('Scan cancelled'); return; }
        toast('Could not read the video frames for the lips scan. Using voice only.');
        doAutoSwitch(false); return;
      }
      draw();
    }
    doAutoSwitch(true);
  }

  function doSwap() { edit(p.segments.map((s) => ({ ...s, main: (s.main === 'host' ? 'constant' : 'host') as Role }))); }
  function doSplit() { edit(splitAt(p.segments, playMs)); selectedId = segmentAt(p.segments, playMs)?.id ?? null; tick(); }
  function doMerge() { const s = selected(); if (s) { edit(mergeWithPrev(p.segments, s.id)); selectedId = null; afterEdit(); } else toast('Tap a segment in the bottom row first.'); }
  async function doDelete() {
    const s = selected();
    if (!s) { toast('Tap a segment in the bottom row first.'); return; }
    if (p.segments.length <= 1) { toast('Cannot delete the only segment.'); return; }
    if (await confirmDialog('Delete segment?', 'The neighbouring segment will fill the gap.')) { edit(deleteSegment(p.segments, s.id)); selectedId = null; afterEdit(); }
  }

  function setAudio(role: Role) {
    p.mainAudio = role;
    updateVideoAudioMute();
    if (playing) startCleanAudio();
    renderBar(); draw(); scheduleSave(); tick();
  }

  function renderBar() {
    const rows: Node[] = [];
    const hasClipSel = !!selClip;
    const hasSegSel = !!selected();
    if (!hasClipSel && !hasSegSel) {
      // nothing selected: the main tools, like CapCut's first row
      rows.push(
        tool('sync', 'Sync', () => { selClip = 'constant'; selectedId = null; openPanel('sync'); updateSelFrame(); }),
        tool('wand', 'Auto switch', () => doAutoSwitch(false)),
        tool('lips', 'Lips scan', doSmartSwitch),
        tool('silence', 'Silence', () => openPanel('silence')),
        tool('layout', 'Layout', () => openPanel('layout')),
        tool('user', 'On screen', () => openPanel('main')),
        tool('volume', 'Audio', () => openPanel('audio')),
        tool('crop', 'Crop', () => openPanel('crop')),
        tool('mirror', 'Mirror', toggleMirrorForScreen),
        tool('ratio', 'Ratio', () => openPanel('ratio')),
        tool('zoomOut', 'Zoom out', () => { pxPerSec = Math.max(minPx(), pxPerSec / 1.5); draw(); }),
        tool('zoomIn', 'Zoom in', () => { pxPerSec = Math.min(300, pxPerSec * 1.5); draw(); }),
      );
    } else if (hasClipSel) {
      // a video clip is selected: clip tools with back chevron and reset crop
      rows.push(backTool(),
        tool('undo', 'Reset crop', () => { if (selClip) resetCrop(selClip); }),
        tool('crop', 'Crop', () => { cropRole = selClip!; openPanel('crop'); }),
        tool('mirror', 'Mirror', () => { if (selClip) toggleMirror(selClip); }),
        tool('volume', 'Audio', () => openPanel('audio')));
      if (selClip === 'constant') rows.push(tool('sync', 'Sync', () => openPanel('sync')));
    } else {
      // a segment is selected: the bar swaps to segment tools with a back chevron (CapCut)
      rows.push(backTool(),
        tool('scissors', 'Split', doSplit),
        tool('layout', 'Layout', () => openPanel('layout')),
        tool('user', 'On screen', () => openPanel('main')),
        tool('volume', 'Audio', () => openPanel('audio')),
        tool('crop', 'Crop', () => openPanel('crop')),
        tool('mirror', 'Mirror', toggleMirrorForScreen),
        tool('merge', 'Merge', doMerge),
        tool('trash', 'Delete', doDelete),
        tool('swap', 'Swap', doSwap));
    }
    toolbar.replaceChildren(...rows);
    toolbar.scrollLeft = 0;
  }

  // ======================================================================= Panels: sync, ratio, crop, silence
  let panel: Panel = 'none';
  let cropRole: Role = 'host';
  const panelEl = h('div', { class: 'panel', style: 'display:none' });

  function openPanel(n: Panel) {
    if (n === 'none') return closePanel();
    if (playing) setPlaying(false);
    panel = n;
    pendingCuts = [];
    if (n !== 'sync') selClip = null;
    if (n === 'crop') cropRole = segmentAt(p.segments, playMs)?.main ?? 'host';
    if (n === 'silence') { if (!needAudio()) { panel = 'none'; return; } runDetect(); }
    cropView.classList.toggle('on', n === 'crop');
    updateSelFrame();
    const topOffset = preview.offsetTop + preview.offsetHeight;
    panelEl.style.top = `${topOffset}px`;
    panelEl.style.display = 'flex';
    toolbar.style.display = 'none';
    renderPanel(); draw(); tick();
    if (n === 'crop') requestAnimationFrame(layoutCrop);
  }
  function closePanel() {
    panel = 'none'; pendingCuts = []; snapMs = null;
    if (selClip === 'constant') selClip = null;
    cropView.classList.remove('on'); guideV.classList.remove('on'); guideH.classList.remove('on');
    panelEl.style.display = 'none';
    toolbar.style.display = '';
    updateSelFrame();
    renderPanel(); renderBar(); draw();
  }

  /** CapCut footer: cancel on left, centered title, check on the right. */
  const pFoot = (title: string) => h('div', { class: 'pfoot' },
    h('button', { class: 'pcancel', 'aria-label': 'Cancel', title: 'Cancel', onclick: closePanel }, icon('close', 20)),
    h('div', { class: 'ptitle' }, title),
    h('button', { class: 'pcheck', 'aria-label': 'Done', title: 'Done', onclick: closePanel }, icon('check', 24)));
  const pHandle = () => h('div', { class: 'panel-drag-handle' });
  const setPanel = (title: string, ...body: Node[]) => panelEl.replaceChildren(pHandle(), h('div', { class: 'pbody' }, ...body), pFoot(title));
  /** CapCut tile: rounded square with an icon, label under it. Selected = white outline. */
  const ptile = (inner: Node, label: string, run: () => void, o: { sel?: boolean; disabled?: boolean } = {}) =>
    h('button', { class: 'ptile' + (o.sel ? ' sel' : ''), disabled: !!o.disabled, 'aria-label': label, onclick: run },
      h('span', { class: 'pbox' }, inner), h('span', { class: 'plab' }, label));
  const pstrip = (...tiles: Node[]) => h('div', { class: 'pstrip' }, ...tiles);

  const secText = (ms: number) => (ms >= 60000 ? fmtClock(ms) : `${(ms / 1000).toFixed(1)} s`);

  function chipRow<T extends string | number>(opts: [T, string][], cur: T, on: (v: T) => void): HTMLElement {
    return h('div', { class: 'chips' }, ...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => on(v) }, l)));
  }

  function runDetect() {
    const s = app.settings;
    pendingCuts = detectSilence(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs,
      { minMs: s.silenceMinMs, padMs: s.silencePadMs, sens: s.silenceSens }, coverage(p.segments));
  }

  function applySilence() {
    if (!pendingCuts.length) return;
    const removed = pendingCuts.reduce((a, r) => a + (r.endMs - r.startMs), 0);
    const count = pendingCuts.length;
    const next = dropSlivers(subtractRanges(p.segments, pendingCuts));
    if (!next.length) { toast('That would remove everything. Pick a longer silence time.'); return; }
    pendingCuts = [];
    edit(next);
    if (!isKept(p.segments, playMs)) seek(nextKeptStart(p.segments, playMs) ?? firstStart());
    runDetect();
    toast(`Removed ${secText(removed)} of silence (${count} ${count === 1 ? 'cut' : 'cuts'}). New length ${secText(keptMs(p.segments))}. Undo to go back.`, 3600);
    renderPanel(); draw();
  }

  function slider(lbl: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void, disabled = false) {
    const val = h('div', { class: 'pval' }, fmt(value));
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), disabled, 'aria-label': lbl }) as HTMLInputElement;
    input.addEventListener('input', () => { const v = parseFloat(input.value); val.textContent = fmt(v); on(v); });
    return { row: h('div', { class: 'prow' }, h('div', { class: 'plabel' }, lbl), input, val), input };
  }

  // ----- sync panel -----
  const shiftText = () => { const s = -p.offsetMs; return `${s >= 0 ? '+' : '-'}${(Math.abs(s) / 1000).toFixed(3)} s`; };
  let syncNote = p.syncConfidence ? `${p.syncConfidence} confidence` : '';
  let syncNoteCls = p.syncConfidence ?? '';

  /** Move the green clip by d ms (+ = later / to the right). Undoable. */
  function nudge(d: number) {
    hist.push(snap());
    const old = p.durationMs;
    p.offsetMs -= d;
    syncNote = 'Manual'; syncNoteCls = 'Manual';
    commitOffset(old);
    updateBtns();
  }

  async function doAutoSync() {
    if (!needAudio()) return;
    hist.push(snap());
    const old = p.durationMs;
    startTask('sync', 'Syncing audio', 0, { modal: true });
    await nextPaint();
    const r = runSync(p);
    endTask('sync');
    p.segments = fitSegmentsToDuration(p.segments, old, p.durationMs);
    syncNote = `${r.confidence} confidence`; syncNoteCls = r.confidence;
    commitOffset(old); updateBtns();
    toast(r.confidence === 'Low' ? 'Low confidence. Drag the green clip or use the buttons until the waves line up.' : `Synced (${r.confidence} confidence).`);
  }

  /** While dragging the clip only the numbers change (rebuilding the panel would eat the touch). */
  function renderPanelSoft() {
    const el = panelEl.querySelector('.shiftval');
    if (el) el.textContent = shiftText();
  }

  function noiseControl(role: Role): HTMLElement {
    const label = role === 'host' ? 'Host mic' : 'Constant mic';
    const input = h('input', {
      type: 'range', min: 0, max: 100, step: 1, value: noiseStrength(role),
      'aria-label': `${label} noise reduction`,
    }) as HTMLInputElement;
    const value = h('span', { class: 'noise-value' }, `${noiseStrength(role)}%`);
    input.disabled = !sourcePcm(role);
    input.addEventListener('input', () => { value.textContent = `${input.value}%`; });
    input.addEventListener('change', () => { void applyNoiseReduction(role, Number(input.value)); });
    return h('div', { class: 'noise-control' },
      h('div', { class: 'noise-head' }, h('span', {}, `${label} noise reduction`), value),
      input);
  }

  function renderPanel() {
    toolbar.style.display = panel === 'none' ? '' : 'none';
    panelEl.style.display = panel === 'none' ? 'none' : 'flex';
    if (panel === 'none') return;
    const topOffset = preview.offsetTop + preview.offsetHeight;
    if (topOffset) panelEl.style.top = `${topOffset}px`;
    const s = app.settings;
    const seg = target();

    if (panel === 'sync') {
      const nudges: [number, string][] = [[-1000, '-1s'], [-100, '-100ms'], [-10, '-10ms'], [10, '+10ms'], [100, '+100ms'], [1000, '+1s']];
      setPanel('Sync',
        h('div', { class: 'prow' },
          h('div', { class: 'plabel' }, 'Green clip'),
          h('b', { class: 'shiftval' }, shiftText()),
          syncNote ? h('span', { class: `badge ${syncNoteCls}` }, syncNote) : null,
          h('div', { class: 'grow' }),
          h('button', { class: 'chip', onclick: doAutoSync, disabled: !audioReady() }, icon('sync', 16), 'Auto sync')),
        h('div', { class: 'chips nudges2' }, ...nudges.map(([d, l]) => h('button', { class: 'chip', onclick: () => nudge(d) }, l))),
        h('div', { class: 'pinfo' }, 'Drag the green clip on the timeline until its waves line up with the white ones. + moves it later.'));
    } else if (panel === 'ratio') {
      const tiles = (Object.keys(ASPECTS) as Aspect[]).map((a) => {
        const [aw, ah] = ASPECTS[a]; const k = 20 / Math.max(aw, ah);
        return ptile(h('i', { class: 'rbox', style: `width:${Math.round(aw * k)}px;height:${Math.round(ah * k)}px` }), a,
          () => { p.aspect = a; fitStage(); applyLayout(segmentAt(p.segments, playMs)); scheduleSave(); renderPanel(); tick(); }, { sel: p.aspect === a });
      });
      setPanel('Ratio', pstrip(...tiles));
    } else if (panel === 'layout') {
      const tiles: Node[] = (['one', 'side', 'updown', 'popup'] as LayoutStyle[]).map((st) => ptile(icon(st, 26), STYLE_LABEL[st], () => setStyle(st), { sel: seg?.style === st, disabled: !seg }));
      if (seg?.style === 'popup') {
        tiles.push(h('div', { class: 'psep' }));
        (['tl', 'tr', 'bl', 'br'] as Corner[]).forEach((c) => tiles.push(ptile(icon(({ tl: 'cTL', tr: 'cTR', bl: 'cBL', br: 'cBR' } as const)[c], 26), ({ tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' })[c], () => patch({ corner: c }), { sel: seg.corner === c })));
        tiles.push(h('div', { class: 'psep' }));
        (['S', 'M', 'L'] as PopupSize[]).forEach((z) => tiles.push(ptile(icon(({ S: 'sizeS', M: 'sizeM', L: 'sizeL' } as const)[z], 26), `Size ${z}`, () => patch({ size: z }), { sel: seg.size === z })));
      }
      setPanel('Layout', pstrip(...tiles));
    } else if (panel === 'main') {
      const lock = !seg || seg.style === 'side' || seg.style === 'updown';
      setPanel('On screen', pstrip(
        ptile(icon('user', 26), 'Host', () => patch({ main: 'host' as Role }), { sel: seg?.main === 'host', disabled: lock }),
        ptile(icon('user', 26), 'Constant', () => patch({ main: 'constant' as Role }), { sel: seg?.main === 'constant', disabled: lock }),
        ptile(icon('swap', 26), 'Swap all', () => { doSwap(); renderPanel(); })));
    } else if (panel === 'audio') {
      const vkey = p.mainAudio === 'host' ? 'volumeHost' : 'volumeConst';
      const vol = p[vkey];
      const setVol = (v: number) => { p[vkey] = v; applyVolume(); scheduleSave(); };
      const vs = slider('Master volume', 0, 1000, 5, vol, (v) => `${Math.round(v)}%`, setVol);
      setPanel('Audio Settings',
        h('div', { style: 'font-size:12px;color:#8a8a8a;margin-bottom:6px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px' }, 'Audio Source'),
        pstrip(
          ptile(icon('volume', 26), 'Host mic', () => { setAudio('host'); renderPanel(); }, { sel: p.mainAudio === 'host' }),
          ptile(icon('volume', 26), 'Constant mic', () => { setAudio('constant'); renderPanel(); }, { sel: p.mainAudio === 'constant' })),
        h('div', { style: 'margin:12px 0 6px;font-size:12px;color:#8a8a8a;font-weight:500;text-transform:uppercase;letter-spacing:0.5px' }, 'Volume & Gain'),
        vs.row,
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Quick boost'),
          chipRow<number>([[100, '100%'], [200, '200%'], [400, '400%'], [700, '700%'], [1000, '1000%']], vol, (v) => { setVol(v); renderPanel(); })),
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Normalize'),
          chipRow<string>([['off', 'Off'], ['on', 'On']], p.normalize ? 'on' : 'off', (v) => { p.normalize = v === 'on'; applyVolume(); scheduleSave(); renderPanel(); })),
        h('div', { style: 'margin:14px 0 6px;font-size:12px;color:#8a8a8a;font-weight:500;text-transform:uppercase;letter-spacing:0.5px' }, 'Noise Reduction'),
        noiseControl('host'),
        noiseControl('constant'));
    } else if (panel === 'crop') {
      const c: CropState = cropRole === 'host' ? p.cropHost : p.cropConst;
      const reset = h('button', { class: 'chip crop-reset', onclick: () => {
        if (c.zoom === 1 && c.x === 0 && c.y === 0 && (c.rotate ?? 0) === 0
          && (c.ratio ?? 'custom') === 'custom' && (!c.frameRatio || Math.abs(c.frameRatio - cropViewAspect()) < 0.001)) return;
        hist.push(snap()); updateBtns();
        Object.assign(c, NO_CROP); delete c.frameRatio;
        applyCrop(cropRole); drawCropCanvas(); positionCropFrame(); scheduleSave(); renderPanel();
      } }, icon('trash', 16), 'Reset');
      const mirrorEnabled = cropRole === 'host' ? p.mirrorHost : p.mirrorConst;
      const mirrorChip = h('button', {
        class: 'chip crop-mirror' + (mirrorEnabled ? ' on' : ''),
        'aria-label': `${mirrorEnabled ? 'Unmirror' : 'Mirror'} ${cropRole === 'host' ? 'Host' : 'Constant'}`,
        onclick: () => toggleMirror(cropRole),
      }, icon('mirror', 16), 'Mirror');
      const rotateValue = h('b', { class: 'crop-rotate-value' }, `${Math.round(c.rotate ?? 0)}°`);
      const rotateInput = h('input', { class: 'crop-rotate-input', type: 'range', min: '-45', max: '45', step: '1', value: String(c.rotate ?? 0), 'aria-label': 'Rotate from minus 45 to plus 45 degrees' }) as HTMLInputElement;
      const rememberRotate = () => { hist.push(snap()); updateBtns(); };
      rotateInput.addEventListener('pointerdown', rememberRotate);
      rotateInput.addEventListener('keydown', (e) => { if (!e.repeat && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) rememberRotate(); });
      rotateInput.addEventListener('input', () => {
        c.rotate = Number(rotateInput.value);
        rotateValue.textContent = `${Math.round(c.rotate)}°`;
        applyCrop(cropRole); drawCropCanvas(); scheduleSave();
      });
      const rulerTicks = Array.from({ length: 19 }, (_, i) =>
        h('i', { class: `crop-tick${i % 3 === 0 ? ' major' : ''}${i === 9 ? ' center' : ''}`, style: `left:${(i / 18) * 100}%` }));
      const ratios = h('div', { class: 'chips crop-ratios' }, ...CROP_RATIOS.map(([ratio, label]) =>
        h('button', {
          class: 'chip' + ((c.ratio ?? 'custom') === ratio ? ' on' : ''),
          'aria-label': `Crop aspect ratio ${label}`,
          onclick: () => {
            if ((c.ratio ?? 'custom') === ratio) return;
            hist.push(snap()); updateBtns();
            const oldRatio = currentCropRatio();
            c.ratio = ratio;
            if (ratio === 'custom') c.frameRatio = oldRatio;
            else c.frameRatio = undefined;
            c.zoom = Math.max(0.2, c.zoom || 1);
            c.x = 0; c.y = 0;
            applyCrop(cropRole); positionCropFrame(); scheduleSave(); renderPanel();
          },
        }, label)));
      setPanel('Crop',
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Video'),
          chipRow<Role>([['host', 'Host'], ['constant', 'Constant']], cropRole, (v) => { cropRole = v; renderPanel(); layoutCrop(); })),
        h('div', { class: 'crop-rotate' },
          h('div', { class: 'crop-rotate-head' }, h('span', {}, 'Rotate'), rotateValue),
          h('div', { class: 'crop-ruler' }, ...rulerTicks, rotateInput),
          h('div', { class: 'crop-ruler-labels' }, h('span', {}, '−45°'), h('span', {}, '0°'), h('span', {}, '+45°'))),
        h('div', { class: 'prow crop-ratio-row' }, h('div', { class: 'plabel' }, 'Aspect ratio'), ratios),
        h('div', { class: 'crop-actions' }, mirrorChip, reset),
        h('div', { class: 'pinfo' }, 'Drag the corners or pinch to crop. Drag inside the frame to move it.'));
    } else {
      const total = pendingCuts.reduce((a, r) => a + (r.endMs - r.startMs), 0);
      const info = pendingCuts.length
        ? h('div', { class: 'pinfo', style: 'background:rgba(25,230,193,0.08);border:1px solid rgba(25,230,193,0.2);border-radius:10px;padding:10px 12px;margin:8px 0 14px;color:#e0e0e0' },
            'Found ', h('b', { style: 'color:#19e6c1' }, `${pendingCuts.length} silent ${pendingCuts.length === 1 ? 'part' : 'parts'}`),
            ' (', h('b', { style: 'color:#fff' }, secText(total)), ') to remove. Marked red on the timeline.')
        : h('div', { class: 'pinfo', style: 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 12px;margin:8px 0 14px;color:#8a8a8a' },
            'No silence found matching current settings. Try shorter duration or higher sensitivity.');
      const go = (pt: Partial<typeof s>) => { Object.assign(s, pt); saveSettings(s); runDetect(); renderPanel(); draw(); };
      const applyBtn = h('button', {
        class: 'btn primary',
        style: 'width:100%;min-height:48px;margin-top:16px;border-radius:12px;border:0;background:linear-gradient(135deg,#00f2fe,#19e6c1);color:#000;font-size:15px;font-weight:700;letter-spacing:0.3px;box-shadow:0 4px 16px rgba(0,242,254,0.25);cursor:pointer',
        disabled: !pendingCuts.length,
        onclick: applySilence
      }, pendingCuts.length ? `Apply Silence Cut (${pendingCuts.length} ${pendingCuts.length === 1 ? 'cut' : 'cuts'})` : 'No Silence to Cut');

      const minDurSlider = slider('Silence duration', 200, 5000, 100, s.silenceMinMs, (v) => `${(v / 1000).toFixed(1)} s`, (v) => go({ silenceMinMs: v }));
      const padSlider = slider('Padding margin', 0, 500, 50, s.silencePadMs, (v) => `${(v / 1000).toFixed(2)} s`, (v) => go({ silencePadMs: v }));

      setPanel('Silence Cut',
        h('div', { style: 'font-size:16px;font-weight:600;color:#fff;margin-bottom:4px' }, 'Smart Silence Cut'),
        info,
        minDurSlider.row,
        padSlider.row,
        h('div', { class: 'prow', style: 'margin-top:10px' },
          h('div', { class: 'plabel' }, 'Sensitivity'),
          chipRow<SilenceSens>([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.silenceSens, (v) => go({ silenceSens: v }))),
        applyBtn);
    }
  }

  // ----- CapCut-style crop: the picture is shown big, a frame with corner handles picks the part that is kept -----
  // The frame keeps the layout cell's shape until Custom is chosen; position, size and angle are stored in CropState.
  const cropCanvas = h('canvas', { class: 'cropcanvas' }) as HTMLCanvasElement;
  const cropGrid = h('div', { class: 'grid' });
  const cropFrame = h('div', { class: 'cropframe' }, cropGrid,
    ...(['tl', 'tr', 'bl', 'br'] as const).map((k) => h('div', { class: `crh ${k}`, 'data-c': k })));
  const cropView = h('div', { class: 'cropview' }, cropCanvas, cropFrame);
  preview.append(cropView);
  let cm = { x: 0, y: 0, w: 0, h: 0 }; // the big picture area inside the preview
  let cropAr = 16 / 9;
  function cropViewAspect(): number { return cropAr; }

  function layoutCrop() {
    if (panel !== 'crop') return;
    const cw = preview.clientWidth, ch = preview.clientHeight;
    if (!cw || !ch) return;
    const cell = cropRole === 'host' ? hostCell : constCell;
    cropAr = cell.clientWidth > 0 && cell.clientHeight > 0 ? cell.clientWidth / cell.clientHeight : aspectValue(p.aspect);
    const pad = 24;
    const w = Math.max(40, Math.min(cw - 2 * pad, (ch - 2 * pad) * cropAr));
    const hh = w / cropAr;
    cm = { x: (cw - w) / 2, y: (ch - hh) / 2, w, h: hh };
    const dpr = window.devicePixelRatio || 1;
    cropCanvas.width = Math.round(w * dpr); cropCanvas.height = Math.round(hh * dpr);
    cropCanvas.style.cssText = `left:${cm.x}px;top:${cm.y}px;width:${w}px;height:${hh}px`;
    drawCropCanvas(); positionCropFrame();
  }
  /** The video as the layout box shows it with no crop (cover), drawn big. */
  function drawCropCanvas() {
    const ctx = cropCanvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    const v = vid(cropRole);
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (vw / vh > cropAr) { sw = vh * cropAr; sx = (vw - sw) / 2; } else { sh = vw / cropAr; sy = (vh - sh) / 2; }
    const rotate = cropState().rotate ?? 0;
    const cover = rotationCoverZoom(rotate, cropAr);
    try {
      ctx.save();
      ctx.translate(cropCanvas.width / 2, cropCanvas.height / 2);
      ctx.scale(cover, cover);
      ctx.rotate(rotate * Math.PI / 180);
      const mirrored = cropRole === 'host' ? p.mirrorHost : p.mirrorConst;
      if (mirrored) ctx.scale(-1, 1);
      ctx.translate(-cropCanvas.width / 2, -cropCanvas.height / 2);
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
      ctx.restore();
    } catch { ctx.restore(); /* frame not decoded yet */ }
  }
  const cropState = () => (cropRole === 'host' ? p.cropHost : p.cropConst);
  const currentCropRatio = () => {
    const c = cropState();
    return c.ratio === 'custom' || !c.ratio ? (c.frameRatio ?? cropAr) : cropRatioValue(c.ratio, cropAr);
  };
  const frameRect = () => {
    const c = cropState(); const ratio = currentCropRatio();
    const z = Math.max(0.2, c.zoom || 1);
    const maxW = Math.min(cm.w, cm.h * ratio);
    const w = Math.min(cm.w, maxW / z);
    const hh = w / ratio;
    const cx = cm.x + cm.w / 2 - c.x * (cm.w - w) / 2, cy = cm.y + cm.h / 2 - c.y * (cm.h - hh) / 2;
    return { l: cx - w / 2, t: cy - hh / 2, w, h: hh };
  };
  function positionCropFrame() {
    const r = frameRect();
    cropFrame.style.cssText = `left:${r.l}px;top:${r.t}px;width:${r.w}px;height:${r.h}px`;
  }
  /** Store a frame (left, top, width, height) as CropState, with limits and snapping to the center. */
  function setFrame(l: number, t: number, w: number, h0?: number, snap = true) {
    const c = cropState();
    const isCustom = (c.ratio ?? 'custom') === 'custom';
    const ratio = currentCropRatio();
    let hh: number;
    if (isCustom) {
      w = Math.max(cm.w / 3, Math.min(cm.w, w));
      hh = Math.max(cm.h / 3, Math.min(cm.h, h0 ?? w / ratio));
    } else {
      const maxW = Math.min(cm.w, cm.h * ratio);
      w = Math.max(maxW / 3, Math.min(maxW, w));
      hh = w / ratio;
    }
    const frameRatio = w / hh;
    l = Math.max(cm.x, Math.min(cm.x + cm.w - w, l));
    t = Math.max(cm.y, Math.min(cm.y + cm.h - hh, t));
    const ux = l + w / 2 - (cm.x + cm.w / 2), uy = t + hh / 2 - (cm.y + cm.h / 2);
    const rx = (cm.w - w) / 2, ry = (cm.h - hh) / 2;
    c.zoom = cm.w / w;
    if (isCustom) c.frameRatio = frameRatio;
    if (c.zoom < 1.002 && Math.abs(hh - cm.h) < 1 && isCustom) { c.zoom = 1; c.x = 0; c.y = 0; c.frameRatio = cropAr; }
    else {
      c.x = rx > 0.5 ? Math.max(-1, Math.min(1, -ux / rx)) : 0;
      c.y = ry > 0.5 ? Math.max(-1, Math.min(1, -uy / ry)) : 0;
      if (snap && Math.abs(ux) < 5) c.x = 0;
      if (snap && Math.abs(uy) < 5) c.y = 0;
    }
    guideV.classList.toggle('on', c.zoom > 1 && c.x === 0);
    guideH.classList.toggle('on', (cm.h / hh > 1.001) && c.y === 0);
    applyCrop(cropRole); positionCropFrame(); scheduleSave();
  }

  type CropDrag = { mode: 'move' | 'resize'; corner?: string; ax?: number; ay?: number; dx?: number; dy?: number };
  const cropPtrs = new Map<number, Ptr>();
  let cropDrag: CropDrag | null = null;
  let pinchStart = { d: 0, w: 0, h: 0 };
  let cropGesturePushed = false;
  cropView.addEventListener('pointerdown', (e) => {
    if (panel !== 'crop') return;
    if (!cropPtrs.size && !cropGesturePushed) { hist.push(snap()); updateBtns(); cropGesturePushed = true; }
    cropView.setPointerCapture(e.pointerId);
    const rect = cropView.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    cropPtrs.set(e.pointerId, { x: px, y: py });
    cropGrid.classList.add('on');
    const r = frameRect();
    if (cropPtrs.size === 2) {
      const [a, b] = [...cropPtrs.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), w: r.w, h: r.h };
      cropDrag = null;
      return;
    }
    const corner = (e.target as HTMLElement).dataset?.c;
    if (corner) {
      const right = corner === 'tr' || corner === 'br', bottom = corner === 'bl' || corner === 'br';
      cropDrag = { mode: 'resize', corner, ax: right ? r.l : r.l + r.w, ay: bottom ? r.t : r.t + r.h };
    } else {
      cropDrag = { mode: 'move', dx: px - r.l, dy: py - r.t };
    }
  });
  cropView.addEventListener('pointermove', (e) => {
    if (panel !== 'crop' || !cropPtrs.has(e.pointerId)) return;
    const rect = cropView.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    cropPtrs.set(e.pointerId, { x: px, y: py });
    const r = frameRect();
    if (cropPtrs.size === 2) {
      const [a, b] = [...cropPtrs.values()];
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / (pinchStart.d || 1);
      const w = pinchStart.w * factor, hh = pinchStart.h * factor;
      const cx = r.l + r.w / 2, cy = r.t + r.h / 2;
      setFrame(cx - w / 2, cy - hh / 2, w, hh);
    } else if (cropDrag?.mode === 'move') {
      setFrame(px - cropDrag.dx!, py - cropDrag.dy!, r.w, r.h);
    } else if (cropDrag?.mode === 'resize') {
      const { ax, ay, corner } = cropDrag as Required<CropDrag>;
      const dirX = corner.endsWith('r') ? 1 : -1, dirY = corner.startsWith('b') ? 1 : -1;
      const spaceX = dirX > 0 ? cm.x + cm.w - ax : ax - cm.x;
      const spaceY = dirY > 0 ? cm.y + cm.h - ay : ay - cm.y;
      const ratio = currentCropRatio();
      const custom = (cropState().ratio ?? 'custom') === 'custom';
      let w: number, hh: number;
      if (custom) {
        w = Math.max(cm.w / 3, Math.min(Math.abs(px - ax), spaceX));
        hh = Math.max(cm.h / 3, Math.min(Math.abs(py - ay), spaceY));
      } else {
        w = Math.max(Math.abs(px - ax), Math.abs(py - ay) * ratio);
        const maxW = Math.min(spaceX, spaceY * ratio);
        w = Math.max(Math.min(cm.w, cm.h * ratio) / 3, Math.min(w, maxW));
        hh = w / ratio;
      }
      setFrame(dirX > 0 ? ax : ax - w, dirY > 0 ? ay : ay - hh, w, hh, false);
    }
  });
  const cropEnd = (e: PointerEvent) => {
    cropPtrs.delete(e.pointerId);
    if (cropPtrs.size === 1) { // one finger left after a pinch: carry on as a move
      const [pt] = [...cropPtrs.values()]; const r = frameRect();
      cropDrag = { mode: 'move', dx: pt.x - r.l, dy: pt.y - r.t };
    } else if (!cropPtrs.size) {
      cropDrag = null; cropGesturePushed = false; cropGrid.classList.remove('on');
      guideV.classList.remove('on'); guideH.classList.remove('on');
    }
  };
  cropView.addEventListener('pointerup', cropEnd);
  cropView.addEventListener('pointercancel', cropEnd);
  hostV.addEventListener('seeked', () => {
    if (panel === 'crop' && cropRole === 'host') drawCropCanvas();
    if (playing && !hostV.seeking) startCleanAudio();
  });
  constV.addEventListener('seeked', () => { if (panel === 'crop' && cropRole === 'constant') drawCropCanvas(); });
  hostV.addEventListener('loadeddata', () => { if (panel === 'crop' && cropRole === 'host') drawCropCanvas(); });
  constV.addEventListener('loadeddata', () => { if (panel === 'crop' && cropRole === 'constant') drawCropCanvas(); });

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = window.setTimeout(() => saveProject(p), 600); }

  // ======================================================================= Main loop
  function refresh() {
    applyLayout(segmentAt(p.segments, playMs));
    hudTimeBadge.textContent = `${fmtClock(playMs)} / ${fmtClock(p.durationMs)}`;
    draw();
  }

  function loop() {
    if (playing) {
      // the Host video is the clock: the timeline follows it, so a slow decoder never makes the picture "stand still"
      if (!hostV.seeking && hostV.readyState >= 2) playMs = hostV.currentTime * 1000;
      const endAt = lastEnd();
      if (playMs >= endAt - 30 || hostV.ended) { playMs = Math.min(endAt, p.durationMs); setPlaying(false); refresh(); }
      else {
        if (p.segments.length && !isKept(p.segments, playMs)) {
          // jump over a part that was cut out
          const nx = nextKeptStart(p.segments, playMs);
          if (nx !== null) { playMs = nx; syncHost(true); syncConst(true); }
        }
        syncConst(false);
        refresh();
      }
    }
    raf = requestAnimationFrame(loop);
  }

  // ======================================================================= Start-up: thumbnails, previews, audio, sync, auto switch
  async function bootstrap() {
    startSource('host'); startSource('constant');
    // until a video can play, show its first picture in the preview instead of black
    const poster = (role: Role, st: Strip | undefined) => {
      const img = st?.frames.find((f) => !!f);
      if (img && !ready[role] && !failed[role] && !posterSet[role]) { posterSet[role] = true; vid(role).poster = img.src; }
    };
    hostStrip = makeStrip({ path: runtime.hostPath, url: runtime.hostUrl!, durationMs: hostDur, height: LANE * 2, onFrame: () => { poster('host', hostStrip); requestDraw(); } });
    constStrip = makeStrip({ path: runtime.constPath, url: runtime.constUrl!, durationMs: constDur, height: LANE * 2, onFrame: () => { poster('constant', constStrip); requestDraw(); } });

    // audio -> waveforms (and what sync / auto switch need)
    if (!audioReady()) {
      let hp = 0, cp = 0;
      startTask('audio', 'Reading audio', 0);
      const upd = () => updateTask('audio', 'Reading audio', (hp + cp) / 2);
      try {
        await Promise.all([ensureAudio('host', (n) => { hp = n; upd(); }), ensureAudio('constant', (n) => { cp = n; upd(); })]);
      } catch (e) {
        hasAudioError = true;
        if (!destroyed) toast(`${(e as Error).message || 'Could not read the audio.'} Auto sync and auto switch are off.`, 4200);
      }
      endTask('audio');
    }
    if (destroyed) return;
    for (const role of ['host', 'constant'] as Role[]) {
      if (noiseStrength(role) > 0) {
        await applyNoiseReduction(role, noiseStrength(role), { history: false, persist: false, resetOnFailure: true });
        if (destroyed) return;
      }
    }
    computePeaks(); requestDraw();
    applyVolume();

    if (!p.segments.length) {
      // first time in the editor with these two videos
      if (audioReady()) {
        startTask('sync', 'Syncing audio', 0, { modal: true });
        await nextPaint();
        if (destroyed) { endTask('sync'); return; }
        const r = runSync(p);
        endTask('sync');
        syncNote = `${r.confidence} confidence`; syncNoteCls = r.confidence;
        p.segments = defaultSegments(p.durationMs, p.mainAudio);
        selectedId = p.segments[0].id;
        syncReady = true; refresh(); updatePlayState();
        startTask('switch', 'Detecting who is speaking', 0, { modal: true });
        await nextPaint();
        if (destroyed) { endTask('switch'); return; }
        p.segments = runAutoSwitch(p, app.settings);
        endTask('switch');
        selectedId = p.segments[0]?.id ?? null;
        if (r.confidence === 'Low') {
          toast('The audio did not match well. Drag the green clip or use the buttons until the waves line up.', 4200);
          selClip = 'constant'; selectedId = null; openPanel('sync');
        }
      } else {
        p.offsetMs = 0; p.syncConfidence = 'Low';
        p.durationMs = overlapDuration(hostDur, constDur, 0);
        p.segments = defaultSegments(p.durationMs, p.mainAudio);
        selectedId = p.segments[0].id;
        syncNote = 'Not synced'; syncNoteCls = 'Low';
        toast('Could not sync automatically. Drag the green clip until the waves line up.', 4200);
        selClip = 'constant'; selectedId = null; openPanel('sync');
      }
      syncReady = true;
      hist.reset();
      seek(0); afterEdit(); updatePlayState();
      saveProject(p);
    }

    if (destroyed) return;
    const intent: Intent | undefined = app.intent; app.intent = undefined;
    if (intent) openPanel(intent);
  }

  // ======================================================================= Screen
  function goExport() {
    if (!syncReady || !p.segments.length) { toast('Wait until syncing is done.'); return; }
    setPlaying(false);
    app.go('export'); // the screen's destroy() saves the project; no extra wait here keeps the tap instant
  }
  const resChip = h('button', { class: 'reschip', 'aria-label': 'Export settings', onclick: () => {
    if (!syncReady || !p.segments.length) { toast('Wait until syncing is done.'); return; }
    openExportSheet(p, { onChange: () => setResChip(), onExport: goExport });
  } }, h('span', {}, resChipText(p)), icon('chevD', 14));
  function setResChip() { (resChip.firstElementChild as HTMLElement).textContent = resChipText(p); }

  const tlWrap = h('div', { class: 'tl-wrap' }, tl);
  const titleEl = h('div', { class: 'edtop-title' },
    h('span', { class: 'edtop-name' }, p.name),
    h('span', { class: 'edtop-badge' }, 'Autosaved')
  );
  const el = h('div', { class: 'screen editor' },
    h('div', { class: 'edtop' },
      iconButton('close', 'Close', async () => { setPlaying(false); await saveProject(p); app.go('home'); }, 'plain'),
      titleEl,
      h('div', { class: 'grow' }),
      resChip,
      h('button', { class: 'exportbtn', 'aria-label': 'Export', onclick: goExport }, 'Export')),
    preview, controls, tlWrap, toolbar, panelEl);

  app.onBack = () => {
    if (taskSheetEl) { closeListSheet(); return true; }
    if (minimizeAllDialogs()) return true;
    if (stage.classList.contains('full')) { exitFull(); return true; }
    if (panel !== 'none') { closePanel(); return true; }
    if (selectedId || selClip) { selectedId = null; selClip = null; renderBar(); draw(); updateSelFrame(); return true; }
    return false;
  };

  // ----- CapCut style: dialog with % + Minimize -> small "Applying N features" pill -> tap = bottom sheet -----
  let taskSheetEl: HTMLElement | null = null;
  let lastTasks: Task[] = [];
  const dialogEl = dialogHost;
  function closeListSheet() {
    if (taskSheetEl) {
      taskSheetEl.remove();
      taskSheetEl = null;
    }
  }
  function renderListSheet() {
    if (!taskSheetEl) return;
    if (!lastTasks.length) { closeListSheet(); return; }
    const body = taskSheetEl.querySelector('.task-sheet-body') as HTMLElement;
    if (!body) return;
    body.replaceChildren(
      ...lastTasks.map((t) => h('div', { class: 'tl-row' },
        spinner(18),
        h('div', { class: 'tl-main' },
          h('div', { class: 'tl-title' }, t.label),
          h('div', { class: 'tl-pct' }, t.pct !== undefined && t.pct > 0 ? `${t.pct}%` : 'Working...')),
        t.cancel ? iconButton('close', 'Cancel', () => t.cancel!(), 'plain') : null))
    );
  }
  function openListSheet() {
    if (taskSheetEl) { closeListSheet(); return; }
    if (!lastTasks.length) return;
    const dragBar = h('div', { class: 'sheet-handle' }, h('i', { class: 'handle-bar' }));
    const head = h('div', { class: 'task-sheet-head' },
      h('div', { class: 'task-sheet-title' }, 'In progress'),
      iconButton('close', 'Close', closeListSheet, 'plain'));
    const body = h('div', { class: 'task-sheet-body' });
    taskSheetEl = h('div', { class: 'task-sheet' }, dragBar, head, body);

    let swipeY = 0;
    dragBar.addEventListener('pointerdown', (e: PointerEvent) => {
      dragBar.setPointerCapture(e.pointerId);
      swipeY = e.clientY;
    });
    dragBar.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragBar.hasPointerCapture(e.pointerId)) return;
      const dy = Math.max(0, e.clientY - swipeY);
      taskSheetEl!.style.transform = `translateY(${dy}px)`;
    });
    const onSwipeEnd = (e: PointerEvent) => {
      if (!dragBar.hasPointerCapture(e.pointerId)) return;
      dragBar.releasePointerCapture(e.pointerId);
      const dy = e.clientY - swipeY;
      if (dy > 40) {
        closeListSheet();
      } else if (taskSheetEl) {
        taskSheetEl.style.transform = '';
      }
    };
    dragBar.addEventListener('pointerup', onSwipeEnd);
    dragBar.addEventListener('pointercancel', onSwipeEnd);

    el.append(taskSheetEl);
    renderListSheet();
  }

  offTasks = onTasks((list: Task[]) => {
    lastTasks = list;
    // 1) dialog for the first modal task that is not minimized
    const dlg = list.find((t) => t.modal && !t.minimized);
    if (dlg) {
      const pct = dlg.pct ?? 0;
      dialogEl.replaceChildren(h('div', { class: 'taskdialog', role: 'dialog' },
        iconButton('close', dlg.cancel ? 'Cancel' : 'Minimize', () => { if (dlg.cancel) dlg.cancel(); else minimizeTask(dlg.id); }, 'plain'),
        h('div', { class: 'td-ring' }, spinner(34)),
        h('div', { class: 'td-label' }, dlg.label + (pct > 0 ? `... ${pct}%` : '...')),
        h('div', { class: 'td-bar' }, h('i', { style: pct > 0 ? `width:${pct}%` : '', class: pct > 0 ? '' : 'indet' })),
        h('button', { class: 'td-min', onclick: () => minimizeTask(dlg.id) }, 'Minimize')));
    } else dialogEl.replaceChildren();

    // 2) ONE small dark pill at bottom-left inside preview for all tasks without open modal dialog
    const activeTasks = list.filter((t) => !t.modal || t.minimized);
    if (!activeTasks.length) {
      pillsEl.replaceChildren();
      closeListSheet();
    } else {
      const label = activeTasks.length === 1
        ? activeTasks[0].label + (activeTasks[0].pct !== undefined && activeTasks[0].pct > 0 ? ` ${activeTasks[0].pct}%` : '')
        : `Applying ${activeTasks.length} features`;
      const pillBtn = h('button', {
        class: 'pill tap',
        'aria-label': label,
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          if (taskSheetEl) closeListSheet();
          else openListSheet();
        },
      }, h('div', { class: 'td-ring' }, spinner(20)), h('span', {}, label));
      pillsEl.replaceChildren(pillBtn);
    }
    renderListSheet();
    if (!destroyed) updatePlayState();
  });

  requestAnimationFrame(() => {
    selectedId = null;
    applyPreviewHeight();
    fitStage();
    renderBar(); updateBtns(); updatePlayState();
    refresh();
    loop();
    bootstrap();
  });
  const onResize = () => {
    applyPreviewHeight();
    fitStage();
    if (panel !== 'none') {
      const topOffset = preview.offsetTop + preview.offsetHeight;
      if (topOffset) panelEl.style.top = `${topOffset}px`;
    }
    draw();
  };
  window.addEventListener('resize', onResize);

  return {
    el,
    destroy: () => {
      destroyed = true;
      denoiseRun++;
      cancelDenoiseJob();
      endTask('denoise');
      cancelAnimationFrame(raf); clearTimeout(saveTimer); saveProject(p);
      stopCleanAudio(); hostV.pause(); constV.pause();
      hostStrip?.cancel(); constStrip?.cancel();
      offTasks();
      endTask('audio'); endTask('sync'); endTask('switch'); endTask('proxy-host'); endTask('proxy-constant'); endTask('lips'); scanCancel = true; closeListSheet();
      try { actx?.close(); } catch { /* ignore */ }
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect();
      (screen.orientation as any)?.unlock?.();
    },
  };
}
