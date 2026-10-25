import { app, type Intent } from '../app';
import { peaks, PEAKS_PER_SEC, SAMPLE_RATE } from '../core/audio';
import { startDenoise } from '../core/denoise';
import { detectSpeakers, lastMethod, lastSeparationDb, lastUsedLips, lastVoiceQuality, uid, detectByFaces, polishCuts } from '../core/speaker';
import { motionToActivity } from '../core/motion';
import { cropForFace, FACE_SAMPLE_MS, faceBetween, lastReport, motionFromScan, pickTrack, scanFaces, speakerRuns, type FaceReport, type FaceScan } from '../core/faces';
import { pickFace } from './facePick';
import { askFaceOptions } from './faceOptions';
import { openCaptionSheet } from './captionSheet';
import { openTextItemsSheet } from './textSheet';
import { openReactionSheet } from './reactionSheet';
import { askAutoZoom } from './zoomSheet';
import { openMusicSheet, type AutoPlan } from './musicSheet';
import { BGM_RATE, decodeFile, decodeUrl, renderMix, toBase64, toBuffer, toWav } from '../core/bgm';
import { MOOD_LABEL, analyzeMood, moodQuery, type MusicLang } from '../core/mood';
import { SFX_LABEL, synthLoop, synthSfx, type SfxKind } from '../core/synth';
import { buildPages, DEFAULT_CAPTION_STYLE, drawCaption, pageAt, type CapPage, textPage, textStyleOf } from '../core/captions';
import { transcribe, type WhisperModel } from '../core/transcribe';
import { addPunchZooms, addReactions, findPeaks, removeAllReactions, removeReaction } from '../core/autocut';
import { History, runtime, saveProject, saveSettings, type DenoiseCache, type Snapshot } from '../core/store';
import { detectSilence } from '../core/silence';
import { EditorrNative, fileSrc, isNative, tick, youtubeAvailable } from '../core/native';
import { ensureAudio, nextPaint, runAutoSwitch, runSync } from '../core/pipeline';
import { cancelProxy, ensureProxy, needsProxy } from '../core/proxy';
import { makeStrip, type Strip } from '../core/thumbs';
import { effectiveGain } from '../core/gain';
import { fxActive, getFx, type FxTarget } from '../core/fx';
import { FxNode, loadFxWorklet } from '../core/fxGraph';
import { openFxSheet } from './fxSheet';
import { openExportSheet, resChipText } from './exportSheet';
import { endTask, minimizeAllDialogs, minimizeTask, onTasks, startTask, updateTask, type Task } from '../core/tasks';
import {
  coverage, defaultSegments, deleteSegment, dropSlivers, fitSegmentsToDuration, intersectRanges, isKept, keptMs, mergeWithPrev,
  moveBoundary, nextKeptStart, overlapDuration, segmentAt, splitAt, subtractRanges, updateSegment, type Range,
} from '../core/timeline';
import { Aspect, ASPECTS, aspectValue, Corner, CropRatio, CropState, LayoutStyle, NO_CROP, PopupSize, Project, Role, Segment, segmentColor, SilenceSens, STYLE_LABEL } from '../core/types';
import { confirmDialog, fmtClock, h, ICON, icon, iconButton, spinner, toast } from '../ui';

type Panel = 'none' | 'ratio' | 'crop' | 'mask' | 'silence' | 'sync' | 'layout' | 'main' | 'audio' | 'denoise';

