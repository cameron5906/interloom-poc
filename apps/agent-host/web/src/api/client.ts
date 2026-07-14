/**
 * Thin typed fetch wrapper for the daemon REST API (CONTRACTS §6).
 *
 * Every call goes through `request`, which normalises errors into an
 * `ApiError` carrying an HTTP-ish status. Status `0` means the daemon was
 * unreachable (network error) — the shell surfaces this as a "daemon down"
 * banner rather than letting a page crash.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** True when the daemon itself could not be reached (vs. an HTTP error). */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

/** Any JSON-serialisable request body. */
type Json = unknown;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Json;
  signal?: AbortSignal;
}

/** The two 401 slugs the portal auth gate can return (CONTRACTS §6). */
export type UnauthorizedSlug = "operator_not_bound" | "portal_auth_required";

const unauthorizedListeners = new Set<(slug: UnauthorizedSlug) => void>();

/**
 * Subscribe to portal-auth 401s from any request, anywhere — the operator
 * bind gate uses this to react immediately (e.g. a session expiring mid-use)
 * instead of every call site checking `err.status === 401` by hand. Returns
 * an unsubscribe function.
 */
export function onUnauthorized(listener: (slug: UnauthorizedSlug) => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function isUnauthorizedSlug(value: unknown): value is UnauthorizedSlug {
  return value === "operator_not_bound" || value === "portal_auth_required";
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = opts;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body != null ? { "content-type": "application/json" } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(
      "The Agent Host daemon is unreachable. Is it running on port 7420?",
      0,
    );
  }

  if (!res.ok) {
    let parsed: unknown;
    let message = `Request failed (${res.status})`;
    try {
      parsed = await res.json();
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        const e = (parsed as { error: unknown }).error;
        if (typeof e === "string") message = e;
      }
    } catch {
      /* non-JSON error body — keep the default message */
    }
    if (res.status === 401) {
      const slug = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
      if (isUnauthorizedSlug(slug)) {
        for (const listener of unauthorizedListeners) listener(slug);
      }
    }
    throw new ApiError(message, res.status, parsed);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: Json, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body, signal }),
  patch: <T>(path: string, body?: Json, signal?: AbortSignal) =>
    request<T>(path, { method: "PATCH", body, signal }),
  del: <T>(path: string, body?: Json, signal?: AbortSignal) =>
    request<T>(path, { method: "DELETE", body, signal }),
};
