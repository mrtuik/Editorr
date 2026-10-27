/**
 * AI Agent planner: turns a plain-language instruction ("make it fast paced, cut retakes, add meme sounds")
 * into timeline edits. Everything runs on the phone with the existing tools:
 *   silence.ts  -> silent pauses        sfxPlan.ts -> where meme sounds go
 *   mood.ts     -> background music     timeline.ts -> cutting segments
 * An optional LLM (Gemini or Claude, when an API key is given) only DECIDES the plan; the edit itself is always done here,
 * so preview and export stay identical to every other Editorr edit.
 */
import { SAMPLE_RATE } from './audio';
import { renderMix, toBase64, toBuffer, toWav } from './bgm';
import type { CapWord } from './captions';
import { analyzeMood, MOOD_LABEL } from './mood';
import { EditorrNative, isNative } from './native';
import { ensureAudio, runAutoSwitch, runSync } from './pipeline';
import { detectSilence } from './silence';
import { AUTO_INFO, planSfx, type AutoKind } from './sfxPlan';
import { runtime } from './store';
import { synthLoop, synthSfx } from './synth';
import { coverage, defaultSegments, dropSlivers, keptMs, subtractRanges, type Range } from './timeline';
import { transcribe } from './transcribe';
import type { Project, Segment, Settings } from './types';

// ------------------------------------------------------------------ types

export const AGENT_STEPS = [
  'Reading audio & transcript...',
  'Removing false starts and silent pauses...',
  'Scoring punchlines with meme sounds...',
  'Applying retention speed...',
] as const;

export interface AgentPlan {
  /** 1 = normal. Clips get this speed (1.1 = 10% faster). */
  speed: number;
  /** Cut silences longer than this (ms). 0 = leave silences alone. */
  silenceMinMs: number;
  retakes: boolean;
  fillers: boolean;
  meme: boolean;
  /** Most meme sounds to add. */
  memeMax: number;
  bgm: boolean;
  /** Music level under the voice (dB, negative). */
  bgmLevelDb: number;
  normalize: boolean;
  /** Extra ranges to drop, chosen by the LLM from the transcript. */
  dropRanges: Range[];
  /** Short line the assistant says about what it understood. */
  reply: string;
  source: 'local' | 'llm';
}

export interface AgentStats {
  lengthBeforeMs: number;
  lengthAfterMs: number;
  silenceMs: number;
  retakes: number;
  fillers: number;
  sfx: number;
  bgmSections: number;
  speed: number;
  warnings: string[];
}

export interface AgentInput {
  project: Project;
  prompt: string;
  /** Mono 16 kHz audio of the Host video. Missing = read from runtime / the video. */
  pcm?: Float32Array;
  settings?: Settings;
  /** Gemini (AIza...) or Claude (sk-ant-...) key. Empty = local rules only. */
  apiKey?: string;
  /** Called with the step index (0..3) when it starts and again with done=true when it ends. */
  onStep?: (step: number, state: 'run' | 'done' | 'skip', detail?: string) => void;
}

export interface AgentResult { project: Project; stats: AgentStats; plan: AgentPlan }

// ------------------------------------------------------------------ plan from the instruction (local rules)

const has = (t: string, re: RegExp) => re.test(t);

