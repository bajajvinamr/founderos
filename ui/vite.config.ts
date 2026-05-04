import path from "path";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Hard-fail the build if Supabase env vars are missing OR look like the
 * placeholder sentinel that bricked production on 2026-05-04.
 *
 * Belt + suspenders alongside the runtime guard in `src/lib/supabase.ts`:
 *  - Runtime guard catches the case where someone bypasses the build (rare).
 *  - Build-time guard catches every CI/Docker/local build before anything
 *    ships. The cost of a build failure is "you see the error in your
 *    terminal." The cost of a silent placeholder bundle in prod is what
 *    we just lived through.
 *
 * Skip in test/dev to keep `pnpm test` and `pnpm dev` flowing without
 * hard-coded creds. Production builds (`vite build`) and `mode === "production"`
 * are where the gate fires.
 */
function supabaseConfigGuard(): PluginOption {
  return {
    name: "founderos:supabase-config-guard",
    apply: "build",
    config(_userConfig, env) {
      if (env.mode !== "production") return;
      const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
      const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
      const errors: string[] = [];
      if (!url) errors.push("VITE_SUPABASE_URL is not set");
      if (!anonKey) errors.push("VITE_SUPABASE_ANON_KEY is not set");
      if (url.includes("placeholder.supabase.co")) {
        errors.push(`VITE_SUPABASE_URL is the literal placeholder "${url}"`);
      }
      if (anonKey === "placeholder-anon-key" || anonKey.startsWith("placeholder")) {
        errors.push("VITE_SUPABASE_ANON_KEY is the literal placeholder string");
      }
      if (errors.length > 0) {
        const msg = [
          "",
          "─────────────────────────────────────────────────────────",
          "  FounderOS UI build halted: bad Supabase config",
          "─────────────────────────────────────────────────────────",
          ...errors.map((e) => `  • ${e}`),
          "",
          "  Production builds MUST embed real Supabase credentials at",
          "  build time. The Fly Dockerfile passes them as build args:",
          "",
          "     fly deploy --build-arg VITE_SUPABASE_URL=... \\",
          "                --build-arg VITE_SUPABASE_ANON_KEY=...",
          "",
          "  Local production builds need them in the shell env or .env.production.",
          "  See docs/runbooks/supabase-config.md for the exact procedure.",
          "─────────────────────────────────────────────────────────",
        ].join("\n");
        // Throwing here aborts the Vite build with a clear message. Any
        // CI/Docker layer that runs `vite build` will exit non-zero.
        throw new Error(msg);
      }
    },
  };
}

export default defineConfig({
  plugins: [supabaseConfigGuard(), react(), tailwindcss()],
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
