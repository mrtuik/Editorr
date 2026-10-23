/**
 * Background work the editor shows as small "pills" over the preview (like CapCut's "Applying 2 features"):
 * reading audio, syncing, detecting speakers, making preview copies.
 */
export interface Task { id: string; label: string; pct?: number }

const tasks = new Map<string, Task>();
const subs = new Set<(list: Task[]) => void>();

function emit(): void {
  const list = [...tasks.values()];
  subs.forEach((f) => f(list));
}

export function startTask(id: string, label: string, pct?: number): void {
  tasks.set(id, { id, label, pct });
  emit();
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
