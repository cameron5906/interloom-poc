import { describe, expect, it } from "vitest";
import {
  FrontierLinkPayload,
  FrontierLinkSessionAuth,
  FrontierProvider,
  FrontierRuntimeConfig,
  FrontierWorkItem,
} from "./frontier.js";

describe("FrontierProvider / FrontierRuntimeConfig (CONTRACTS §14)", () => {
  it("accepts anthropic and openai", () => {
    expect(FrontierProvider.safeParse("anthropic").success).toBe(true);
    expect(FrontierProvider.safeParse("openai").success).toBe(true);
  });

  it("rejects an unknown provider", () => {
    expect(FrontierProvider.safeParse("cohere").success).toBe(false);
  });

  it("round-trips a FrontierRuntimeConfig", () => {
    const parsed = FrontierRuntimeConfig.parse({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("claude-sonnet-5");
  });

  it("rejects an empty model string", () => {
    expect(FrontierRuntimeConfig.safeParse({ provider: "openai", model: "" }).success).toBe(false);
  });

  it("rejects a model string over 120 chars", () => {
    expect(
      FrontierRuntimeConfig.safeParse({ provider: "openai", model: "x".repeat(121) }).success,
    ).toBe(false);
  });
});

describe("FrontierWorkItem (CONTRACTS §14)", () => {
  const trigger = {
    id: "m1",
    channelId: "c1",
    authorId: "u1",
    authorName: "Cam",
    isAgent: false,
    text: "hey @Ada, can you help?",
    mentions: ["ada"],
    createdAt: "2026-07-14T00:00:00.000Z",
  };

  const base = {
    workId: "w1",
    agentId: "ada",
    channelId: "c1",
    channelName: "general",
    workspaceName: "Interloom Demo",
    trigger,
    recentMessages: [trigger],
    members: [
      { name: "Cam", isAgent: false },
      { name: "Ada", isAgent: true },
    ],
    persona: { name: "Ada", title: "the Helper", persona: "You are a helpful agent." },
    enqueuedAt: "2026-07-14T00:00:01.000Z",
  };

  it("parses a full work item", () => {
    const result = FrontierWorkItem.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trigger.text).toBe(trigger.text);
      expect(result.data.recentMessages).toHaveLength(1);
      expect(result.data.persona.title).toBe("the Helper");
    }
  });

  it("JSON round-trips a work item (canonicalJson gotcha — optional keys omitted, not undefined)", () => {
    const parsed = FrontierWorkItem.parse(base);
    const roundTripped = FrontierWorkItem.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("persona.title and persona.persona are optional", () => {
    const result = FrontierWorkItem.safeParse({
      ...base,
      persona: { name: "Ada" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional leaseToken and parses without one (additive)", () => {
    const withToken = FrontierWorkItem.safeParse({ ...base, leaseToken: "lease-abc123" });
    expect(withToken.success).toBe(true);
    if (withToken.success) expect(withToken.data.leaseToken).toBe("lease-abc123");

    const withoutToken = FrontierWorkItem.safeParse(base);
    expect(withoutToken.success).toBe(true);
    if (withoutToken.success) expect(withoutToken.data.leaseToken).toBeUndefined();
  });

  it("rejects a work item missing trigger", () => {
    const { trigger: _trigger, ...missing } = base;
    expect(FrontierWorkItem.safeParse(missing).success).toBe(false);
  });

  it("rejects a work item whose trigger is not a valid ChatMessage", () => {
    expect(FrontierWorkItem.safeParse({ ...base, trigger: { text: "hi" } }).success).toBe(false);
  });
});

describe("FrontierLinkSessionAuth (CONTRACTS §14/§4)", () => {
  const base = {
    kind: "frontier-agent" as const,
    agentId: "a1",
    nonce: "n1",
    iat: 1_752_000_000_000,
  };

  it("parses a valid auth payload", () => {
    expect(FrontierLinkSessionAuth.safeParse(base).success).toBe(true);
  });

  it("rejects a wrong kind literal", () => {
    expect(FrontierLinkSessionAuth.safeParse({ ...base, kind: "device" }).success).toBe(false);
  });

  it("rejects a missing nonce", () => {
    const { nonce: _nonce, ...missing } = base;
    expect(FrontierLinkSessionAuth.safeParse(missing).success).toBe(false);
  });

  it("rejects a non-numeric iat", () => {
    expect(FrontierLinkSessionAuth.safeParse({ ...base, iat: "now" }).success).toBe(false);
  });
});

describe("FrontierLinkPayload (CONTRACTS §14)", () => {
  const base = {
    v: 1 as const,
    kind: "frontier-agent" as const,
    agentId: "a1",
    agentName: "Ada",
    agentPrivKey: "cHJpdmtleQ==",
    agentPubKey: "cHVia2V5",
    networkUrl: "https://net.example.com",
    provider: "anthropic" as const,
    model: "claude-sonnet-5",
  };

  it("parses a minimal payload (apiKey/operatorGrant absent)", () => {
    const result = FrontierLinkPayload.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKey).toBeUndefined();
      expect(result.data.operatorGrant).toBeUndefined();
    }
  });

  it("parses a full payload with apiKey and operatorGrant", () => {
    const result = FrontierLinkPayload.safeParse({
      ...base,
      apiKey: "sk-abc123",
      operatorGrant: { payload: { v: 1 }, key: "k", sig: "s" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing agentPrivKey", () => {
    const { agentPrivKey: _agentPrivKey, ...missing } = base;
    expect(FrontierLinkPayload.safeParse(missing).success).toBe(false);
  });

  it("rejects a wrong kind literal", () => {
    expect(FrontierLinkPayload.safeParse({ ...base, kind: "device" }).success).toBe(false);
  });

  it("rejects a wrong v literal", () => {
    expect(FrontierLinkPayload.safeParse({ ...base, v: 2 }).success).toBe(false);
  });

  it("rejects a non-url networkUrl", () => {
    expect(FrontierLinkPayload.safeParse({ ...base, networkUrl: "not-a-url" }).success).toBe(false);
  });

  it("JSON round-trips a payload with an optional apiKey omitted (canonicalJson gotcha)", () => {
    const parsed = FrontierLinkPayload.parse(base);
    expect(parsed).not.toHaveProperty("apiKey");
    const roundTripped = FrontierLinkPayload.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});
