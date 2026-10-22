import type { Project, Segment, Settings } from './types';

const PROJECTS_KEY = 'editorr.projects.v1';
const SETTINGS_KEY = 'editorr.settings.v1';
const MAX_UNDO = 50;

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 'medium',
  minSegmentMs: 1500,
  resolution: 720,
  bothSpeaking: 'hold',
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function listProjects(): Project[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]') as Project[];
    return arr.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
}

export function saveProject(p: Project): void {
  const all = listProjects().filter((x) => x.id !== p.id);
  p.updatedAt = Date.now();
  all.push(p);
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(all)); } catch { /* quota */ }
}

export function deleteProject(id: string): void {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(listProjects().filter((x) => x.id !== id))); } catch { /* ignore */ }
}

export function clearAllStorage(): void {
  try { localStorage.removeItem(PROJECTS_KEY); } catch { /* ignore */ }
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
  };
}

/** Undo/redo over the segment list (50 steps, spec asks >= 30). */
export class History {
  private past: Segment[][] = [];
  private future: Segment[][] = [];
  push(current: Segment[]): void {
    this.past.push(structuredClone(current));
    if (this.past.length > MAX_UNDO) this.past.shift();
    this.future = [];
  }
  undo(current: Segment[]): Segment[] | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(structuredClone(current));
    return prev;
  }
  redo(current: Segment[]): Segment[] | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(structuredClone(current));
    return next;
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

/** Runtime-only media (object URLs + decoded PCM) kept out of the saved JSON. */
export interface Runtime {
  hostFile?: File;
  constFile?: File;
  hostUrl?: string;
  constUrl?: string;
  hostPath?: string;
  constPath?: string;
  hostPcm?: Float32Array;
  constPcm?: Float32Array;
}
export const runtime: Runtime = {};
