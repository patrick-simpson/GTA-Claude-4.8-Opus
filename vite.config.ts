import { defineConfig } from 'vite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The size of every model file, written into the code as __MODEL_BYTES__ so the title card knows the total of what
// it is waiting for before the first response arrives (src/core/assets.ts).
const models = fileURLToPath(new URL('./public/models', import.meta.url));
const modelBytes = Object.fromEntries(fs.readdirSync(models).map((f) => [f, fs.statSync(`${models}/${f}`).size]));

// Relative base so the build works on the custom domain and on a /repo/ sub-path alike.
export default defineConfig({
  base: './',
  define: { __MODEL_BYTES__: JSON.stringify(modelBytes) },
  plugins: [{
    // The game's script is a dynamic import of the small entry script (src/main.ts), so the page would only learn
    // its address after running that one. Name it in the page itself and the two are fetched side by side.
    name: 'preload-game',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const game = Object.values(ctx.bundle ?? {}).find((c) => c.type === 'chunk' && c.isDynamicEntry && c.name === 'boot');
        return game ? html.replace('</head>', `  <link rel="modulepreload" crossorigin href="./${game.fileName}">
</head>`) : html;
      },
    },
  }],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: true,
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, host: true },
});
