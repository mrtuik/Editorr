import { EditorrNative, fileSrc, isNative } from './native';
import { loadMedia, runtime } from './store';
import type { Project } from './types';

const stripScheme = (u: string) => (u.startsWith('file://') ? u.slice(7) : u);

/** The two video files a project points at (native app only). */
export function projectVideoPaths(p: Project): string[] {
  return [p.host?.uri, p.constant?.uri, ...(p.overlays ?? []).map((o) => o.uri)].filter((x): x is string => !!x).map(stripScheme);
}

/** True when this project's videos are already attached to the runtime (audio may still be loading). */
export function isLoaded(p: Project): boolean {
  return runtime.projectId === p.id && !!runtime.hostUrl && !!runtime.constUrl;
}

/**
 * Re-open a saved project: check both video files are still on the phone and point the runtime at them.
 * The audio is read again inside the editor (with a progress pill), so Home does not have to wait for it.
 * Returns false when a video is gone, so the caller can send the user to the Import screen.
 */
export async function attachProjectMedia(p: Project): Promise<boolean> {
  if (!isNative()) {
    // browser build: the video files are Blobs in IndexedDB
    if (!p.host || !p.constant) return false;
    const [a, b] = await Promise.all([loadMedia(p.id, 'host'), loadMedia(p.id, 'constant')]);
    if (!a || !b) return false;
    if (runtime.projectId !== p.id) { runtime.hostPcm = runtime.constPcm = undefined; runtime.hostMotion = runtime.constMotion = undefined; }
    const hf = new File([a.blob], a.name), cf = new File([b.blob], b.name);
    runtime.projectId = p.id;
    runtime.hostPath = runtime.constPath = undefined;
    runtime.hostFile = hf; runtime.constFile = cf;
    runtime.hostUrl = URL.createObjectURL(hf); runtime.constUrl = URL.createObjectURL(cf);
    return true;
  }
  if (!p.host?.uri || !p.constant?.uri) return false;
  const hostPath = stripScheme(p.host.uri), constPath = stripScheme(p.constant.uri);
  const [a, b] = await Promise.all([EditorrNative.fileExists({ path: hostPath }), EditorrNative.fileExists({ path: constPath })]);
  if (!a.exists || !b.exists) return false;
  if (runtime.projectId !== p.id) {
    runtime.hostPcm = runtime.constPcm = undefined;
    runtime.hostMotion = runtime.constMotion = undefined;
  }
  runtime.projectId = p.id;
  runtime.hostPath = hostPath; runtime.constPath = constPath;
  runtime.hostUrl = fileSrc(hostPath); runtime.constUrl = fileSrc(constPath);
  runtime.hostFile = runtime.constFile = undefined;
  return true;
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
