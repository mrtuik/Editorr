import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  // The Whisper worker loads transformers.js with import(), which needs code-splitting.
  // Vite's default worker format (iife) cannot do that, so workers are built as ES modules.
  worker: { format: 'es' },
});
