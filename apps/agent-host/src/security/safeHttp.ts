import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { canonicalOrigin } from "@interloom/protocol";

export interface SafeHttpRequestOptions {
  url: string;
  allowedOrigin: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxResponseBytes: number;
  timeoutMs?: number;
  /** Explicit development-only exception; caller must not derive this from NODE_ENV alone. */
  allowLoopback?: boolean;
}

export interface SafeHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

type LookupCallbackCompat = {
  (error: Error | null, address: string, family: 4 | 6): void;
  (error: Error | null, addresses: Array<{ address: string; family: 4 | 6 }>): void;
};

function completeLookup(
  options: unknown,
  callback: unknown,
  result: { address: string; family: 4 | 6 } | Error,
): void {
  const cb = callback as LookupCallbackCompat;
  const wantsAll =
    typeof options === "object" &&
    options !== null &&
    "all" in options &&
    (options as { all?: unknown }).all === true;
  if (result instanceof Error) {
    if (wantsAll) cb(result, []);
    else cb(result, "", 4);
    return;
  }
  if (wantsAll) cb(null, [result]);
  else cb(null, result.address, result.family);
}

function ipv4Private(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function ipv6Private(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return net.isIP(mapped) !== 4 || ipv4Private(mapped);
  }
  if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith("ff")) return true;
  if (value.startsWith("2001:db8:")) return true;
  // Current globally routable unicast space is 2000::/3. Reject every other
  // class conservatively instead of trying to maintain a permissive denylist.
  return !/^[23]/.test(value);
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return ipv4Private(address);
  if (family === 6) return ipv6Private(address);
  return true;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function resolvePinnedAddress(
  hostname: string,
  allowLoopback: boolean,
): Promise<{ address: string; family: 4 | 6 }> {
  if (isLoopbackHost(hostname) && !allowLoopback) throw new Error("private destination rejected");
  const resolved = await withTimeout(
    dns.lookup(hostname, { all: true, verbatim: true }),
    10_000,
    "DNS lookup timed out",
  );
  if (resolved.length === 0) throw new Error("destination did not resolve");
  for (const item of resolved) {
    if (isPrivateOrReservedAddress(item.address) && !(allowLoopback && isLoopbackHost(hostname))) {
      throw new Error("private destination rejected");
    }
  }
  const selected = resolved[0]!;
  if (selected.family !== 4 && selected.family !== 6) throw new Error("unsupported address family");
  return { address: selected.address, family: selected.family };
}

/** Node lookup callback that validates every answer, then pins one address. */
export function createSafeLookup(
  allowedOriginValue: string,
  allowLoopback = false,
): NonNullable<http.RequestOptions["lookup"]> {
  const allowedOrigin = canonicalOrigin(allowedOriginValue);
  const expectedHostname = new URL(allowedOrigin).hostname;
  if (new URL(allowedOrigin).protocol !== "https:" && !allowLoopback) {
    throw new Error("HTTPS destination required");
  }
  return (hostname, _options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      completeLookup(_options, callback, new Error("destination hostname mismatch"));
      return;
    }
    void resolvePinnedAddress(hostname, allowLoopback)
      .then((resolved) => completeLookup(_options, callback, resolved))
      .catch((error: unknown) =>
        completeLookup(
          _options,
          callback,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
  };
}

export async function safeHttpRequest(options: SafeHttpRequestOptions): Promise<SafeHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const target = new URL(options.url);
  const allowedOrigin = canonicalOrigin(options.allowedOrigin);
  if (target.origin !== allowedOrigin) throw new Error("destination origin mismatch");
  if (target.username || target.password || target.hash) throw new Error("invalid destination URL");
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("unsupported destination scheme");
  }
  if (target.protocol !== "https:" && !options.allowLoopback) {
    throw new Error("HTTPS destination required");
  }

  const pinned = await withTimeout(
    resolvePinnedAddress(target.hostname, options.allowLoopback === true),
    timeoutMs,
    "request timed out",
  );
  const transport = target.protocol === "https:" ? https : http;
  const body = options.body;
  const remainingMs = Math.max(1, deadline - Date.now());

  return new Promise<SafeHttpResponse>((resolve, reject) => {
    let settled = false;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearOverallTimer = () => {
      if (overallTimer) clearTimeout(overallTimer);
      overallTimer = null;
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearOverallTimer();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const request = transport.request(
      target,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        servername: target.hostname,
        lookup: (_hostname, lookupOptions, callback) => {
          completeLookup(lookupOptions, callback, pinned);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const declared = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
          response.destroy(new Error("response exceeds maximum size"));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > options.maxResponseBytes) {
            response.destroy(new Error("response exceeds maximum size"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", finishReject);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearOverallTimer();
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    overallTimer = setTimeout(() => request.destroy(new Error("request timed out")), remainingMs);
    request.setTimeout(remainingMs, () => request.destroy(new Error("request timed out")));
    request.on("error", finishReject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
