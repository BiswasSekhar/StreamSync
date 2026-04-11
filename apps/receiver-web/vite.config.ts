import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "chrome100",
    // webtorrent is loaded from CDN, not bundled
    rollupOptions: {
      external: [],
    },
  },
});
