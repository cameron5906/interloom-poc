import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Portal SPA for the Agent Host daemon. In dev, proxy REST + WS to the local
// daemon on :7420. In prod the daemon serves this build from ./dist.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 7421,
    proxy: {
      "/api": {
        target: "http://localhost:7420",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:7420",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
