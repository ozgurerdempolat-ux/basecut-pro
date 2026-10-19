import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// the version shown in the app comes from package.json at build time (also right when run unpackaged)
const version = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;
const define = { __APP_VERSION__: JSON.stringify(version) };

export default defineConfig({
  main: {
    define,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts'), worker: resolve(__dirname, 'src/main/worker.ts') },
        external: ['ffmpeg-static', 'ffprobe-static'],
      },
    },
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react()],
  },
});
