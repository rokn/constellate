import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  publicDir: path.resolve(import.meta.dirname, "public"),
  plugins: [react(), tailwindcss()],
  // The headset's map layout runs in a module worker (web/xr/layout.worker.ts).
  worker: { format: "es" },
  build: { outDir: path.resolve(import.meta.dirname, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
