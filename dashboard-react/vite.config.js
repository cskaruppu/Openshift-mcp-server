import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React dashboard — builds to ../dashboard/app so the backend serves it at /.
// The legacy single-file dashboard is preserved at /old-app.
// During development, API calls are proxied to the running MCP server.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../dashboard/app",
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
