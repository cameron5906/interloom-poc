import { z } from "zod";
import { ModelRef } from "./model.js";

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
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** A channel or DM location (CONTRACTS §5). */
export const Channel = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["channel", "dm"]),
  /** Participant member ids: both DM partners, or a public channel's roster (who gets woken / was pulled in). */
  memberIds: z.array(z.string()).optional(),
});
export type Channel = z.infer<typeof Channel>;

/** A workspace member — human or agent (CONTRACTS §5). */
export const Member = z.object({
  id: z.string(),
  name: z.string(),
  isAgent: z.boolean(),
  online: z.boolean(),
  avatar: z
    .object({
      emoji: z.string(),
      bg: z.string(),
    })
    .optional(),
  persona: z.string().optional(),
  capabilityBlurb: z.string().optional(),
  /** The network agentId; present only for agent members. */
  agentId: z.string().optional(),
  /** Unix ms when the agent manifest was last synced from the network; agent members only. */
  syncedAt: z.number().optional(),
  /** Unix ms when the member joined the workspace. */
  joinedAt: z.number().optional(),
  /** The model this agent runs on (from its manifest); agent members only. */
  model: ModelRef.optional(),
});
export type Member = z.infer<typeof Member>;

// --- Client → server WS messages (§5) ---

export const ClientWsMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.send"),
    channelId: z.string(),
    text: z.string(),
    /** Member ids the sender confirmed to add to the channel (auto-join). */
    addMemberIds: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("typing.start"),
    channelId: z.string(),
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
  }),
  z.object({
    type: z.literal("typing"),
    channelId: z.string(),
    memberId: z.string(),
    isAgent: z.boolean(),
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
]);
export type ServerWsEvent = z.infer<typeof ServerWsEvent>;
