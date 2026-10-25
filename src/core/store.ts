import type { FaceScan } from './faces';
import { NO_CROP, type CropState, type Project, type Segment, type Settings } from './types';

const OLD_PROJECTS_KEY = 'editorr.projects.v1';
const OLD_SETTINGS_KEY = 'editorr.settings.v1';
const MAX_UNDO = 50;

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 'medium',
  minSegmentMs: 1000,
  resolution: 720,
  fps: 30,
  bitrateMbps: 0,
  bothSpeaking: 'hold',
  silenceMinMs: 1000,
  silencePadMs: 150,
  silenceSens: 'medium',
  preferredAudio: 'auto',
  faceFollow: 'speaker',
  faceMode: 'smooth',
  faceSpeedMs: 600,
  faceTight: 'medium',
  autoframeBy: 'both',
  leadInMs: 300,
  ignoreShortMs: 1500,
  whisperModel: 'small',
  captionLang: '',
  reactAfterMs: 8000,
  reactLengthMs: 1500,
  zoomStrength: 'medium',
  zoomAmount: 1.15,
  zoomInMs: 300,
  zoomHoldMs: 1200,
  zoomOutMs: 300,
  zoomEase: [0.42, 0, 0.58, 1],
  musicLevelDb: -20,
  musicDuckDb: 14,
  musicFadeMs: 1500,
};

// ---------------------------------------------------------------- IndexedDB
// Stores: projects (one record per project), thumbs (small jpeg per project), kv (settings, flags).
// IndexedDB has no small size limit like localStorage (about 5 MB) and survives app restarts.

const DB_NAME = 'editorr';
const DB_VERSION = 2;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        // video files picked in the browser build (the Android app keeps files on disk and only their path in 'projects')
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

/** Run one request inside its own transaction and wait until the transaction is committed. */
async function run<T>(stores: string | string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let out: T | undefined;
    const r = fn(tx);
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Writes run one after another, and reads wait for them, so "save then go Home" always shows the new data. */
let writes: Promise<unknown> = Promise.resolve();
function queueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => {});
  return next;
}

/** Open the database, ask Android/WebView not to evict it, and move old localStorage data over (once). */
export async function initStorage(): Promise<void> {
  await openDb();
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  await migrateFromLocalStorage();
}

async function migrateFromLocalStorage(): Promise<void> {
  try {
    const done = await run<{ key: string; value: unknown }>('kv', 'readonly', (tx) => tx.objectStore('kv').get('migratedLocalStorage'));
    if (done) return;
    const oldProjects = JSON.parse(localStorage.getItem(OLD_PROJECTS_KEY) || '[]') as Project[];
    const oldSettings = JSON.parse(localStorage.getItem(OLD_SETTINGS_KEY) || 'null') as Settings | null;
    for (const p of oldProjects) await saveProject(p);
    if (oldSettings) await saveSettings({ ...DEFAULT_SETTINGS, ...oldSettings });
    await run('kv', 'readwrite', (tx) => tx.objectStore('kv').put({ key: 'migratedLocalStorage', value: true }));
    localStorage.removeItem(OLD_PROJECTS_KEY);
    localStorage.removeItem(OLD_SETTINGS_KEY);
  } catch { /* keep the old data in place; migration is retried next launch */ }
}

