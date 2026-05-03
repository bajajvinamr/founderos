/**
 * Resolve the API host used for WebSocket upgrades.
 *
 * On split-deploy setups (UI on Vercel, API on Fly) the browser's
 * `window.location.host` points at the UI origin — but Vercel's edge
 * rewrites only proxy HTTP, not WebSocket upgrades. WSS to the UI origin
 * therefore fails the upgrade handshake silently and reconnects forever.
 *
 * To avoid that, the prod build pins WS to the API origin via
 * `VITE_API_ORIGIN` (host only, e.g. `founderos.fly.dev`). When unset
 * (local dev, Fly-served UI), we fall back to `window.location.host` so
 * same-origin deployments continue to work without configuration.
 */
export function getApiWsHost(): string {
  const fromEnv = import.meta.env.VITE_API_ORIGIN as string | undefined;
  const trimmed = fromEnv?.trim();
  if (trimmed) {
    return trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
  return window.location.host;
}

export function getApiWsProtocol(): "ws" | "wss" {
  const fromEnv = import.meta.env.VITE_API_ORIGIN as string | undefined;
  if (fromEnv?.trim()) {
    return /^http:\/\//i.test(fromEnv.trim()) ? "ws" : "wss";
  }
  return window.location.protocol === "https:" ? "wss" : "ws";
}
