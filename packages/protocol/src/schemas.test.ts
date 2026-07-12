import { describe, expect, it } from "vitest";
import {
  AgentManifest,
  ClientWsMessage,
  InviteVoucher,
  Placement,
  ServerWsEvent,
  signedEnvelope,
  TelemetryFrame,
  WebhookEvent,
} from "./index.js";

describe("InviteVoucher schema", () => {
  const base = {
    v: 1 as const,
    placementId: "p1",
    agentId: "a1",
    agentPubKey: "pub",
    instanceUrl: "https://demo.example",
    instanceName: "demo",
    iat: 1000,
    exp: 1000 + 24 * 3600,
    nonce: "abc",
  };

  it("accepts a valid voucher", () => {
    expect(InviteVoucher.safeParse(base).success).toBe(true);
  });

  it("accepts an expired-shape voucher (expiry LOGIC is a consumer concern)", () => {
    // exp in the past is still a schema-valid number; no time check here.
    const expired = { ...base, exp: 1 };
    const result = InviteVoucher.safeParse(expired);
    expect(result.success).toBe(true);
  });

  it("rejects a wrong version literal", () => {
    expect(InviteVoucher.safeParse({ ...base, v: 2 }).success).toBe(false);
  });

  it("rejects a non-numeric exp", () => {
    expect(InviteVoucher.safeParse({ ...base, exp: "soon" }).success).toBe(false);
  });
});

