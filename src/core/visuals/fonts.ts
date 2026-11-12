/**
 * Fonts for visuals, as data: URIs. A picture made from SVG foreignObject cannot load files or URLs,
 * so the faces from public/fonts are read once, turned into @font-face rules and pasted into every visual.
 */
const FACES: { family: string; file: string; weight: number; format: string }[] = [
  { family: 'EdPoppins', file: 'poppins-bold.ttf', weight: 700, format: 'truetype' },
  { family: 'EdInter', file: 'inter-black.otf', weight: 900, format: 'opentype' },
  { family: 'EdSerif', file: 'gfsbaskerville.otf', weight: 400, format: 'opentype' },
  { family: 'EdMono', file: 'liberationmono-bold.ttf', weight: 700, format: 'truetype' },
];

let cache: Promise<string> | null = null;
let cssNow = '';

const toB64 = (buf: ArrayBuffer) => {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The @font-face CSS. A face that fails to load is left out (the stack falls back to system fonts). */
export function loadVisualFonts(base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'): Promise<string> {
  if (cache) return cache;
  cache = (async () => {
    const parts = await Promise.all(FACES.map(async f => {
      try {
        const r = await fetch(`${base}fonts/${f.file}`);
        if (!r.ok) return '';
        return `@font-face{font-family:'${f.family}';font-weight:${f.weight};src:url(data:font/${f.format === 'truetype' ? 'ttf' : 'otf'};base64,${toB64(await r.arrayBuffer())}) format('${f.format}');}`;
      } catch { return ''; }
    }));
    cssNow = parts.join('');
    return cssNow;
  })();
  return cache;
}
/** The CSS if loadVisualFonts already finished, else empty (visuals still draw with system fonts). */
export const visualFontCssNow = () => cssNow;
