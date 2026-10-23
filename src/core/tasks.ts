/**
 * Background work the editor shows as small "pills" over the preview (like CapCut's "Applying 2 features"):
 * reading audio, syncing, detecting speakers, making preview copies.
 */
export interface Task {
  id: string; label: string; pct?: number;
  /** Shows a centered dialog (progress + Minimize) like CapCut. Minimized = small pill, tap it for the list. */
  modal?: boolean; minimized?: boolean;
  /** Set when the task can be cancelled (X in the dialog / list). */
  cancel?: () => void;
}

const tasks = new Map<string, Task>();
const subs = new Set<(list: Task[]) => void>();

function emit(): void {
  const list = [...tasks.values()];
  subs.forEach((f) => f(list));
}

export function startTask(id: string, label: string, pct?: number, opts: { modal?: boolean; cancel?: () => void } = {}): void {
  tasks.set(id, { id, label, pct, modal: opts.modal, cancel: opts.cancel, minimized: false });
  emit();
}

export function minimizeTask(id: string, on = true): void {
  const t = tasks.get(id);
  if (!t) return;
  t.minimized = on;
  emit();
}

/** Minimize every open dialog (used by the Android back button). Returns true if one was open. */
export function minimizeAllDialogs(): boolean {
  let any = false;
  tasks.forEach((t) => { if (t.modal && !t.minimized) { t.minimized = true; any = true; } });
  if (any) emit();
  return any;
}

export function updateTask(id: string, label?: string, pct?: number): void {
  const t = tasks.get(id);
  if (!t) return;
  if (label !== undefined) t.label = label;
  if (pct !== undefined) t.pct = Math.max(0, Math.min(100, Math.round(pct)));
  emit();
}

export function endTask(id: string): void {
  if (tasks.delete(id)) emit();
}

export function hasTask(id: string): boolean {
  return tasks.has(id);
}

/** Subscribe; the callback gets the current list straight away. Returns an unsubscribe function. */
export function onTasks(cb: (list: Task[]) => void): () => void {
  subs.add(cb);
  cb([...tasks.values()]);
  return () => { subs.delete(cb); };
}
