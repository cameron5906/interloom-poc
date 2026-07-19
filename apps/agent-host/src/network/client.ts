import { randomBytes } from "node:crypto";
import { bytesToB64url, signEnvelope } from "@interloom/keys";
import type { FrontierLinkSessionAuth } from "@interloom/protocol";
import { NETWORK_URL } from "../config.js";
import { getFrontierKeyEntry } from "../agents/frontierKeys.js";

/** Carries the HTTP status + raw body of a failed network call, so callers
 * can distinguish specific rejection reasons (e.g. a stale operator grant)
 * from a generic network failure without re-parsing an error message string. */
export class NetworkApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "NetworkApiError";
  }
}

export async function networkRegisterAgent(envelope: unknown): Promise<void> {
  const res = await fetch(`${NETWORK_URL}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new NetworkApiError(`agent register failed: ${res.status} ${text}`, res.status, text);
  }
}

/**
 * Cheap public registry probe used by the host's reconciliation loop. A
 * locally registered agent can outlive the Network database (for example,
 * after a production volume restore/replacement), so heartbeat state alone
 * is not enough to decide whether its manifest still exists remotely.
 */
export async function networkAgentExists(agentId: string): Promise<boolean> {
  const res = await fetch(`${NETWORK_URL}/api/agents/${encodeURIComponent(agentId)}`);
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text();
    throw new NetworkApiError(`agent lookup failed: ${res.status} ${text}`, res.status, text);
  }
  return true;
}

export async function networkHeartbeat(
  agentId: string,
  envelope: unknown,
): Promise<unknown> {
  const res = await fetch(`${NETWORK_URL}/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    throw new Error(`heartbeat failed: ${res.status}`);
  }
  return res.json();
}

export async function networkRevokePlacement(
  placementId: string,
  envelope: unknown,
): Promise<void> {
  const res = await fetch(`${NETWORK_URL}/api/placements/${placementId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    throw new Error(`revoke placement failed: ${res.status}`);
  }
}

/**
 * Creates a device-link session (CONTRACTS §4/§14). Network gates a plain
 * device-link session behind an operator identity-session cookie, which
 * this server-to-server call does not carry. For `kind: "frontier-agent"`
 * the network additionally accepts a `SignedEnvelope<FrontierLinkSessionAuth>`
 * under the agent's own registered keypair (CONTRACTS §14) — this call signs
 * that envelope with the frontier agent's stored keypair (`frontierKeys.ts`)
 * so the daemon can create the session headlessly.
 */
export async function networkCreateLinkSession(
  kind: "device" | "frontier-agent",
  agentId?: string,
): Promise<{ linkId: string; expiresAt: number; kind?: string }> {
  const body: { kind: "device" | "frontier-agent"; auth?: unknown } = { kind };

  if (kind === "frontier-agent") {
    if (!agentId) {
      throw new Error("networkCreateLinkSession: agentId required for kind 'frontier-agent'");
    }
    const keyEntry = getFrontierKeyEntry(agentId);
    if (!keyEntry) {
      throw new Error("networkCreateLinkSession: frontier agent has no stored keypair");
    }
    const authPayload: FrontierLinkSessionAuth = {
      kind: "frontier-agent",
      agentId,
      nonce: bytesToB64url(randomBytes(24)),
      iat: Date.now(),
    };
    body.auth = signEnvelope(authPayload, keyEntry.agentPrivKey, keyEntry.agentPubKey);
  }

  const res = await fetch(`${NETWORK_URL}/api/link/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new NetworkApiError(`link session create failed: ${res.status} ${text}`, res.status, text);
  }
  return res.json() as Promise<{ linkId: string; expiresAt: number; kind?: string }>;
}

export async function networkGetWellKnown(): Promise<{ name: string; pubKey: string }> {
  const res = await fetch(`${NETWORK_URL}/.well-known/interloom-network.json`);
  if (!res.ok) {
    throw new Error(`well-known fetch failed: ${res.status}`);
  }
  return res.json() as Promise<{ name: string; pubKey: string }>;
}

export async function networkUploadAvatar(envelope: unknown): Promise<{ sha: string; url: string }> {
  const res = await fetch(`${NETWORK_URL}/api/assets/avatar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    throw new Error(`avatar upload failed: ${res.status}`);
  }
  return res.json() as Promise<{ sha: string; url: string }>;
}

export async function networkPublishIdentity(envelope: unknown): Promise<void> {
  const res = await fetch(`${NETWORK_URL}/api/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    throw new Error(`identity publish failed: ${res.status}`);
  }
}
