import { defineConfig } from 'vite';

export default defineConfig({
  base: '/Gtameme/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    host: true,
  },
});
