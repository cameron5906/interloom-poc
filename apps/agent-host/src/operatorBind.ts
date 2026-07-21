import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { bytesToB64url, verifyGrant, type SignedEnvelope } from "@interloom/keys";
import { signedEnvelope, IdentityGrant } from "@interloom/protocol";
import { DATA_DIR, NETWORK_URL } from "./config.js";
import { getKeypair } from "./keys.js";
import { getOperatorDisplayName } from "./settings.js";
import { createPortalSession, wipeAllSessions, PORTAL_COOKIE } from "./portalAuth.js";
import { PORTAL_COOKIE_BASE } from "./httpSecurity.js";

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

/** Wipes the binding — the Host returns to bootstrap-only, registration-disabled state. */
export function wipeOperatorBinding(): void {
  const p = bindingFilePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// One-shot, 5-min TTL link-start nonces (in-memory — a lost daemon restart
// mid-flow just means the operator restarts the bind, same as any nonce flow).
interface PendingOperatorHandoff {
  handoffId: string;
  hostPubKey: string;
  nonce: string;
  verifier: string;
  challenge: string;
  expiresAt: number;
  userCode: string;
  subjectFp: string;
  exchanging: boolean;
}

const pendingHandoffs = new Map<string, PendingOperatorHandoff>();

function pruneNonces(): void {
  const now = Date.now();
  for (const [handoffId, entry] of pendingHandoffs) {
    if (entry.expiresAt <= now) pendingHandoffs.delete(handoffId);
  }
}

function base32(value: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function displayCode(value: string): string {
  const raw = base32(createHash("sha256").update(value, "utf8").digest()).slice(0, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

async function boundedJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("network response omitted a body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("network response exceeded limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged)) as unknown;
}

async function networkRequest(
  pathname: string,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const networkOrigin = new URL(NETWORK_URL).origin;
  const response = await fetch(`${networkOrigin}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await boundedJson(response);
  return { response, body };
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
    const verifier = bytesToB64url(randomBytes(32));
    const challenge = bytesToB64url(createHash("sha256").update(verifier, "utf8").digest());
    const { response, body } = await networkRequest("/api/handoff/grant/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        codeChallenge: challenge,
        subjectKey: hostPubKey,
        scope: "host-operator",
        nonce,
      }),
    });
    const started = body as { handoffId?: unknown; expiresAt?: unknown; error?: unknown };
    const expiresAt = typeof started.expiresAt === "string" ? Date.parse(started.expiresAt) : NaN;
    if (
      !response.ok ||
      typeof started.handoffId !== "string" ||
      !started.handoffId ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + NONCE_TTL_MS + 30_000
    ) {
      return reply.status(502).send({ error: "network_handoff_unavailable" });
    }
    const pending: PendingOperatorHandoff = {
      handoffId: started.handoffId,
      hostPubKey,
      nonce,
      verifier,
      challenge,
      expiresAt,
      userCode: displayCode(challenge),
      subjectFp: displayCode(hostPubKey),
      exchanging: false,
    };
    pendingHandoffs.set(pending.handoffId, pending);
    const networkOrigin = new URL(NETWORK_URL).origin;
    return reply.send({
      handoffId: pending.handoffId,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      authorizeUrl: `${networkOrigin}/authorize?grantHandoffId=${encodeURIComponent(pending.handoffId)}`,
      userCode: pending.userCode,
      subjectFp: pending.subjectFp,
    });
  });

  app.post<{ Body: { handoffId?: unknown } }>("/api/operator/link/complete", async (req, reply) => {
    pruneNonces();
    const handoffId = req.body?.handoffId;
    if (typeof handoffId !== "string" || !handoffId || handoffId.length > 256) {
      return reply.status(400).send({ error: "invalid_handoff" });
    }
    const pending = pendingHandoffs.get(handoffId);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingHandoffs.delete(handoffId);
      return reply.status(410).send({ error: "handoff_expired" });
    }
    if (pending.exchanging) return reply.send({ pending: true });

    const statusResult = await networkRequest(
      `/api/handoff/grant/${encodeURIComponent(handoffId)}`,
    );
    const status = statusResult.body as Record<string, unknown>;
    if (
      !statusResult.response.ok ||
      status["subjectKey"] !== pending.hostPubKey ||
      status["scope"] !== "host-operator" ||
      status["audience"] !== undefined ||
      status["nonce"] !== pending.nonce ||
      status["userCode"] !== pending.userCode ||
      status["subjectFp"] !== pending.subjectFp
    ) {
      pendingHandoffs.delete(handoffId);
      return reply.status(502).send({ error: "network_handoff_mismatch" });
    }
    if (status["consumed"] === true) {
      pendingHandoffs.delete(handoffId);
      return reply.status(409).send({ error: "handoff_already_consumed" });
    }
    if (status["completed"] !== true) return reply.send({ pending: true });

    pending.exchanging = true;
    let exchanged: { response: Response; body: unknown };
    try {
      exchanged = await networkRequest("/api/handoff/grant/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffId, codeVerifier: pending.verifier }),
      });
    } finally {
      pending.exchanging = false;
    }
    if (!exchanged.response.ok) {
      pendingHandoffs.delete(handoffId);
      return reply.status(502).send({ error: "network_handoff_exchange_failed" });
    }
    const grantBody = exchanged.body as { grant?: unknown };
    const bodySchema = signedEnvelope(IdentityGrant);
    const parsed = bodySchema.safeParse(grantBody.grant);
    if (!parsed.success) {
      pendingHandoffs.delete(handoffId);
      return reply.status(400).send({ error: "invalid_grant" });
    }
    const envelope = parsed.data;

    const hostPubKey = getKeypair().publicKey;
    if (pending.hostPubKey !== hostPubKey || envelope.payload.nonce !== pending.nonce) {
      pendingHandoffs.delete(handoffId);
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
      pendingHandoffs.delete(handoffId);
      return reply.status(400).send({ error: "invalid_grant" });
    }
    pendingHandoffs.delete(handoffId);

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
      ...PORTAL_COOKIE_BASE,
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
    reply.clearCookie(PORTAL_COOKIE, PORTAL_COOKIE_BASE);
    return reply.send({});
  });
}
