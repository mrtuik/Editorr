import { app } from '../app';
import { probeVideo } from '../core/audio';
import { runtime, saveProject } from '../core/store';
import type { Role, VideoRef } from '../core/types';
import { EditorrNative, fileSrc, isNative } from '../core/native';
import { projectVideoPaths } from '../core/media';
import { fmtTime, h, icon, iconButton, toast } from '../ui';

const MAX_MS = 15 * 60 * 1000;

export function importScreen() {
  const p = app.project;
  const info: Partial<Record<Role, VideoRef>> = {};
  if (p.host && runtime.hostUrl) info.host = { ...p.host, url: runtime.hostUrl };
  if (p.constant && runtime.constUrl) info.constant = { ...p.constant, url: runtime.constUrl };

  const slots = h('div');
  const warnings = h('div');
  const cont = h('button', { class: 'btn primary', disabled: true, onclick: next }, 'Continue');

  async function pickNative(role: Role) {
    try {
      toast('Copying video...', 4000);
      const v = await EditorrNative.pickVideo();
      const url = fileSrc(v.path);
      info[role] = { name: v.name, url, uri: 'file://' + v.path, durationMs: v.durationMs, width: v.width, height: v.height, fps: v.fps || 30 };
      if (role === 'host') { runtime.hostPath = v.path; runtime.hostUrl = url; runtime.hostPcm = undefined; runtime.hostFile = undefined; }
      else { runtime.constPath = v.path; runtime.constUrl = url; runtime.constPcm = undefined; runtime.constFile = undefined; }
      render();
    } catch (e) {
      const m = (e as Error).message || '';
      if (!/cancel/i.test(m)) toast(m || 'Could not open this video.');
    }
  }

  function pick(role: Role) {
    if (isNative()) { pickNative(role); return; }
    const input = h('input', { type: 'file', accept: 'video/*' });
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const url = URL.createObjectURL(f);
        const meta = await probeVideo(url);
        info[role] = { name: f.name, url, durationMs: meta.durationMs, width: meta.width, height: meta.height, fps: 30 };
        if (role === 'host') { runtime.hostFile = f; runtime.hostUrl = url; runtime.hostPcm = undefined; }
        else { runtime.constFile = f; runtime.constUrl = url; runtime.constPcm = undefined; }
        render();
      } catch (e) { toast((e as Error).message); }
    };
    input.click();
  }

  function swap() {
    [info.host, info.constant] = [info.constant, info.host];
    [runtime.hostFile, runtime.constFile] = [runtime.constFile, runtime.hostFile];
    [runtime.hostPath, runtime.constPath] = [runtime.constPath, runtime.hostPath];
    [runtime.hostUrl, runtime.constUrl] = [runtime.constUrl, runtime.hostUrl];
    [runtime.hostPcm, runtime.constPcm] = [runtime.constPcm, runtime.hostPcm];
    render();
  }

  function slot(role: Role, label: string) {
    const v = info[role];
    return h('div', { class: 'slot' + (v ? ' filled' : '') },
      h('div', { class: 'title' }, label),
      v
        ? h('div', {},
            h('div', { class: 'cap' }, v.name),
            h('div', { class: 'sec' }, `${fmtTime(v.durationMs)} - ${v.width}x${v.height}`))
        : h('div', { class: 'cap' }, 'No video selected'),
      h('div', { style: 'margin-top:10px' },
        h('button', { class: 'btn small', onclick: () => pick(role) }, v ? 'Change video' : 'Pick from gallery')));
  }

  function render() {
    slots.replaceChildren(
      slot('host', 'Host video'),
      h('div', { style: 'text-align:center;margin:-4px 0 8px' },
        h('button', { class: 'btn small', 'aria-label': 'Swap Host and Constant', onclick: swap }, icon('swap', 20), 'Swap')),
      slot('constant', 'Constant video'));

    const w: string[] = [];
    const { host, constant } = info;
    if (host && host.durationMs > MAX_MS) w.push('Host video is longer than 15 minutes. Trim it first for best results.');
    if (constant && constant.durationMs > MAX_MS) w.push('Constant video is longer than 15 minutes. Trim it first for best results.');
    if (host && constant) {
      if (Math.abs(host.durationMs - constant.durationMs) > 1000) w.push('The two videos differ in length by more than 1 second. Sync will trim to the overlap.');
      if (host.width !== constant.width || host.height !== constant.height) w.push('Resolutions differ. Export will scale both to fit.');
      if ((host.width > host.height) !== (constant.width > constant.height)) w.push('One video is portrait and the other landscape. Record both in the same orientation.');
    }
    warnings.replaceChildren(...w.map((t) => h('div', { class: 'warn' }, t)));
    cont.disabled = !(host && constant);
  }

  async function next() {
    const { host, constant } = info;
    if (!host || !constant) return;
    const { url: _a, ...hostMeta } = host;
    const { url: _b, ...constMeta } = constant;
    const before = projectVideoPaths(p);
    p.host = hostMeta; p.constant = constMeta;
    p.segments = []; p.offsetMs = 0;
    runtime.projectId = p.id;
    await saveProject(p);
    // a video that was replaced is no longer used: free its space
    if (isNative()) {
      const now = projectVideoPaths(p);
      const old = before.filter((x) => !now.includes(x));
      if (old.length) EditorrNative.deleteVideos({ paths: old }).catch(() => {});
    }
    app.go('sync');
  }

  render();
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' }, iconButton('back', 'Back', () => app.go('home')), h('h1', {}, 'Import videos')),
    h('div', { class: 'content' },
      slots, warnings,
      h('div', { class: 'cap' }, 'Max 15 minutes per video. Everything stays on your phone.')),
    h('div', { class: 'bottombar' }, cont));
  return { el };
}
