import fs from "fs";
import path from "path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { bytesToB64url } from "@interloom/keys";
import { DATA_DIR } from "./config.js";

export const PORTAL_COOKIE = "il_portal";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface PortalSession {
  token: string;
  createdAt: string;
  expiresAt: number;
}

function sessionsFilePath(): string {
  return path.join(DATA_DIR, "sessions.json");
}

function readSessions(): PortalSession[] {
  const p = sessionsFilePath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as PortalSession[]) : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions: PortalSession[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = sessionsFilePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), "utf8");
  fs.renameSync(tmp, sessionsFilePath());
}

/** Issues a new 30-day portal session, pruning any already-expired rows. */
export function createPortalSession(): { token: string; expiresAt: number } {
  const now = Date.now();
  const sessions = readSessions().filter((s) => s.expiresAt > now);
  const token = bytesToB64url(randomBytes(32));
  const expiresAt = now + SESSION_TTL_MS;
  sessions.push({ token, createdAt: new Date(now).toISOString(), expiresAt });
  writeSessions(sessions);
  return { token, expiresAt };
}

/** True when `token` matches a live (unexpired) portal session. */
export function isValidPortalSession(token: string | undefined): boolean {
  if (!token) return false;
  const now = Date.now();
  return readSessions().some((s) => s.token === token && s.expiresAt > now);
}

/** Wipes every portal session — used by sign-out to re-gate the portal. */
export function wipeAllSessions(): void {
  writeSessions([]);
}

const BOOTSTRAP_EXACT = new Set(["/api/system", "/api/keys", "/api/operator"]);

function isBootstrapRoute(pathname: string): boolean {
  if (BOOTSTRAP_EXACT.has(pathname)) return true;
  return pathname.startsWith("/api/operator/link/");
}

/**
 * Global auth gate (CONTRACTS §6): every `/api/*` and `/ws/*` route requires
 * a live `il_portal` cookie EXCEPT the bootstrap set — `/api/system`,
 * `/api/keys`, `/api/operator`, and `/api/operator/link/*` (NOT
 * `/api/operator/signout`, which is a state-changing route for an already
 * -authenticated session). While the host is unbound, the bootstrap set is
 * still open (so the sign-in screen can boot) but everything else 401s with
 * `operator_not_bound` instead of `portal_auth_required`.
 *
 * Takes `isBound` as a parameter (rather than importing `operatorBind.js`
 * directly) purely to keep the two modules from depending on each other.
 */
export function registerPortalAuthGate(app: FastifyInstance, isBound: () => boolean): void {
  app.addHook("preHandler", async (req, reply) => {
    const pathname = (req.raw.url ?? req.url ?? "").split("?")[0] ?? "";
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/ws/")) return;
    if (isBootstrapRoute(pathname)) return;

    if (!isBound()) {
      return reply.status(401).send({ error: "operator_not_bound" });
    }

    const token = req.cookies?.[PORTAL_COOKIE];
    if (!isValidPortalSession(token)) {
      return reply.status(401).send({ error: "portal_auth_required" });
    }
  });
}
