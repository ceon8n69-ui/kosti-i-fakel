import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/auth": "http://localhost:3000", "/me": "http://localhost:3000" },
  },
  build: { target: "es2020", sourcemap: false, chunkSizeWarningLimit: 450 },
});
