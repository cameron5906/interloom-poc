import { NETWORK_URL } from "../config.js";

export interface MagicLinkResponse {
  loginUrl: string;
}

export interface NetworkSessionState {
  email?: string;
  sessionToken?: string;
  loggedIn: boolean;
}

export async function networkMagicLink(email: string): Promise<MagicLinkResponse> {
  const res = await fetch(`${NETWORK_URL}/api/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new Error(`network magic-link failed: ${res.status}`);
  }
  return res.json() as Promise<MagicLinkResponse>;
}

export async function networkRegisterAgent(envelope: unknown): Promise<void> {
  const res = await fetch(`${NETWORK_URL}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`agent register failed: ${res.status} ${text}`);
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
