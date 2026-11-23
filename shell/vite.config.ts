import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: {
    // Firefox is the primary browser. The floor is Firefox 160, set 2026-11-22
    // and raised by the quarterly frontend-audit run; the Chrome and Safari
    // numbers are Baseline Widely available. Anything newer is progressive
    // enhancement behind @supports or feature detection.
    target: ["es2022", "firefox160", "chrome120", "safari17"],
  },
  server: {
    host: true, // bind 0.0.0.0 by default — reachable over LAN/Tailscale (PoC)
    port: 5320,
    strictPort: true,
  },
});
