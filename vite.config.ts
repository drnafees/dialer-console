import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/v1": "http://localhost:8788",
      "/hooks": "http://localhost:8788",
      "/console": "http://localhost:8788",
    },
  },
});
