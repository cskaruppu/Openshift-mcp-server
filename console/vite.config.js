import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React dashboard — builds to dist/ for the Docker image.
// During development, API calls are proxied to the running MCP server.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      "/intelligence": { target: "http://localhost:8080", changeOrigin: true },
      "/hub": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
});
