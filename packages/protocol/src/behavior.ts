import { z } from "zod";
import { BoundedId } from "./limits.js";

/** Workspace-selected agent behavior generation (CONTRACTS §19). */
export const AgentBehaviorVersion = z.union([z.literal(1), z.literal(2)]);
export type AgentBehaviorVersion = z.infer<typeof AgentBehaviorVersion>;

export const AgentBehaviorMode = z.enum(["direct", "thread", "ambient_discovery", "work_report"]);
export type AgentBehaviorMode = z.infer<typeof AgentBehaviorMode>;

export const AgentBehaviorAuthority = z.enum([
  "conversation_only",
  "requested_actions",
  "read_only",
]);
export type AgentBehaviorAuthority = z.infer<typeof AgentBehaviorAuthority>;

export const ConversationMemoryKind = z.enum([
  "fact",
  "decision",
  "commitment",
  "open_question",
  "reference",
]);
export type ConversationMemoryKind = z.infer<typeof ConversationMemoryKind>;

export const ConversationMemorySource = z.object({
  messageId: BoundedId,
  excerpt: z.string().min(1).max(160),
});
export type ConversationMemorySource = z.infer<typeof ConversationMemorySource>;

export const ConversationMemoryItem = z.object({
  kind: ConversationMemoryKind,
  text: z.string().min(1).max(320),
  sources: z.array(ConversationMemorySource).min(1).max(3),
});
export type ConversationMemoryItem = z.infer<typeof ConversationMemoryItem>;

/** Source-linked compacted context, stored separately from v1 summaries. */
export const ConversationMemoryV2 = z.object({
  version: z.literal(2),
  items: z.array(ConversationMemoryItem).max(24),
});
export type ConversationMemoryV2 = z.infer<typeof ConversationMemoryV2>;

export const AmbientAttentionDecisionV2 = z
  .object({
    decision: z.enum(["ignore", "reply"]),
    reason: z.string().min(1).max(200),
  })
  .strict();
export type AmbientAttentionDecisionV2 = z.infer<typeof AmbientAttentionDecisionV2>;

/** Optional frontier handoff metadata; absent means behavior v1. */
export const AgentBehaviorEnvelopeV2 = z.object({
  version: z.literal(2),
  mode: AgentBehaviorMode,
  authority: AgentBehaviorAuthority,
  memory: ConversationMemoryV2.optional(),
});
export type AgentBehaviorEnvelopeV2 = z.infer<typeof AgentBehaviorEnvelopeV2>;
