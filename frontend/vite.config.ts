import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: process.env.CAPACITOR_BUILD === "1" ? "./" : "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  // Do not let Vite crawl built Android assets during dependency discovery.
  // A clean npm ci otherwise sees imports embedded in old APK assets as source dependencies.
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5174,
  },
});