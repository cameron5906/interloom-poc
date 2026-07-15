import { z } from "zod";
import { ChatMessage } from "./chat.js";

/** Frontier agent LLM provider (CONTRACTS §14). */
export const FrontierProvider = z.enum(["anthropic", "openai"]);
export type FrontierProvider = z.infer<typeof FrontierProvider>;

/** The provider/model a frontier agent runs on, in place of the local llama-server (CONTRACTS §14). */
export const FrontierRuntimeConfig = z.object({
  provider: FrontierProvider,
  model: z.string().min(1).max(120),
});
export type FrontierRuntimeConfig = z.infer<typeof FrontierRuntimeConfig>;

/**
 * Work item delivered to the MCP over the tunnel (`work.pull` result, CONTRACTS
 * §14). The instance-side queue row mirrors this shape. `trigger`/`recentMessages`
 * are lazily bound to `ChatMessage` to avoid a hard circular module-eval
 * dependency (frontier.ts -> chat.ts -> registry.ts -> frontier.ts).
 */
export const FrontierWorkItem = z.object({
  workId: z.string(),
  agentId: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  workspaceName: z.string(),
  trigger: z.lazy(() => ChatMessage),
  recentMessages: z.array(z.lazy(() => ChatMessage)),
  members: z.array(z.object({ name: z.string(), isAgent: z.boolean() })),
  persona: z.object({
    name: z.string(),
    title: z.string().optional(),
    persona: z.string().optional(),
  }),
  enqueuedAt: z.string(),
  /**
   * Opaque token bound to this specific lease (CONTRACTS §14 "Lease
   * ownership"). Additive — absent only if delivered by a not-yet-upgraded
   * instance. Must be echoed back on `work.complete`/`work.fail`; the
   * instance rejects a mismatched/missing token with `E_STALE_LEASE`
   * instead of applying the mutation, so a lease that outlived its 120s
   * window (or a second session sharing the agent keypair) can never
   * double-post or resurrect a completed item.
   */
  leaseToken: z.string().optional(),
});
export type FrontierWorkItem = z.infer<typeof FrontierWorkItem>;

/**
 * Signed-envelope auth alternative for `POST /api/link/sessions` when a
 * frontier agent's headless MCP-issuing daemon has no browser identity
 * cookie to present (CONTRACTS §14/§4). Carried as `SignedEnvelope<FrontierLinkSessionAuth>`
 * in the request body's `auth` field; `envelope.key` must equal the
 * registered agent's `pubKey` and that agent's manifest must declare
 * `runtime === "frontier"`.
 */
export const FrontierLinkSessionAuth = z.object({
  kind: z.literal("frontier-agent"),
  agentId: z.string(),
  nonce: z.string(),
  iat: z.number(),
});
export type FrontierLinkSessionAuth = z.infer<typeof FrontierLinkSessionAuth>;

// `FrontierLinkIssuerAuth` (the issuer's `/ws/link/:linkId` join auth) lives in
// `identity.ts` alongside `LinkSignalFrame` — defining it here would import
// `identity.ts` back into a cycle it currently sits outside of (identity.ts
// is a leaf relative to frontier.ts -> chat.ts -> registry.ts -> identity.ts;
// pulling it into frontier.ts and importing it back from identity.ts closes
// the loop and breaks eval order for registry.ts's non-lazy `IdentityGrant`
// use — reproduced and reverted once, see CONTRACTS §4/§14).

/** Encrypted link payload carried inside the device-link AES-GCM blob (CONTRACTS §14). */
export const FrontierLinkPayload = z.object({
  v: z.literal(1),
  kind: z.literal("frontier-agent"),
  agentId: z.string(),
  agentName: z.string(),
  agentPrivKey: z.string(),
  agentPubKey: z.string(),
  networkUrl: z.string().url(),
  provider: FrontierProvider,
  model: z.string(),
  apiKey: z.string().optional(),
  operatorGrant: z.unknown().optional(),
});
export type FrontierLinkPayload = z.infer<typeof FrontierLinkPayload>;
