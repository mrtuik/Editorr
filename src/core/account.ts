import { EditorrNative, isNative } from './native';

/** The Google account signed in to Antigravity. Shown in the profile card, the Home avatar and the "Me" tab. */
export interface Account { name: string; email: string; /** small round photo as a data URL ('' = none) */ picture: string }

const KEY = 'editorr_account';
let current: Account | null = null;
const listeners = new Set<() => void>();

try {
  const raw = localStorage.getItem(KEY);
  if (raw) { const a = JSON.parse(raw) as Account; if (a && (a.name || a.email)) current = a; }
} catch { /* no saved account */ }

export const getAccount = (): Account | null => current;
export const firstName = (a: Account | null): string => (a?.name || a?.email || '').trim().split(/\s+/)[0] ?? '';

/** Call fn whenever the account changes. Returns a function that stops listening. */
export function onAccountChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function set(a: Account | null) {
  current = a;
  try { if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => { try { fn(); } catch { /* one bad listener must not block the others */ } });
}

export function clearAccount() { set(null); }

/** Asks the app who is signed in to Antigravity and updates every screen. Quietly does nothing when nobody is. */
export async function refreshAccount(): Promise<void> {
  if (!isNative()) return;
  try {
    const st = await EditorrNative.antigravityStatus();
    if (!st.installed || !st.signedIn) { if (current) set(null); return; }
    const p = await EditorrNative.antigravityProfile();
    if (p.name || p.email) set({ name: p.name, email: p.email, picture: p.picture });
  } catch { /* keep what we have */ }
}

// keep the profile fresh: when the app starts, and right after a sign-in finishes
if (isNative()) {
  void refreshAccount();
  void EditorrNative.addListener('agyAuth', (e: { status: string }) => {
    if (e.status === 'signed_in') setTimeout(() => void refreshAccount(), 600);
    if (e.status === 'signed_out' && current) set(null);
  });
}
