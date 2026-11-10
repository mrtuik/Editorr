/**
 * The shared "glass on onyx" look of every Kallaway card and every plain documentary split card:
 *   dotGrid   deep onyx #060607, 1.5 px dots every 30 px, and a soft vignette
 *   glassCard #141418 at 92 %, inner sheen, layered contact + ambient shadow, specular edge on the top and right side
 * `k` = frame short side / 1080. The Android export repeats the same numbers (EditorrNativePlugin.DocuOverlay.paintGlass*).
 */

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + k, y); g.lineTo(x + w - k, y); g.arcTo(x + w, y, x + w, y + k, k);
  g.lineTo(x + w, y + h - k); g.arcTo(x + w, y + h, x + w - k, y + h, k);
  g.lineTo(x + k, y + h); g.arcTo(x, y + h, x, y + h - k, k);
  g.lineTo(x, y + k); g.arcTo(x, y, x + k, y, k);
  g.closePath();
}

/** Glass card: #141418 at 92 %, inner sheen, layered contact + ambient shadow, and a specular edge along the top and right side. */
export function glassCard(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, k: number) {
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 32 * k; g.shadowOffsetY = 16 * k;
  g.fillStyle = 'rgba(20,20,24,0.92)'; rr(g, x, y, w, h, r); g.fill();
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 12 * k; g.shadowOffsetY = 4 * k;
  g.fill();
  g.restore();
  g.save(); rr(g, x, y, w, h, r); g.clip();
  const inner = g.createLinearGradient(x, y, x + w * 0.4, y + h);
  inner.addColorStop(0, 'rgba(255,255,255,0.07)'); inner.addColorStop(0.5, 'rgba(255,255,255,0)'); inner.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = inner; g.fillRect(x, y, w, h);
  // specular: 2 px edge, bright near the top-right corner and fading away along both sides
  const top = g.createLinearGradient(x, y, x + w, y);
  top.addColorStop(0, 'rgba(255,255,255,0)'); top.addColorStop(1, 'rgba(255,255,255,0.7)');
  g.fillStyle = top; g.fillRect(x, y, w, 2 * k);
  const right = g.createLinearGradient(0, y, 0, y + h);
  right.addColorStop(0, 'rgba(255,255,255,0.7)'); right.addColorStop(0.6, 'rgba(255,255,255,0)');
  g.fillStyle = right; g.fillRect(x + w - 2 * k, y, 2 * k, h);
  g.restore();
  g.lineWidth = 1 * k; g.strokeStyle = 'rgba(255,255,255,0.12)';
  rr(g, x + k / 2, y + k / 2, w - k, h - k, Math.max(0, r - k / 2)); g.stroke();
}

export function dotGrid(g: CanvasRenderingContext2D, w: number, h: number, k: number) {
  g.fillStyle = '#060607'; g.fillRect(0, 0, w, h);
  const step = Math.max(8, Math.round(30 * k)), r = Math.max(0.7, 0.75 * k); // 1.5 px round dots every 30 px
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.beginPath();
  for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) { g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); }
  g.fill();
  // soft darkening towards the edges so the card stands out
  const v = g.createRadialGradient(w / 2, h * 0.4, Math.min(w, h) * 0.3, w / 2, h * 0.4, Math.hypot(w, h) * 0.62);
  v.addColorStop(0, 'rgba(18,18,24,0.4)'); v.addColorStop(1, 'rgba(6,6,7,0.95)');
  g.fillStyle = v; g.fillRect(0, 0, w, h);
}

