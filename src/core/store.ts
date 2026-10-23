import { NO_CROP, type Project, type Segment, type Settings } from './types';

const OLD_PROJECTS_KEY = 'editorr.projects.v1';
const OLD_SETTINGS_KEY = 'editorr.settings.v1';
const MAX_UNDO = 50;

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 'medium',
  minSegmentMs: 1500,
  resolution: 720,
  bothSpeaking: 'hold',
  silenceMinMs: 1000,
  silencePadMs: 150,
  silenceSens: 'medium',
};

// ---------------------------------------------------------------- IndexedDB
// Stores: projects (one record per project), thumbs (small jpeg per project), kv (settings, flags).
// IndexedDB has no small size limit like localStorage (about 5 MB) and survives app restarts.

const DB_NAME = 'editorr';
const DB_VERSION = 1;
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
  return { ...p, aspect: p.aspect ?? '16:9', cropHost: p.cropHost ?? { ...NO_CROP }, cropConst: p.cropConst ?? { ...NO_CROP } };
}

export async function listProjects(): Promise<Project[]> {
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
  } catch { return []; }
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
    await run(['projects', 'thumbs'], 'readwrite', (tx) => { tx.objectStore('projects').delete(id); tx.objectStore('thumbs').delete(id); });
  }).catch(() => {});
}

export function clearAllStorage(): Promise<void> {
  return queueWrite(async () => {
    await run(['projects', 'thumbs'], 'readwrite', (tx) => { tx.objectStore('projects').clear(); tx.objectStore('thumbs').clear(); });
  }).catch(() => {});
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
    durationMs: 0,
    aspect: '16:9',
    cropHost: { ...NO_CROP },
    cropConst: { ...NO_CROP },
  };
}

/** What undo/redo restores: the cut list and the sync offset (dragging the green clip is undoable too). */
export interface Snapshot { segments: Segment[]; offsetMs: number; durationMs: number }

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
  /** lip/face movement per 100 ms timeline frame (not saved) */
  hostMotion?: Float32Array;
  constMotion?: Float32Array;
}
export const runtime: Runtime = {};
