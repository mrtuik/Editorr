import { app } from '../app';
import { AGENT_STEPS, runAgent, type AgentResult } from '../core/agentPlanner';
import { attachProjectMedia, isLoaded } from '../core/media';
import { listProjects, runtime, saveProject } from '../core/store';
import type { Project } from '../core/types';
import { fmtClock, h, icon, promptDialog, spinner, toast } from '../ui';

const KEY_STORE = 'editorr_agent_key';
const PRESETS: { label: string; prompt: string }[] = [
  { label: '⚡ Viral Fast Paced', prompt: 'Make it viral and fast paced: tight pauses, no dead air, slightly faster speech.' },
  { label: '😂 Auto Meme SFX', prompt: 'Add funny meme sound effects on the punchlines, shouts and awkward silences.' },
  { label: '✂️ Cut Retakes & Stutters', prompt: 'Cut retakes, false starts, stutters and filler words. Keep only the best take.' },
  { label: '🎙️ Studio Podcast Clean', prompt: 'Make it a clean studio podcast: trim long pauses, remove retakes, add soft background music.' },
];

const getKey = () => { try { return localStorage.getItem(KEY_STORE) ?? ''; } catch { return ''; } };
const setKey = (v: string) => { try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch { /* storage unavailable */ } };
const secs = (ms: number) => (ms >= 60_000 ? fmtClock(ms) : `${Math.max(0, Math.round(ms / 1000))}s`);

/**
 * AI Agent tab: a chat where you tell the editor what you want ("make it fast paced, cut retakes")
 * and it edits the project (cuts, speed, sounds, music). "Open in Timeline" keeps the result.
 */
