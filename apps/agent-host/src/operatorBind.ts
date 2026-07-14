import fs from "fs";
import path from "path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { bytesToB64url, verifyGrant, type SignedEnvelope } from "@interloom/keys";
import { signedEnvelope, IdentityGrant } from "@interloom/protocol";
import { DATA_DIR, NETWORK_URL } from "./config.js";
import { getKeypair } from "./keys.js";
import { getOperatorDisplayName } from "./settings.js";
import { createPortalSession, wipeAllSessions, PORTAL_COOKIE } from "./portalAuth.js";

const NONCE_TTL_MS = 5 * 60 * 1000;

/** Persisted operator↔host binding (CONTRACTS §6 "Operator binding"). */
export interface OperatorBinding {
  identityKey: string;
  displayName: string;
  avatarSha?: string;
  /** Convenience field beyond the pinned shape — resolved once at bind time
   * so the portal can render an avatar without a second network round trip.
   * Not part of the wire contract; safe to ignore. */
  avatarUrl?: string;
  grant: SignedEnvelope<IdentityGrant>;
  boundAt: string;
}

function bindingFilePath(): string {
  return path.join(DATA_DIR, "operator.json");
}

function readBinding(): OperatorBinding | null {
  const p = bindingFilePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    return raw as OperatorBinding;
  } catch {
    return null;
  }
}

function writeBinding(binding: OperatorBinding): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = bindingFilePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(binding, null, 2), "utf8");
  fs.renameSync(tmp, bindingFilePath());
}

/** Returns the currently bound operator, or `null` when this host is unbound. */
export function getOperatorBinding(): OperatorBinding | null {
  return readBinding();
}

export function isOperatorBound(): boolean {
  return readBinding() !== null;
}

// In-memory only — a stale grant is re-detected on the next register attempt
// after a daemon restart anyway, so this doesn't need persistence.
let staleGrant = false;

/** Flags (or clears) the bound operator's grant as stale (CONTRACTS §11.7 —
 * a network revoke-all bumped the identity's session_epoch past what the
 * grant was issued under). Surfaced via `GET /api/operator` so the portal
 * can prompt a reconnect instead of silently failing every re-register. */
export function setOperatorGrantStale(stale: boolean): void {
  staleGrant = stale;
}

export function isOperatorGrantStale(): boolean {
  return staleGrant;
}

/** Wipes the binding — the host reverts to legacy (host-key) operator stamping. */
export function wipeOperatorBinding(): void {
  const p = bindingFilePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// One-shot, 5-min TTL link-start nonces (in-memory — a lost daemon restart
// mid-flow just means the operator restarts the bind, same as any nonce flow).
const pendingNonces = new Map<string, { hostPubKey: string; expiresAt: number }>();

function pruneNonces(): void {
  const now = Date.now();
  for (const [nonce, entry] of pendingNonces) {
    if (entry.expiresAt <= now) pendingNonces.delete(nonce);
  }
}

/**
 * Best-effort display/avatar resolution for a newly-bound identity (CONTRACTS
 * §6). The network's `/api/identities/resolve` proxy may not be reachable (or
 * not yet deployed) — any failure falls back to the existing operator
 * display-name setting and no avatar, never blocking the bind.
 */
async function resolveIdentityDisplay(
  identityKey: string,
): Promise<{ displayName: string; avatarUrl?: string }> {
  try {
    const res = await fetch(
      `${NETWORK_URL}/api/identities/resolve?keys=${encodeURIComponent(identityKey)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        identities?: Record<string, { displayName?: string; avatarUrl?: string }>;
      };
      const resolved = data.identities?.[identityKey];
      if (resolved?.displayName) {
        return { displayName: resolved.displayName, avatarUrl: resolved.avatarUrl };
      }
    }
  } catch {
    // network unreachable or route not yet deployed — fall through
  }
  return { displayName: getOperatorDisplayName() };
}

export function registerOperatorBindRoutes(app: FastifyInstance): void {
  app.get("/api/operator", async (_req, reply) => {
    const binding = readBinding();
    if (!binding) return reply.send({ bound: false });
    return reply.send({
      bound: true,
      operator: {
        identityKey: binding.identityKey,
        displayName: binding.displayName,
        ...(binding.avatarSha ? { avatarSha: binding.avatarSha } : {}),
        ...(binding.avatarUrl ? { avatarUrl: binding.avatarUrl } : {}),
        boundAt: binding.boundAt,
      },
      ...(staleGrant ? { staleGrant: true } : {}),
    });
  });

  app.post("/api/operator/link/start", async (_req, reply) => {
    pruneNonces();
    const hostPubKey = getKeypair().publicKey;
    const nonce = bytesToB64url(randomBytes(24));
    pendingNonces.set(nonce, { hostPubKey, expiresAt: Date.now() + NONCE_TTL_MS });
    return reply.send({ networkUrl: NETWORK_URL, hostPubKey, nonce });
  });

  app.post<{ Body: { grant?: unknown } }>("/api/operator/link/complete", async (req, reply) => {
    const bodySchema = signedEnvelope(IdentityGrant);
    const parsed = bodySchema.safeParse(req.body?.grant);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_grant" });
    }
    const envelope = parsed.data;

    const nonceEntry = pendingNonces.get(envelope.payload.nonce);
    pendingNonces.delete(envelope.payload.nonce); // one-shot regardless of outcome
    if (!nonceEntry || nonceEntry.expiresAt <= Date.now()) {
      return reply.status(400).send({ error: "nonce_expired" });
    }

    const hostPubKey = getKeypair().publicKey;
    if (nonceEntry.hostPubKey !== hostPubKey) {
      return reply.status(400).send({ error: "invalid_grant" });
    }

    // Host-operator grants are issued audience-less (CONTRACTS §11 point 7 —
    // a home-network host has no durable public origin to bind an audience
    // to, unlike an instance's public URL). We therefore verify with
    // audience: undefined, which only accepts grants that themselves omit it.
    const valid = verifyGrant(envelope, {
      subjectKey: hostPubKey,
      scope: "host-operator",
      audience: undefined,
    });
    if (!valid) {
      return reply.status(400).send({ error: "invalid_grant" });
    }

    const identityKey = envelope.payload.identityKey;
    const { displayName, avatarUrl } = await resolveIdentityDisplay(identityKey);

    const binding: OperatorBinding = {
      identityKey,
      displayName,
      ...(avatarUrl ? { avatarUrl } : {}),
      grant: envelope,
      boundAt: new Date().toISOString(),
    };
    writeBinding(binding);
    setOperatorGrantStale(false);

    const { reregisterAllAgents } = await import("./operator.js");
    await reregisterAllAgents();

    const session = createPortalSession();
    reply.setCookie(PORTAL_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });

    return reply.send({
      bound: true,
      operator: {
        identityKey: binding.identityKey,
        displayName: binding.displayName,
        ...(binding.avatarUrl ? { avatarUrl: binding.avatarUrl } : {}),
        boundAt: binding.boundAt,
      },
    });
  });

  app.post("/api/operator/signout", async (_req, reply) => {
    wipeOperatorBinding();
    setOperatorGrantStale(false);
    wipeAllSessions();
    reply.clearCookie(PORTAL_COOKIE, { path: "/" });
    return reply.send({});
  });
}
