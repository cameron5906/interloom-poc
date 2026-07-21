import dns from "node:dns/promises";
import type http from "node:http";
import net from "node:net";
import { canonicalOrigin } from "@interloom/protocol";

type LookupCallback = {
  (error: Error | null, address: string, family: 4 | 6): void;
  (error: Error | null, addresses: Array<{ address: string; family: 4 | 6 }>): void;
};

function privateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
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
  if (family === 6) {
    const value = address.toLowerCase().split("%")[0] ?? "";
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
    return (
      /^f[cd]/.test(value) ||
      /^fe[89ab]/.test(value) ||
      value.startsWith("ff") ||
      !/^[23]/.test(value)
    );
  }
  return true;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  );
}

function complete(
  options: unknown,
  callback: unknown,
  result: { address: string; family: 4 | 6 } | Error,
): void {
  const cb = callback as LookupCallback;
  const all =
    typeof options === "object" && options !== null && (options as { all?: unknown }).all === true;
  if (result instanceof Error) {
    if (all) cb(result, []);
    else cb(result, "", 4);
  } else if (all) cb(null, [result]);
  else cb(null, result.address, result.family);
}

/** Resolves every answer through the public-address policy, then pins one socket address. */
export function createSafeLookup(
  originValue: string,
  allowLoopback = false,
): NonNullable<http.RequestOptions["lookup"]> {
  const origin = canonicalOrigin(originValue);
  const url = new URL(origin);
  if (url.protocol !== "https:" && !allowLoopback) throw new Error("HTTPS destination required");
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== url.hostname.toLowerCase()) {
      complete(options, callback, new Error("destination hostname mismatch"));
      return;
    }
    void dns
      .lookup(hostname, { all: true, verbatim: true })
      .then((answers) => {
        if (answers.length === 0) throw new Error("destination did not resolve");
        if (
          answers.some(
            (answer) =>
              privateAddress(answer.address) && !(allowLoopback && loopbackHost(hostname)),
          )
        ) {
          throw new Error("private destination rejected");
        }
        const selected = answers[0]!;
        if (selected.family !== 4 && selected.family !== 6) {
          throw new Error("unsupported address family");
        }
        complete(options, callback, { address: selected.address, family: selected.family });
      })
      .catch((error: unknown) =>
        complete(options, callback, error instanceof Error ? error : new Error(String(error))),
      );
  };
}
