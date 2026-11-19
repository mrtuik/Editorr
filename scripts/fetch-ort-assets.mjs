// Remove BG offline files. Runs in CI after `npm install` (npm run ort-assets). Never fails the build:
// the app then falls back to the internet (jsDelivr is NOT used; the RVM model comes from the GitHub release).
//  1. onnxruntime-web wasm/mjs files -> public/ort
//  2. RVM MobileNetV3 model (~15 MB, GPL-3.0, upstream's own release) -> public/rvm
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';

const SRC = 'node_modules/onnxruntime-web/dist', OUT = 'public/ort';
try {
  if (!existsSync(SRC)) throw new Error('onnxruntime-web is not installed');
  mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (const f of readdirSync(SRC)) {
    if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) { cpSync(`${SRC}/${f}`, `${OUT}/${f}`); n++; }
  }
  console.log(`onnxruntime-web: ${n} files copied.`);
} catch (e) {
  console.warn('Could not copy onnxruntime-web files:', e.message);
}

const RVM_DIR = 'public/rvm', RVM_FILE = 'rvm_mobilenetv3_fp32.onnx';
const RVM_URL = `https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/${RVM_FILE}`;
try {
  mkdirSync(RVM_DIR, { recursive: true });
  const path = `${RVM_DIR}/${RVM_FILE}`;
  if (existsSync(path) && statSync(path).size > 1_000_000) console.log('RVM model already there.');
  else {
    const res = await fetch(RVM_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error('file too small');
    writeFileSync(path, buf);
    console.log(`RVM model downloaded (${Math.round(buf.length / 1e6)} MB).`);
  }
} catch (e) {
  console.warn('Could not download the RVM model (the app will try the internet):', e.message);
}
