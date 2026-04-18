import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  build: {
    // Peel heavy visualization deps out of the main chunk so they only
    // download when the user actually opens a page that uses them.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/mermaid")) return "vendor-mermaid";
          if (id.includes("node_modules/cytoscape")) return "vendor-cytoscape";
          if (id.includes("node_modules/katex")) return "vendor-katex";
          if (id.includes("node_modules/@mdxeditor")) return "vendor-mdxeditor";
          if (id.includes("node_modules/lexical")) return "vendor-lexical";
          if (id.includes("node_modules/@sentry")) return "vendor-sentry";
          if (id.includes("node_modules/@clerk")) return "vendor-clerk";
          // Leave the default chunking for everything else — Vite's hash-naming
          // + tree-shaking already handles the common case well.
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 1_500,
  },
  server: {
    port: 5173,
    // Allow Cloudflare quick-tunnel + local network to host the UI externally
    allowedHosts: [".trycloudflare.com", ".local", "localhost"],
    // WSL2 /mnt/ drives don't support inotify — fall back to polling so HMR works
    watch: process.cwd().startsWith("/mnt/") ? { usePolling: true, interval: 1000 } : undefined,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
});
