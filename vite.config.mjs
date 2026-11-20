import { defineConfig } from 'vite';

/* Revisione 2026 — build per GitHub Pages.
   base './' → percorsi relativi: funziona sotto /<repo>/ senza configurare il nome. */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/*.test.{js,mjs,cjs}'],
    testTimeout: 60000,
  },
});
