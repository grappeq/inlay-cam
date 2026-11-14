import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built app works from any folder on a static host.
  base: "./",
  worker: { format: "es" },
  server: { port: 5173, strictPort: true },
});
