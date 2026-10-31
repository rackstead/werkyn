import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";
import { bundleBudget } from "./scripts/bundle-budget";
import { manualChunks } from "./scripts/chunking";

export default defineConfig({
  plugins: [
    // Each route component is its own chunk, loaded when the route is visited
    // or a link to it is hovered (see src/lib/router.ts).
    TanStackRouterVite({ autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // Fails the build when the initial chunks outgrow their budget.
    bundleBudget(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      // One chunk for what every workspace page needs (see scripts/chunking.ts).
      output: { manualChunks: manualChunks(), onlyExplicitManualChunks: true },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: ["read.hopkins.sh", "brandon.nb.stage.npeer.io", "app.werkyn.com"],
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        ws: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      "/uploads": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/storage": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