describe("signedEnvelope factory", () => {
  it("wraps an inner schema and validates the envelope shape", () => {
    const env = signedEnvelope(InviteVoucher);
    const result = env.safeParse({
      payload: {
        v: 1,
        placementId: "p1",
        agentId: "a1",
        agentPubKey: "pub",
        instanceUrl: "u",
        instanceName: "n",
        iat: 1,
        exp: 2,
        nonce: "z",
      },
      key: "networkPub",
      sig: "sigstring",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope whose payload violates the inner schema", () => {
    const env = signedEnvelope(InviteVoucher);
    expect(env.safeParse({ payload: { v: 1 }, key: "k", sig: "s" }).success).toBe(false);
  });
});

describe("AgentManifest schema", () => {
  it("accepts a full manifest", () => {
    const result = AgentManifest.safeParse({
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#efeafc" },
      persona: "helpful",
      capabilityBlurb: "does things",
      pubKey: "pub",
      availability: "always",
      contract: { kind: "free" },
      params: { temperature: 0.7, contextLength: 4096 },
      model: { filename: "qwen2.5-7b-q4.gguf", displayName: "Qwen 2.5 7B" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-'always' availability", () => {
    const result = AgentManifest.safeParse({
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#efeafc" },
      persona: "helpful",
      capabilityBlurb: "does things",
      pubKey: "pub",
      availability: "sometimes",
      contract: { kind: "free" },
      params: { temperature: 0.7, contextLength: 4096 },
      model: { filename: "qwen2.5-7b-q4.gguf", displayName: "Qwen 2.5 7B" },
    });
    expect(result.success).toBe(false);
  });
});

describe("Placement schema", () => {
  it("accepts a placement carrying a signed voucher envelope", () => {
    const result = Placement.safeParse({
      placementId: "p1",
      instanceUrl: "u",
      instanceName: "n",
      voucher: {
        payload: {
          v: 1,
          placementId: "p1",
          agentId: "a1",
          agentPubKey: "pub",
          instanceUrl: "u",
          instanceName: "n",
          iat: 1,
          exp: 2,
          nonce: "z",
        },
        key: "networkPub",
        sig: "sig",
      },
      revoked: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("WebhookEvent discriminated union", () => {
  it("narrows to persona.updated with a manifest", () => {
    const parsed = WebhookEvent.parse({
      kind: "persona.updated",
      agentId: "a1",
      manifest: {
        agentId: "a1",
        name: "Ada",
        avatar: { emoji: "🤖", bg: "#efeafc" },
        persona: "p",
        capabilityBlurb: "b",
        pubKey: "pub",
        availability: "always",
        contract: { kind: "free" },
        params: { temperature: 0.7, contextLength: 4096 },
      model: { filename: "qwen2.5-7b-q4.gguf", displayName: "Qwen 2.5 7B" },
      },
      ts: 5,
    });
    expect(parsed.kind).toBe("persona.updated");
    if (parsed.kind === "persona.updated") {
      expect(parsed.manifest.name).toBe("Ada");
    }
  });

  it("narrows to placement.revoked with a placementId", () => {
    const parsed = WebhookEvent.parse({
      kind: "placement.revoked",
      agentId: "a1",
      placementId: "p1",
      ts: 5,
    });
    if (parsed.kind === "placement.revoked") {
      expect(parsed.placementId).toBe("p1");
    } else {
      expect.unreachable();
    }
  });

  it("rejects an unknown kind", () => {
    expect(WebhookEvent.safeParse({ kind: "nope", agentId: "a", ts: 1 }).success).toBe(false);
  });
});

describe("chat WS unions", () => {
  it("ClientWsMessage narrows message.send vs typing.start", () => {
    const send = ClientWsMessage.parse({ type: "message.send", channelId: "c1", text: "hi" });
    if (send.type === "message.send") {
      expect(send.text).toBe("hi");
    } else {
      expect.unreachable();
    }
    const typing = ClientWsMessage.parse({ type: "typing.start", channelId: "c1" });
    expect(typing.type).toBe("typing.start");
  });

  it("ServerWsEvent narrows message.new to a full ChatMessage", () => {
    const evt = ServerWsEvent.parse({
      type: "message.new",
      message: {
        id: "m1",
        channelId: "c1",
        authorId: "u1",
        authorName: "Cam",
        isAgent: false,
        text: "yo",
        mentions: [],
        createdAt: "2026-07-12T00:00:00Z",
      },
    });
    if (evt.type === "message.new") {
      expect(evt.message.authorName).toBe("Cam");
    } else {
      expect.unreachable();
    }
  });

  it("ServerWsEvent narrows message.updated with a complete flag and channelId", () => {
    const evt = ServerWsEvent.parse({
      type: "message.updated",
      messageId: "m1",
      channelId: "c1",
      text: "partial",
      complete: false,
    });
    if (evt.type === "message.updated") {
      expect(evt.complete).toBe(false);
      expect(evt.channelId).toBe("c1");
    } else {
      expect.unreachable();
    }
  });

  it("rejects an unknown server event type", () => {
    expect(ServerWsEvent.safeParse({ type: "bogus" }).success).toBe(false);
  });
});

describe("TelemetryFrame schema", () => {
  it("accepts a full telemetry frame", () => {
    const result = TelemetryFrame.safeParse({
      ts: 1,
      gpus: [{ name: "RTX", utilPct: 42, vramUsedMB: 1000, vramTotalMB: 24000 }],
      tokensPerSec: 30,
      requestLog: [
        {
          ts: 1,
          source: "tunnel:demo",
          agentName: "Ada",
          promptTokens: 10,
          completionTokens: 20,
          tokensPerSec: 30,
        },
      ],
      tunnels: [{ instanceName: "demo", instanceUrl: "u", agentName: "Ada", status: "connected" }],
      agents: [{ agentId: "a1", name: "Ada", status: "idle", registered: true }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts agent status 'offline' for model-not-loaded agents", () => {
    const result = TelemetryFrame.safeParse({
      ts: 1,
      gpus: [],
      tokensPerSec: 0,
      requestLog: [],
      tunnels: [],
      agents: [{ agentId: "a1", name: "Ada", status: "offline", registered: true }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional inference field with active model and queue depth", () => {
    const result = TelemetryFrame.safeParse({
      ts: 1,
      gpus: [],
      tokensPerSec: 0,
      requestLog: [],
      tunnels: [],
      agents: [],
      inference: { activeModel: { filename: "qwen.gguf", displayName: "Qwen" }, queueDepth: 2 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts inference field with null activeModel", () => {
    const result = TelemetryFrame.safeParse({
      ts: 1,
      gpus: [],
      tokensPerSec: 0,
      requestLog: [],
      tunnels: [],
      agents: [],
      inference: { activeModel: null, queueDepth: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts telemetry frame without inference field (backwards compat)", () => {
    const result = TelemetryFrame.safeParse({
      ts: 1,
      gpus: [],
      tokensPerSec: 0,
      requestLog: [],
      tunnels: [],
      agents: [],
    });
    expect(result.success).toBe(true);
  });
});