// ---- timeline geometry (CSS px) ----
const G = 64;            // left column: audio-source button + lane icons
const RULER = 22;        // top ruler
const LANE = 50;         // auto-cut master video filmstrip track height
const AUD = 32;          // audio waveform track height
const GAP = 4;
const MAIN_Y = RULER + GAP;
const AUD_Y = MAIN_Y + LANE + GAP;
// "voice-scan" icon (14x14 viewBox) for the Host / Constant audio-source button
const VOICE_ICON = new Path2D('M2 1.625A.375.375 0 0 0 1.625 2v2a.625.625 0 1 1-1.25 0V2A1.625 1.625 0 0 1 2 .375h2a.625.625 0 1 1 0 1.25zm8-1.25a.625.625 0 1 0 0 1.25h2a.375.375 0 0 1 .375.375v2a.625.625 0 1 0 1.25 0V2A1.625 1.625 0 0 0 12 .375zM7 3.5a.75.75 0 0 1 .75.75v5.5a.75.75 0 0 1-1.5 0v-5.5A.75.75 0 0 1 7 3.5m-2.75 1a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75m6.25.75a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0zM13 9.375c.345 0 .625.28.625.625v2A1.625 1.625 0 0 1 12 13.625h-2a.625.625 0 1 1 0-1.25h2a.375.375 0 0 0 .375-.375v-2c0-.345.28-.625.625-.625M1.625 10a.625.625 0 1 0-1.25 0v2A1.625 1.625 0 0 0 2 13.625h2a.625.625 0 1 0 0-1.25H2A.375.375 0 0 1 1.625 12z');
const SUB_M = 24;        // music row height (one line)
const SUB_S = 18;        // sound-effect row height
const SUB_T = 20;        // text row height
const TL_H = AUD_Y + AUD + GAP + SUB_M + 10;   // smallest timeline (only the Add music row)
const CYAN = '#C6F277';
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
  const songFiles: { name: string; buf: AudioBuffer }[] = [];
  const sfxFiles: { name: string; buf: AudioBuffer; startMs: number; auto?: boolean }[] = [];
  const clipFiles: { name: string; buf: AudioBuffer; startMs: number; endMs?: number; loop?: boolean; kind?: 'bgm' | 'music'; mood?: string }[] = [];
  let bgmPeaks: Float32Array | null = null;
  let prevSrc: AudioBufferSourceNode | null = null;
  let bgmBuffer: AudioBuffer | null = null;
  let bgmSource: AudioBufferSourceNode | null = null;
  let bgmLoading = false;
  let capPages: CapPage[] = [];
  let capKey = '';
  let capVersion = 0;
  let playing = false;
  let selectedId: string | null = null;
  let selClip: Role | null = null;
  /** Crop panel tick: off = only the clip under the playhead changes, on = every clip changes. */
  let applyAllCrop = false;
  let applyAllMask = false;
  let lastCropKey = '';
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
  hostMsg.addEventListener('click', () => retryVideo('host'));
  constMsg.addEventListener('click', () => retryVideo('constant'));
  hostV.muted = p.mainAudio !== 'host' || p.noiseHost > 0;
  constV.muted = p.mainAudio !== 'constant' || p.noiseConst > 0;
  // Each video lives in its own clip box. Transform, border and rounded corners go on the clip box,
  // so the border always hugs the video and moves/scales with it (CapCut behaviour).
  const hostClip = h('div', { class: 'clip-box' }, hostV);
  const constClip = h('div', { class: 'clip-box' }, constV);
  const hostCell = h('div', { class: 'cell' }, hostClip, hostMsg);
  const constCell = h('div', { class: 'cell' }, constClip, constMsg);
  const capCanvas = h('canvas', { class: 'cap-overlay' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'stage' }, hostCell, constCell, capCanvas);
  const guideV = h('div', { class: 'guide v' });
  const guideH = h('div', { class: 'guide h' });
  const pillsEl = h('div', { class: 'pills' });
  const dialogHost = h('div', { class: 'taskdialog-wrap' });
  const hudTimeBadge = h('div', { class: 'hud-time-badge' }, `${fmtClock(playMs)} / ${fmtClock(p.durationMs)}`);
  const playRipple = h('div', { class: 'preview-play-ripple' }, icon('play', 28));
  const preview = h('div', { class: 'preview' }, stage, guideV, guideH, playRipple);

  function triggerPlayRipple(isPlaying: boolean) {
    playRipple.replaceChildren(icon(isPlaying ? 'play' : 'pause', 28));
    playRipple.classList.remove('animate');
    void playRipple.offsetWidth;
    playRipple.classList.add('animate');
  }

  // Selected video frame on preview with Reset button
  const selFrame = h('div', { class: 'sel-frame' });
  stage.append(selFrame);

  function resetCrop(role: Role) {
    hist.push(snap()); updateBtns();
    const c = cropForEdit(role);
    c.zoom = 1;
    c.x = 0;
    c.y = 0;
    c.rotate = 0;
    c.ratio = 'custom';
    c.frameRatio = undefined;
    c.px = 0; c.py = 0; c.ps = 1;
    cropEdited(role);
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
    const sr = shapedRect[selClip];
    const clipRect = (sr ? (selClip === 'host' ? hostRing : constRing) : (selClip === 'host' ? hostClip : constClip)).getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    selFrame.style.left = `${clipRect.left - stageRect.left}px`;
    selFrame.style.top = `${clipRect.top - stageRect.top}px`;
    selFrame.style.width = `${clipRect.width}px`;
    selFrame.style.height = `${clipRect.height}px`;
    selFrame.style.zIndex = '7';
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
    drawCaptionsPreview();
  }
  const ro = new ResizeObserver(() => { applyPreviewHeight(); fitStage(); layoutCrop(); });
  ro.observe(preview);

  // ---- crop of each clip ----
  // Every clip (segment) can keep its own crop. A clip without one uses the project crop.
  const CK = (role: Role) => (role === 'host' ? 'cropHost' : 'cropConst') as 'cropHost' | 'cropConst';
  /** The crop that is showing now: the clip under the playhead, else the project crop. */
  function cropOf(role: Role): CropState { return segmentAt(p.segments, playMs)?.[CK(role)] ?? p[CK(role)]; }
  /** Same crop, ready to edit: the clip under the playhead gets its own copy first, so other clips stay as they are. */
  function cropForEdit(role: Role): CropState {
    const seg = segmentAt(p.segments, playMs);
    const k = CK(role);
    if (!seg) return p[k];
    if (!seg[k]) seg[k] = { ...p[k] };
    return seg[k]!;
  }
  function copyCrop(dst: CropState, src: CropState) {
    if (dst === src) return;
    for (const key of Object.keys(dst)) delete (dst as unknown as Record<string, unknown>)[key];
    Object.assign(dst, src);
  }
  /** Give this crop to every clip and to the project default. */
  function spreadCrop(role: Role) {
    const k = CK(role);
    const src = cropForEdit(role);
    copyCrop(p[k], src);
    for (const sg of p.segments) { if (!sg[k]) sg[k] = { ...src }; else copyCrop(sg[k]!, src); }
  }
  /** Call after a crop value changed: spreads it when "Apply to all clips" is ticked, then redraws. */
  function cropEdited(role: Role) {
    if (applyAllCrop) spreadCrop(role);
    applyCrop(role);
  }

  // When the picked frame shape differs from the slot shape (1:1 in a half-screen slot, say), the kept part is shown whole and
  // centred in the slot. The cell is clipped to that part and a ring draws the border, so border and corners hug the picture.
  const hostRing = h('div', { class: 'crop-ring' });
  const constRing = h('div', { class: 'crop-ring' });
  hostCell.append(hostRing); constCell.append(constRing);
  const shapedRect: Record<Role, { l: number; t: number; w: number; h: number } | null> = { host: null, constant: null };

  /** Crop = zoom + move inside the frame. Uniform scale, zero distortion. */
  function applyCrop(role: Role) {
    const c = cropOf(role);
    const v = role === 'host' ? hostV : constV;
    const clip = role === 'host' ? hostClip : constClip;
    const ring = role === 'host' ? hostRing : constRing;
    const cell = clip.parentElement as HTMLElement | null;
    const cw = cell?.clientWidth ?? 0, chh = cell?.clientHeight ?? 0;
    const aspect = cw > 0 && chh > 0 ? cw / chh : aspectValue(p.aspect);
    const zoom = Math.max(0.2, Math.min(6.0, c.zoom || 1));
    const rotate = c.rotate ?? 0;
    const cover = rotationCoverZoom(rotate, aspect);
    const mirrored = role === 'host' ? p.mirrorHost : p.mirrorConst;
    const radius = c.radius ? c.radius : 0;
    const stroke = c.strokeWidth ? `${c.strokeWidth}px solid ${c.strokeColor || '#ffffff'}` : 'none';
    const ratio = (c.ratio ?? 'custom') === 'custom' ? (c.frameRatio ?? aspect) : cropRatioValue(c.ratio, aspect);
    const shaped = cw > 0 && chh > 0 && zoom >= 1 && Math.abs(ratio / aspect - 1) > 0.01;
    shapedRect[role] = null;

    if (shaped) {
      // frame (in slot pixels) the user picked, then scaled so the whole frame fits the slot and sits in its centre
      const maxW = Math.min(cw, chh * ratio);
      const fw = Math.min(cw, maxW / zoom), fh = fw / ratio;
      const sc = Math.min(cw / fw, chh / fh);
      const tx = sc * c.x * (cw - fw) / 2, ty = sc * c.y * (chh - fh) / 2;
      clip.style.transform = `translate(${tx}px, ${ty}px) scale(${sc}, ${sc}) rotate(${rotate}deg) scale(${cover})`;
      clip.style.borderRadius = '0px';
      clip.style.border = 'none';
      const rect = { l: (cw - sc * fw) / 2, t: (chh - sc * fh) / 2, w: sc * fw, h: sc * fh };
      shapedRect[role] = rect;
      cell!.style.clipPath = `inset(${rect.t}px ${rect.l}px ${rect.t}px ${rect.l}px round ${radius}px)`;
      ring.style.cssText = `display:block;left:${rect.l}px;top:${rect.t}px;width:${rect.w}px;height:${rect.h}px;border:${stroke};border-radius:${radius}px`;
    } else {
      const tx = zoom > 1 ? c.x * (zoom - 1) * 50 : c.x * 50;
      const ty = zoom > 1 ? c.y * (zoom - 1) * 50 : c.y * 50;
      const identity = Math.abs(zoom - 1) < 0.001 && Math.abs(c.x) < 0.001 && Math.abs(c.y) < 0.001 && Math.abs(rotate) < 0.001;
      // Pan, zoom and rotate move the whole clip box, so the border and rounded corners travel with the video.
      clip.style.transform = identity ? '' : `translate(${tx}%, ${ty}%) scale(${zoom}, ${zoom}) rotate(${rotate}deg) scale(${cover})`;
      clip.style.borderRadius = radius ? `${radius}px` : '0px';
      clip.style.border = stroke;
      if (cell) cell.style.clipPath = '';
      ring.style.display = 'none';
    }
    // Free placement (CapCut style): the whole slot, with its crop and border, can sit anywhere on the stage.
    if (cell) {
      const fx = c.px ?? 0, fy = c.py ?? 0, fs = Math.max(0.2, Math.min(6, c.ps ?? 1));
      cell.style.transform = fx || fy || fs !== 1 ? `translate(${fx * cw}px, ${fy * chh}px) scale(${fs})` : '';
      cell.style.zIndex = role === selClip ? '4' : cell.classList.contains('pop') ? '2' : '1';
    }
    clip.style.overflow = 'hidden';
    clip.style.boxSizing = 'border-box';
    // Mirroring only flips the picture, never the border.
    v.style.transform = mirrored ? 'scaleX(-1)' : '';

    if (cell) { cell.style.border = ''; cell.style.borderRadius = ''; }
    if (role === selClip) updateSelFrame();
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
        const c = cropOf(hitRole);
        startCropX = c.px ?? 0;
        startCropY = c.py ?? 0;
      }
    } else if (previewPtrs.size === 2 && selClip) {
      if (!gestureSnapshot) gestureSnapshot = snap();
      const [p1, p2] = [...previewPtrs.values()];
      pinchStartDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const c = cropOf(selClip);
      pinchStartZoom = Math.max(0.2, c.ps ?? 1);
    }
  });

  preview.addEventListener('pointermove', (e: PointerEvent) => {
    if (!previewPtrs.has(e.pointerId) || panel === 'crop' || stage.classList.contains('full')) return;
    previewPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dist = Math.hypot(e.clientX - previewDownX, e.clientY - previewDownY);
    if (dist > 6) previewMoved = true;
    if (!selClip) return;

    const cell = selClip === 'host' ? hostCell : constCell;
    const c = cropForEdit(selClip);

    if (previewPtrs.size === 1 && previewMoved) {
      gestureChanged = true;
      // free move: the finger drags the whole clip, wherever it should sit on the stage
      const dx = e.clientX - previewDownX;
      const dy = e.clientY - previewDownY;
      c.px = Math.max(-2, Math.min(2, startCropX + dx / Math.max(1, cell.clientWidth)));
      c.py = Math.max(-2, Math.min(2, startCropY + dy / Math.max(1, cell.clientHeight)));
      if (!previewGestureRaf) {
        const roleToUpdate = selClip;
        previewGestureRaf = requestAnimationFrame(() => {
          previewGestureRaf = 0;
          cropEdited(roleToUpdate);
        });
      }
    } else if (previewPtrs.size === 2) {
      gestureChanged = true;
      const [p1, p2] = [...previewPtrs.values()];
      const currentDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const factor = currentDist / (pinchStartDist || 1);
      c.ps = Math.max(0.2, Math.min(6.0, pinchStartZoom * factor));
      if (!previewGestureRaf) {
        const roleToUpdate = selClip;
        previewGestureRaf = requestAnimationFrame(() => {
          previewGestureRaf = 0;
          cropEdited(roleToUpdate);
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
      if (selClip) { if (gestureChanged) cropEdited(selClip); else applyCrop(selClip); }

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
  /** True while the face scan plays the two preview videos itself: the editor must not seek, play or reload them. */
  let scanLock = false;
  const ready: Record<Role, boolean> = { host: false, constant: false };
  const failed: Record<Role, boolean> = { host: false, constant: false };
  const proxying: Record<Role, boolean> = { host: false, constant: false };
  const usingProxy: Record<Role, boolean> = { host: false, constant: false };
  const vid = (r: Role) => (r === 'host' ? hostV : constV);
  const curUrl: Record<Role, string> = { host: '', constant: '' };
  const posterSet: Record<Role, boolean> = { host: false, constant: false };
  /** Black cell with a message while a video cannot be shown; hides the moment it plays again. */
  function showMissing(role: Role, on: boolean, text = 'Video not found') {
    const m = role === 'host' ? hostMsg : constMsg;
    m.style.display = on ? '' : 'none';
    m.textContent = text;
    const v = vid(role);
    if (on) { v.style.visibility = 'hidden'; } else { v.style.visibility = ''; }
  }
  /** `missing` = the file is really gone. `error` = it could not be played (often a busy decoder): tap the cell to try again. */
  function markFailed(role: Role, kind: 'missing' | 'error' = 'missing') {
    failed[role] = true; ready[role] = true;
    showMissing(role, true, kind === 'missing' ? 'Video not found' : 'Preview unavailable. Tap to try again.');
    if (!destroyed) updatePlayState();
  }
  /** How often a video was loaded again after an error (a busy decoder usually frees up a moment later). */
  const retries: Record<Role, number> = { host: 0, constant: 0 };
  const label = (r: Role) => (r === 'host' ? 'Host' : 'Constant');

  function setSource(role: Role, url: string) {
    const v = vid(role);
    ready[role] = false;
    curUrl[role] = url;
    v.src = url;
    v.load();
    v.addEventListener('loadedmetadata', () => {
      ready[role] = true; failed[role] = false; retries[role] = 0; showMissing(role, false);
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
    let userStopped = false;
    startTask(id, `Optimizing ${label(role)} preview`, 0, { cancel: () => { userStopped = true; cancelProxy(path); } });
    try {
      const url = await ensureProxy(path, meta, (n) => updateTask(id, undefined, n));
      if (destroyed) return;
      usingProxy[role] = true;
      if (role === 'host') p.proxyHost = true; else p.proxyConst = true;
      scheduleSave();
      setSource(role, url);
      if (wasPlaying) vid(role).addEventListener('loadedmetadata', () => { if (!destroyed) setPlaying(true); }, { once: true });
    } catch (e) {
      if (userStopped) { markFailed(role, 'error'); toast(`${label(role)} preview copy stopped.`); }
      else if (!destroyed && curUrl[role] !== (role === 'host' ? runtime.hostUrl : runtime.constUrl) && (role === 'host' ? runtime.hostUrl : runtime.constUrl)) {
        // the copy could not be made: try the original video once, it may play fine
        setSource(role, (role === 'host' ? runtime.hostUrl : runtime.constUrl)!);
        toast(`${label(role)} video: using the original for preview. ${(e as Error).message || ''}`.trim());
      } else {
        markFailed(role, 'error'); // do not block playing forever
        toast(`${label(role)} video: could not make a smooth preview. ${(e as Error).message || ''}`.trim());
      }
    } finally {
      proxying[role] = false;
      endTask(id);
      if (!destroyed) updatePlayState();
    }
  }

  const listening: Record<Role, boolean> = { host: false, constant: false };
  function startSource(role: Role) {
    const v = vid(role);
    if (!listening[role]) {
      listening[role] = true;
      v.addEventListener('error', () => {
        if (destroyed || scanLock || proxying[role]) return;
        // First errors are usually the phone's decoders being busy for a moment: load the same video again after a pause.
        const attempt = ++retries[role];
        if (attempt <= 3) {
          window.setTimeout(() => {
            if (destroyed || scanLock || proxying[role] || !curUrl[role] || ready[role] && !v.error) return;
            setSource(role, curUrl[role]);
          }, attempt * 1200);
          return;
        }
        if (isNative() && !usingProxy[role]) {
          // still failing: the WebView cannot play it. Pause cleanly, make a preview copy, carry on where we were.
          const was = playing;
          if (playing) setPlaying(false);
          useProxy(role, was);
        } else if (!failed[role]) {
          markFailed(role, 'error');
          toast(`${label(role)} video cannot be played in the preview. Tap it to try again. Export may still work.`);
        }
      });
    }
    loadRole(role);
  }
  /** Check the file, then load it (or its preview copy). */
  function loadRole(role: Role) {
    const meta = role === 'host' ? p.host : p.constant;
    const flagged = role === 'host' ? p.proxyHost : p.proxyConst;
    const url = role === 'host' ? runtime.hostUrl! : runtime.constUrl!;
    const begin = () => {
      if (isNative() && (flagged || needsProxy(meta))) useProxy(role); // before playing: no stall in the middle of a video
      else setSource(role, url);
    };
    const path = role === 'host' ? runtime.hostPath : runtime.constPath;
    if (isNative() && path) {
      // file deleted or moved: show "Video not found" straight away instead of a broken picture
      EditorrNative.fileExists({ path }).then((r) => { if (destroyed) return; if (r.exists) begin(); else markFailed(role, 'missing'); }, () => { if (!destroyed) begin(); });
    } else begin();
  }
  /** Tap on the black "Preview unavailable" cell. */
  function retryVideo(role: Role) {
    if (!failed[role] || proxying[role] || scanLock) return;
    failed[role] = false; ready[role] = false; retries[role] = 0; usingProxy[role] = false;
    showMissing(role, false);
    loadRole(role);
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
    if (scanLock) return;
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
    if (scanLock) return;
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
    if (scanLock) return;
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
    if (scanLock) return 'Scanning faces...';
    if (!syncReady) return 'Still syncing the two videos...';
    if (!ready.host || (!ready.constant && !failed.constant)) {
      return proxying.host || proxying.constant ? 'Still preparing the preview...' : 'The videos are still loading...';
    }
    return null;
  }

  // ----- volume: Web Audio gain (HTML video.volume stops at 100 %) + soft limiter -----
  let actx: AudioContext | null = null;
  const gainNodes: Partial<Record<Role, GainNode>> = {};
  const fxNodes: Partial<Record<FxTarget, FxNode>> = {};
  let safetyLim: DynamicsCompressorNode | null = null;
  /** A/B in the Enhanced Audio sheet: hear the original. Preview only, never exported. */
  let fxBypass = false;
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
      safetyLim = lim;
      // Enhanced Audio: mic -> gain -> its own chain -> master chain -> safety limiter -> speakers (music joins at the master chain)
      const master = new FxNode(ctx);
      master.output.connect(lim);
      fxNodes.master = master;
      (['host', 'constant'] as Role[]).forEach((r) => {
        const v = vid(r);
        const g = ctx.createGain();
        let src = mediaSources.get(v);
        if (!src) {
          src = ctx.createMediaElementSource(v);
          mediaSources.set(v, src);
        }
        try { src.connect(g); } catch { /* ignore if connected */ }
        const fx = new FxNode(ctx);
        g.connect(fx.input); fx.output.connect(master.input);
        fxNodes[r] = fx;
        gainNodes[r] = g;
      });
      actx = ctx;
      void loadFxWorklet(ctx).then((ok) => { Object.values(fxNodes).forEach((n) => n?.attachDyn(ok)); });
      applyFx();
      return true;
    } catch { return false; }
  }
  /** Push the Enhanced Audio settings to the preview chains. */
  function applyFx() {
    if (!actx) return;
    const f = getFx(p);
    (['host', 'constant', 'master'] as FxTarget[]).forEach((t) => fxNodes[t]?.update(f[t], fxBypass));
    // the shared safety limiter would squash peaks the Enhanced Audio limiter already holds at its ceiling, so it only catches overs then
    if (safetyLim) {
      const on = fxActive(p) && !fxBypass;
      safetyLim.threshold.value = on ? -0.5 : -12; safetyLim.knee.value = on ? 0 : 6; safetyLim.ratio.value = on ? 20 : 4;
    }
  }
  /** Push the current volumes (and normalize) to the preview. Only builds the audio graph once a gain other than 100 % is needed. */
  function applyVolume() {
    const roles: Role[] = ['host', 'constant'];
    const denoiseOn = p.noiseHost > 0 || p.noiseConst > 0;
    if (!actx && !denoiseOn && !fxActive(p) && roles.every((r) => Math.abs(effectiveGain(p, r) - 1) < 0.01)) { updateVideoAudioMute(); return; }
    if (!ensureGraph()) {
      roles.forEach((r) => { vid(r).volume = Math.min(1, effectiveGain(p, r)); });
      hostV.muted = p.mainAudio !== 'host';
      constV.muted = p.mainAudio !== 'constant';
      return;
    }
    roles.forEach((r) => { if (gainNodes[r]) gainNodes[r]!.gain.value = effectiveGain(p, r); });
    applyFx();
    updateVideoAudioMute();
    if (actx!.state === 'suspended') actx!.resume().catch(() => {});
  }

  function stopCleanAudio() {
    stopBgm();
    const source = cleanSource;
    cleanSource = null;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
    try { source.disconnect(); } catch { /* already disconnected */ }
  }
  function startCleanAudio() {
    stopCleanAudio();
    startBgm();
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
    if (on) stopFling();
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

  const filmGlyph = (g: CanvasRenderingContext2D, cx: number, cy: number, color: string) => {
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.2;
    const w = 14, h = 11;
    const x = cx - w / 2, y = cy - h / 2;
    g.strokeRect(x, y, w, h);
    g.fillRect(x + 2, y + 2, 2, 2);
    g.fillRect(x + w - 4, y + 2, 2, 2);
    g.fillRect(x + 2, y + h - 4, 2, 2);
    g.fillRect(x + w - 4, y + h - 4, 2, 2);
    g.restore();
  };

  /** Unified Auto-Cut Master Video Track: renders filmstrip thumbnails for active speaker segments. */
  function drawMasterVideoTrack(g: CanvasRenderingContext2D) {
    const bx1 = xOf(0), bx2 = xOf(p.durationMs);
    if (bx2 < G || bx1 > W) return;
    const bw = bx2 - bx1;

    g.save();
    rrect(g, bx1, MAIN_Y, bw, LANE, 4);
    g.clip();

    // Dark track background
    g.fillStyle = '#141416';
    g.fillRect(bx1, MAIN_Y, bw, LANE);

    // Gaps/holes where silence was cut out
    const kept = coverage(p.segments);
    let at = 0;
    const holes: Range[] = [];
    for (const r of kept) { if (r.startMs > at) holes.push({ startMs: at, endMs: r.startMs }); at = r.endMs; }
    if (kept.length && at < p.durationMs) holes.push({ startMs: at, endMs: p.durationMs });
    for (const r of holes) {
      const x1 = Math.max(G, xOf(r.startMs)), x2 = Math.min(W, xOf(r.endMs));
      if (x2 - x1 < 2) continue;
      g.save(); g.beginPath(); g.rect(x1, MAIN_Y, x2 - x1, LANE); g.clip();
      g.strokeStyle = '#282828'; g.lineWidth = 1;
      for (let k = x1 - LANE; k < x2; k += 6) { g.beginPath(); g.moveTo(k, MAIN_Y + LANE); g.lineTo(k + LANE, MAIN_Y); g.stroke(); }
      g.restore();
    }

    // Render each cut segment
    for (const seg of p.segments) {
      const x1 = xOf(seg.startMs), x2 = xOf(seg.endMs);
      if (x2 < G || x1 > W) continue;
      const sw = x2 - x1;

      g.save();
      g.beginPath();
      g.rect(Math.max(G, x1), MAIN_Y, Math.min(W, x2) - Math.max(G, x1), LANE);
      g.clip();

      const isHost = seg.main === 'host';
      const strip = isHost ? hostStrip : constStrip;
      const offsetMs = isHost ? 0 : p.offsetMs;
      const durMs = isHost ? hostDur : constDur;

      // Subtle speaker tint
      g.fillStyle = isHost ? '#18181e' : '#121f16';
      g.fillRect(x1, MAIN_Y, sw, LANE);

      // Filmstrip thumbnails
      if (strip) {
        const sx1 = xOf(-offsetMs);
        const sx2 = sx1 + (durMs / 1000) * pxPerSec;
        const vx1 = Math.max(x1, G, sx1);
        const vx2 = Math.min(x2, W, sx2);
        if (vx2 > vx1) {
          const tw = Math.max(16, Math.round(LANE * strip.aspect));
          const k0 = Math.max(0, Math.floor((vx1 - sx1) / tw));
          const k1 = Math.floor((vx2 - sx1) / tw);
          for (let k = k0; k <= k1; k++) {
            const tMs = ((k + 0.5) * tw / pxPerSec) * 1000;
            if (tMs < 0 || tMs >= durMs) continue;
            const idx = Math.max(0, Math.min(strip.count - 1, Math.floor((tMs / durMs) * strip.count)));
            const img = strip.frames[idx] ?? strip.frames.find((f) => !!f);
            if (img) {
              g.globalAlpha = strip.frames[idx] ? 1 : 0.45;
              g.drawImage(img, sx1 + k * tw, MAIN_Y, tw, LANE);
              g.globalAlpha = 1;
            }
          }
        }
      }

      // Glyph indicator if width allows
      if (sw > 24) {
        drawGlyph(g, seg, Math.max(x1, G) + 12, MAIN_Y + 12);
      }

      g.restore();

      // CapCut white subtle vertical split divider
      g.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x1 + 0.5, MAIN_Y);
      g.lineTo(x1 + 0.5, MAIN_Y + LANE);
      g.stroke();

      // Active selection highlight
      if (seg.id === selectedId) {
        g.strokeStyle = '#FFFFFF';
        g.lineWidth = 2;
        rrect(g, x1 + 1, MAIN_Y + 1, sw - 2, LANE - 2, 3);
        g.stroke();

        const hw = Math.min(8, Math.max(5, sw / 4));
        g.fillStyle = '#FFFFFF';
        rrect(g, x1, MAIN_Y + 1, hw, LANE - 2, 2); g.fill();
        rrect(g, x2 - hw, MAIN_Y + 1, hw, LANE - 2, 2); g.fill();
        g.fillStyle = '#000000';
        g.fillRect(x1 + hw / 2 - 0.75, MAIN_Y + 12, 1.5, LANE - 24);
        g.fillRect(x2 - hw / 2 - 0.75, MAIN_Y + 12, 1.5, LANE - 24);
      }
    }

    g.restore();

    // Outer border
    g.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    g.lineWidth = 1;
    rrect(g, bx1 + 0.5, MAIN_Y + 0.5, bw - 1, LANE - 1, 4);
    g.stroke();
  }

  /** Single audio waveform row for the selected sound (p.mainAudio). Centered mirrored bars. */
  const MUSIC_COLOR = { bgm: '#2b6f69', music: '#2b5f94', sfx: '#a8651f' } as const;
  type MItem = NonNullable<Project['bgm']>['items'] extends (infer T)[] | undefined ? T : never;
  /** Greedy packing: items that overlap in time go to the next line of their row. */
  function pack(spans: [number, number][]): { line: number[]; n: number } {
    const order = spans.map((_, i) => i).sort((a, b) => spans[a]![0] - spans[b]![0]);
    const ends: number[] = [], line: number[] = new Array(spans.length).fill(0);
    for (const i of order) {
      let l = ends.findIndex((e) => e <= spans[i]![0]);
      if (l < 0) { l = ends.length; ends.push(0); }
      ends[l] = Math.max(spans[i]![1], spans[i]![0] + 400); line[i] = l;
    }
    return { line, n: Math.max(1, ends.length) };
  }
  /** Rows under the waveform, like CapCut: Music, SFX and Text each get their own row; overlapping items stack. */
  function tlRows() {
    const items = p.bgm?.items ?? [];
    const mus = items.filter((i) => i.kind !== 'sfx'), sfx = items.filter((i) => i.kind === 'sfx'), txt = p.texts ?? [];
    const pm = pack(mus.map((i) => [i.startMs, i.endMs])), ps = pack(sfx.map((i) => [i.startMs, i.endMs])), pt = pack(txt.map((t) => [t.s, t.e]));
    let y = AUD_Y + AUD + GAP;
    const music = { y, h: pm.n * SUB_M + (pm.n - 1) * 3 }; y += music.h + GAP;
    const fx = sfx.length ? { y, h: ps.n * SUB_S + (ps.n - 1) * 3 } : null; if (fx) y += fx.h + GAP;
    const text = txt.length ? { y, h: pt.n * SUB_T + (pt.n - 1) * 3 } : null; if (text) y += text.h + GAP;
    return { mus, sfx, txt, pm, ps, pt, music, fx, text, tlH: y + 10 };
  }
  let rowsNow = tlRows();
  let minTlH = TL_H;
  function pill(g: CanvasRenderingContext2D, a: number, y: number, w: number, hh: number, color: string, label: string) {
    rrect(g, a, y, w, hh, 5); g.fillStyle = color; g.fill();
    if (label && w > 28) {
      g.save();
      g.beginPath(); g.rect(Math.max(a, G), y, Math.max(0, Math.min(a + w, W) - Math.max(a, G)), hh); g.clip();
      g.fillStyle = '#ffffff'; g.font = '600 9px Roboto, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(label, Math.max(a, G) + 5, y + hh / 2 + 0.5);
      g.restore();
    }
  }
  function drawMusicRow(g: CanvasRenderingContext2D) {
    const R = rowsNow, items = R.mus;
    const MUS_Y = R.music.y;
    const x0 = xOf(0), x1 = xOf(p.durationMs);
    g.save();
    g.beginPath(); g.rect(G, MUS_Y - 1, W - G, R.music.h + 2); g.clip();
    if (!items.length) {
      rrect(g, x0, MUS_Y, Math.max(0, x1 - x0), SUB_M, 6);
      g.fillStyle = '#0d0d0d'; g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = '#8a8a8a'; g.font = '600 10px Roboto, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText('+  Add music', Math.max(x0, G) + 10, MUS_Y + SUB_M / 2);
    }
    items.forEach((it: MItem, n) => {
      const a = xOf(it.startMs), b = xOf(it.endMs);
      if (b < G || a > W) return;
      const w = Math.max(6, b - a), y = MUS_Y + R.pm.line[n]! * (SUB_M + 3);
      rrect(g, a, y, w, SUB_M, 6);
      g.fillStyle = MUSIC_COLOR[it.kind]; g.fill();
      if (bgmPeaks) {
        g.fillStyle = 'rgba(255,255,255,0.35)';
        const cy = y + SUB_M - 7;
        for (let x = Math.max(Math.floor(a) + 2, G); x < Math.min(a + w, W); x += 2) {
          const ms = msOf(x);
          const v = bgmPeaks[Math.round((ms / 1000) * 20)] ?? 0;
          const bh = Math.max(1, Math.min(6, v * 9));
          g.fillRect(x, cy - bh, 1.4, bh * 2);
        }
      }
      g.save();
      g.beginPath(); g.rect(Math.max(a, G), y, Math.max(0, Math.min(a + w, W) - Math.max(a, G)), SUB_M); g.clip();
      g.fillStyle = '#ffffff'; g.font = '600 9px Roboto, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
      const label = it.mood && it.mood in MOOD_LABEL ? `${MOOD_LABEL[it.mood as keyof typeof MOOD_LABEL]} · ${it.name}` : it.name;
      g.fillText(label, Math.max(a, G) + 6, y + 8);
      g.restore();
    });
    g.restore();
  }
  function drawSfxRow(g: CanvasRenderingContext2D) {
    const R = rowsNow; if (!R.fx) return;
    g.save();
    g.beginPath(); g.rect(G, R.fx.y - 1, W - G, R.fx.h + 2); g.clip();
    R.sfx.forEach((it: MItem, n) => {
      const a = xOf(it.startMs), b = xOf(it.endMs);
      if (b < G || a > W) return;
      pill(g, a, R.fx!.y + R.ps.line[n]! * (SUB_S + 3), Math.max(16, b - a), SUB_S, MUSIC_COLOR.sfx, it.name);
    });
    g.restore();
  }
  function drawTextRow(g: CanvasRenderingContext2D) {
    const R = rowsNow; if (!R.text) return;
    g.save();
    g.beginPath(); g.rect(G, R.text.y - 1, W - G, R.text.h + 2); g.clip();
    R.txt.forEach((t, n) => {
      const a = xOf(t.s), b = xOf(t.e);
      if (b < G || a > W) return;
      pill(g, a, R.text!.y + R.pt.line[n]! * (SUB_T + 3), Math.max(16, b - a), SUB_T, '#7a4fc4', t.text);
    });
    g.restore();
  }
  function computeBgmPeaks(b: AudioBuffer) {
    const per = 20, n = Math.ceil(b.duration * per), d = b.getChannelData(0), win = Math.max(1, Math.floor(b.sampleRate / per));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = i * win, e = Math.min(d.length, a + win);
      for (let k = a; k < e; k += 8) { const v = Math.abs(d[k] ?? 0); if (v > m) m = v; }
      out[i] = m;
    }
    bgmPeaks = out;
  }

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
    const color = isHost ? '#ffffff' : '#64d2ff';

    if (arr) {
      g.fillStyle = color;
      const cy = AUD_Y + AUD / 2;
      const maxBh = (AUD - 6) / 2;
      const vx1 = Math.max(bx1 + 34, G); // keep the waveform clear of the music badge
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

    g.strokeStyle = p.mainAudio === 'constant' ? 'rgba(100,210,255,0.25)' : 'rgba(255,255,255,0.16)';
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
    bars(actH!, MAIN_Y, 0); bars(actC!, MAIN_Y, p.offsetMs);
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

    // ---- unified master video and audio rows (all clipped to 0 .. p.durationMs)
    drawMasterVideoTrack(g);
    drawAudioRow(g);
    rowsNow = tlRows();
    if (rowsNow.tlH !== minTlH) { minTlH = rowsNow.tlH; tl.style.height = `${Math.max(minTlH, tl.parentElement?.clientHeight ?? 0)}px`; requestDraw(); }
    drawMusicRow(g);
    drawSfxRow(g);
    drawTextRow(g);

    // silence found but not cut yet
    if (pendingCuts.length) {
      g.fillStyle = 'rgba(239,68,68,.38)';
      for (const r of pendingCuts) {
        const x1 = Math.max(G, xOf(r.startMs)), x2 = Math.min(W, xOf(r.endMs));
        if (x2 > x1) g.fillRect(x1, MAIN_Y, x2 - x1, AUD_Y + AUD - MAIN_Y);
      }
    }

    // sync snap guide
    if (snapMs !== null) {
      const sx = xOf(snapMs);
      g.fillStyle = CYAN; g.fillRect(sx - 0.75, MAIN_Y - 2, 1.5, AUD_Y + AUD - MAIN_Y + 4);
    }

    // ---- left column (lane icons), drawn over the clips
    g.fillStyle = '#000'; g.fillRect(0, RULER, G, H - RULER);
    // audio-source button (where CapCut has "Mute clip"): shows which mic is used; tap to switch Host / Constant
    {
      const col = p.mainAudio === 'host' ? '#ffffff' : '#64d2ff';
      g.save();
      g.save();
      const isz = 20;
      g.translate(G / 2 - 1 - isz / 2, MAIN_Y + 15 - isz / 2);
      g.scale(isz / 14, isz / 14);
      g.fillStyle = col;
      g.fill(VOICE_ICON, 'evenodd');
      g.restore();
      g.font = '600 9px Roboto, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = col;
      g.fillText(p.mainAudio === 'host' ? 'Host' : 'Constant', G / 2 - 1, MAIN_Y + LANE - 12);
      g.restore();
    }
    // left labels: Music, SFX and Text rows
    {
      const R = rowsNow;
      const label = (y: number, h: number, text: string, on: boolean, glyph: 'note' | 'bolt' | 'text') => {
        const cy = y + Math.min(h, SUB_M) / 2, col = on ? '#ffffff' : '#8a8a8a';
        g.save();
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.5; g.lineCap = 'round'; g.lineJoin = 'round';
        if (glyph === 'note') {
          g.beginPath(); g.arc(G / 2 - 12, cy + 4, 2.6, 0, Math.PI * 2); g.stroke();
          g.beginPath(); g.moveTo(G / 2 - 9.4, cy + 4); g.lineTo(G / 2 - 9.4, cy - 6); g.lineTo(G / 2 - 5, cy - 4); g.stroke();
        } else if (glyph === 'bolt') {
          g.beginPath(); g.moveTo(G / 2 - 9, cy - 6); g.lineTo(G / 2 - 13, cy + 1); g.lineTo(G / 2 - 10, cy + 1); g.lineTo(G / 2 - 11, cy + 6); g.lineTo(G / 2 - 7, cy - 1); g.lineTo(G / 2 - 10, cy - 1); g.closePath(); g.fill();
        } else {
          g.font = '700 12px Roboto, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('T', G / 2 - 10, cy);
        }
        g.font = '600 9px Roboto, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(text, G / 2 - 2, cy);
        g.restore();
      };
      label(R.music.y, R.music.h, 'Music', R.mus.length > 0, 'note');
      if (R.fx) label(R.fx.y, R.fx.h, 'SFX', true, 'bolt');
      if (R.text) label(R.text.y, R.text.h, 'Text', true, 'text');
    }
    // music-note badge: sits at the start of the audio clip and slides with the timeline; the waveform starts after it
    {
      const tx = xOf(0) + 4, ty = AUD_Y + (AUD - 26) / 2, cx = tx + 13, cy = ty + 13;
      if (tx + 26 > G && tx < W && tx + 26 < xOf(p.durationMs)) {
        g.save();
        g.beginPath(); g.rect(G, 0, W - G, H); g.clip();
        g.fillStyle = '#262626';
        g.beginPath(); g.roundRect(tx, ty, 26, 26, 6); g.fill();
        g.strokeStyle = '#8a8a8a'; g.lineWidth = 1.5; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); g.arc(cx - 2.5, cy + 5, 3, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(cx + 0.5, cy + 5); g.lineTo(cx + 0.5, cy - 6); g.lineTo(cx + 5, cy - 3.5); g.stroke();
        g.restore();
      }
    }

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

  // fling: after a quick swipe the timeline keeps gliding and slows down smoothly
  let dragStartPlayMs = 0;
  let flingRaf = 0;
  const dragSamples: { t: number; x: number }[] = [];
  function stopFling() { if (flingRaf) { cancelAnimationFrame(flingRaf); flingRaf = 0; } }
  function startFling(vPxPerMs: number) {
    stopFling();
    let v = vPxPerMs * 1000; // px per second, finger direction
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last); last = now;
      v *= Math.pow(0.94, dt / 16.67);
      const next = playMs - (v * dt / 1000 / pxPerSec) * 1000;
      const hitEdge = next <= 0 || next >= p.durationMs;
      scheduleScrub(next);
      if (Math.abs(v) < 25 || hitEdge) { flingRaf = 0; return; }
      flingRaf = requestAnimationFrame(step);
    };
    flingRaf = requestAnimationFrame(step);
  }

  let lastClientY = 0;
  const localX = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;
  const localY = (e: PointerEvent) => e.clientY - canvas.getBoundingClientRect().top;
  type Lane = 'ruler' | 'main' | 'audio' | 'music' | 'sfx' | 'text' | 'none';
  function laneAt(y: number): Lane {
    if (y < RULER) return 'ruler';
    if (y < MAIN_Y + LANE + GAP / 2) return 'main';
    if (y < AUD_Y + AUD + GAP / 2) return 'audio';
    const R = rowsNow;
    if (y < R.music.y + R.music.h + GAP / 2) return 'music';
    if (R.fx && y < R.fx.y + R.fx.h + GAP / 2) return 'sfx';
    if (R.text && y < R.text.y + R.text.h + GAP / 2) return 'text';
    return 'none';
  }
  function hitSegment(x: number): Segment | undefined {
    const ms = msOf(x);
    return p.segments.find((s) => ms >= s.startMs && ms < s.endMs);
  }
  function hitBoundary(x: number, y: number): number {
    if (y < MAIN_Y - 8 || y > MAIN_Y + LANE + 8) return -1;
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
    stopFling();
    startX = localX(e); startY = localY(e); startT = Date.now(); moved = false; lastClientY = e.clientY;
    dragStartPlayMs = playMs; dragSamples.length = 0; dragSamples.push({ t: performance.now(), x: startX });
    const lane = laneAt(startY);
    const bi = startX >= G ? hitBoundary(startX, startY) : -1;
    if (bi >= 0) { mode = 'boundary'; boundaryIdx = bi; hist.push(snap()); }
    else if (panel === 'sync' && startX >= G) {
      mode = 'clip'; clipStartMs0 = -p.offsetMs; clipPushed = false; clipBefore = structuredClone(snap());
    }
    else mode = 'scrub';
    clearTimeout(lpTimer);
    lpTimer = window.setTimeout(() => {
      if (moved || mode !== 'scrub' || laneAt(startY) !== 'main' || startX < G) return;
      const s = hitSegment(startX);
      if (s) { selectSeg(s.id); tick(); }
    }, 450);
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
      const targetMs = Math.max(0, Math.min(p.durationMs, dragStartPlayMs - ((x - startX) / pxPerSec) * 1000));
      scheduleScrub(targetMs);
      const nowT = performance.now();
      dragSamples.push({ t: nowT, x });
      while (dragSamples.length > 2 && nowT - dragSamples[0].t > 100) dragSamples.shift();
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
    if (mode === 'scrub' && moved && e.type === 'pointerup' && dragSamples.length >= 2) {
      const a0 = dragSamples[0], a1 = dragSamples[dragSamples.length - 1];
      const age = performance.now() - a1.t, span = a1.t - a0.t;
      if (span > 0 && age < 80) { const v = (a1.x - a0.x) / span; if (Math.abs(v) > 0.15) startFling(v); }
    }
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
    if (lane === 'music') { openMusic(rowsNow.mus.length ? 'bgm' : 'home'); return; }
    if (lane === 'sfx') { openMusic('sfx'); return; }
    if (lane === 'text') { openTexts(); return; }
    if (x < G) {
      if (lane === 'audio') {
        openAudioGroup();
      } else if (lane === 'main') {
        setAudio(p.mainAudio === 'host' ? 'constant' : 'host');
        if (panel === 'audio' || panel === 'denoise') renderPanel();
        if (toolGroup === 'audio') renderBar();
        toast(p.mainAudio === 'host' ? 'Audio: Host mic' : 'Audio: Constant mic', 1400);
      }
      return;
    }
    if (lane === 'main') {
      const s = hitSegment(x);
      if (s) {
        if (panel !== 'none') closePanel();
        selectSeg(s.id);
        tick();
      } else {
        selectedId = null;
        selClip = null;
        renderBar();
        draw();
        updateSelFrame();
      }
      return;
    }
    if (lane === 'audio') {
      openAudioGroup();
      return;
    }
    if (lane === 'ruler') {
      const ms = Math.max(0, Math.min(p.durationMs, msOf(x)));
      seek(ms);
      return;
    }
    selectedId = null;
    selClip = null;
    renderBar();
    draw();
    updateSelFrame();
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
    if (panel === 'audio' || panel === 'denoise') renderPanel();
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
  /** Which sub-toolbar is open (CapCut style: tap Music or Text and the bar swaps to its own tools with a back chevron). */
  let toolGroup: 'none' | 'music' | 'text' | 'audio' = 'none';
  const openGroup = (g: 'music' | 'text' | 'audio') => { toolGroup = g; renderBar(); tick(); };
  /** Tap on the audio row (or the Audio tool): the bar shows the sound tools of the mic that is the audio source. */
  function openAudioGroup() {
    if (panel !== 'none') closePanel();
    selectedId = null; selClip = null; toolGroup = 'audio';
    renderBar(); draw(); updateSelFrame(); tick();
  }
  const groupBack = () => h('button', { class: 'tool back', 'aria-label': 'Back', onclick: () => { toolGroup = 'none'; renderBar(); tick(); } }, icon('back', 20));
  const backTool = () => h('button', { class: 'tool back', 'aria-label': 'Back', onclick: () => { toolGroup = 'none'; selectedId = null; selClip = null; renderBar(); draw(); updateSelFrame(); tick(); } }, icon('back', 20));
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
      if (panel === 'audio' || panel === 'denoise') renderPanel();
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
        if (panel === 'audio' || panel === 'denoise') renderPanel();
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
    if (segs.length <= 1) toast('Could not tell the two people apart. Try Autoframe or cut by hand.');
    else if (lastUsedLips) toast(`Auto switch with lips + voice: ${segs.length} segments. Undo to go back.`);
    else if (lastMethod === 'voice') toast(`Auto switch by voice: ${segs.length} segments (quality ${lastVoiceQuality.toFixed(1)}). Wrong way round? Tap swap.`);
    else toast(`Auto switch by mic loudness: ${segs.length} segments (${lastSeparationDb.toFixed(1)} dB). Undo to go back.`);
  }

  let scanning = false, scanCancel = false;
  // ======================================================================= Faces + Autoframe
  const faceStale = (sc: FaceScan | undefined, startMs: number) => !sc || sc.startMs !== startMs || sc.n < Math.ceil(p.durationMs / FACE_SAMPLE_MS);
  const roleName = (r: Role) => (r === 'host' ? 'Host' : 'Constant');
  const faceScanOf = (r: Role) => (r === 'host' ? runtime.hostFaces : runtime.constFaces);

  /** Load a preview video again (it broke while playing fast) and wait until it is ready. */
  function reloadVideo(role: Role): Promise<void> {
    return new Promise((resolve) => {
      const v = vid(role);
      if (!curUrl[role]) { resolve(); return; }
      v.addEventListener('loadedmetadata', () => resolve(), { once: true });
      window.setTimeout(resolve, 6000);
      setSource(role, curUrl[role]);
    });
  }
  const reportLine = (name: string, r?: FaceReport) => r
    ? `${name}: ${r.samples}/${r.expected} frames, ${r.errors} errors${r.firstError ? ` (${r.firstError})` : ''}, ${r.delegate}, ${r.via}, ${Math.round(r.ms / 1000)}s`
    : `${name}: not scanned`;
  const noFaceMessage = () => `No face found. ${reportLine('Host', lastReport.host)}. ${reportLine('Constant', lastReport.constant)}.`;

  /**
   * Scans faces of both videos when that has not been done (or the sync offset changed).
   * The scan plays the editor's own two preview videos (fast, muted) instead of opening more videos:
   * a phone has only a few video decoders, and opening extra ones made the Host/Constant preview go black.
   */
  async function ensureFaces(): Promise<'ok' | 'cancel' | 'fail' | 'busy'> {
    const need: Role[] = [];
    if (faceStale(runtime.hostFaces, 0)) need.push('host');
    if (faceStale(runtime.constFaces, p.offsetMs)) need.push('constant');
    if (!need.length) return 'ok';
    const why = playReason();
    if (why || failed.host || failed.constant) { toast(why ?? 'A video is missing, so faces cannot be scanned.'); return 'busy'; }
    setPlaying(false);
    scanning = true; scanCancel = false; scanLock = true;
    const savedMs = playMs;
    startTask('faces', 'Loading face model', 0, { modal: true, cancel: () => { scanCancel = true; } });
    try {
      for (let k = 0; k < need.length; k++) {
        const role = need[k];
        const v = vid(role);
        v.style.visibility = ''; v.muted = true;
        const r = await scanFaces(v, role === 'host' ? 0 : p.offsetMs, p.durationMs,
          (x) => updateTask('faces', `Scanning faces${need.length > 1 ? ` (${k + 1}/${need.length})` : ''}`, (k * 100 + x) / need.length), () => scanCancel,
          role, () => reloadVideo(role));
        if (!r) return scanCancel ? 'cancel' : 'fail';
        if (role === 'host') runtime.hostFaces = r; else runtime.constFaces = r;
      }
      return 'ok';
    } catch { return 'fail'; } finally {
      endTask('faces'); scanning = false; scanLock = false;
      // give the preview back exactly as it was
      for (const r of ['host', 'constant'] as Role[]) { const v = vid(r); try { v.pause(); } catch { /* ignore */ } v.playbackRate = 1; }
      updateVideoAudioMute();
      if (!destroyed) {
        playMs = savedMs;
        // a video the fast play broke is loaded again and then seeks back to the playhead (setSource does that)
        for (const r of ['host', 'constant'] as Role[]) {
          const v = vid(r);
          if (!proxying[r] && curUrl[r] && (v.error || v.readyState === 0)) setSource(r, curUrl[r]);
        }
        syncHost(true); syncConst(true);
        refresh(); requestDraw();
      }
    }
  }

  function setMotionFromFaces() {
    if (runtime.hostFaces) runtime.hostMotion = motionFromScan(runtime.hostFaces, p.faceHost, p.durationMs);
    if (runtime.constFaces) runtime.constMotion = motionFromScan(runtime.constFaces, p.faceConst, p.durationMs);
  }

  /** Asks which person to follow in a video that shows more than one person. false = the user cancelled. */
  async function choosePeople(force: boolean): Promise<boolean> {
    for (const role of ['host', 'constant'] as Role[]) {
      const scan = faceScanOf(role);
      const key = role === 'host' ? 'faceHost' : 'faceConst';
      if (!scan || scan.tracks.length < 2) continue;
      if (!force && p[key]) continue;
      const r = await pickFace(`Follow who in ${roleName(role)}?`, scan, p[key]);
      if (r === undefined) return false;
      if (r === null) delete p[key]; else p[key] = r;
      scheduleSave();
    }
    return true;
  }

  /** "Faces" tool: scan, ask how the frame should follow people, then frame the current cuts. */
  async function doFaces() {
    if (scanning) return;
    const fr = await ensureFaces();
    if (fr === 'busy') return;
    if (fr === 'cancel') { toast('Scan cancelled'); return; }
    if (fr === 'fail') { toast('Face scan failed. Check the internet once (first run), or update the app.'); return; }
    const tracks = (runtime.hostFaces?.tracks.length ?? 0) + (runtime.constFaces?.tracks.length ?? 0);
    if (!tracks) { toast(noFaceMessage(), 12000); return; }
    const r = await askFaceOptions(p.aspect);
    if (!r) return;
    if (r.aspect !== p.aspect) { p.aspect = r.aspect; fitStage(); applyLayout(segmentAt(p.segments, playMs)); }
    const multi = (runtime.hostFaces?.tracks.length ?? 0) > 1 || (runtime.constFaces?.tracks.length ?? 0) > 1;
    if (multi && app.settings.faceFollow === 'picked' && !(await choosePeople(true))) return;
    setMotionFromFaces();
    edit(frameSegments(p.segments)); afterEdit(); draw(); scheduleSave();
    toast(app.settings.faceFollow === 'picked' ? 'Framed the picked people. Undo to go back.' : 'Frame now follows whoever talks. Undo to go back.');
  }

  /**
   * Crop of every clip so the followed person is centred with headroom for the chosen ratio.
   * With "Active speaker" a camera that shows several people is split where the talker changes, and the crop either
   * jumps (cut) or glides in small steps (smooth). Steps are tiny clips with slightly different crops, so preview and
   * export look the same.
   */
  function frameSegments(input: Segment[]): Segment[] {
    const st = app.settings;
    const mode = st.faceMode ?? 'smooth';
    const speedMs = Math.max(100, st.faceSpeedMs ?? 600);
    const frac = st.faceTight === 'wide' ? 0.32 : st.faceTight === 'close' ? 0.6 : 0.45;
    const a0 = aspectValue(p.aspect);
    // earlier face splits are rebuilt from scratch: join neighbours that only differ by crop
    const segs: Segment[] = [];
    for (const sg of input) {
      const last = segs[segs.length - 1];
      if (last && last.style === sg.style && last.main === sg.main && last.corner === sg.corner && last.size === sg.size && Math.abs(last.endMs - sg.startMs) < 2) {
        last.endMs = sg.endMs;
        if (last.cropHost || last.cropConst) { delete last.cropHost; delete last.cropConst; }
      } else segs.push({ ...sg });
    }
    const out: Segment[] = [];
    type Key = { t: number; crop: CropState };
    for (const sg of segs) {
      const visible: Role[] = sg.style === 'one' ? [sg.main] : ['host', 'constant'];
      const slot = sg.style === 'side' ? a0 / 2 : sg.style === 'updown' ? a0 * 2 : a0;
      const keys: Record<Role, Key[]> = { host: [], constant: [] };
      for (const role of ['host', 'constant'] as Role[]) {
        const scan = faceScanOf(role);
        if (!scan) continue;
        const k = CK(role);
        const mirrored = role === 'host' ? p.mirrorHost : p.mirrorConst;
        const base = sg[k] ?? p[k];
        const make = (track: ReturnType<typeof pickTrack>, from: number, to: number): CropState | null => {
          const face = faceBetween(track, scan.sampleMs, from, to);
          if (!face) return null;
          const c = cropForFace(face, scan.aspect, slot, mirrored, base, frac);
          c.ratio = 'custom'; delete c.frameRatio;
          return c;
        };
        const picked = pickTrack(scan, role === 'host' ? p.faceHost : p.faceConst);
        if (visible.includes(role) && st.faceFollow !== 'picked' && scan.tracks.length >= 2) {
          for (const run of speakerRuns(scan, sg.startMs, sg.endMs, 1200)) {
            const c = make(run.track, run.startMs, run.endMs);
            if (c) keys[role].push({ t: run.startMs, crop: c });
          }
        } else {
          const c = make(picked, sg.startMs, sg.endMs);
          if (c) keys[role].push({ t: sg.startMs, crop: c });
        }
      }
      // cut points: segment edges, every talker change, and (glide) a few steps after each change
      const steps = Math.max(2, Math.min(8, Math.round(speedMs / 100)));
      const cuts = new Set<number>([sg.startMs, sg.endMs]);
      for (const role of ['host', 'constant'] as Role[]) {
        keys[role].forEach((kk, i) => {
          if (i === 0) return;
          cuts.add(Math.round(kk.t));
          if (mode === 'smooth') for (let j = 1; j < steps; j++) { const t = Math.round(kk.t + (speedMs * j) / steps); if (t < sg.endMs) cuts.add(t); }
        });
      }
      const times = [...cuts].filter((t) => t >= sg.startMs && t <= sg.endMs).sort((x, y) => x - y);
      const ease = (u: number) => u * u * (3 - 2 * u);
      const cropAt = (role: Role, t: number): CropState | undefined => {
        const ks = keys[role];
        if (!ks.length) return undefined;
        let i = 0;
        while (i + 1 < ks.length && ks[i + 1].t <= t) i++;
        const cur = ks[i];
        if (mode !== 'smooth' || i === 0) return cur.crop;
        const u = Math.min(1, (t - cur.t) / speedMs);
        if (u >= 1) return cur.crop;
        const pv = ks[i - 1].crop, e = ease(Math.max(0, u));
        return { ...cur.crop, zoom: pv.zoom + (cur.crop.zoom - pv.zoom) * e, x: pv.x + (cur.crop.x - pv.x) * e, y: pv.y + (cur.crop.y - pv.y) * e };
      };
      for (let i = 0; i + 1 < times.length; i++) {
        const a = times[i], b = times[i + 1];
        if (b - a < 30 && out.length) { out[out.length - 1].endMs = b; continue; }
        const piece: Segment = { ...sg, id: i === 0 ? sg.id : uid(), startMs: a, endMs: b };
        const mid = (a + b) / 2;
        for (const role of ['host', 'constant'] as Role[]) { const c = cropAt(role, mid); if (c) piece[CK(role)] = c; }
        out.push(piece);
      }
      if (times.length < 2) out.push({ ...sg });
    }
    return out;
  }

  /** One tap: find the faces, cut to whoever speaks like Auto switch does, and frame that person in every clip. */
  async function doAutoframe() {
    if (scanning || !needAudio()) return;
    const fr = await ensureFaces();
    if (fr === 'busy') return;
    if (fr === 'cancel') { toast('Scan cancelled'); return; }
    if (fr === 'fail') { toast('Face scan failed. Check the internet once (first run), or update the app. Use Auto switch for now.'); return; }
    if (app.settings.faceFollow === 'picked' && !(await choosePeople(false))) return;
    setMotionFromFaces();
    const keep = coverage(p.segments); // parts removed by silence cut stay removed
    // Host / Constant: lips + audio together (default), lips only, or audio only (like Auto switch).
    const by = app.settings.autoframeBy ?? 'both';
    let how = by === 'both' ? 'lips + audio' : by === 'lips' ? 'lips' : 'audio';
    let segs = (by !== 'audio' && runtime.hostMotion && runtime.constMotion)
      ? detectByFaces(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs, app.settings,
        { host: runtime.hostMotion, constant: runtime.constMotion }, by === 'both' ? 0.9 : 0.2)
      : null;
    if (!segs) {
      segs = detectSpeakers(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs, app.settings, p.mainAudio);
      how = (by === 'audio' ? '' : 'no lips found, ') + (lastMethod === 'voice' ? 'voice' : `mic loudness ${lastSeparationDb.toFixed(1)} dB`);
    }
    segs = polishCuts(segs, app.settings.ignoreShortMs ?? 1500, app.settings.leadInMs ?? 300);
    const clipped = keep.length ? intersectRanges(segs, keep) : segs;
    if (clipped.length) segs = clipped;
    const cameraSegs = segs.length;
    const found = (runtime.hostFaces?.tracks.length ?? 0) + (runtime.constFaces?.tracks.length ?? 0);
    segs = frameSegments(segs);
    edit(segs); selectedId = segs[0]?.id ?? null; afterEdit(); draw();
    if (!found) toast(noFaceMessage(), 12000);
    else if (cameraSegs <= 1) toast('Framed the face. Could not tell the two people apart for cutting.');
    else toast(`Autoframe (${how}): ${cameraSegs} camera cuts, ${segs.length} parts with faces centred. Undo to go back.`, 6000);
  }

  // ======================================================================= Captions, reactions, auto zoom
  function drawCaptionsPreview() {
    const g = capCanvas.getContext('2d');
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(stage.clientWidth * dpr), hh = Math.round(stage.clientHeight * dpr);
    if (!w || !hh) return;
    if (capCanvas.width !== w || capCanvas.height !== hh) { capCanvas.width = w; capCanvas.height = hh; }
    g.clearRect(0, 0, w, hh);
    for (const it of p.texts ?? []) {
      if (playMs < it.s || playMs >= it.e) continue;
      const pg = textPage(it);
      if (pg.words.length) drawCaption(g, w, hh, pg, playMs, textStyleOf(it));
    }
    if (!p.captions?.words.length) return;
    const st = p.captionStyle ?? DEFAULT_CAPTION_STYLE;
    const key = `${p.captions.words.length}|${JSON.stringify(st)}|${p.captions.words[0].w}|${p.captions.words[p.captions.words.length - 1].w}|${capVersion}`;
    if (key !== capKey) { capKey = key; capPages = buildPages(p.captions, st); }
    const page = pageAt(capPages, playMs);
    if (page) drawCaption(g, w, hh, page, playMs, st);
  }

  /** Whisper on the main audio, shifted so that time 0 is timeline 0. */
  async function generateCaptions(lang: string, model: WhisperModel): Promise<boolean> {
    if (!needAudio()) return false;
    const role = p.mainAudio;
    const src = cleanedPcm(role) ?? sourcePcm(role);
    if (!src) { toast('Audio is still being read. Try again in a moment.'); return false; }
    const per = SAMPLE_RATE / 1000;
    const shiftS = role === 'host' ? 0 : Math.round(p.offsetMs * per);
    let pcm: Float32Array;
    if (shiftS >= 0) pcm = src.subarray(shiftS, shiftS + Math.ceil(p.durationMs * per));
    else { pcm = new Float32Array(Math.ceil(p.durationMs * per)); pcm.set(src.subarray(0, Math.max(0, pcm.length + shiftS)), -shiftS); }
    setPlaying(false);
    const job = transcribe(pcm, model, lang, (text, pct) => updateTask('captions', text, pct ?? undefined));
    startTask('captions', 'Making captions', 0, { modal: true, cancel: () => job.cancel() });
    try {
      const data = await job.promise;
      if (!data.words.length) { toast('No speech found.'); return false; }
      p.captions = data;
      p.captionStyle ??= { ...DEFAULT_CAPTION_STYLE };
      capVersion++;
      scheduleSave(); drawCaptionsPreview();
      toast(`Captions ready: ${data.words.length} words. Style them in Text.`);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Captions failed.';
      toast(msg === 'cancelled' ? 'Cancelled' : `Captions failed: ${msg}`, 8000);
      return false;
    } finally { endTask('captions'); }
  }
  function openCaptions() {
    openCaptionSheet({
      p, settings: app.settings,
      generate: generateCaptions,
      changed: () => { capVersion++; drawCaptionsPreview(); scheduleSave(); },
      remove: () => { delete p.captions; capVersion++; drawCaptionsPreview(); scheduleSave(); },
      seek: (ms) => seek(ms),
    });
  }

  function openTexts() {
    openTextItemsSheet({
      p, playMs: () => playMs, durationMs: () => p.durationMs,
      changed: () => { drawCaptionsPreview(); scheduleSave(); },
      seek: (ms) => seek(ms),
    });
  }

  function doReactionTool() {
    if (!needAudio()) return;
    openReactionSheet({
      settings: app.settings,
      segments: () => p.segments,
      durationMs: () => p.durationMs,
      seek: (ms) => seek(ms),
      remove: (id) => { edit(removeReaction(p.segments, id)); },
      removeAll: () => { edit(removeAllReactions(p.segments)); },
      add: () => {
        const visible = (role: Role, ms: number) => {
          const sc = faceScanOf(role);
          if (!sc) return true;
          const i = Math.min(sc.n - 1, Math.max(0, Math.floor(ms / sc.sampleMs)));
          return sc.tracks.some((t) => !Number.isNaN(t.cx[i]));
        };
        const segs = addReactions(removeAllReactions(p.segments), runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs,
          { afterMs: app.settings.reactAfterMs ?? 8000, lengthMs: app.settings.reactLengthMs ?? 1500 }, visible);
        edit(segs);
        const n = segs.filter((s) => s.reaction).length;
        if (!n) toast('No long talking part found. Try a shorter "After talking for".');
        return n;
      },
    });
  }

  async function doAutoZoom() {
    if (!needAudio()) return;
    const shape = await askAutoZoom(app.settings);
    if (!shape) return;
    const host = p.mainAudio === 'host';
    const pcm = host ? runtime.hostPcm! : runtime.constPcm!;
    const peaks = findPeaks(pcm, host ? 0 : Math.round(p.offsetMs / 100), p.durationMs, 5000, 5);
    const before = p.segments.length;
    const segs = addPunchZooms(p.segments, peaks, shape, (sg, role) => sg[CK(role)] ?? p[CK(role)]);
    if (segs.length === before) { toast('No good moment found for a zoom.'); return; }
    edit(segs);
    toast(`Auto zoom added on ${peaks.length} loud moments. Undo to go back.`);
  }

  // ======================================================================= Music (BGM + effects)

  function stopBgm() {
    const s = bgmSource;
    bgmSource = null;
    if (!s) return;
    try { s.stop(); } catch { /* already ended */ }
    try { s.disconnect(); } catch { /* already disconnected */ }
  }
  /** The baked music track plays from the playhead, in step with the video. */
  function startBgm() {
    if (!playing || !p.bgm) return;
    if (!bgmBuffer) {
      if (bgmLoading) return;
      bgmLoading = true;
      if (!ensureGraph() || !actx) { bgmLoading = false; return; }
      const ctx = actx;
      fetch(fileSrc(p.bgm.path)).then((r) => r.arrayBuffer()).then((ab) => ctx.decodeAudioData(ab))
        .then((b) => { bgmBuffer = b; computeBgmPeaks(b); draw(); bgmLoading = false; if (playing) startBgm(); })
        .catch(() => { bgmLoading = false; toast('Could not load the music track. Make it again in Music.'); });
      return;
    }
    if (!ensureGraph() || !actx) return;
    const offset = Math.max(0, playMs) / 1000;
    const duration = Math.min(bgmBuffer.duration - offset, Math.max(0, p.durationMs - playMs) / 1000);
    if (duration <= 0) return;
    const src = actx.createBufferSource();
    src.buffer = bgmBuffer;
    src.connect(fxNodes.master?.input ?? actx.destination);
    bgmSource = src;
    src.onended = () => { if (bgmSource === src) bgmSource = null; try { src.disconnect(); } catch { /* ok */ } };
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    src.start(actx.currentTime, offset, duration);
  }

  /** Mixes the picked songs and effects under the voice and saves one wav. */
  async function makeMusic(o: { levelDb: number; duckDb: number; fadeMs: number; clipDb: number; clipDuck: boolean }): Promise<boolean> {
    if (!ensureGraph() || !actx) { toast('Audio is not ready yet. Try again in a moment.'); return false; }
    const role = p.mainAudio;
    const voice = sourcePcm(role);
    startTask('music', 'Making music track', 5, { modal: true });
    const yieldUi = () => new Promise<void>((r) => setTimeout(r, 30));
    try {
      await yieldUi();
      const mix = renderMix({
        songs: songFiles.map((s) => s.buf),
        sfx: sfxFiles.map((s) => ({ buf: s.buf, startMs: s.startMs, gain: s.auto ? (app.settings.sfxLevel ?? 55) / 100 : 1 })),
        clips: clipFiles.map((c) => ({ buf: c.buf, startMs: c.startMs, endMs: c.endMs, loop: c.loop, levelDb: c.kind === 'bgm' ? o.levelDb : o.clipDb, duck: c.kind === 'bgm' ? true : o.clipDuck })),
        durationMs: p.durationMs, voice, voiceShiftMs: role === 'host' ? 0 : p.offsetMs,
        levelDb: o.levelDb, duckDb: o.duckDb, fadeMs: o.fadeMs,
      });
      updateTask('music', 'Saving music track', 30);
      await yieldUi();
      const wav = toWav(mix);
      const name = `bgm_${p.id}.wav`;
      const CH = 1_500_000;
      let path = '';
      for (let at = 0; at < wav.length; at += CH) {
        const r = await EditorrNative.writeBytes({ name, data: toBase64(wav.subarray(at, at + CH)), append: at > 0 });
        path = r.path;
        updateTask('music', 'Saving music track', 30 + Math.round((at / wav.length) * 65));
      }
      const buf = actx.createBuffer(1, mix.length, BGM_RATE);
      buf.getChannelData(0).set(mix);
      bgmBuffer = buf;
      computeBgmPeaks(buf);
      const items = [
        ...(songFiles.length ? [{ name: songFiles.map((s) => s.name).join(' + '), startMs: 0, endMs: p.durationMs, kind: 'bgm' as const }] : []),
        ...clipFiles.map((c) => ({ name: c.name, startMs: c.startMs, endMs: Math.min(p.durationMs, c.endMs ?? c.startMs + Math.round(c.buf.duration * 1000)), kind: (c.kind ?? 'music') as 'bgm' | 'music', mood: c.mood })),
        ...sfxFiles.map((s) => ({ name: s.name, startMs: s.startMs, endMs: s.startMs + Math.round(s.buf.duration * 1000), kind: 'sfx' as const })),
      ];
      p.bgm = { items, path, names: [...songFiles.map((s) => s.name), ...clipFiles.map((c) => c.name), ...sfxFiles.map((s) => s.name)], levelDb: o.levelDb, duckDb: o.duckDb, fadeMs: o.fadeMs, sfx: sfxFiles.map((s) => ({ name: s.name, startMs: s.startMs })) };
      scheduleSave();
      draw();
      toast('Music added. It plays under the voice and is in the export.');
      return true;
    } catch (error) {
      toast(`Music failed: ${error instanceof Error ? error.message : 'unknown error'}`, 8000);
      return false;
    } finally { endTask('music'); }
  }

  function clearMusic() { stopBgm(); stopPreview(); delete p.bgm; bgmBuffer = null; bgmPeaks = null; draw(); songFiles.length = 0; sfxFiles.length = 0; clipFiles.length = 0; scheduleSave(); toast('Music removed.'); }

  function stopPreview() {
    const s = prevSrc;
    prevSrc = null;
    if (!s) return;
    try { s.stop(); } catch { /* already ended */ }
    try { s.disconnect(); } catch { /* already disconnected */ }
  }
  /** Plays the first seconds of the n-th Auto BGM song so it can be heard before Apply. */
  function previewAuto(n: number): boolean {
    const c = clipFiles.filter((x) => x.kind === 'bgm')[n];
    if (!c || !ensureGraph() || !actx) return false;
    stopPreview();
    const src = actx.createBufferSource();
    src.buffer = c.buf;
    const gain = actx.createGain();
    gain.gain.value = 0.6;
    src.connect(gain); gain.connect(actx.destination);
    prevSrc = src;
    src.onended = () => { if (prevSrc === src) prevSrc = null; try { src.disconnect(); gain.disconnect(); } catch { /* ok */ } };
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    src.start(actx.currentTime, 0, 25);
    return true;
  }

  /** Auto BGM: find the mood of each part of the video, get a song for it (YouTube, else made on the phone). */
  async function autoBgm(o: { lang: MusicLang; status: (s: string) => void }): Promise<AutoPlan | null> {
    if (p.durationMs < 3000) { toast('The video is too short for music.'); return null; }
    stopPreview();
    const role = p.mainAudio;
    o.status('Listening to your video...');
    await new Promise<void>((r) => setTimeout(r, 30));
    const sections = analyzeMood(sourcePcm(role), role === 'host' ? 0 : p.offsetMs, p.durationMs, p.captions?.words);
    for (let i = clipFiles.length - 1; i >= 0; i--) if (clipFiles[i]!.kind === 'bgm') clipFiles.splice(i, 1);
    const plan: AutoPlan = [];
    const used = new Set<string>();
    let ytOk = await youtubeAvailable();
    let why = ytOk ? '' : 'YouTube works only in the Android app.';
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!;
      const label = `${i + 1}/${sections.length} ${MOOD_LABEL[s.mood]}`;
      let done = false;
      if (ytOk) {
        try {
          o.status(`${label}: searching YouTube...`);
          // Try several searches; take the best length first (1-8 min), then anything up to 25 min. Try the next song if one fails.
          const base = moodQuery(s.mood, o.lang);
          const queries = [base, `${base} 3 minutes`, `${MOOD_LABEL[s.mood].toLowerCase()} instrumental music no copyright`];
          type Cand = { id: string; title: string; durationMs: number };
          const cands: Cand[] = [];
          for (const q of queries) {
            const r = await EditorrNative.youtubeSearch({ query: q, ccOnly: false });
            for (const it of r.items as Cand[]) if (!used.has(it.id) && !cands.some((c) => c.id === it.id) && it.durationMs >= 30_000 && it.durationMs <= 25 * 60_000) cands.push(it);
            if (cands.some((c) => c.durationMs >= 60_000 && c.durationMs <= 8 * 60_000)) break;
          }
          const tier = (c: Cand) => (c.durationMs >= 60_000 && c.durationMs <= 8 * 60_000 ? 0 : 1);
          cands.sort((a, b) => tier(a) - tier(b));
          if (!cands.length) throw new Error('No suitable song found.');
          let got: { pick: Cand; d: { path: string; title: string }; buf: AudioBuffer } | null = null;
          for (const pick of cands.slice(0, 3)) {
            try {
              o.status(`${label}: downloading ${pick.title.slice(0, 30)}...`);
              const d = await EditorrNative.youtubeDownload({ id: pick.id });
              got = { pick, d, buf: await decodeUrl(fileSrc(d.path)) };
              break;
            } catch (error) { why = error instanceof Error ? error.message : String(error); }
          }
          if (!got) throw new Error(why || 'No song could be downloaded.');
          const { pick, d, buf } = got;
          used.add(pick.id);
          const title = d.title || pick.title;
          clipFiles.push({ name: title, buf, startMs: s.startMs, endMs: s.endMs, loop: buf.duration * 1000 < s.endMs - s.startMs, kind: 'bgm', mood: s.mood });
          plan.push({ ...s, title, source: 'youtube' });
          done = true;
        } catch (error) {
          why = error instanceof Error ? error.message : String(error);
          if (!/no suitable/i.test(why)) ytOk = false;
        }
      }
      if (!done) {
        o.status(`${label}: making music on the phone...`);
        await new Promise<void>((r) => setTimeout(r, 30));
        const title = `${MOOD_LABEL[s.mood]} music (made here)`;
        clipFiles.push({ name: title, buf: toBuffer(synthLoop(s.mood, 3 + i)), startMs: s.startMs, endMs: s.endMs, loop: true, kind: 'bgm', mood: s.mood });
        plan.push({ ...s, title, source: 'built-in', note: why });
      }
    }
    return plan;
  }

  /** A downloaded effect: only the loudest hit is kept (no silence, no second sound after it), with a tiny fade in and a soft fade out.
   *  peakMs = where the loudest part is inside the clip, so the effect can be placed with its peak on the cut. */
  function tidySfx(buf: AudioBuffer, maxS = 4): { buf: AudioBuffer; peakMs: number } {
    const d = buf.getChannelData(0);
    const F = Math.round(0.01 * BGM_RATE), nF = Math.floor(d.length / F);
    if (nF < 3) return { buf, peakMs: 0 };
    const env = new Float32Array(nF);
    for (let i = 0; i < nF; i++) { let m = 0; for (let k = i * F; k < (i + 1) * F; k += 4) m = Math.max(m, Math.abs(d[k] ?? 0)); env[i] = m; }
    let pk = 0; for (let i = 1; i < nF; i++) if (env[i]! > env[pk]!) pk = i;
    const peak = Math.max(env[pk]!, 1e-6);
    let from = pk; while (from > 0 && env[from - 1]! > peak * 0.1 && pk - from < 90) from--;
    from = Math.max(0, from - 2);
    let to = pk, quiet = 0;
    const maxF = Math.round(maxS * 100);
    while (to < nF - 1 && to - from < maxF) {
      to++;
      if (env[to]! < peak * 0.06) { if (++quiet >= 6) { to -= 5; break; } } else quiet = 0;
    }
    to = Math.max(to, Math.min(nF - 1, pk + 12));
    const out = d.slice(from * F, Math.min(d.length, (to + 1) * F));
    const fin = Math.min(out.length, Math.round(0.004 * BGM_RATE));
    const fout = Math.min(Math.floor(out.length / 3), Math.round(0.12 * BGM_RATE));
    for (let k = 0; k < fin; k++) out[k] *= k / fin;
    for (let k = 0; k < fout; k++) out[out.length - 1 - k] *= k / fout;
    return { buf: toBuffer(out), peakMs: (pk - from) * 10 };
  }

  /** Auto SFX: a whoosh where the layout changes, a soft pop where the camera moves to the other person.
   *  The sounds come from YouTube; a sound made on the phone is used only when YouTube does not work. */
  async function autoSfx(o: { status: (s: string) => void }): Promise<{ count: number; fromYoutube: number; note?: string }> {
    for (let i = sfxFiles.length - 1; i >= 0; i--) if (sfxFiles[i]!.auto) sfxFiles.splice(i, 1);
    const cuts: { kind: SfxKind; startMs: number }[] = [];
    let last = -1e9;
    for (let i = 1; i < p.segments.length && cuts.length < 40; i++) {
      const a = p.segments[i - 1]!, b = p.segments[i]!;
      const kind: SfxKind | null = a.style !== b.style ? 'whoosh' : a.main !== b.main ? 'pop' : null;
      if (!kind || b.startMs - last < 2500) continue;
      cuts.push({ kind, startMs: b.startMs });
      last = b.startMs;
    }
    if (!cuts.length) return { count: 0, fromYoutube: 0 };

    let ytOk = await youtubeAvailable();
    let note = ytOk ? '' : 'YouTube works only in the Android app.';
    let fromYoutube = 0;
    const variants = new Map<SfxKind, { name: string; buf: AudioBuffer; peakMs: number }[]>();
    for (const kind of new Set(cuts.map((c) => c.kind))) {
      const list: { name: string; buf: AudioBuffer; peakMs: number }[] = [];
      if (ytOk) {
        try {
          o.status(`Searching YouTube for ${kind === 'whoosh' ? 'whoosh' : 'pop'} sounds...`);
          const r = await EditorrNative.youtubeSearch({ query: kind === 'whoosh' ? 'whoosh transition sound effect' : 'pop click sound effect', ccOnly: false, shortOnly: true, maxSeconds: 20 });
          const picks = r.items.filter((it: { durationMs: number }) => it.durationMs >= 300 && it.durationMs <= 12_000).slice(0, 4);
          if (!picks.length) throw new Error('No suitable sound found.');
          for (const pick of picks) {
            if (list.length >= 2) break;
            try {
              o.status(`Downloading ${pick.title.slice(0, 28)}...`);
              const d = await EditorrNative.youtubeDownload({ id: pick.id });
              list.push({ name: d.title || pick.title, ...tidySfx(await decodeUrl(fileSrc(d.path)), kind === 'whoosh' ? 1.4 : 0.7) });
            } catch (error) { note = error instanceof Error ? error.message : String(error); }
          }
          if (!list.length) throw new Error(note || 'No sound could be downloaded.');
        } catch (error) {
          note = error instanceof Error ? error.message : String(error);
          if (!/no suitable/i.test(note)) ytOk = false;
        }
      }
      if (!list.length) list.push({ name: SFX_LABEL[kind], ...tidySfx(toBuffer(synthSfx(kind)), 3) });
      variants.set(kind, list);
    }
    const count: Record<string, number> = {};
    for (const c of cuts) {
      const list = variants.get(c.kind)!;
      const n = count[c.kind] = (count[c.kind] ?? -1) + 1;
      const v = list[n % list.length]!;
      // the loudest part of the effect lands exactly on the cut (a whoosh may start up to 0.9 s before it, a pop starts right on it)
      const lead = Math.min(v.peakMs, c.kind === 'whoosh' ? 900 : 40);
      sfxFiles.push({ name: v.name, buf: v.buf, startMs: Math.max(0, c.startMs - lead), auto: true });
      if (v.name !== SFX_LABEL[c.kind]) fromYoutube++;
    }
    return { count: cuts.length, fromYoutube, ...(fromYoutube < cuts.length && note ? { note } : {}) };
  }

  /** Hear the n-th effect of the list (first seconds). */
  function previewSfx(n: number): boolean {
    const c = sfxFiles[n];
    if (!c || !ensureGraph() || !actx) return false;
    stopPreview();
    const src = actx.createBufferSource();
    src.buffer = c.buf;
    const gain = actx.createGain();
    gain.gain.value = 0.8;
    src.connect(gain); gain.connect(actx.destination);
    prevSrc = src;
    src.onended = () => { if (prevSrc === src) prevSrc = null; try { src.disconnect(); gain.disconnect(); } catch { /* ok */ } };
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    src.start(actx.currentTime, 0, 6);
    return true;
  }

  function openMusic(start: 'home' | 'bgm' | 'music' | 'sfx' = 'home') {
    openMusicSheet({
      p, playMs: () => playMs, songs: songFiles, sfx: sfxFiles, clips: clipFiles,
      autoBgm, autoSfx, previewAuto, previewSfx, stopPreview,
      addSfxFromPath: async (path, title, startMs) => {
        try { sfxFiles.push({ name: title, buf: tidySfx(await decodeUrl(fileSrc(path)), 6).buf, startMs }); } catch { toast(`Cannot play the audio of ${title}.`, 5000); throw new Error('decode'); }
      },
      addSongs: async (files) => {
        for (const f of files) {
          try { songFiles.push({ name: f.name, buf: await decodeFile(f) }); } catch { toast(`Cannot read ${f.name}. Pick an mp3, m4a, wav or ogg file.`, 5000); }
        }
      },
      addSongFromPath: async (path, title) => {
        try { songFiles.push({ name: title, buf: await decodeUrl(fileSrc(path)) }); } catch { toast(`Cannot play the audio of ${title}.`, 5000); throw new Error('decode'); }
      },
      addClip: async (file, startMs) => {
        try { clipFiles.push({ name: file.name, buf: await decodeFile(file), startMs }); } catch { toast(`Cannot read ${file.name}. Pick an mp3, m4a, wav or ogg file.`, 5000); }
      },
      addClipFromPath: async (path, title, startMs) => {
        try { clipFiles.push({ name: title, buf: await decodeUrl(fileSrc(path)), startMs }); } catch { toast(`Cannot play the audio of ${title}.`, 5000); throw new Error('decode'); }
      },
      removeClip: (i) => { clipFiles.splice(i, 1); },
      addSfx: async (file, startMs) => {
        try { sfxFiles.push({ name: file.name, buf: await decodeFile(file), startMs }); } catch { toast(`Cannot read ${file.name}.`, 5000); }
      },
      removeSong: (i) => { songFiles.splice(i, 1); },
      removeSfx: (i) => { sfxFiles.splice(i, 1); },
      apply: makeMusic,
      clear: clearMusic,
      preview: () => { if (playing) startCleanAudio(); },
    }, app.settings, () => { void saveSettings(app.settings); }, start);
  }

  /** Enhanced Audio studio (EQ, de-esser, compressor, limiter, presets). The sheet stays see-through so the video can keep playing. */
  function openFx() {
    openFxSheet({
      p,
      changed: () => { applyVolume(); scheduleSave(); },
      setBypass: (on) => { fxBypass = on; applyFx(); },
      getNoise: (role) => noiseStrength(role),
      setNoise: (role, v) => { void applyNoiseReduction(role, v); },
    });
  }

  /** Audio > Split: cut the timeline at the playhead (the sound follows the video parts) and stay in the Audio tools. */
  function doSplitAudio() { edit(splitAt(p.segments, playMs)); selectedId = null; renderBar(); draw(); tick(); }
  /** Audio > Delete: take the sound of the mic that is the audio source out (volume 0 %). Volume brings it back. */
  async function doDeleteAudio() {
    const host = p.mainAudio === 'host';
    if (!(await confirmDialog(`Delete ${host ? 'Host' : 'Constant'} audio?`, 'The sound of this mic is removed (volume 0%). Set the volume again in Volume to bring it back.', 'Delete'))) return;
    if (host) p.volumeHost = 0; else p.volumeConst = 0;
    applyVolume(); scheduleSave(); draw(); toast(`${host ? 'Host' : 'Constant'} audio removed. Volume brings it back.`);
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
    if (!hasClipSel && !hasSegSel && toolGroup === 'music') {
      rows.push(groupBack(),
        tool('wand', 'Auto BGM', () => openMusic('bgm')),
        tool('note', 'Music', () => openMusic('music')),
        tool('bolt', 'SFX', () => openMusic('sfx')),
        ...(p.bgm ? [tool('trash', 'Remove', () => { clearMusic(); renderBar(); })] : []));
    } else if (!hasClipSel && !hasSegSel && toolGroup === 'audio') {
      rows.push(groupBack(),
        tool('volume', 'Volume', () => openPanel('audio')),
        tool('scissors', 'Split', doSplitAudio),
        tool('wand', 'Denoise', () => openPanel('denoise')),
        tool('enhance', 'Enhanced', openFx),
        tool('silence', 'Silence', () => openPanel('silence')),
        tool('trash', 'Delete', () => void doDeleteAudio()));
    } else if (!hasClipSel && !hasSegSel && toolGroup === 'text') {
      rows.push(groupBack(),
        tool('text', 'Add text', openTexts),
        tool('wand', 'Auto captions', openCaptions));
    } else if (!hasClipSel && !hasSegSel) {
      // nothing selected: the main tools, like CapCut's first row
      rows.push(
        tool('sync', 'Sync', () => { selClip = 'constant'; selectedId = null; openPanel('sync'); updateSelFrame(); }),
        tool('switchSlider', 'Auto switch', () => doAutoSwitch(false)),
        tool('autoframe', 'Autoframe', doAutoframe),
        tool('face', 'Faces', doFaces),
        tool('text', 'Text', () => openGroup('text')),
        tool('reaction', 'Reaction', doReactionTool),
        tool('punch', 'Auto zoom', doAutoZoom),
        tool('note', 'Music', () => openGroup('music')),
        tool('silence', 'Silence', () => openPanel('silence')),
        tool('layout', 'Layout', () => openPanel('layout')),
        tool('user', 'On screen', () => openPanel('main')),
        tool('volume', 'Audio', openAudioGroup),
        tool('crop', 'Crop', () => openPanel('crop')),
        tool('mask', 'Mask', () => openPanel('mask')),
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
        tool('mask', 'Mask', () => { const r = selClip!; openPanel('mask'); cropRole = r; renderPanel(); }),
        tool('mirror', 'Mirror', () => { if (selClip) toggleMirror(selClip); }),
        tool('volume', 'Audio', openAudioGroup));
      if (selClip === 'constant') rows.push(tool('sync', 'Sync', () => openPanel('sync')));
    } else {
      // a segment is selected: the bar swaps to segment tools with a back chevron (CapCut)
      rows.push(backTool(),
        tool('scissors', 'Split', doSplit),
        tool('layout', 'Layout', () => openPanel('layout')),
        tool('user', 'On screen', () => openPanel('main')),
        tool('volume', 'Audio', openAudioGroup),
        tool('crop', 'Crop', () => openPanel('crop')),
        tool('mask', 'Mask', () => openPanel('mask')),
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
    if (n === 'crop' || n === 'mask') {
      const sg = segmentAt(p.segments, playMs);
      cropRole = sg?.main ?? 'host';
      lastCropKey = sg ? `${sg.id}|${sg.style}|${sg.main}` : '';
    }
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
    const paintFill = () => { const span = max - min || 1; input.style.setProperty('--fill', `${((parseFloat(input.value) - min) / span) * 100}%`); };
    paintFill();
    input.addEventListener('input', () => { const v = parseFloat(input.value); val.textContent = fmt(v); paintFill(); on(v); });
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
      setPanel('Volume',
        h('div', { style: 'margin:0 0 6px;font-size:12px;color:#8a8a8a;font-weight:500;text-transform:uppercase;letter-spacing:0.5px' }, 'Volume & Gain'),
        vs.row,
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Quick boost'),
          chipRow<number>([[100, '100%'], [200, '200%'], [400, '400%'], [700, '700%'], [1000, '1000%']], vol, (v) => { setVol(v); renderPanel(); })),
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Normalize'),
          chipRow<string>([['off', 'Off'], ['on', 'On']], p.normalize ? 'on' : 'off', (v) => { p.normalize = v === 'on'; applyVolume(); scheduleSave(); renderPanel(); })));
    } else if (panel === 'denoise') {
      setPanel('Denoise',
        h('div', { style: 'margin:0 0 6px;font-size:12px;color:#8a8a8a;font-weight:500;text-transform:uppercase;letter-spacing:0.5px' }, 'Noise Reduction'),
        noiseControl('host'),
        noiseControl('constant'));
    } else if (panel === 'crop') {
      const c: CropState = cropForEdit(cropRole);
      const reset = h('button', { class: 'chip crop-reset', onclick: () => {
        if (c.zoom === 1 && c.x === 0 && c.y === 0 && (c.rotate ?? 0) === 0
          && (c.ratio ?? 'custom') === 'custom' && (!c.frameRatio || Math.abs(c.frameRatio - cropViewAspect()) < 0.001)) return;
        hist.push(snap()); updateBtns();
        Object.assign(c, NO_CROP); delete c.frameRatio;
        cropEdited(cropRole); drawCropCanvas(); positionCropFrame(); scheduleSave(); renderPanel();
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
        cropEdited(cropRole); drawCropCanvas(); scheduleSave();
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
            cropEdited(cropRole); positionCropFrame(); scheduleSave(); renderPanel();
          },
        }, label)));
      const cropSeg = segmentAt(p.segments, playMs);
      const allTick = h('button', {
        class: 'chip crop-all' + (applyAllCrop ? ' on' : ''),
        role: 'checkbox', 'aria-checked': String(applyAllCrop),
        'aria-label': 'Apply this crop to all clips',
        onclick: () => {
          applyAllCrop = !applyAllCrop;
          if (applyAllCrop) { hist.push(snap()); updateBtns(); spreadCrop(cropRole); applyCrop('host'); applyCrop('constant'); scheduleSave(); toast('This crop now applies to all clips.'); }
          renderPanel();
        },
      }, h('span', { class: 'tickbox' }, applyAllCrop ? icon('check', 14) : ''), 'Apply to all clips');
      allTick.className = 'tool-all' + (applyAllCrop ? ' on' : '');
      reset.className = 'tool-reset';
      setPanel('Crop',
        h('div', { class: 'pinfo crop-for' }, applyAllCrop ? 'Changes go to all clips.' : `Changes go to this clip only${cropSeg ? ` (${STYLE_LABEL[cropSeg.style]})` : ''}.`),
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Video'),
          chipRow<Role>([['host', 'Host'], ['constant', 'Constant']], cropRole, (v) => { cropRole = v; renderPanel(); layoutCrop(); })),
        h('div', { class: 'crop-rotate' },
          h('div', { class: 'crop-rotate-head' }, h('span', {}, 'Rotate'), rotateValue),
          h('div', { class: 'crop-ruler' }, ...rulerTicks, rotateInput),
          h('div', { class: 'crop-ruler-labels' }, h('span', {}, '−45°'), h('span', {}, '0°'), h('span', {}, '+45°'))),
        h('div', { class: 'prow crop-ratio-row' }, h('div', { class: 'plabel' }, 'Aspect ratio'), ratios),
        h('div', { class: 'crop-actions tool-actions' }, allTick, mirrorChip, reset));
    } else if (panel === 'mask') {
      const c: CropState = cropForEdit(cropRole);
      const spreadMask = () => {
        const src = cropForEdit(cropRole);
        const targets: CropState[] = [p.cropHost, p.cropConst];
        for (const sg of p.segments) { sg.cropHost = sg.cropHost ?? { ...p.cropHost }; sg.cropConst = sg.cropConst ?? { ...p.cropConst }; targets.push(sg.cropHost, sg.cropConst); }
        for (const t of targets) { t.radius = src.radius; t.strokeWidth = src.strokeWidth; t.strokeColor = src.strokeColor; }
        applyCrop('host'); applyCrop('constant');
      };
      const refresh = () => { cropEdited(cropRole); if (applyAllMask) spreadMask(); scheduleSave(); };
      const radiusSlider = slider('Corner radius', 0, 48, 1, c.radius ?? 0, (v) => `${v}px`, (v) => { c.radius = v; refresh(); });
      const strokeSlider = slider('Border width', 0, 12, 1, c.strokeWidth ?? 0, (v) => `${v}px`, (v) => { c.strokeWidth = v; refresh(); });
      const colors = ['#ffffff', '#C6F277', '#facc15', '#4ade80', '#f43f5e', '#60a5fa', '#a855f7'];
      const curColor = c.strokeColor || '#ffffff';
      const colorRow = h('div', { class: 'prow' },
        h('div', { class: 'plabel' }, 'Border color'),
        h('div', { class: 'color-swatches' },
          ...colors.map((col) => h('button', {
            class: 'color-swatch' + (col === curColor ? ' sel' : ''),
            style: `background:${col}`,
            'aria-label': `Select border color ${col}`,
            onclick: () => { hist.push(snap()); updateBtns(); c.strokeColor = col; refresh(); renderPanel(); },
          }))));
      const resetBtn = h('button', { class: 'chip crop-reset', onclick: () => {
        if (!c.radius && !c.strokeWidth) return;
        hist.push(snap()); updateBtns();
        c.radius = 0; c.strokeWidth = 0;
        refresh(); renderPanel();
      } }, icon('trash', 16), 'Reset');
      resetBtn.className = 'tool-reset';
      const applyAllBtn = h('button', {
        class: 'tool-all' + (applyAllMask ? ' on' : ''),
        role: 'checkbox', 'aria-checked': String(applyAllMask), 'aria-label': 'Apply this mask to all clips',
        onclick: () => {
          applyAllMask = !applyAllMask;
          if (applyAllMask) { hist.push(snap()); updateBtns(); spreadMask(); scheduleSave(); toast('This mask now applies to all clips.'); }
          renderPanel();
        },
      }, h('span', { class: 'tickbox' }, applyAllMask ? icon('check', 14) : ''), 'Apply to all clips');
      setPanel('Mask',
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Video'),
          chipRow<Role>([['host', 'Host'], ['constant', 'Constant']], cropRole, (v) => { cropRole = v; renderPanel(); })),
        radiusSlider.row,
        strokeSlider.row,
        colorRow,
        h('div', { class: 'crop-actions tool-actions' }, applyAllBtn, resetBtn),
        h('div', { class: 'pinfo' }, 'The border and rounded corners stay on the video edges when you move or zoom it.'));
    } else {
      const total = pendingCuts.reduce((a, r) => a + (r.endMs - r.startMs), 0);
      const info = pendingCuts.length
        ? h('div', { class: 'pinfo', style: 'background:rgba(198,242,119,0.08);border:1px solid rgba(198,242,119,0.2);border-radius:10px;padding:10px 12px;margin:8px 0 14px;color:#e0e0e0' },
            'Found ', h('b', { style: 'color:#C6F277' }, `${pendingCuts.length} silent ${pendingCuts.length === 1 ? 'part' : 'parts'}`),
            ' (', h('b', { style: 'color:#fff' }, secText(total)), ') to remove. Marked red on the timeline.')
        : h('div', { class: 'pinfo', style: 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 12px;margin:8px 0 14px;color:#8a8a8a' },
            'No silence found matching current settings. Try shorter duration or higher sensitivity.');
      const go = (pt: Partial<typeof s>) => { Object.assign(s, pt); saveSettings(s); runDetect(); renderPanel(); draw(); };
      const applyBtn = h('button', {
        class: 'btn primary',
        style: 'width:100%;min-height:48px;margin-top:16px;border-radius:12px;border:0;background:#C6F277;color:#10140a;font-size:15px;font-weight:600;cursor:pointer',
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
  const cropState = () => cropOf(cropRole);
  const currentCropRatio = () => {
    const c = cropState();
    return c.ratio === 'custom' || !c.ratio ? (c.frameRatio ?? cropAr) : cropRatioValue(c.ratio, cropAr);
  };
  const frameRect = () => {
    const c = cropState(); const ratio = currentCropRatio();
    const z = Math.max(0.2, c.zoom || 1);
    const maxW = Math.min(cm.w, cm.h * ratio);
    const w = Math.min(maxW, maxW / z);
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
    const c = cropForEdit(cropRole);
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
    // zoom is measured against the biggest frame of this shape that fits the picture, so the frame and the slot always agree
    c.zoom = Math.min(cm.w, cm.h * frameRatio) / w;
    if (isCustom) c.frameRatio = frameRatio;
    if (isCustom && Math.abs(w - cm.w) < 1 && Math.abs(hh - cm.h) < 1) { c.zoom = 1; c.x = 0; c.y = 0; c.frameRatio = cropAr; }
    else {
      c.x = rx > 0.5 ? Math.max(-1, Math.min(1, -ux / rx)) : 0;
      c.y = ry > 0.5 ? Math.max(-1, Math.min(1, -uy / ry)) : 0;
      if (snap && Math.abs(ux) < 5) c.x = 0;
      if (snap && Math.abs(uy) < 5) c.y = 0;
    }
    guideV.classList.toggle('on', c.zoom > 1 && c.x === 0);
    guideH.classList.toggle('on', (cm.h / hh > 1.001) && c.y === 0);
    cropEdited(cropRole); positionCropFrame(); scheduleSave();
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
    const seg = segmentAt(p.segments, playMs);
    applyLayout(seg);
    if (panel === 'crop' || panel === 'mask') {
      // the playhead moved to another clip or layout: it has its own crop and slot shape
      const key = seg ? `${seg.id}|${seg.style}|${seg.main}` : '';
      if (key !== lastCropKey) { lastCropKey = key; layoutCrop(); renderPanel(); }
    }
    hudTimeBadge.textContent = `${fmtClock(playMs)} / ${fmtClock(p.durationMs)}`;
    drawCaptionsPreview();
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
    // Load the videos ONE AFTER THE OTHER. Two <video> elements starting together, plus thumbnails, audio and preview copies,
    // used up the phone's video decoders and one preview (Host or Constant) came up as "Video not found".
    const settled = (r: Role) => ready[r] || failed[r] || proxying[r];
    const waitSettled = async (roles: Role[], maxMs: number) => {
      const t0 = Date.now();
      while (!destroyed && Date.now() - t0 < maxMs && !roles.every(settled)) await new Promise((res) => setTimeout(res, 120));
    };
    startSource('host');
    await waitSettled(['host'], 5000);
    if (destroyed) return;
    startSource('constant');
    await waitSettled(['constant'], 5000);
    if (destroyed) return;
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
      let stopAudio: () => void = () => {};
      const stopped = new Promise<never>((_, rej) => { stopAudio = () => rej(new Error('Audio reading was stopped.')); });
      stopped.catch(() => {});
      startTask('audio', 'Reading audio', 0, { cancel: () => stopAudio() });
      const upd = () => updateTask('audio', 'Reading audio', (hp + cp) / 2);
      try {
        const reading = Promise.all([ensureAudio('host', (n) => { hp = n; upd(); }), ensureAudio('constant', (n) => { cp = n; upd(); })]);
        reading.catch(() => {});
        await Promise.race([reading, stopped]);
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
  // The timeline fills all the free space under the preview: the playhead runs the full height and a swipe anywhere there scrubs the video.
  const fitTimeline = () => { tl.style.height = `${Math.max(minTlH, tlWrap.clientHeight)}px`; draw(); };
  const tlRo = new ResizeObserver(fitTimeline);
  tlRo.observe(tlWrap);
  const titleEl = h('div', { class: 'edtop-title' },
    h('span', { class: 'edtop-name' }, p.name)
  );
  const el = h('div', { class: 'screen editor' },
    h('div', { class: 'edtop' },
      iconButton('close', 'Close', async () => { setPlaying(false); await saveProject(p); app.go('home'); }, 'plain'),
      titleEl,
      h('div', { class: 'grow' }),
      resChip,
      h('button', { class: 'exportbtn', 'aria-label': 'Export', onclick: goExport }, 'Export')),
    preview, controls, tlWrap, pillsEl, toolbar, panelEl, dialogHost);

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
    const cnt = taskSheetEl.querySelector('.task-sheet-count') as HTMLElement;
    if (!body) return;
    if (cnt) cnt.textContent = String(lastTasks.length);
    body.replaceChildren(
      ...lastTasks.map((t) => h('div', { class: 'tl-row' },
        h('div', { class: 'tl-main' },
          h('div', { class: 'tl-title' }, t.label),
          h('div', { class: 'tl-pct' }, t.pct !== undefined && t.pct > 0 ? `${t.pct}%` : 'Working...')),
        t.cancel ? h('button', {
          class: 'tl-stop', 'aria-label': `Stop ${t.label}`,
          onclick: async () => {
            const stop = t.cancel!;
            if (await confirmDialog('Stop this task?', `${t.label} will be cancelled.`, 'Stop task')) stop();
          },
        }, icon('close', 14)) : null))
    );
  }
  function openListSheet() {
    if (taskSheetEl) { closeListSheet(); return; }
    if (!lastTasks.length) return;
    const dragBar = h('div', { class: 'sheet-handle' }, h('i', { class: 'handle-bar' }));
    const head = h('div', { class: 'task-sheet-head' },
      h('div', { class: 'task-sheet-title' }, 'In progress', h('span', { class: 'task-sheet-count' }, String(lastTasks.length))),
      // closes only this sheet; it never stops a task (the X on each task row does that)
      h('button', { class: 'ts-close', 'aria-label': 'Close', onclick: () => closeListSheet() }, icon('close', 20)));
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
    // 1) small centered card for the first modal task that is not minimized.
    //    Built once per task and then only updated in place: rebuilding it on every % restarted the fade-in, so it looked ghosted and cut.
    const dlg = list.find((t) => t.modal && !t.minimized);
    if (dlg) {
      const pct = dlg.pct ?? 0;
      let card = dialogEl.querySelector('.taskdialog') as HTMLElement | null;
      if (!card || card.dataset.id !== dlg.id || card.dataset.cancel !== String(!!dlg.cancel)) {
        const ring = h('div', { class: 'td-ring2', style: '--p:0' }, h('span', {}, ''));
        card = h('div', { class: 'taskdialog', role: 'dialog', 'aria-label': dlg.label },
          h('div', { class: 'td-tile' }, ring),
          h('div', { class: 'td-title' }, dlg.label),
          h('div', { class: 'td-sub' }, 'This can take a moment. You can keep editing.'),
          h('button', { class: 'td-min', onclick: () => minimizeTask(dlg.id) }, 'Minimize'),
          dlg.cancel ? h('button', {
            class: 'td-cancel',
            onclick: async () => {
              const stop = dlg.cancel!;
              if (await confirmDialog('Stop this task?', `${dlg.label} will be cancelled.`, 'Stop task')) stop();
            },
          }, 'Cancel task') : null);
        card.dataset.id = dlg.id; card.dataset.cancel = String(!!dlg.cancel);
        dialogEl.replaceChildren(card);
      }
      const ringEl = card.querySelector('.td-ring2') as HTMLElement;
      ringEl.classList.toggle('indet', !(pct > 0));
      ringEl.style.setProperty('--p', String(pct));
      (ringEl.querySelector('span') as HTMLElement).textContent = pct > 0 ? `${pct}%` : '';
      (card.querySelector('.td-title') as HTMLElement).textContent = dlg.label;
      card.setAttribute('aria-label', dlg.label);
    } else dialogEl.replaceChildren();

    // 2) ONE small capsule at the left, just above the tools, for every task without an open dialog (updated in place, no re-animation)
    const activeTasks = list.filter((t) => !t.modal || t.minimized);
    if (!activeTasks.length) {
      pillsEl.replaceChildren();
      closeListSheet();
    } else {
      const first = activeTasks[0];
      const one = activeTasks.length === 1;
      const pct = one && first.pct !== undefined && first.pct > 0 ? first.pct : 0;
      const label = one ? first.label : `${activeTasks.length} tasks running`;
      let pillBtn = pillsEl.querySelector('.pill.tap') as HTMLElement | null;
      if (!pillBtn) {
        pillBtn = h('button', {
          class: 'pill tap',
          onclick: (ev: MouseEvent) => {
            ev.stopPropagation();
            if (taskSheetEl) closeListSheet();
            else openListSheet();
          },
        }, h('span', { class: 'pill-ring indet' }), h('span', { class: 'pill-text' }), h('span', { class: 'pill-pct' }), h('span', { class: 'pill-count' }));
        pillsEl.replaceChildren(pillBtn);
      }
      pillBtn.setAttribute('aria-label', `${activeTasks.length} running: ${label}`);
      const ringEl = pillBtn.querySelector('.pill-ring') as HTMLElement;
      ringEl.classList.toggle('indet', !(pct > 0));
      ringEl.style.setProperty('--p', String(pct));
      (pillBtn.querySelector('.pill-text') as HTMLElement).textContent = label;
      const pctEl = pillBtn.querySelector('.pill-pct') as HTMLElement;
      pctEl.textContent = pct > 0 ? `${pct}%` : ''; pctEl.style.display = pct > 0 ? '' : 'none';
      const cntEl = pillBtn.querySelector('.pill-count') as HTMLElement;
      cntEl.textContent = String(activeTasks.length); cntEl.style.display = one ? 'none' : '';
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
      cancelAnimationFrame(raf); stopFling(); clearTimeout(saveTimer); saveProject(p);
      stopCleanAudio(); hostV.pause(); constV.pause();
      hostStrip?.cancel(); constStrip?.cancel();
      offTasks();
      endTask('audio'); endTask('sync'); endTask('switch'); endTask('proxy-host'); endTask('proxy-constant'); endTask('faces'); scanCancel = true; closeListSheet();
      try { actx?.close(); } catch { /* ignore */ }
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect(); tlRo.disconnect();
      (screen.orientation as any)?.unlock?.();
    },
  };
}
