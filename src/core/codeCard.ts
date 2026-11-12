/**
 * Code cards: a syntax-highlighted IDE / terminal window drawn as one SVG picture.
 * The picture goes through the same path as every other Kallaway "svg" card (cleaned, baked, drawn in the preview and in the Media3 export),
 * so the preview and the export match without any native change.
 * Languages: html, css, javascript, terminal. No libraries, no network.
 */
export type CodeLang = 'html' | 'css' | 'javascript' | 'terminal';
export interface CodeSnippet { lang: CodeLang; code: string; title: string }

type Cls = 'kw' | 'str' | 'num' | 'com' | 'tag' | 'attr' | 'prop' | 'fn' | 'pun' | 'prompt' | 'txt';
const COLORS: Record<Cls, string> = {
  kw: '#FF7B72', str: '#A5D6FF', num: '#79C0FF', com: '#8B949E', tag: '#7EE787', attr: '#79C0FF', prop: '#79C0FF', fn: '#D2A8FF', pun: '#C9D1D9', prompt: '#7EE787', txt: '#E6EDF3',
};
const JS_KW = 'const|let|var|function|return|if|else|for|while|async|await|import|from|export|default|new|class|try|catch|throw|true|false|null|undefined|typeof';
const RULES: Record<CodeLang, [RegExp, Cls][]> = {
  html: [[/^<!--[\s\S]*?-->/, 'com'], [/^<\/?[A-Za-z][\w-]*/, 'tag'], [/^\/?>/, 'tag'], [/^"[^"]*"|^'[^']*'/, 'str'], [/^[A-Za-z_:@][\w:.-]*(?==)/, 'attr'], [/^=/, 'pun'], [/^\s+/, 'txt'], [/^[^<"'=\s]+/, 'txt']],
  css: [[/^\/\*[\s\S]*?\*\//, 'com'], [/^"[^"]*"|^'[^']*'/, 'str'], [/^#[0-9a-fA-F]{3,8}\b/, 'num'], [/^-?\d*\.?\d+(?:px|rem|em|vh|vw|%|s|ms|deg)?/, 'num'], [/^@[\w-]+/, 'kw'], [/^[A-Za-z-]+(?=\s*:)/, 'prop'], [/^[A-Za-z-]+(?=\()/, 'fn'], [/^[.#][\w-]+/, 'tag'], [/^[{}:;(),]/, 'pun'], [/^\s+/, 'txt'], [/^[\w-]+/, 'txt'], [/^./, 'txt']],
  javascript: [[/^\/\/.*/, 'com'], [/^\/\*[\s\S]*?\*\//, 'com'], [/^`[^`]*`|^"[^"]*"|^'[^']*'/, 'str'], [new RegExp(`^(?:${JS_KW})\\b`), 'kw'], [/^\d[\d_.]*/, 'num'], [/^[A-Za-z_$][\w$]*(?=\()/, 'fn'], [/^=>/, 'kw'], [/^[{}()[\];,.:=+\-*/<>!&|?]+/, 'pun'], [/^\s+/, 'txt'], [/^[\w$]+/, 'txt'], [/^./, 'txt']],
  terminal: [[/^#.*/, 'com'], [/^\$\s?/, 'prompt'], [/^--?[A-Za-z][\w-]*/, 'attr'], [/^"[^"]*"|^'[^']*'/, 'str'], [/^\d[\d.]*/, 'num'], [/^\s+/, 'txt'], [/^\S+/, 'txt']],
};

export function tokenize(line: string, lang: CodeLang): { t: string; c: Cls }[] {
  const out: { t: string; c: Cls }[] = [];
  const rules = RULES[lang];
  let rest = line;
  let guard = 0;
  while (rest && guard++ < 400) {
    let hit = false;
    for (const [re, c] of rules) {
      const m = re.exec(rest);
      if (m && m[0].length) { out.push({ t: m[0], c }); rest = rest.slice(m[0].length); hit = true; break; }
    }
    if (!hit) { out.push({ t: rest[0]!, c: 'txt' }); rest = rest.slice(1); }
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface CodeCardLook { bg: string; bar: string; border: string; accent: string }
export const CODE_LOOK_IDE: CodeCardLook = { bg: '#0D1117', bar: '#161B22', border: '#30363D', accent: '#58A6FF' };
export const CODE_LOOK_TERMINAL: CodeCardLook = { bg: '#050807', bar: '#0B120F', border: '#1E7A4B', accent: '#2CFF8F' };

const MAX_LINES = 10, MAX_COLS = 40;

/** One SVG (viewBox 960 x 720) with window chrome, line numbers and coloured code. */
export function buildCodeCardSvg(snip: CodeSnippet, look: CodeCardLook = snip.lang === 'terminal' ? CODE_LOOK_TERMINAL : CODE_LOOK_IDE): string {
  const lines = snip.code.replace(/\t/g, '  ').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l || (i > 0 && i < a.length - 1)).slice(0, MAX_LINES)
    .map((l) => (l.length > MAX_COLS ? l.slice(0, MAX_COLS - 1) + '…' : l));
  const fs = 34, lh = 52, top = 150, left = 108;
  const H = Math.max(520, top + lines.length * lh + 70);
  const rows = lines.map((l, i) => {
    const y = top + i * lh;
    const spans = tokenize(l, snip.lang).map((tk) => `<tspan fill="${COLORS[tk.c]}">${esc(tk.t)}</tspan>`).join('');
    return `<text x="52" y="${y}" font-size="26" fill="#6E7681" text-anchor="end" xml:space="preserve" font-family="monospace">${i + 1}</text>` +
      `<text x="${left}" y="${y}" font-size="${fs}" xml:space="preserve" font-family="'JetBrains Mono','Roboto Mono','DejaVu Sans Mono','Courier New',monospace">${spans}</text>`;
  }).join('');
  const file = esc(snip.title || (snip.lang === 'html' ? 'index.html' : snip.lang === 'css' ? 'style.css' : snip.lang === 'javascript' ? 'app.js' : 'zsh'));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${H}">` +
    `<rect x="4" y="4" width="952" height="${H - 8}" rx="28" fill="${look.bg}" stroke="${look.border}" stroke-width="3"/>` +
    `<path d="M4 32a28 28 0 0 1 28-28h896a28 28 0 0 1 28 28v60H4z" fill="${look.bar}"/>` +
    `<circle cx="52" cy="48" r="12" fill="#FF5F57"/><circle cx="92" cy="48" r="12" fill="#FEBC2E"/><circle cx="132" cy="48" r="12" fill="#28C840"/>` +
    `<text x="480" y="58" font-size="26" text-anchor="middle" fill="#8B949E" font-family="'Inter',sans-serif">${file}</text>` +
    `<rect x="4" y="92" width="952" height="3" fill="${look.accent}" opacity="0.7"/>` +
    rows + `</svg>`;
}

// ---------------------------------------------------------------- built-in snippets for the offline director
const SNIPPETS: { re: RegExp; snip: CodeSnippet }[] = [
  { re: /\b(html|markup|tag|tags|webpage|web page|website|landing page)\b/i, snip: { lang: 'html', title: 'index.html', code: '<main class="hero">\n  <h1>Hello, world</h1>\n  <video autoplay muted />\n  <a href="/start">Get started</a>\n</main>' } },
  { re: /\b(css|style|styles|styling|design|animation|animate|layout)\b/i, snip: { lang: 'css', title: 'style.css', code: '.hero {\n  display: grid;\n  place-items: center;\n  background: #0d1117;\n  transition: transform 0.3s;\n}' } },
  { re: /\b(api|fetch|request|server|backend|endpoint|json|data)\b/i, snip: { lang: 'javascript', title: 'api.js', code: 'const res = await fetch("/api/data");\nconst json = await res.json();\nconsole.log(json.items.length);' } },
  { re: /\b(bug|bugs|error|errors|debug|fix|crash|exception)\b/i, snip: { lang: 'javascript', title: 'debug.js', code: 'try {\n  runApp();\n} catch (err) {\n  console.error("Bug found:", err);\n}' } },
  { re: /\b(install|terminal|command|npm|git|deploy|build|run|script|cli)\b/i, snip: { lang: 'terminal', title: 'zsh', code: '$ npm install\n$ npm run build\n$ git push origin main\n# deployed in 12s' } },
  { re: /\b(code|coding|javascript|js|function|logic|program|programming|app|apps|react|python|developer|software)\b/i, snip: { lang: 'javascript', title: 'app.js', code: 'const build = async (idea) => {\n  const app = await ship(idea);\n  return app.users;\n};\nbuild("my app");' } },
];
/** A fitting snippet for a spoken sentence, or null when the sentence is not about code or tech. */
export function snippetFor(text: string): CodeSnippet | null {
  for (const s of SNIPPETS) if (s.re.test(text)) return s.snip;
  return null;
}
