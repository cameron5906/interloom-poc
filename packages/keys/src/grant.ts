import type { SignedEnvelope } from "./envelope.js";
import { verifyEnvelope } from "./envelope.js";

export type GrantScope = "workspace-device" | "omni-device" | "host-operator";

/**
 * Structural shape of an `IdentityGrant` payload (CONTRACTS §2), defined here
 * rather than imported so `@interloom/keys` stays free of a dependency on
 * `@interloom/protocol`. The zod schema — the source of truth — lives in
 * `packages/protocol/src/identity.ts`; this is the minimal shape `verifyGrant`
 * needs, checked structurally at runtime.
 */
export interface GrantPayload {
  v: 1;
  identityKey: string;
  subjectKey: string;
  scope: GrantScope;
  audience?: string;
  issuedAt: number;
  expiresAt?: number;
  epoch: number;
  nonce: string;
}

export interface VerifyGrantOptions {
  subjectKey: string;
  scope: GrantScope;
  audience?: string;
  now?: number;
}

function isGrantPayload(value: unknown): value is GrantPayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.identityKey === "string" &&
    typeof p.subjectKey === "string" &&
    (p.scope === "workspace-device" || p.scope === "omni-device" || p.scope === "host-operator") &&
    (p.audience === undefined || typeof p.audience === "string") &&
    typeof p.issuedAt === "number" &&
    (p.expiresAt === undefined || typeof p.expiresAt === "number") &&
    typeof p.epoch === "number" &&
    typeof p.nonce === "string"
  );
}

/**
 * Verify an identity grant envelope (CONTRACTS §2) — the ONE implementation
 * every verifier calls (network manifest route, instance import-claim, host
 * link-complete): envelope signature valid, `envelope.key === payload.identityKey`
 * (self-signed by the grantor), `payload.subjectKey` matches the key that
 * separately signed the live nonce/challenge in the calling context,
 * `payload.scope` matches the verifier's expectation, `audience` absent or
 * equal, `expiresAt` absent or in the future. Does NOT check epoch — epoch
 * revalidation is the network's authority; instances/hosts treat it as opaque
 * provenance.
 */
export function verifyGrant(env: SignedEnvelope<unknown>, opts: VerifyGrantOptions): boolean {
  if (!isGrantPayload(env.payload)) return false;
  const payload = env.payload;
  if (!verifyEnvelope(env as SignedEnvelope<GrantPayload>)) return false;
  if (env.key !== payload.identityKey) return false;
  if (payload.subjectKey !== opts.subjectKey) return false;
  if (payload.scope !== opts.scope) return false;
  if (payload.audience !== undefined && payload.audience !== opts.audience) return false;
  const now = opts.now ?? Date.now();
  if (payload.expiresAt !== undefined && payload.expiresAt <= now) return false;
  return true;
}
