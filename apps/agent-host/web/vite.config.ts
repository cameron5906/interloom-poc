import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Portal SPA for the Agent Host daemon. In dev, proxy REST + WS to the local
// daemon on :7420. In prod the daemon serves this build from ./dist — every
// asset path must stay relative to the same origin (no absolute box URLs).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Interloom Agent Host",
        short_name: "Agent Host",
        theme_color: "#f6ede0",
        background_color: "#f6ede0",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
      },
    }),
  ],
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
