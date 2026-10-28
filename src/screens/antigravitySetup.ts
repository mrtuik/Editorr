import { EditorrNative, isNative, type AgyStatus } from '../core/native';
import { h, toast } from '../ui';

const AGY_STORE = 'editorr_agent_antigravity';
/** Is Antigravity planning switched on by the user? On by default. */
export const agyOn = (): boolean => { try { return localStorage.getItem(AGY_STORE) !== '0'; } catch { return true; } };
const setAgy = (on: boolean): void => { try { localStorage.setItem(AGY_STORE, on ? '1' : '0'); } catch { /* storage unavailable */ } };

/**
 * Antigravity panel: one-time setup (download), Google sign-in (link + one-time code), sign out.
 * Everything runs inside Editorr. Calls onChange() whenever the state changes so the caller can repaint.
 */
export function openAntigravityPanel(onChange: () => void): void {
  if (!isNative()) { toast('Antigravity works in the Android app only'); return; }

  const title = h('div', { class: 'title' }, 'Antigravity');
  const info = h('p', { class: 'sec' }, 'Checking...');
  const bar = h('div', { style: 'height:6px;border-radius:3px;background:#22222c;overflow:hidden;margin:10px 0;display:none' },
    h('div', { style: 'height:100%;width:0;background:var(--accent,#c6f432)' }));
  const fill = bar.firstElementChild as HTMLElement;
  const codeInput = h('input', { type: 'text', placeholder: 'Paste the code from Google', autocapitalize: 'off', autocomplete: 'off' }) as HTMLInputElement;
  const codeRow = h('div', { style: 'margin-top:10px;display:none' }, codeInput);
  const actions = h('div', { class: 'actions' });
  const box = h('div', { class: 'box' }, title, info, bar, codeRow, actions);
  const dlg = h('div', { class: 'dialog', role: 'dialog' }, box);
  document.body.append(dlg);

  const handles: { remove: () => void }[] = [];
  let link = '';
  let closed = false;
  const close = () => { closed = true; handles.forEach((x) => x.remove()); dlg.remove(); onChange(); };
  const btn = (label: string, fn: () => void, cls = 'btn') => h('button', { class: cls, onclick: fn }, label);

  const setProgress = (message: string, fraction: number) => {
    bar.style.display = 'block';
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    info.textContent = `${message} (${Math.round(fraction * 100)}%)`;
  };

  const run = async (fn: () => Promise<AgyStatus>) => {
    try { paint(await fn()); } catch (e) { toast((e as Error).message || 'Something went wrong'); paint(await EditorrNative.antigravityStatus()); }
  };

  function paint(s: AgyStatus, message = '') {
    if (closed) return;
    actions.replaceChildren();
    codeRow.style.display = 'none';
    bar.style.display = 'none';
    if (!s.supported) {
      info.textContent = 'Antigravity needs a 64-bit ARM (arm64) phone.';
      actions.append(btn('Close', close));
      return;
    }
    if (s.installing) {
      info.textContent = 'Setting up... keep Editorr open.';
      actions.append(btn('Close', close));
      return;
    }
    if (!s.installed) {
      info.textContent = 'One-time setup downloads about 115 MB (a small private Linux plus Google\'s Antigravity CLI). Use Wi-Fi. Everything stays inside Editorr.';
      actions.append(btn('Cancel', close), btn('Set up', () => { setProgress('Starting', 0); void run(() => EditorrNative.antigravityInstall()); }, 'btn primary'));
      return;
    }
    if (s.signedIn || s.auth === 'signed_in') {
      info.textContent = s.email ? `Signed in as ${s.email}. Antigravity can plan your typed instructions.` : 'Signed in. Antigravity can plan your typed instructions.';
      actions.append(
        btn('Sign out', () => void run(() => EditorrNative.antigravityLogout())),
        btn(agyOn() ? 'Turn off' : 'Turn on', () => { setAgy(!agyOn()); paint(s); }),
        btn('Done', close, 'btn primary'));
      return;
    }
    if (s.auth === 'awaiting_code' && link) {
      info.textContent = message || '1) Open the Google page and sign in. 2) Copy the code Google shows. 3) Paste it here.';
      codeRow.style.display = 'block';
      actions.append(
        btn('Open Google', () => { void EditorrNative.openUrl({ url: link }).catch(() => toast('Could not open the browser')); }),
        btn('Send code', () => {
          const code = codeInput.value.trim();
          if (!code) { toast('Paste the code first'); return; }
          void run(() => EditorrNative.antigravitySubmitCode({ code }));
        }, 'btn primary'));
      return;
    }
    if (s.auth === 'starting' || s.auth === 'completing') {
      info.textContent = message || (s.auth === 'starting' ? 'Starting Google sign-in...' : 'Completing sign-in...');
      actions.append(btn('Cancel', () => void run(() => EditorrNative.antigravityCancelLogin())));
      return;
    }
    info.textContent = s.auth === 'error' && message ? message : 'Sign in with your Google account to use Antigravity. No API key needed.';
    actions.append(btn('Close', close), btn('Sign in with Google', () => { link = ''; void run(() => EditorrNative.antigravityLogin()); }, 'btn primary'));
  }

  void (async () => {
    handles.push(await EditorrNative.addListener('agyInstall', (e: { message: string; fraction: number }) => {
      if (!closed) setProgress(e.message, e.fraction);
    }));
    handles.push(await EditorrNative.addListener('agyAuth', (e: { status: string; message: string; url?: string; email: string }) => {
      if (e.url) link = e.url;
      void EditorrNative.antigravityStatus().then((s) => {
        paint({ ...s, auth: e.status, email: e.email || s.email, signedIn: e.status === 'signed_in' || (s.signedIn && e.status !== 'error') }, e.message);
        if (e.status === 'signed_in') onChange();
      });
    }));
    paint(await EditorrNative.antigravityStatus());
  })();
}

/** True only when Antigravity is set up AND signed in (used to decide whether the planner may call it). */
export async function antigravityReady(): Promise<boolean> {
  if (!isNative()) return false;
  try { const s = await EditorrNative.antigravityStatus(); return s.installed && s.signedIn; } catch { return false; }
}
