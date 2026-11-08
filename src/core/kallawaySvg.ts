/**
 * Custom SVG graphics (written by the AI director or pasted by hand) are drawn as a picture, never as live markup.
 * Even so the markup is cleaned first: no scripts, no embedded pages, no event handlers, no links to anything outside the file.
 */
const BAD_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas', 'animate', 'set', 'animatetransform', 'animatemotion']);

/** Returns clean markup (a single <svg> with a viewBox) or undefined when it cannot be used. */
export function sanitizeSvg(markup: string): string | undefined {
  const src = (markup || '').trim();
  if (!src || src.length > 60000 || !/<svg[\s>]/i.test(src)) return undefined;
  let doc: Document;
  try { doc = new DOMParser().parseFromString(src, 'image/svg+xml'); } catch { return undefined; }
  if (doc.getElementsByTagName('parsererror').length) return undefined;
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg') return undefined;
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (BAD_TAGS.has(child.localName.toLowerCase())) { child.remove(); continue; }
      walk(child);
    }
    for (const at of Array.from(el.attributes)) {
      const n = at.name.toLowerCase(), v = at.value.trim().toLowerCase();
      if (n.startsWith('on')) { el.removeAttribute(at.name); continue; }
      if ((n === 'href' || n === 'xlink:href') && !v.startsWith('#')) { el.removeAttribute(at.name); continue; }
      if (/url\(\s*['"]?\s*(https?:|data:|\/\/|file:)/i.test(v) || v.includes('javascript:')) { el.removeAttribute(at.name); continue; }
    }
    if (el.localName.toLowerCase() === 'style') el.textContent = (el.textContent ?? '').replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?\s*(https?:|data:|\/\/|file:)[^)]*\)/gi, 'none');
  };
  walk(root);
  if (!root.getAttribute('viewBox')) {
    const w = parseFloat(root.getAttribute('width') ?? ''), h = parseFloat(root.getAttribute('height') ?? '');
    if (w > 0 && h > 0) root.setAttribute('viewBox', `0 0 ${w} ${h}`); else return undefined;
  }
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(root);
}

export const svgDataUrl = (clean: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(clean);