export async function loadSettings(): Promise<Settings> {
  try {
    await writes;
    const row = await run<{ key: string; value: Settings }>('kv', 'readonly', (tx) => tx.objectStore('kv').get('settings'));
    return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s: Settings): Promise<void> {
  const copy = { ...s };
  return queueWrite(async () => { await run('kv', 'readwrite', (tx) => tx.objectStore('kv').put({ key: 'settings', value: copy })); }).catch(() => {});
}

/** Projects saved by older versions miss the newer fields. */
function withDefaults(p: Project): Project {
  const cropDefaults = (crop?: Partial<CropState>): CropState => ({
    ...NO_CROP,
    ...(crop ?? {}),
    rotate: crop?.rotate ?? 0,
    ratio: crop?.ratio ?? 'custom',
    radius: crop?.radius ?? 0,
    strokeWidth: crop?.strokeWidth ?? 0,
    strokeColor: crop?.strokeColor ?? '#ffffff',
  });
  return {
    ...p,
    aspect: p.aspect ?? '16:9',
    cropHost: cropDefaults(p.cropHost),
    cropConst: cropDefaults(p.cropConst),
    segments: (p.segments ?? []).map((s) => ({
      ...s,
      ...(s.cropHost ? { cropHost: cropDefaults(s.cropHost) } : {}),
      ...(s.cropConst ? { cropConst: cropDefaults(s.cropConst) } : {}),
    })),
    mirrorHost: p.mirrorHost ?? false,
    mirrorConst: p.mirrorConst ?? false,
    noiseHost: p.noiseHost ?? 0,
    noiseConst: p.noiseConst ?? 0,
    volumeHost: p.volumeHost ?? 100,
    volumeConst: p.volumeConst ?? 100,
  };
}

export async function listProjects(strict = false): Promise<Project[]> {
  try {
    await writes;
    const db = await openDb();
    const [projects, thumbs] = await new Promise<[Project[], { id: string; data: string }[]]>((resolve, reject) => {
      const tx = db.transaction(['projects', 'thumbs'], 'readonly');
      const a = tx.objectStore('projects').getAll();
      const b = tx.objectStore('thumbs').getAll();
      tx.oncomplete = () => resolve([a.result as Project[], b.result as { id: string; data: string }[]]);
      tx.onerror = () => reject(tx.error);
    });
    const byId = new Map(thumbs.map((x) => [x.id, x.data]));
    return projects.map((p) => withDefaults({ ...p, thumb: byId.get(p.id) })).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) { if (strict) throw e; return []; }
}

export function saveProject(p: Project): Promise<void> {
  p.updatedAt = Date.now();
  const { thumb, ...rest } = structuredClone(p); // snapshot now: the editor keeps changing p
  return queueWrite(async () => {
    await run(['projects', 'thumbs'], 'readwrite', (tx) => {
      tx.objectStore('projects').put(rest);
      if (thumb) tx.objectStore('thumbs').put({ id: p.id, data: thumb });
    });
  }).catch(() => { /* storage full or blocked: the editor keeps working */ });
}

export function deleteProject(id: string): Promise<void> {
  return queueWrite(async () => {
    await run(['projects', 'thumbs', 'media'], 'readwrite', (tx) => {
      tx.objectStore('projects').delete(id); tx.objectStore('thumbs').delete(id);
      tx.objectStore('media').delete(`${id}:host`); tx.objectStore('media').delete(`${id}:constant`);
    });
  }).catch(() => {});
}

export function clearAllStorage(): Promise<void> {
  return queueWrite(async () => {
    await run(['projects', 'thumbs', 'media'], 'readwrite', (tx) => { tx.objectStore('projects').clear(); tx.objectStore('thumbs').clear(); tx.objectStore('media').clear(); });
  }).catch(() => {});
}

// ---- video files (browser build): kept as Blobs in IndexedDB so they are still there after a reload ----
export function saveMedia(projectId: string, role: 'host' | 'constant', file: Blob | undefined, name: string): Promise<void> {
  return queueWrite(async () => {
    await run('media', 'readwrite', (tx) => {
      if (file) tx.objectStore('media').put({ key: `${projectId}:${role}`, blob: file, name });
      else tx.objectStore('media').delete(`${projectId}:${role}`);
    });
  }).catch(() => {});
}

export async function loadMedia(projectId: string, role: 'host' | 'constant'): Promise<{ blob: Blob; name: string } | undefined> {
  try {
    await writes;
    return await run<{ key: string; blob: Blob; name: string }>('media', 'readonly', (tx) => tx.objectStore('media').get(`${projectId}:${role}`));
  } catch { return undefined; }
}

export async function mediaBytes(): Promise<number> {
  try {
    const rows = await run<{ blob: Blob }[]>('media', 'readonly', (tx) => tx.objectStore('media').getAll());
    return (rows ?? []).reduce((a, r) => a + (r.blob?.size ?? 0), 0);
  } catch { return 0; }
}

export function newProject(): Project {
  return {
    id: 'p' + Date.now().toString(36),
    name: 'Untitled project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    offsetMs: 0,
    segments: [],
    mainAudio: 'host',
    normalize: false,
    volumeHost: 100,
    volumeConst: 100,
    durationMs: 0,
    aspect: '16:9',
    cropHost: { ...NO_CROP },
    cropConst: { ...NO_CROP },
    mirrorHost: false,
    mirrorConst: false,
    noiseHost: 0,
    noiseConst: 0,
  };
}

/** What undo/redo restores: timeline edits, sync offset, both crop states, and mirroring. */
export interface Snapshot {
  segments: Segment[];
  offsetMs: number;
  durationMs: number;
  cropHost: CropState;
  cropConst: CropState;
  mirrorHost: boolean;
  mirrorConst: boolean;
  noiseHost: number;
  noiseConst: number;
}

/** Undo/redo (50 steps, spec asks >= 30). */
export class History {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  push(current: Snapshot): void {
    this.past.push(structuredClone(current));
    if (this.past.length > MAX_UNDO) this.past.shift();
    this.future = [];
  }
  undo(current: Snapshot): Snapshot | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(structuredClone(current));
    return prev;
  }
  redo(current: Snapshot): Snapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(structuredClone(current));
    return next;
  }
  reset(): void { this.past = []; this.future = []; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

/** Runtime-only media (object URLs + decoded PCM) kept out of the saved JSON. */
export interface Runtime {
  /** which project the loaded videos and audio belong to */
  projectId?: string;
  hostFile?: File;
  constFile?: File;
  hostUrl?: string;
  constUrl?: string;
  hostPath?: string;
  constPath?: string;
  hostPcm?: Float32Array;
  constPcm?: Float32Array;
  hostDenoiseCache?: DenoiseCache;
  constDenoiseCache?: DenoiseCache;
  /** lip/face movement per 100 ms timeline frame (not saved) */
  hostMotion?: Float32Array;
  constMotion?: Float32Array;
  /** face tracks of each video (not saved) */
  hostFaces?: FaceScan;
  constFaces?: FaceScan;
}

/** Small, runtime-only strength cache. Tied to the source PCM object to avoid cross-project reuse. */
export interface DenoiseCache { source: Float32Array; values: Map<number, Float32Array> }

export const runtime: Runtime = {};
