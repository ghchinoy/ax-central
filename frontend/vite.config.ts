import { realpathSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    fs: { allow: [".", realpathSync("node_modules")] },
  },
  build: {
    chunkSizeWarningLimit: 800,
  },
});
