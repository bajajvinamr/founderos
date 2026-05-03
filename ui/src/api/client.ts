import { getAccessToken } from "@/lib/supabase";

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;
  /** Request correlation ID — read from the x-request-id response header
   *  if present, falling back to body.requestId echoed by the server's
   *  errorHandler. Surface this to users for support tickets so engineers
   *  can grep server logs / Sentry by the same ID. */
  requestId: string | null;

  constructor(message: string, status: number, body: unknown, requestId: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.requestId =
      requestId ??
      (body && typeof body === "object" && "requestId" in body && typeof (body as { requestId?: unknown }).requestId === "string"
        ? ((body as { requestId: string }).requestId)
        : null);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Attach Supabase access token as Bearer header for every API call.
  // Cookie-based sessions still work, but an explicit header is cleaner
  // for a SPA and avoids cross-origin cookie edge cases.
  if (!headers.has("Authorization")) {
    const token = await getAccessToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
      res.headers.get("x-request-id"),
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
