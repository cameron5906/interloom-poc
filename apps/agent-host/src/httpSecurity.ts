import type { FastifyInstance } from "fastify";
import { PORTAL_COOKIE } from "./portalAuth.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const PORTAL_COOKIE_BASE = Object.freeze({
  httpOnly: true,
  path: "/" as const,
  sameSite: "lax" as const,
  // Loopback origins are potentially trustworthy in modern browsers; keep
  // the session cookie Secure even though the local portal uses http://.
  secure: true,
});

function loopbackOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function loopbackHost(value: string | undefined): boolean {
  return value ? loopbackOrigin(`http://${value}`) : false;
}

export function registerHostSecurity(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!loopbackHost(req.headers.host)) {
      return reply.code(421).send({ error: "loopback_host_required" });
    }
    if (
      UNSAFE_METHODS.has(req.method) &&
      req.cookies?.[PORTAL_COOKIE] &&
      !loopbackOrigin(req.headers.origin)
    ) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws:",
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("x-frame-options", "DENY");
  });
}
