import { describe, expect, it } from "vitest";
import { AgentPendingChange, ChatMessage, Channel, ClientWsMessage, Member, ServerWsEvent } from "../chat.js";

describe("ServerWsEvent — message.edited (CONTRACTS §5 A.5)", () => {
  it("round-trips a message.edited event", () => {
    const evt = ServerWsEvent.parse({
      type: "message.edited",
      messageId: "m1",
      channelId: "c1",
      text: "updated text",
      editedAt: 1_700_000_000_000,
      mentions: ["u2"],
    });
    if (evt.type === "message.edited") {
      expect(evt.text).toBe("updated text");
      expect(evt.editedAt).toBe(1_700_000_000_000);
      expect(evt.mentions).toEqual(["u2"]);
    } else {
      expect.unreachable();
    }
  });

  it("rejects message.edited missing editedAt", () => {
    const result = ServerWsEvent.safeParse({
      type: "message.edited",
      messageId: "m1",
      channelId: "c1",
      text: "t",
      mentions: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("ServerWsEvent — message.deleted (CONTRACTS §5 A.5)", () => {
  it("round-trips a message.deleted event", () => {
    const evt = ServerWsEvent.parse({
      type: "message.deleted",
      messageId: "m1",
      channelId: "c1",
    });
    if (evt.type === "message.deleted") {
      expect(evt.messageId).toBe("m1");
      expect(evt.channelId).toBe("c1");
    } else {
      expect.unreachable();
    }
  });
});

describe("ServerWsEvent — channel.deleted (CONTRACTS §5 A.6)", () => {
  it("round-trips a channel.deleted event", () => {
    const evt = ServerWsEvent.parse({ type: "channel.deleted", channelId: "c1" });
    if (evt.type === "channel.deleted") {
      expect(evt.channelId).toBe("c1");
    } else {
      expect.unreachable();
    }
  });
});

describe("AgentPendingChange — extended changedFields (CONTRACTS §5 A.3)", () => {
  const baseManifest = {
    agentId: "a1",
    name: "Ada",
    avatar: { emoji: "🤖", bg: "#efeafc" },
    persona: "helpful",
    capabilityBlurb: "does things",
    pubKey: "pub",
    availability: "always" as const,
    contract: { kind: "free" as const },
    params: { temperature: 0.7, contextLength: 4096 },
    model: { filename: "qwen2.5-7b-q4.gguf", displayName: "Qwen 2.5 7B" },
  };

  it("accepts a changedFields:[\"title\"] case with title on current/incoming", () => {
    const result = AgentPendingChange.safeParse({
      memberId: "m1",
      agentId: "a1",
      name: "Ada",
      requestedAt: "2026-07-14T00:00:00Z",
      changedFields: ["title"],
      current: { persona: "helpful", title: "Old Title" },
      incoming: { persona: "helpful", title: "New Title" },
      incomingManifest: baseManifest,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.changedFields).toEqual(["title"]);
      expect(result.data.current.title).toBe("Old Title");
      expect(result.data.incoming.title).toBe("New Title");
    }
  });

  it("accepts blurb and avatar as changedFields values", () => {
    const result = AgentPendingChange.safeParse({
      memberId: "m1",
      agentId: "a1",
      name: "Ada",
      requestedAt: "2026-07-14T00:00:00Z",
      changedFields: ["blurb", "avatar"],
      current: {
        persona: "helpful",
        capabilityBlurb: "old blurb",
        avatarImageUrl: "https://old.example/a.png",
      },
      incoming: {
        persona: "helpful",
        capabilityBlurb: "new blurb",
        avatarImageUrl: "https://new.example/a.png",
      },
      incomingManifest: baseManifest,
    });
    expect(result.success).toBe(true);
  });

  it("still accepts the legacy persona/model-only shape", () => {
    const result = AgentPendingChange.safeParse({
      memberId: "m1",
      agentId: "a1",
      name: "Ada",
      requestedAt: "2026-07-14T00:00:00Z",
      changedFields: ["persona", "model"],
      current: { persona: "old persona", model: baseManifest.model },
      incoming: { persona: "new persona", model: baseManifest.model },
      incomingManifest: baseManifest,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown changedFields value", () => {
    const result = AgentPendingChange.safeParse({
      memberId: "m1",
      agentId: "a1",
      name: "Ada",
      requestedAt: "2026-07-14T00:00:00Z",
      changedFields: ["nonsense"],
      current: { persona: "p" },
      incoming: { persona: "p" },
      incomingManifest: baseManifest,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty changedFields array", () => {
    const result = AgentPendingChange.safeParse({
      memberId: "m1",
      agentId: "a1",
      name: "Ada",
      requestedAt: "2026-07-14T00:00:00Z",
      changedFields: [],
      current: { persona: "p" },
      incoming: { persona: "p" },
      incomingManifest: baseManifest,
    });
    expect(result.success).toBe(false);
  });
});

describe("ChatMessage additive fields — editedAt/deleted (CONTRACTS §5 A.5)", () => {
  const base = {
    id: "m1",
    channelId: "c1",
    authorId: "u1",
    authorName: "Cam",
    isAgent: false,
    text: "hi",
    mentions: [],
    createdAt: "2026-07-14T00:00:00Z",
  };

  it("parses an old-shape message without editedAt/deleted (backward compat)", () => {
    const result = ChatMessage.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.editedAt).toBeUndefined();
      expect(result.data.deleted).toBeUndefined();
    }
  });

  it("accepts editedAt and deleted", () => {
    const result = ChatMessage.safeParse({
      ...base,
      text: "",
      editedAt: 1_700_000_000_000,
      deleted: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.editedAt).toBe(1_700_000_000_000);
      expect(result.data.deleted).toBe(true);
    }
  });
});

describe("Member additive field — bio (CONTRACTS §5 A.4)", () => {
  it("parses an old-shape member without bio (backward compat)", () => {
    const result = Member.safeParse({ id: "m1", name: "Ada", isAgent: false, online: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bio).toBeUndefined();
    }
  });

  it("accepts a bio", () => {
    const result = Member.safeParse({
      id: "m1",
      name: "Ada",
      isAgent: false,
      online: true,
      bio: "Building things at Eris.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bio).toBe("Building things at Eris.");
    }
  });
});

describe("Member additive field — runtime (CONTRACTS §14)", () => {
  it("parses an old-shape member without runtime (backward compat, absent ⇒ hosted)", () => {
    const result = Member.safeParse({ id: "m1", name: "Ada", isAgent: true, online: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBeUndefined();
    }
  });

  it("accepts runtime:'frontier'", () => {
    const result = Member.safeParse({
      id: "m1",
      name: "Ada",
      isAgent: true,
      online: true,
      runtime: "frontier",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe("frontier");
    }
  });

  it("rejects an unknown runtime value", () => {
    expect(
      Member.safeParse({ id: "m1", name: "Ada", isAgent: true, online: true, runtime: "cloud" })
        .success,
    ).toBe(false);
  });
});

describe("Channel additive fields — unread/hasMention/lastMessageAt (CONTRACTS §5 A.7)", () => {
  it("parses an old-shape channel without the new fields (backward compat)", () => {
    const result = Channel.safeParse({ id: "c1", name: "general", kind: "channel" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unread).toBeUndefined();
      expect(result.data.hasMention).toBeUndefined();
      expect(result.data.lastMessageAt).toBeUndefined();
    }
  });

  it("accepts unread, hasMention, and lastMessageAt", () => {
    const result = Channel.safeParse({
      id: "c1",
      name: "general",
      kind: "channel",
      unread: 3,
      hasMention: true,
      lastMessageAt: 1_700_000_000_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unread).toBe(3);
      expect(result.data.hasMention).toBe(true);
      expect(result.data.lastMessageAt).toBe(1_700_000_000_000);
    }
  });
});

describe("flat thread and ambient-attention additions (CONTRACTS §18)", () => {
  it("keeps old message/channel shapes valid and accepts thread summaries", () => {
    const message = ChatMessage.parse({
      id: "root-1",
      channelId: "c1",
      authorId: "u1",
      authorName: "Cam",
      isAgent: false,
      text: "Thoughts?",
      mentions: [],
      createdAt: "2026-07-17T00:00:00Z",
      threadSummary: {
        replyCount: 2,
        participantIds: ["u1", "agent-1"],
        latestReplyAt: "2026-07-17T00:01:00Z",
        unread: 1,
      },
    });
    expect(message.threadSummary?.replyCount).toBe(2);
    expect(Channel.parse({ id: "c1", name: "general", kind: "channel" }).ambientAttentionEnabled).toBeUndefined();
    expect(Channel.parse({ id: "c1", name: "general", kind: "channel", ambientAttentionEnabled: true }).ambientAttentionEnabled).toBe(true);
  });

  it("round-trips thread-scoped send, typing, and summary events", () => {
    expect(ClientWsMessage.parse({
      type: "message.send",
      channelId: "c1",
      threadRootId: "root-1",
      text: "A reply",
    }).threadRootId).toBe("root-1");
    expect(ClientWsMessage.parse({
      type: "typing.start",
      channelId: "c1",
      threadRootId: "root-1",
    }).threadRootId).toBe("root-1");
    const event = ServerWsEvent.parse({
      type: "thread.updated",
      channelId: "c1",
      rootMessageId: "root-1",
      summary: { replyCount: 1, participantIds: ["agent-1"] },
    });
    expect(event.type).toBe("thread.updated");
  });
});
