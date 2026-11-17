import { defineConfig } from 'vite';

// Relative base so the build works on the custom domain and on a /repo/ sub-path alike.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: true,
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
    // Until the first playable milestone the live site is still the old index.html,
    // so the new game builds from play.html. The switch-over renames it (see PLAN.md).
    rollupOptions: { input: 'play.html' },
  },
  server: { port: 5173, host: true },
});
