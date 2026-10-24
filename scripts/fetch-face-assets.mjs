// Puts the MediaPipe wasm files and the face model into public/mediapipe so the app can run Autoframe offline.
// Runs in CI after `npm install` (npm run face-assets). Never fails the build: the app falls back to the internet.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';

const OUT = 'public/mediapipe';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

mkdirSync(OUT, { recursive: true });

try {
  cpSync('node_modules/@mediapipe/tasks-vision/wasm', `${OUT}/wasm`, { recursive: true });
  console.log('MediaPipe wasm copied.');
} catch (e) {
  console.warn('Could not copy MediaPipe wasm:', e.message);
}

const modelPath = `${OUT}/face_landmarker.task`;
if (existsSync(modelPath) && statSync(modelPath).size > 1_000_000) {
  console.log('Face model already there.');
} else {
  try {
    const res = await fetch(MODEL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
    console.log('Face model downloaded.');
  } catch (e) {
    console.warn('Could not download the face model:', e.message);
  }
}
