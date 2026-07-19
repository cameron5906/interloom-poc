import { describe, it, expect } from "vitest";
import {
  AgentManifest,
  AgentOperator,
  AvatarAssetUpload,
  AvatarCharacter,
  HostAgent,
  IdentityPublish,
  IdentityRecord,
  MarketplaceAgent,
  Member,
  NotionistsOptions,
  ServerWsEvent,
} from "../index.js";

describe("NotionistsOptions / AvatarCharacter (CONTRACTS §12)", () => {
  const options = {
    brows: "variant04",
    eyes: "variant01",
    lips: "variant10",
    nose: "variant05",
    body: "variant01",
  };

  it("accepts the required-only piece set", () => {
    expect(NotionistsOptions.safeParse(options).success).toBe(true);
  });

  it("accepts every optional piece", () => {
    const full = {
      ...options,
      hair: "hat",
      beard: "variant03",
      bodyIcon: "electric",
      gesture: "handPhone",
      glasses: "variant02",
    };
    expect(NotionistsOptions.safeParse(full).success).toBe(true);
  });

  it("rejects a missing required piece", () => {
    const { brows: _brows, ...missingBrows } = options;
    expect(NotionistsOptions.safeParse(missingBrows).success).toBe(false);
  });

  it("round-trips a full AvatarCharacter", () => {
    const character = {
      style: "notionists" as const,
      seed: "Ada",
      gender: "female" as const,
      backgroundColor: "b6e3f4",
      options,
    };
    const parsed = AvatarCharacter.parse(character);
    expect(parsed.gender).toBe("female");
    expect(parsed.options.body).toBe("variant01");
  });

  it("rejects a non-notionists style literal", () => {
    expect(
      AvatarCharacter.safeParse({
        style: "bottts",
        seed: "Ada",
        gender: "other",
        backgroundColor: "f0f0f0",
        options,
      }).success,
    ).toBe(false);
  });
});

describe("AgentOperator schema", () => {
  it("accepts pubKey only", () => {
    expect(AgentOperator.safeParse({ pubKey: "pub" }).success).toBe(true);
  });

  it("accepts pubKey with displayName", () => {
    expect(AgentOperator.safeParse({ pubKey: "pub", displayName: "Cam" }).success).toBe(true);
  });

  it("rejects an empty displayName", () => {
    expect(AgentOperator.safeParse({ pubKey: "pub", displayName: "" }).success).toBe(false);
  });

  it("rejects a displayName over 60 chars", () => {
    expect(AgentOperator.safeParse({ pubKey: "pub", displayName: "x".repeat(61) }).success).toBe(
      false,
    );
  });
});

