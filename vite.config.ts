import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  // Workers are built as ES modules (the denoise worker).
  worker: { format: 'es' },
});
