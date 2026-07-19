import { z } from "zod";
import { ModelRef } from "./model.js";
import { AgentGender } from "./avatar.js";
import { AgentManifest, AgentOperator } from "./registry.js";

/** An image attachment persisted on a chat message (CONTRACTS §5). */
export const Attachment = z.object({
  id: z.string(),
  kind: z.literal("image"),
  url: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

/** An attachment reference sent by the client on `message.send` (CONTRACTS §5) — pre-uploaded via REST. */
export const AttachmentRef = z.object({
  url: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

/** A chat message (CONTRACTS §5). `mentions` holds member ids. */
export const ChatMessage = z.object({
  id: z.string(),
  channelId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  isAgent: z.boolean(),
  text: z.string(),
  mentions: z.array(z.string()),
  createdAt: z.string(),
  /** Client-synthesized announce line (e.g. "X added Y"); never persisted. */
  system: z.boolean().optional(),
  /** Unix ms of the last edit (own human messages only, CONTRACTS §5). Absent ⇒ never edited. */
  editedAt: z.number().optional(),
  /** Soft-deleted (CONTRACTS §5). `text` is blanked; clients render a tombstone. */
  deleted: z.boolean().optional(),
  /** Image attachments uploaded via REST before send (CONTRACTS §5). */
  attachments: z.array(Attachment).optional(),
  /** Durable invocation that produced this agent-authored message. */
  agentRunId: z.string().optional(),
  threadRootId: z.string().optional(),
  threadSummary: z.object({
    replyCount: z.number().int().nonnegative(),
    participantIds: z.array(z.string()),
    latestReplyAt: z.string().optional(),
    unread: z.number().int().nonnegative().optional(),
  }).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** A channel or DM location (CONTRACTS §5). */
export const Channel = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["channel", "dm"]),
  /** Participant member ids: both DM partners, or a public channel's roster (who gets woken / was pulled in). */
  memberIds: z.array(z.string()).optional(),
  /** Unread message count for the session member (CONTRACTS §5 read tracking). Server-computed. */
  unread: z.number().optional(),
  /** Whether any unread message mentions the session member. */
  hasMention: z.boolean().optional(),
  /** Unix ms of the most recent message, for float-up ordering. */
  lastMessageAt: z.number().optional(),
  ambientAttentionEnabled: z.boolean().optional(),
});
export type Channel = z.infer<typeof Channel>;

/**
 * A workspace member — human or agent (CONTRACTS §5). `avatar` is all-optional:
 * agents carry `emoji`+`bg`(+`imageUrl`) from the manifest, humans `imageUrl` only.
 */
export const Member = z.object({
  id: z.string(),
  name: z.string(),
  isAgent: z.boolean(),
  online: z.boolean(),
  avatar: z
    .object({
      emoji: z.string().optional(),
      bg: z.string().optional(),
      imageUrl: z.string().optional(),
    })
    .optional(),
  persona: z.string().optional(),
  capabilityBlurb: z.string().optional(),
  title: z.string().optional(),
  gender: AgentGender.optional(),
  specialties: z.array(z.string()).optional(),
  /** Agent only — manifest.operator ?? {pubKey: manifest.pubKey}. */
  owner: AgentOperator.optional(),
  /** Agent only: a signature change awaits workspace approval. */
  pendingChange: z.boolean().optional(),
  /** The network agentId; present only for agent members. */
  agentId: z.string().optional(),
  /** Unix ms when the agent manifest was last synced from the network; agent members only. */
  syncedAt: z.number().optional(),
  /** Unix ms when the member joined the workspace. */
  joinedAt: z.number().optional(),
  /** The model this agent runs on (from its manifest); agent members only. */
  model: ModelRef.optional(),
  /** Membership acceptance state (CONTRACTS §5). Absent ⇒ active — legacy-safe. */
  status: z.enum(["active", "pending", "rejected"]).optional(),
  /** The network identity key, for human members imported from the network (CONTRACTS §5). */
  identityKey: z.string().optional(),
  /** Human profile bio, ≤500 chars (CONTRACTS §5, workspace-local). */
  bio: z.string().optional(),
  /** Agent only: local model vs. an external frontier CLI agent (CONTRACTS §14). Absent ⇒ hosted. */
  runtime: z.enum(["hosted", "frontier"]).optional(),
});
export type Member = z.infer<typeof Member>;

/** A pending workspace join request awaiting acceptance (CONTRACTS §5). */
export const MemberRequest = z.object({
  memberId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().optional(),
  joinMessage: z.string().optional(),
  identityKey: z.string().optional(),
  requestedAt: z.string(),
});
export type MemberRequest = z.infer<typeof MemberRequest>;

/**
 * A pending agent signature change awaiting workspace approval (CONTRACTS §5).
 * Raised when an inbound manifest's `agentSignatureV2({persona, model, title,
 * capabilityBlurb, avatarImageUrl})` (§2) no longer matches the member's
 * `approved_signature`. `changedFields` is additive-extended beyond
 * `persona`/`model` to `title`/`blurb`/`avatar` — safe because the sole
 * producer (instance) and consumer (web `AgentChangeCard`) redeploy together.
 */
export const AgentPendingChange = z.object({
  memberId: z.string(),
  agentId: z.string(),
  name: z.string(),
  requestedAt: z.string(),
  changedFields: z.array(z.enum(["persona", "model", "title", "blurb", "avatar"])).min(1),
  current: z.object({
    persona: z.string(),
    model: ModelRef.optional(),
    title: z.string().optional(),
    capabilityBlurb: z.string().optional(),
    avatarImageUrl: z.string().optional(),
  }),
  incoming: z.object({
    persona: z.string(),
    model: ModelRef.optional(),
    title: z.string().optional(),
    capabilityBlurb: z.string().optional(),
    avatarImageUrl: z.string().optional(),
  }),
  // Lazily bound to avoid a hard circular module-eval dependency
  // (chat.ts -> registry.ts -> frontier.ts -> chat.ts, CONTRACTS §14).
  incomingManifest: z.lazy(() => AgentManifest),
});
export type AgentPendingChange = z.infer<typeof AgentPendingChange>;

// --- Agent activity (§5, generic workspace surface; no prompt/tool payloads) ---

export const AgentRunKind = z.enum(["chat", "work", "subloop", "report"]);
export type AgentRunKind = z.infer<typeof AgentRunKind>;

export const AgentRunRuntime = z.enum(["hosted", "frontier"]);
export type AgentRunRuntime = z.infer<typeof AgentRunRuntime>;

export const AgentRunStatus = z.enum([
  "queued",
  "running",
  "stopping",
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const AgentRunStage = z.enum([
  "queued",
  "preparing_context",
  "compacting",
  "waiting_model",
  "using_tool",
  "waiting_slot",
  "verifying",
  "posting",
  "stopping",
]);
export type AgentRunStage = z.infer<typeof AgentRunStage>;

/** Safe summary broadcast to channel participants. Detailed redacted events
 * stay behind the channel-authorized REST surface. */
export const AgentRunSummary = z.object({
  id: z.string(),
  parentRunId: z.string().nullable(),
  memberId: z.string(),
  channelId: z.string(),
  kind: AgentRunKind,
  runtime: AgentRunRuntime,
  status: AgentRunStatus,
  stage: AgentRunStage.nullable(),
  label: z.string(),
  model: ModelRef.optional(),
  toolCalls: z.number(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  lastSeq: z.number(),
  threadRootId: z.string().optional(),
  wakeReason: z.enum(["ambient", "thread", "mention", "dm"]).optional(),
});
export type AgentRunSummary = z.infer<typeof AgentRunSummary>;

// --- Client → server WS messages (§5) ---

export const ClientWsMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.send"),
    channelId: z.string(),
    text: z.string(),
    threadRootId: z.string().optional(),
    /** Member ids the sender confirmed to add to the channel (auto-join). */
    addMemberIds: z.array(z.string()).optional(),
    /** Image attachments uploaded via REST before send (CONTRACTS §5). */
    attachments: z.array(AttachmentRef).optional(),
  }),
  z.object({
    type: z.literal("typing.start"),
    channelId: z.string(),
    threadRootId: z.string().optional(),
  }),
]);
export type ClientWsMessage = z.infer<typeof ClientWsMessage>;

// --- Server → client WS events (§5) ---

export const ServerWsEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.new"),
    message: ChatMessage,
  }),
  z.object({
    type: z.literal("message.updated"),
    messageId: z.string(),
    channelId: z.string(),
    text: z.string(),
    complete: z.boolean(),
    threadRootId: z.string().optional(),
  }),
  z.object({
    type: z.literal("typing"),
    channelId: z.string(),
    memberId: z.string(),
    isAgent: z.boolean(),
    threadRootId: z.string().optional(),
  }),
  z.object({
    type: z.literal("presence.update"),
    memberId: z.string(),
    online: z.boolean(),
  }),
  z.object({
    type: z.literal("member.updated"),
    member: Member,
  }),
  z.object({
    type: z.literal("member.joined"),
    member: Member,
  }),
  z.object({
    type: z.literal("member.left"),
    memberId: z.string(),
  }),
  z.object({
    type: z.literal("channel.created"),
    channel: Channel,
  }),
  z.object({
    type: z.literal("channel.member.added"),
    channelId: z.string(),
    memberIds: z.array(z.string()),
    byName: z.string(),
  }),
  z.object({
    type: z.literal("agent.change.pending"),
    change: AgentPendingChange,
  }),
  z.object({
    type: z.literal("agent.change.resolved"),
    memberId: z.string(),
    accepted: z.boolean(),
  }),
  z.object({
    type: z.literal("member.request.created"),
    request: MemberRequest,
  }),
  z.object({
    type: z.literal("member.request.resolved"),
    memberId: z.string(),
    accepted: z.boolean(),
  }),
  z.object({
    type: z.literal("message.edited"),
    messageId: z.string(),
    channelId: z.string(),
    text: z.string(),
    /** Unix ms. */
    editedAt: z.number(),
    mentions: z.array(z.string()),
    threadRootId: z.string().optional(),
  }),
  z.object({
    type: z.literal("message.deleted"),
    messageId: z.string(),
    channelId: z.string(),
    threadRootId: z.string().optional(),
  }),
  z.object({
    type: z.literal("thread.updated"),
    channelId: z.string(),
    rootMessageId: z.string(),
    summary: z.object({
      replyCount: z.number().int().nonnegative(),
      participantIds: z.array(z.string()),
      latestReplyAt: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("channel.deleted"),
    channelId: z.string(),
  }),
  z.object({
    type: z.literal("agent.run.updated"),
    run: AgentRunSummary,
  }),
]);
export type ServerWsEvent = z.infer<typeof ServerWsEvent>;
