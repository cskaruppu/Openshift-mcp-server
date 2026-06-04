import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 2 dashboard. Builds to ../dashboard/next so the backend can serve the
// new UI at /next while the legacy single-file dashboard keeps serving at /.
// During development, API calls are proxied to the running MCP server.
export default defineConfig({
  base: "/next/",
  plugins: [react()],
  build: {
    outDir: "../dashboard/next",
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
