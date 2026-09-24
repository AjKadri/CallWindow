import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4174",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: path.resolve("web/index.html"),
        demo: path.resolve("web/demo/index.html"),
        proof: path.resolve("web/proof/index.html"),
        docs: path.resolve("web/docs/index.html"),
      },
    },
  },
});
