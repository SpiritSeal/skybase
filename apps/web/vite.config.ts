import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Vite config for the skybase PWA. The dev server proxies /api and /ws to
// the backend on :8080 so the same origin works locally and in production.

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Custom service worker (we need a `push` event handler that
      // workbox-build won't provide). injectManifest builds OUR sw.ts and
      // injects the precache manifest into it.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: "auto",
      injectManifest: {
        // Bump this when shipping changes that must invalidate the SW cache.
        injectionPoint: "self.__WB_MANIFEST",
      },
      manifest: {
        name: "skybase",
        short_name: "skybase",
        description: "Remote tmux from anywhere",
        // CRITICAL for iOS Web Push: must be standalone and installed to home
        // screen. Without `display: standalone` the iOS PWA push path will
        // never work.
        display: "standalone",
        start_url: "/",
        scope: "/",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      devOptions: {
        enabled: false, // SW caching in dev is a debugging nightmare
        type: "module",
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