export function localPlan(prompt: string): { plan: AgentPlan; understood: boolean } {
  const t = prompt.toLowerCase();
  const fast = has(t, /\b(fast|viral|pace|paced|pacing|quick|tight|snappy|retention|tiktok|reels?|shorts?|speed)\b/);
  const retakes = has(t, /\b(retakes?|stutters?|false starts?|bad takes?|repeat(s|ed)?|mistakes?|filler|fillers|umm?|clean)\b/);
  const meme = has(t, /\b(meme|memes|sfx|sound effects?|funny|vine|boom|laugh|bruh|joke|comedy|punchlines?)\b/);
  const studio = has(t, /\b(studio|podcast|polish|professional|clean)\b/);
  const music = has(t, /\b(bgm|music|background|lofi|ambient|studio|podcast)\b/);
  const understood = fast || retakes || meme || studio || music;
  const plan: AgentPlan = {
    speed: fast ? 1.1 : 1,
    silenceMinMs: fast ? 400 : studio ? 700 : !understood ? 700 : 0,
    retakes: retakes || studio || !understood,
    fillers: retakes || studio || fast || !understood,
    meme,
    memeMax: has(t, /\b(lots|many|more|heavy|max)\b/) ? 14 : 8,
    bgm: music || (meme && fast),
    bgmLevelDb: studio ? -26 : -20,
    normalize: studio,
    dropRanges: [],
    reply: '',
    source: 'local',
  };
  return { plan, understood };
}

// ------------------------------------------------------------------ optional LLM

const clamp = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);

