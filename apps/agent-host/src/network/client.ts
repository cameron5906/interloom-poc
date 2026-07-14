import { NETWORK_URL } from "../config.js";

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
