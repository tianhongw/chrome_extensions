import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.ts";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "es2020",
    outDir: "dist",
    rollupOptions: {
      // Standalone popup window opened by the background for context-menu / PDF
      // results (not referenced from the manifest, so declare it explicitly).
      input: { result: "result.html" },
    },
  },
  // crxjs needs a stable HMR port for the content-script client during `vite dev`
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
