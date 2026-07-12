import { z } from "zod";
import { signedEnvelope } from "./envelope.js";
import { ModelRef } from "./model.js";

/** Agent avatar descriptor (CONTRACTS §4). */
export const AgentAvatar = z.object({
  emoji: z.string(),
  bg: z.string(),
});
export type AgentAvatar = z.infer<typeof AgentAvatar>;

/** Registered agent manifest — the signed registry record (CONTRACTS §4). */
export const AgentManifest = z.object({
  agentId: z.string(),
  name: z.string(),
  avatar: AgentAvatar,
  persona: z.string(),
  capabilityBlurb: z.string(),
  pubKey: z.string(),
  availability: z.literal("always"),
  contract: z.object({
    kind: z.literal("free"),
  }),
  params: z.object({
    temperature: z.number(),
    contextLength: z.number(),
  }),
  /** Published agents always declare the model they run on. */
  model: ModelRef,
});
export type AgentManifest = z.infer<typeof AgentManifest>;

/** Invite voucher payload, signed by the network key (CONTRACTS §4). */
export const InviteVoucher = z.object({
  v: z.literal(1),
  placementId: z.string(),
  agentId: z.string(),
  agentPubKey: z.string(),
  instanceUrl: z.string(),
  instanceName: z.string(),
  iat: z.number(),
  exp: z.number(),
  nonce: z.string(),
});
export type InviteVoucher = z.infer<typeof InviteVoucher>;

/** A placement links an agent to an instance and carries its signed voucher. */
export const Placement = z.object({
  placementId: z.string(),
  instanceUrl: z.string(),
  instanceName: z.string(),
  voucher: signedEnvelope(InviteVoucher),
  revoked: z.boolean(),
});
export type Placement = z.infer<typeof Placement>;

/** Heartbeat payload (signed by agent key) sent every 30s (CONTRACTS §4). */
export const HeartbeatPayload = z.object({
  agentId: z.string(),
  status: z.enum(["idle", "serving"]),
  ts: z.number(),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>;

/** Heartbeat response — how hosts learn about invites (CONTRACTS §4). */
export const HeartbeatResponse = z.object({
  placements: z.array(Placement),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** Public marketplace listing shape (CONTRACTS §4). */
export const MarketplaceAgent = z.object({
  agentId: z.string(),
  name: z.string(),
  avatar: AgentAvatar,
  capabilityBlurb: z.string(),
  persona: z.string(),
  live: z.boolean(),
  ownerEmail: z.string(),
  model: ModelRef.optional(),
});
export type MarketplaceAgent = z.infer<typeof MarketplaceAgent>;

/** Persona-sync subscription request (CONTRACTS §4). */
export const SubscriptionRequest = z.object({
  agentId: z.string(),
  placementId: z.string(),
  webhookUrl: z.string(),
});
export type SubscriptionRequest = z.infer<typeof SubscriptionRequest>;

/**
 * Webhook event fan-out payload (inner of a network-signed envelope).
 * Discriminated union on `kind` (CONTRACTS §4).
 */
export const WebhookEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("persona.updated"),
    agentId: z.string(),
    manifest: AgentManifest,
    ts: z.number(),
  }),
  z.object({
    kind: z.literal("placement.revoked"),
    agentId: z.string(),
    placementId: z.string(),
    ts: z.number(),
  }),
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** `/.well-known/interloom-network.json` shape (CONTRACTS §4). */
export const WellKnownNetwork = z.object({
  name: z.string(),
  pubKey: z.string(),
});
export type WellKnownNetwork = z.infer<typeof WellKnownNetwork>;
