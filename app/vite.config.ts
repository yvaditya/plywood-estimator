import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    fs: {
      // occt-import-js ships .wasm next to its js entry; allow serving it
      allow: ['..']
    }
  },
  optimizeDeps: {
    exclude: ['occt-import-js']
  },
  worker: {
    format: 'es'
  }
});
