import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true, // bind 0.0.0.0 by default — reachable over LAN/Tailscale (PoC)
    port: 5320,
    strictPort: true,
  },
});