export function agentScreen() {
  /** The project being edited. Stays untouched until "Open in Timeline". */
  let original: Project | null = null;
  /** Result of the chat so far (each new instruction builds on it). */
  let working: Project | null = null;
  let busy = false;
  let destroyed = false;

  // ---------- top bar
  const thumb = h('div', { class: 'ag-thumb' });
  const nameEl = h('div', { class: 'ag-name' }, 'No project');
  const subEl = h('div', { class: 'ag-sub' }, 'Pick a project to start');
  const changeBtn = h('button', { class: 'ag-change', onclick: () => void chooseProject() }, 'Change Project');
  const keyBtn = h('button', {
    class: 'circbtn', 'aria-label': 'AI key', title: 'AI key (optional)',
    onclick: async () => {
      const v = await promptDialog('Gemini or Claude API key (optional)', getKey());
      if (v === null) return;
      setKey(v.trim());
      toast(v.trim() ? 'AI key saved on this phone. The agent will ask the AI for a plan.' : 'AI key removed. Built-in rules are used.');
    },
  }, icon('wand', 20));
  const top = h('div', { class: 'ag-top' }, thumb, h('div', { class: 'ag-who' }, nameEl, subEl), changeBtn, keyBtn);

  // ---------- chat
  const chat = h('div', { class: 'ag-chat' });
  const scroll = () => requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  const say = (text: string) => { const b = h('div', { class: 'ag-msg bot' }, h('div', { class: 'ag-av' }, icon('wand', 14)), h('div', { class: 'ag-bub' }, text)); chat.append(b); scroll(); return b; };
  const me = (text: string) => { chat.append(h('div', { class: 'ag-msg me' }, h('div', { class: 'ag-bub' }, text))); scroll(); };

  function welcome() {
    chat.replaceChildren();
    say(original
      ? `Hi! I'm ready to edit "${original.name}". Tell me what you want, or tap a preset: pacing, retakes, meme sounds, music.`
      : 'Hi! Pick a project with "Change Project", then tell me how to edit it.');
  }

  // ---------- project
  function paintProject() {
    const p = original;
    nameEl.textContent = p ? p.name : 'No project';
    subEl.textContent = p ? `${fmtClock(p.durationMs)} · ${p.aspect}${working && working !== original ? ' · edited in chat' : ''}` : 'Pick a project to start';
    thumb.style.backgroundImage = p?.thumb ? `url(${p.thumb})` : '';
    thumb.replaceChildren(...(p?.thumb ? [] : [icon('play', 18)]));
  }

  async function useProject(p: Project): Promise<boolean> {
    const box = h('div', { class: 'dialog' }, h('div', { class: 'box row' }, spinner(24), h('div', { class: 'title' }, 'Opening project...')));
    document.body.append(box);
    try {
      if (!isLoaded(p) && !(await attachProjectMedia(p))) { toast('The videos of this project are missing on this phone.'); return false; }
    } catch (e) { toast(`Could not open the videos: ${(e as Error).message}`); return false; } finally { box.remove(); }
    original = p; working = null;
    paintProject(); welcome();
    return true;
  }

  async function chooseProject() {
    if (busy) return;
    let list: Project[] = [];
    try { list = await listProjects(); } catch { /* empty */ }
    if (!list.length) { toast('No projects yet. Create one in Edit first.'); return; }
    const m = h('div', { class: 'menu', onclick: (e: Event) => { if (e.target === m) m.remove(); } },
      h('div', { class: 'sheet ag-sheet' },
        h('div', { class: 'ag-sheet-title' }, 'Choose a project'),
        ...list.map((p) => h('button', { class: 'ag-pick', onclick: () => { m.remove(); void useProject(p); } },
          h('div', { class: 'ag-thumb', style: p.thumb ? `background-image:url(${p.thumb})` : '' }, p.thumb ? null : icon('play', 18)),
          h('div', { class: 'ag-who' }, h('div', { class: 'ag-name' }, p.name), h('div', { class: 'ag-sub' }, `${fmtClock(p.durationMs)} · ${new Date(p.updatedAt).toLocaleDateString()}`)))),
        h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel')));
    document.body.append(m);
  }

  // ---------- running one instruction
  async function send(text: string) {
    text = text.trim();
    if (!text || busy) return;
    if (!original) { toast('Pick a project first.'); return; }
    busy = true; setBusy(true);
    me(text);
    input.value = '';

    // live progress card
    const rows = AGENT_STEPS.map((label) => {
      const mark = h('span', { class: 'ag-mark' });
      const txt = h('span', {}, label);
      return { el: h('div', { class: 'ag-step' }, mark, txt), mark, txt, label };
    });
    const setRow = (i: number, state: 'idle' | 'run' | 'done' | 'skip', detail?: string) => {
      const r = rows[i]; if (!r) return;
      r.el.className = `ag-step ${state}`;
      r.mark.replaceChildren(...(state === 'run' ? [spinner(14)] : state === 'done' ? [icon('check', 14)] : state === 'skip' ? [document.createTextNode('–')] : []));
      r.txt.textContent = detail ?? r.label;
    };
    rows.forEach((_, i) => setRow(i, 'idle'));
    const card = say('');
    const bub = card.querySelector('.ag-bub')!;
    bub.replaceChildren(h('div', { class: 'ag-steps' }, ...rows.map((r) => r.el)));

    try {
      const base = working ?? original;
      const res = await runAgent({
        project: base, prompt: text, settings: app.settings, apiKey: getKey(),
        onStep: (i, state, detail) => { setRow(i, state === 'run' ? 'run' : state, state === 'run' ? detail : undefined); scroll(); },
      });
      if (destroyed) return;
      working = res.project;
      paintProject();
      bub.replaceChildren(summary(res));
    } catch (e) {
      bub.replaceChildren(h('div', { class: 'ag-err' }, `That did not work: ${(e as Error).message || 'unknown error'}`));
    } finally { busy = false; setBusy(false); scroll(); }
  }

  function summary(res: AgentResult): HTMLElement {
    const s = res.stats;
    const parts: string[] = [];
    if (s.silenceMs >= 500) parts.push(`cut ${secs(s.silenceMs)} of silence`);
    if (s.retakes) parts.push(`removed ${s.retakes} retake${s.retakes === 1 ? '' : 's'}`);
    if (s.fillers) parts.push(`${s.fillers} filler word${s.fillers === 1 ? '' : 's'}`);
    if (s.sfx) parts.push(`added ${s.sfx} SFX`);
    if (s.bgmSections) parts.push('added background music');
    if (s.speed > 1.005) parts.push(`${s.speed}x speed`);
    const line = parts.length ? parts[0]!.charAt(0).toUpperCase() + parts.join(', ').slice(1) + '.' : 'Nothing needed changing here.';
    return h('div', { class: 'ag-result' },
      h('div', { class: 'ag-say' }, res.plan.reply),
      h('div', { class: 'ag-card' },
        h('div', { class: 'ag-line' }, line),
        h('div', { class: 'ag-len' }, `${secs(s.lengthBeforeMs)} → ${secs(s.lengthAfterMs)}`),
        ...s.warnings.map((w) => h('div', { class: 'ag-warn' }, w)),
        h('button', { class: 'btn primary ag-open', onclick: () => void openInTimeline() }, '🎬 Open in Timeline'),
        h('div', { class: 'ag-hint' }, 'Send another instruction to keep refining, or open the timeline to fine-tune by hand.')));
  }

  async function openInTimeline() {
    if (busy) return;
    const p = working ?? original;
    if (!p) return;
    try {
      p.updatedAt = Date.now();
      await saveProject(p);
      app.project = p;
      runtime.projectId = p.id;
      app.intent = undefined;
      app.go('editor');
    } catch (e) { toast(`Could not save: ${(e as Error).message}`); }
  }

  // ---------- bottom: presets + input
  const chips = h('div', { class: 'ag-chips' }, ...PRESETS.map((c) => h('button', { class: 'ag-chip', onclick: () => void send(c.prompt) }, c.label)));
  const input = h('textarea', { class: 'ag-input', rows: 1, placeholder: 'Tell the editor what to do...', 'aria-label': 'Instruction' }) as HTMLTextAreaElement;
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input.value); } });
  const sendBtn = h('button', { class: 'ag-send', 'aria-label': 'Send', onclick: () => void send(input.value) }, icon('back', 20));
  sendBtn.firstElementChild?.setAttribute('style', 'transform:rotate(90deg)');
  function setBusy(on: boolean) { sendBtn.disabled = on; chips.classList.toggle('off', on); changeBtn.disabled = on; }
  const bar = h('div', { class: 'ag-bar' }, chips, h('div', { class: 'ag-row' }, input, sendBtn));

  const el = h('div', { class: 'ag' }, top, chat, bar);
  paintProject(); welcome();

  // start with the project that is open, else the newest one
  (async () => {
    try {
      const cur = app.project;
      if (cur?.host && cur.constant && cur.durationMs > 0) { await useProject(cur); if (original) return; }
      const list = await listProjects();
      const first = list.find((p) => p.host && p.constant);
      if (first && !destroyed && !original) await useProject(first);
    } catch { /* the user can still pick one */ }
  })();

  return { el, destroy: () => { destroyed = true; } };
}