describe("AgentManifest profile field additions (CONTRACTS §4)", () => {
  const base = {
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

  it("still parses a legacy manifest without any new field (backward compat)", () => {
    const result = AgentManifest.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBeUndefined();
      expect(result.data.gender).toBeUndefined();
      expect(result.data.specialties).toBeUndefined();
      expect(result.data.operator).toBeUndefined();
    }
  });

  it("accepts title, gender, specialties, operator together", () => {
    const result = AgentManifest.safeParse({
      ...base,
      title: "the Helper",
      gender: "other",
      specialties: ["research", "writing"],
      operator: { pubKey: "pub", displayName: "Cam" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 8 specialties", () => {
    const result = AgentManifest.safeParse({
      ...base,
      specialties: Array.from({ length: 9 }, (_, i) => `s${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a specialty over 32 chars", () => {
    const result = AgentManifest.safeParse({ ...base, specialties: ["x".repeat(33)] });
    expect(result.success).toBe(false);
  });

  it("avatar.imageUrl is optional and additive", () => {
    const result = AgentManifest.safeParse({
      ...base,
      avatar: { emoji: "🤖", bg: "#efeafc", imageUrl: "https://net.example/assets/av/abc.png" },
    });
    expect(result.success).toBe(true);
  });
});

describe("MarketplaceAgent profile field additions (CONTRACTS §4)", () => {
  const base = {
    agentId: "a1",
    name: "Ada",
    avatar: { emoji: "🤖", bg: "#efeafc" },
    capabilityBlurb: "does things",
    persona: "helpful",
    live: true,
    ownerEmail: "c***@example.com",
  };

  it("still parses a legacy marketplace listing without any new field", () => {
    expect(MarketplaceAgent.safeParse(base).success).toBe(true);
  });

  it("accepts title, gender, specialties, owner together", () => {
    const result = MarketplaceAgent.safeParse({
      ...base,
      title: "the Helper",
      gender: "male",
      specialties: ["research"],
      owner: { pubKey: "pub", displayName: "Cam" },
    });
    expect(result.success).toBe(true);
  });
});

describe("AvatarAssetUpload schema", () => {
  it("accepts a valid upload payload", () => {
    const result = AvatarAssetUpload.safeParse({
      kind: "avatar-upload",
      contentType: "image/png",
      bytesB64: "aGVsbG8=",
      ts: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unsupported content type", () => {
    const result = AvatarAssetUpload.safeParse({
      kind: "avatar-upload",
      contentType: "image/gif",
      bytesB64: "aGVsbG8=",
      ts: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("IdentityPublish / IdentityRecord schemas", () => {
  it("round-trips an operator publish payload", () => {
    const result = IdentityPublish.safeParse({
      kind: "operator",
      pubKey: "pub",
      displayName: "Cam",
      ts: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional workspaceName", () => {
    const result = IdentityPublish.safeParse({
      kind: "user",
      pubKey: "pub",
      displayName: "Cam",
      workspaceName: "Eris Demo",
      ts: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty displayName", () => {
    const result = IdentityPublish.safeParse({
      kind: "user",
      pubKey: "pub",
      displayName: "",
      ts: 1,
    });
    expect(result.success).toBe(false);
  });

  it("round-trips an identity record with joined agents", () => {
    const result = IdentityRecord.safeParse({
      pubKey: "pub",
      kind: "operator",
      displayName: "Cam",
      role: "agent-operator",
      updatedAt: "2026-07-12T00:00:00Z",
      agents: [{ agentId: "a1", name: "Ada" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an identity record without the optional agents field", () => {
    const result = IdentityRecord.safeParse({
      pubKey: "pub",
      kind: "user",
      displayName: "Cam",
      role: "workspace-member",
      updatedAt: "2026-07-12T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("Member avatar (all-optional) and profile field additions (CONTRACTS §5)", () => {
  const base = {
    id: "m1",
    name: "Ada",
    isAgent: true,
    online: true,
  };

  it("still parses a legacy member with a required-shape avatar", () => {
    const result = Member.safeParse({ ...base, avatar: { emoji: "🤖", bg: "#efeafc" } });
    expect(result.success).toBe(true);
  });

  it("parses a member with an all-optional avatar (imageUrl only)", () => {
    const result = Member.safeParse({
      ...base,
      isAgent: false,
      avatar: { imageUrl: "https://instance.example/api/assets/av/abc.png" },
    });
    expect(result.success).toBe(true);
  });

  it("parses a member with no avatar at all", () => {
    expect(Member.safeParse(base).success).toBe(true);
  });

  it("accepts title, gender, specialties, owner, pendingChange", () => {
    const result = Member.safeParse({
      ...base,
      title: "the Helper",
      gender: "other",
      specialties: ["research", "writing"],
      owner: { pubKey: "pub", displayName: "Cam" },
      pendingChange: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("ServerWsEvent agent.change.* variants (CONTRACTS §5)", () => {
  const incomingManifest = {
    agentId: "a1",
    name: "Ada",
    avatar: { emoji: "🤖", bg: "#efeafc" },
    persona: "a new persona",
    capabilityBlurb: "does things",
    pubKey: "pub",
    availability: "always" as const,
    contract: { kind: "free" as const },
    params: { temperature: 0.7, contextLength: 4096 },
    model: { filename: "qwen2.5-7b-q4.gguf", displayName: "Qwen 2.5 7B" },
  };

  it("parses agent.change.pending", () => {
    const result = ServerWsEvent.safeParse({
      type: "agent.change.pending",
      change: {
        memberId: "m1",
        agentId: "a1",
        name: "Ada",
        requestedAt: "2026-07-13T00:00:00Z",
        changedFields: ["persona"],
        current: { persona: "old persona" },
        incoming: { persona: "a new persona" },
        incomingManifest,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects agent.change.pending with an empty changedFields array", () => {
    const result = ServerWsEvent.safeParse({
      type: "agent.change.pending",
      change: {
        memberId: "m1",
        agentId: "a1",
        name: "Ada",
        requestedAt: "2026-07-13T00:00:00Z",
        changedFields: [],
        current: { persona: "old persona" },
        incoming: { persona: "a new persona" },
        incomingManifest,
      },
    });
    expect(result.success).toBe(false);
  });

  it("parses agent.change.resolved", () => {
    const result = ServerWsEvent.safeParse({
      type: "agent.change.resolved",
      memberId: "m1",
      accepted: false,
    });
    expect(result.success).toBe(true);
  });

  it("still parses every legacy ServerWsEvent variant", () => {
    expect(
      ServerWsEvent.safeParse({
        type: "presence.update",
        memberId: "m1",
        online: true,
      }).success,
    ).toBe(true);
    expect(
      ServerWsEvent.safeParse({
        type: "member.left",
        memberId: "m1",
      }).success,
    ).toBe(true);
  });
});

describe("HostAgent avatar additions (CONTRACTS §6/§12)", () => {
  const base = {
    agentId: "a1",
    name: "Ada",
    avatar: { emoji: "🤖", bg: "#efeafc" },
    persona: "helpful",
    capabilityBlurb: "does things",
    params: { temperature: 0.7, contextLength: 4096 },
    registered: false,
  };

  it("still parses a legacy host agent without imageUrl/character", () => {
    expect(HostAgent.safeParse(base).success).toBe(true);
  });

  it("accepts imageUrl and a full AvatarCharacter on avatar", () => {
    const result = HostAgent.safeParse({
      ...base,
      avatar: {
        emoji: "🤖",
        bg: "#efeafc",
        imageUrl: "https://net.example/assets/av/abc.png",
        character: {
          style: "notionists",
          seed: "Ada",
          gender: "female",
          backgroundColor: "b6e3f4",
          options: {
            brows: "variant04",
            eyes: "variant01",
            lips: "variant10",
            nose: "variant05",
            body: "variant01",
          },
        },
      },
      title: "the Helper",
      gender: "female",
      specialties: ["research"],
    });
    expect(result.success).toBe(true);
  });
});

describe("AgentManifest runtime/frontier additions (CONTRACTS §14)", () => {
  const base = {
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

  it("still parses a legacy manifest without runtime/frontier (absent ⇒ hosted)", () => {
    const result = AgentManifest.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBeUndefined();
      expect(result.data.frontier).toBeUndefined();
    }
  });

  it("accepts runtime:'frontier' with a frontier runtime config", () => {
    const result = AgentManifest.safeParse({
      ...base,
      runtime: "frontier",
      frontier: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe("frontier");
      expect(result.data.frontier?.provider).toBe("anthropic");
    }
  });

  it("accepts an explicit runtime:'hosted' without a frontier config", () => {
    expect(AgentManifest.safeParse({ ...base, runtime: "hosted" }).success).toBe(true);
  });

  it("rejects an unknown runtime value", () => {
    expect(AgentManifest.safeParse({ ...base, runtime: "cloud" }).success).toBe(false);
  });
});

describe("HostAgent runtime/frontier additions (CONTRACTS §14)", () => {
  const base = {
    agentId: "a1",
    name: "Ada",
    avatar: { emoji: "🤖", bg: "#efeafc" },
    persona: "helpful",
    capabilityBlurb: "does things",
    params: { temperature: 0.7, contextLength: 4096 },
    registered: false,
  };

  it("still parses a legacy host agent without runtime/frontier (absent ⇒ hosted)", () => {
    const result = HostAgent.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBeUndefined();
      expect(result.data.frontier).toBeUndefined();
    }
  });

  it("accepts runtime:'frontier' with a frontier runtime config", () => {
    const result = HostAgent.safeParse({
      ...base,
      runtime: "frontier",
      frontier: { provider: "openai", model: "gpt-5-codex" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe("frontier");
      expect(result.data.frontier?.model).toBe("gpt-5-codex");
    }
  });

  it("rejects an unknown runtime value", () => {
    expect(HostAgent.safeParse({ ...base, runtime: "cloud" }).success).toBe(false);
  });
});
