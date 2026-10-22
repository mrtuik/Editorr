import { EditorrNative, fileSrc, isNative, loadPcm } from './native';
import { runtime } from './store';
import type { Project } from './types';

const stripScheme = (u: string) => (u.startsWith('file://') ? u.slice(7) : u);

/** The two video files a project points at (native app only). */
export function projectVideoPaths(p: Project): string[] {
  return [p.host?.uri, p.constant?.uri].filter((x): x is string => !!x).map(stripScheme);
}

/** True when this project's videos and audio are already loaded in memory. */
export function isLoaded(p: Project): boolean {
  return runtime.projectId === p.id && !!runtime.hostUrl && !!runtime.constUrl && !!runtime.hostPcm && !!runtime.constPcm;
}

/**
 * Re-open a saved project: check both video files are still on the phone, then decode the audio again
 * (the audio is not saved, only the cut/layout/crop data is). Returns false when a video is gone,
 * so the caller can send the user to the Import screen.
 */
export async function loadProjectMedia(p: Project, onProgress?: (pct: number) => void): Promise<boolean> {
  if (!isNative() || !p.host?.uri || !p.constant?.uri) return false;
  const hostPath = stripScheme(p.host.uri), constPath = stripScheme(p.constant.uri);
  const [a, b] = await Promise.all([EditorrNative.fileExists({ path: hostPath }), EditorrNative.fileExists({ path: constPath })]);
  if (!a.exists || !b.exists) return false;

  let hp = 0, cp = 0;
  const sub = await EditorrNative.addListener('audioProgress', (e: { path?: string; percent: number }) => {
    if (e.path === hostPath) hp = e.percent; else if (e.path === constPath) cp = e.percent;
    onProgress?.(Math.round(((hp + cp) / 200) * 90));
  });
  try {
    const [h1, c1] = await Promise.all([EditorrNative.extractAudio({ path: hostPath }), EditorrNative.extractAudio({ path: constPath })]);
    onProgress?.(92);
    const [hostPcm, constPcm] = await Promise.all([loadPcm(h1.pcmPath), loadPcm(c1.pcmPath)]);
    runtime.projectId = p.id;
    runtime.hostPath = hostPath; runtime.constPath = constPath;
    runtime.hostUrl = fileSrc(hostPath); runtime.constUrl = fileSrc(constPath);
    runtime.hostFile = runtime.constFile = undefined;
    runtime.hostPcm = hostPcm; runtime.constPcm = constPcm;
    runtime.hostMotion = runtime.constMotion = undefined;
    onProgress?.(100);
    return true;
  } finally {
    sub.remove().catch(() => {});
  }
}

/** Delete the video files of a project that is being deleted. */
export async function removeProjectMedia(p: Project): Promise<void> {
  if (!isNative()) return;
  const paths = projectVideoPaths(p);
  if (!paths.length) return;
  try { await EditorrNative.deleteVideos({ paths }); } catch { /* file already gone */ }
  if (runtime.projectId === p.id) { runtime.projectId = undefined; runtime.hostUrl = runtime.constUrl = undefined; runtime.hostPcm = runtime.constPcm = undefined; }
}

/** At launch: remove videos that no project uses (from imports that were never finished). */
export async function pruneUnusedVideos(projects: Project[]): Promise<void> {
  if (!isNative()) return;
  try { await EditorrNative.pruneVideos({ keep: projects.flatMap(projectVideoPaths) }); } catch { /* ignore */ }
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
