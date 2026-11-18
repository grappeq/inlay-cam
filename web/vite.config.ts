import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // INLAY_SERVER=http://localhost:8000 npm run dev: the dev server passes /api on to a
  // running inlay-server, so the page keeps its tool list there as it does when served by it.
  const server = loadEnv(mode, ".", "INLAY_").INLAY_SERVER;
  return {
    plugins: [react()],
    // Relative asset paths, so the built app works from any folder on a static host.
    base: "./",
    worker: { format: "es" },
    server: { port: 5173, strictPort: true, proxy: server ? { "/api": server } : undefined },
  };
});
