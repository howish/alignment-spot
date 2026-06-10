import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the build works on GitHub Pages project sites
  base: './',
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