/** Transcript as short timed lines: "[12.4s] words words words". */
function transcriptText(words: CapWord[], maxWords = 5000): string {
  const out: string[] = [];
  let line: string[] = [], t0 = 0;
  for (const w of words.slice(0, maxWords)) {
    if (!line.length) t0 = w.s;
    line.push((w.orig || w.w).trim());
    if (line.length >= 10) { out.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`); line = []; }
  }
  if (line.length) out.push(`[${(t0 / 1000).toFixed(1)}s] ${line.join(' ')}`);
  return out.join('\n');
}

const SYSTEM = `You plan edits for a podcast/video editor. Reply with ONE JSON object only, no markdown:
{"speed":1.0-1.3,"silenceMinMs":0 or 300-1500,"retakes":bool,"fillers":bool,"meme":bool,"memeMax":0-20,"bgm":bool,"bgmLevelDb":-30..-12,"normalize":bool,
"dropRanges":[{"startMs":int,"endMs":int}],"reply":"one short sentence on what you will do"}
speed 1.1 = fast paced. silenceMinMs 400 = very tight. dropRanges = parts of the transcript to delete (failed takes, rambling the user asked to cut). Times are in milliseconds from the transcript's seconds.`;

/**
 * Ask an external LLM for a custom plan. Returns null on any problem (no key, offline, bad answer) so the caller falls back to the local rules.
 * Key starting with "sk-ant" = Claude, otherwise Gemini.
 */
export async function planWithLLM(transcript: string, prompt: string, apiKey: string, durationMs = 0): Promise<Partial<AgentPlan> | null> {
  if (!apiKey || !apiKey.trim()) return null;
  const key = apiKey.trim();
  const user = `Instruction: ${prompt}\nVideo length: ${Math.round(durationMs / 1000)}s\nTranscript:\n${transcript || '(no transcript)'}`;
  try {
    let text = '';
    if (key.startsWith('sk-ant')) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      text = (j.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
    } else {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      text = j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    }
    const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const drops: Range[] = Array.isArray(o.dropRanges)
      ? o.dropRanges.map((r: { startMs?: number; endMs?: number }) => ({ startMs: Number(r.startMs), endMs: Number(r.endMs) }))
          .filter((r: Range) => isFinite(r.startMs) && isFinite(r.endMs) && r.endMs - r.startMs >= 200 && r.endMs <= durationMs + 1000).slice(0, 40)
      : [];
    return {
      speed: clamp(o.speed, 1, 1.3, 1),
      silenceMinMs: o.silenceMinMs ? clamp(o.silenceMinMs, 300, 1500, 700) : 0,
      retakes: !!o.retakes, fillers: !!o.fillers, meme: !!o.meme,
      memeMax: Math.round(clamp(o.memeMax, 0, 20, 8)), bgm: !!o.bgm,
      bgmLevelDb: clamp(o.bgmLevelDb, -30, -12, -20), normalize: !!o.normalize,
      dropRanges: drops, reply: typeof o.reply === 'string' ? o.reply.slice(0, 200) : '', source: 'llm',
    };
  } catch { return null; }
}

// ------------------------------------------------------------------ retakes, stutters, fillers (word level)

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'hmm', 'hm', 'mmm']);
const OK_REPEAT = new Set(['very', 'so', 'no', 'yes', 'really', 'ha', 'haha', 'hahaha', 'again', 'bye', 'hey', 'now', 'ok', 'okay', 'one', 'two']);
const norm = (w: CapWord) => (w.w || w.orig || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function mergeRanges(r: Range[]): Range[] {
  const s = r.filter((x) => x.endMs > x.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: Range[] = [];
  for (const x of s) {
    const l = out[out.length - 1];
    if (l && x.startMs <= l.endMs + 40) l.endMs = Math.max(l.endMs, x.endMs); else out.push({ ...x });
  }
  return out;
}

/** Subtract `holes` from `ranges`. */
function minusRanges(ranges: Range[], holes: Range[]): Range[] {
  let out = ranges;
  for (const h of holes) {
    const next: Range[] = [];
    for (const r of out) {
      if (h.endMs <= r.startMs || h.startMs >= r.endMs) { next.push(r); continue; }
      if (h.startMs - r.startMs >= 100) next.push({ startMs: r.startMs, endMs: h.startMs });
      if (r.endMs - h.endMs >= 100) next.push({ startMs: h.endMs, endMs: r.endMs });
    }
    out = next;
  }
  return out;
}

/**
 * Drop the failed attempt and keep the last one:
 *   "I I think" / "the the best"            repeated word or phrase (1-4 words)
 *   "So today we ... [pause] So today we"   a sentence started again after a pause
 *   "um", "uh"                              fillers
 */
export function findRetakes(words: CapWord[], opt: { retakes: boolean; fillers: boolean }): { cuts: Range[]; retakes: number; fillers: number } {
  const cuts: Range[] = [];
  let retakes = 0, fillers = 0;
  const tok = words.map(norm);
  const covered = new Uint8Array(words.length);

  if (opt.retakes) {
    // 1) immediate repeats: n words said twice in a row, drop the first copy
    for (let i = 0; i < words.length; i++) {
      if (covered[i]) continue;
      for (let n = 4; n >= 1; n--) {
        if (i + 2 * n > words.length) continue;
        let same = true;
        for (let k = 0; k < n; k++) if (!tok[i + k] || tok[i + k] !== tok[i + n + k]) { same = false; break; }
        if (!same) continue;
        if (n === 1 && (OK_REPEAT.has(tok[i]!) || FILLERS.has(tok[i]!))) continue;
        if (words[i + n]!.s - words[i + n - 1]!.e > 900) continue; // a long gap is a restart, handled below
        cuts.push({ startMs: words[i]!.s, endMs: words[i + n]!.s });
        for (let k = 0; k < n; k++) covered[i + k] = 1;
        retakes++;
        i += n - 1;
        break;
      }
    }
    // 2) restarts after a pause: split into attempts, drop an attempt that the next one repeats
    const starts: number[] = [0];
    for (let i = 1; i < words.length; i++) if (words[i]!.s - words[i - 1]!.e >= 600) starts.push(i);
    for (let a = 0; a + 1 < starts.length; a++) {
      const i = starts[a]!, j = starts[a + 1]!, end = starts[a + 2] ?? words.length;
      const lenA = j - i, lenB = end - j;
      if (lenA < 2 || lenA > 25 || words[j]!.s - words[j - 1]!.e > 6000) continue;
      const A = tok.slice(i, j).filter((x) => x && !FILLERS.has(x)), B = tok.slice(j, end).filter((x) => x && !FILLERS.has(x));
      const head = Math.min(3, A.length, B.length);
      let sameHead = head >= 2;
      for (let k = 0; k < head; k++) if (A[k] !== B[k]) sameHead = false;
      const setB = new Set(B);
      const jac = A.length ? A.filter((x) => setB.has(x)).length / new Set([...A, ...B]).size : 0;
      if ((sameHead && lenB >= lenA - 1) || (jac >= 0.7 && lenB >= lenA - 2)) {
        const r = { startMs: words[i]!.s, endMs: words[j]!.s };
        if (!covered[i]) { cuts.push(r); retakes++; for (let k = i; k < j; k++) covered[k] = 1; }
      }
    }
  }
  if (opt.fillers) {
    for (let i = 0; i < words.length; i++) {
      if (covered[i] || !FILLERS.has(tok[i]!)) continue;
      cuts.push({ startMs: words[i]!.s, endMs: Math.max(words[i]!.e, words[i]!.s + 150) });
      fillers++;
    }
  }
  // shrink each cut a little so the neighbouring words are not clipped
  const tight = mergeRanges(cuts).map((r) => ({ startMs: r.startMs + 20, endMs: r.endMs - 20 })).filter((r) => r.endMs - r.startMs >= 120);
  return { cuts: tight, retakes, fillers };
}

// ------------------------------------------------------------------ helpers

/** Audio that starts at timeline 0 (the Host video is already there; Constant is shifted by the sync offset). */
function timelinePcm(p: Project, src: Float32Array, role: 'host' | 'constant'): Float32Array {
  if (role === 'host') return src;
  const per = SAMPLE_RATE / 1000, shift = Math.round(p.offsetMs * per);
  const n = Math.ceil(p.durationMs * per);
  if (shift >= 0) return src.subarray(shift, shift + n);
  const out = new Float32Array(n);
  out.set(src.subarray(0, Math.max(0, n + shift)), -shift);
  return out;
}

const outputMs = (segs: Segment[]) => segs.reduce((a, s) => a + (s.endMs - s.startMs) / (s.speed || 1), 0);

/** Make sure the project has segments (a project that was never opened in the editor has none yet). */
async function prepare(p: Project, settings: Settings): Promise<void> {
  if (p.segments.length) return;
  if (p.single || !p.constant) {
    p.segments = defaultSegments(p.durationMs || p.host?.durationMs || 0, 'host');
    return;
  }
  await ensureAudio('host'); await ensureAudio('constant');
  runSync(p);
  p.segments = runAutoSwitch(p, settings);
}

async function writeTrack(name: string, wav: Uint8Array): Promise<string> {
  const CH = 1_500_000;
  let path = '';
  for (let at = 0; at < wav.length; at += CH) {
    const r = await EditorrNative.writeBytes({ name, data: toBase64(wav.subarray(at, at + CH)), append: at > 0 });
    path = r.path;
  }
  return path;
}

const MEME_KINDS = new Set<AutoKind>((Object.keys(AUTO_INFO) as AutoKind[]).filter((k) => AUTO_INFO[k].meme));
const tick = () => new Promise<void>((r) => setTimeout(r, 30));

// ------------------------------------------------------------------ the agent

/**
 * Runs the whole edit on a COPY of the project and returns it with the numbers for the summary card.
 * The original is untouched until the caller decides to keep the result.
 */
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const step = input.onStep ?? (() => {});
  const p: Project = structuredClone(input.project);
  const settings = input.settings ?? ({ silencePadMs: 150, silenceSens: 'medium' } as Settings);
  const warnings: string[] = [];

  // ---- step 0: audio, transcript, plan
  step(0, 'run');
  await prepare(p, settings);
  const role = p.mainAudio;
  let host = input.pcm ?? runtime.hostPcm;
  if (!host) host = await ensureAudio('host');
  let cons = runtime.constPcm ?? host;
  if (!p.single && p.constant && !runtime.constPcm) cons = await ensureAudio('constant');
  const voiceSrc = role === 'host' ? host : cons;
  const voice = timelinePcm(p, voiceSrc, role);

  const lp = localPlan(input.prompt);
  let plan = lp.plan;
  let words: CapWord[] = p.captions?.words?.length ? p.captions.words : p.agentWords?.words ?? [];
  const wantsWords = plan.retakes || plan.meme || !!input.apiKey;
  if (!words.length && wantsWords && voice.length > SAMPLE_RATE * 2) {
    step(0, 'run', 'Transcribing speech (first time downloads the model)...');
    try {
      const job = transcribe(voice, settings.whisperModel ?? 'base', settings.captionLang ?? '', (t, pct) => step(0, 'run', pct !== undefined ? `${t} ${pct}%` : t));
      const data = await job.promise;
      if (data.words.length) { words = data.words; p.agentWords = data; }
      else warnings.push('No speech was found, so retakes and word-based sounds were skipped.');
    } catch (e) {
      warnings.push(`Transcript unavailable (${(e as Error).message || 'failed'}). Retakes and word-based sounds were skipped; silence and speed still applied.`);
    }
  }
  if (input.apiKey) {
    step(0, 'run', 'Asking the AI for a plan...');
    const llm = await planWithLLM(transcriptText(words), input.prompt, input.apiKey, p.durationMs);
    if (llm) plan = { ...plan, ...llm, source: 'llm' };
    else warnings.push('The AI could not be reached, so the built-in rules were used.');
  }
  if (!plan.reply) {
    const bits: string[] = [];
    if (plan.speed > 1) bits.push(`${plan.speed}x speed`);
    if (plan.silenceMinMs) bits.push('tighter pauses');
    if (plan.retakes) bits.push('retakes and stutters out');
    if (plan.meme) bits.push('meme sounds');
    if (plan.bgm) bits.push('background music');
    plan.reply = lp.understood || plan.source === 'llm'
      ? `On it: ${bits.join(', ') || 'a light clean-up'}.`
      : "I wasn't sure what you meant, so I did a safe clean-up: pauses and retakes.";
  }
  step(0, 'done');

  const before = outputMs(p.segments);
  const total = p.durationMs;

  // ---- sound moments are chosen BEFORE cutting, so an awkward-silence beat can be protected from the silence cut
  let moments = plan.meme
    ? planSfx({ segments: p.segments, texts: p.texts ?? [], words, voice, voiceShiftMs: 0, durationMs: total }).filter((m) => MEME_KINDS.has(m.kind))
    : [];
  moments = moments.slice(0, plan.memeMax);

  // ---- step 1: retakes + silence
  step(1, 'run');
  await tick();
  let retakeCuts: Range[] = [];
  let retakeN = 0, fillerN = 0;
  if ((plan.retakes || plan.fillers) && words.length) {
    const r = findRetakes(words, { retakes: plan.retakes, fillers: plan.fillers });
    retakeCuts = r.cuts; retakeN = r.retakes; fillerN = r.fillers;
  }
  retakeCuts = mergeRanges([...retakeCuts, ...plan.dropRanges.map((d) => ({ startMs: Math.max(0, d.startMs), endMs: Math.min(total, d.endMs) }))]);
  let segs = p.segments;
  if (retakeCuts.length) segs = dropSlivers(subtractRanges(segs, retakeCuts));
  const afterRetakes = keptMs(segs);

  let silenceCuts: Range[] = [];
  if (plan.silenceMinMs > 0) {
    try {
      const keep = coverage(segs);
      silenceCuts = detectSilence(host, cons, p.offsetMs, total, { minMs: plan.silenceMinMs, padMs: Math.min(settings.silencePadMs ?? 150, 150), sens: settings.silenceSens ?? 'medium' }, keep);
      // keep the quiet beat where a "crickets" sound will play
      const beats = moments.filter((m) => m.kind === 'silence').map((m) => ({ startMs: m.startMs - 200, endMs: m.startMs + 1600 }));
      if (beats.length) silenceCuts = minusRanges(silenceCuts, beats);
      if (silenceCuts.length) segs = dropSlivers(subtractRanges(segs, silenceCuts));
    } catch { warnings.push('Silence detection failed, pauses were left as they are.'); }
  }
  if (!segs.length) { segs = p.segments; warnings.push('Everything would have been cut, so the cuts were undone.'); retakeN = fillerN = 0; silenceCuts = []; }
  const silenceMs = Math.max(0, afterRetakes - keptMs(segs));
  p.segments = segs;
  step(1, 'done');

  // ---- step 2: meme sounds + music
  const kept = coverage(p.segments);
  moments = moments.filter((m) => kept.some((k) => m.startMs >= k.startMs && m.startMs < k.endMs));
  let sfxN = 0, bgmN = 0;
  if (plan.meme || plan.bgm) {
    step(2, 'run');
    await tick();
    if (!isNative()) {
      warnings.push('Music and sounds are saved in the Android app only, so they were skipped here.');
    } else if (p.durationMs >= 3000) {
      try {
        const lvl = settings.sfxLevel ?? 55;
        const sfx = moments.map((m) => ({ kind: m.kind, buf: toBuffer(synthSfx(AUTO_INFO[m.kind].synth)), startMs: m.startMs, gain: lvl / 100 }));
        const sections = plan.bgm ? analyzeMood(voice, 0, total, words) : [];
        const clips = sections.map((s, i) => ({ buf: toBuffer(synthLoop(s.mood, 3 + i)), startMs: s.startMs, endMs: s.endMs, loop: true, levelDb: plan.bgmLevelDb, duck: true, mood: s.mood }));
        const duckDb = settings.musicDuckDb ?? 14, fadeMs = settings.musicFadeMs ?? 1500;
        if (sfx.length || clips.length) {
          const mix = renderMix({ songs: [], sfx, clips, durationMs: total, voice, voiceShiftMs: 0, levelDb: plan.bgmLevelDb, duckDb, fadeMs });
          await tick();
          const path = await writeTrack(`bgm_${p.id}.wav`, toWav(mix));
          p.bgm = {
            path, levelDb: plan.bgmLevelDb, duckDb, fadeMs,
            names: [...clips.map((c) => `${MOOD_LABEL[c.mood]} music (made here)`), ...sfx.map((s) => AUTO_INFO[s.kind].label)],
            sfx: sfx.map((s) => ({ name: AUTO_INFO[s.kind].label, startMs: s.startMs })),
            items: [
              ...clips.map((c) => ({ name: `${MOOD_LABEL[c.mood]} music (made here)`, startMs: c.startMs, endMs: c.endMs, kind: 'bgm' as const, mood: c.mood })),
              ...sfx.map((s) => ({ name: AUTO_INFO[s.kind].label, startMs: s.startMs, endMs: s.startMs + Math.round(s.buf.duration * 1000), kind: 'sfx' as const })),
            ],
          };
          p.autoSoundDone = true;
          sfxN = sfx.length; bgmN = clips.length;
        }
      } catch (e) { warnings.push(`Music and sounds failed: ${(e as Error).message || 'unknown error'}`); }
    }
    step(2, 'done');
  } else step(2, 'skip');

  // ---- step 3: speed
  if (plan.speed > 1.005) {
    step(3, 'run');
    p.segments = p.segments.map((s) => (s.reaction ? s : { ...s, speed: Math.round(plan.speed * 100) / 100 }));
    step(3, 'done');
  } else step(3, 'skip');
  if (plan.normalize) p.normalize = true;

  const after = outputMs(p.segments);
  return {
    project: p,
    plan,
    stats: {
      lengthBeforeMs: before, lengthAfterMs: after, silenceMs, retakes: retakeN, fillers: fillerN,
      sfx: sfxN, bgmSections: bgmN, speed: plan.speed, warnings,
    },
  };
}
