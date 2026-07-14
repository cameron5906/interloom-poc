import { describe, expect, it } from "vitest";
import {
  AgentManifest,
  AgentOperator,
  AllocationView,
  AssociationMutation,
  Attachment,
  AttachmentRef,
  ChatMessage,
  ClientWsMessage,
  DeviceKeyPayload,
  GpuBudget,
  GpuInfo,
  IdentityAuthClaim,
  IdentityGrant,
  IdentityPublish,
  IdentityRecord,
  IdentitySelf,
  IdentitySessionInfo,
  InviteVoucher,
  LinkSession,
  LinkSignalFrame,
  LoadedModel,
  LoadModelBody,
  LocalModel,
  Member,
  MemberRequest,
  ModelSettings,
  ModelSettingsPatch,
  Placement,
  ModelRef,
  ResolvedIdentity,
  ServerWsEvent,
  signedEnvelope,
  TelemetryFrame,
  UnloadModelBody,
  WebhookEvent,
  WorkspaceAssociation,
} from "./index.js";
import { ModelCapabilities } from "./model.js";

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

describe("auto-join wire additions", () => {
  it("ChatMessage accepts an optional system flag", () => {
    const m = ChatMessage.parse({
      id: "m1",
      channelId: "c1",
      authorId: "system",
      authorName: "",
      isAgent: false,
      text: "Cam added Bob to the channel",
      mentions: [],
      createdAt: "2026-07-12T00:00:00.000Z",
      system: true,
    });
    expect(m.system).toBe(true);
  });

  it("message.send accepts optional addMemberIds", () => {
    const s = ClientWsMessage.parse({
      type: "message.send",
      channelId: "c1",
      text: "hi @Bob",
      addMemberIds: ["bob"],
    });
    expect(s.type === "message.send" && s.addMemberIds).toEqual(["bob"]);
  });

  it("parses a channel.member.added event", () => {
    const e = ServerWsEvent.parse({
      type: "channel.member.added",
      channelId: "c1",
      memberIds: ["bob"],
      byName: "Cam",
    });
    expect(e.type).toBe("channel.member.added");
    expect(e.type === "channel.member.added" && e.memberIds).toEqual(["bob"]);
  });
});

describe("ModelCapabilities (additive, CONTRACTS §4)", () => {
  it("round-trips a ModelRef with capabilities", () => {
    const ref = {
      filename: "Qwen3-8B-Q4_K_M.gguf",
      displayName: "Qwen3 8B",
      capabilities: { tools: true, vision: false, thinking: true },
    };
    const parsed = ModelRef.parse(ref);
    expect(parsed.capabilities).toEqual({ tools: true, vision: false, thinking: true });
  });

  it("ModelRef without capabilities still parses (old manifests stay valid)", () => {
    const parsed = ModelRef.parse({ filename: "a.gguf", displayName: "A" });
    expect(parsed.capabilities).toBeUndefined();
  });

  it("LocalModel accepts capabilities + mmproj pairing fields", () => {
    const parsed = LocalModel.parse({
      path: "/models/repo/model.gguf",
      filename: "model.gguf",
      sizeBytes: 123,
      capabilities: { tools: false, vision: true, thinking: false },
      mmprojPath: "/models/repo/mmproj-f16.gguf",
      mmprojBytes: 456,
    });
    expect(parsed.mmprojPath).toBe("/models/repo/mmproj-f16.gguf");
  });

  it("ModelCapabilities rejects missing keys", () => {
    expect(ModelCapabilities.safeParse({ tools: true }).success).toBe(false);
  });
});

describe("GpuInfo index field (additive, CONTRACTS §6)", () => {
  it("parses without index (back-compat)", () => {
    const result = GpuInfo.safeParse({ name: "RTX 4090", vramMB: 24000, kind: "cuda" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBeUndefined();
  });

  it("parses with index present", () => {
    const result = GpuInfo.safeParse({ name: "RTX 4090", vramMB: 24000, kind: "cuda", index: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBe(0);
  });
});

describe("multi-instance model loading (CONTRACTS §6)", () => {
  const loadedModel = {
    path: "/models/repo/model.gguf",
    filename: "model.gguf",
    ctx: 8192,
    port: 8080,
    gpus: [0],
    fit: "fast" as const,
    health: "ready" as const,
  };

  it("LoadedModel round-trips the minimal shape", () => {
    const parsed = LoadedModel.parse(loadedModel);
    expect(parsed.port).toBe(8080);
    expect(parsed.gpus).toEqual([0]);
  });

  it("LoadedModel accepts the full shape (tensorSplit, model, reasoningBudget, mmprojPath)", () => {
    const parsed = LoadedModel.parse({
      ...loadedModel,
      model: { filename: "model.gguf", displayName: "Model" },
      tensorSplit: [0.5, 0.5],
      gpus: [0, 1],
      fit: "spill",
      reasoningBudget: 0,
      mmprojPath: "/models/repo/mmproj-f16.gguf",
    });
    expect(parsed.tensorSplit).toEqual([0.5, 0.5]);
    expect(parsed.reasoningBudget).toBe(0);
  });

  it("LoadedModel accepts null reasoningBudget and mmprojPath", () => {
    const parsed = LoadedModel.parse({ ...loadedModel, reasoningBudget: null, mmprojPath: null });
    expect(parsed.reasoningBudget).toBeNull();
    expect(parsed.mmprojPath).toBeNull();
  });

  it("LoadedModel rejects an unknown fit value", () => {
    expect(LoadedModel.safeParse({ ...loadedModel, fit: "no" }).success).toBe(false);
  });

  it("GpuBudget round-trips", () => {
    const parsed = GpuBudget.parse({
      index: 0,
      name: "RTX 4090",
      vramTotalMB: 24000,
      vramCommittedMB: 8000,
      vramFreeMB: 16000,
    });
    expect(parsed.vramFreeMB).toBe(16000);
  });

  it("AllocationView round-trips gpus + loaded + maxConcurrentAgents", () => {
    const parsed = AllocationView.parse({
      gpus: [{ index: 0, name: "RTX 4090", vramTotalMB: 24000, vramCommittedMB: 8000, vramFreeMB: 16000 }],
      loaded: [loadedModel],
      maxConcurrentAgents: 1,
    });
    expect(parsed.loaded).toHaveLength(1);
    expect(parsed.maxConcurrentAgents).toBe(1);
  });

  it("LoadModelBody accepts a minimal body (path only)", () => {
    const parsed = LoadModelBody.parse({ path: "/models/repo/model.gguf" });
    expect(parsed.ctx).toBeUndefined();
    expect(parsed.placement).toBeUndefined();
  });

  it("LoadModelBody accepts placement + confirmSpill", () => {
    const parsed = LoadModelBody.parse({
      path: "/models/repo/model.gguf",
      ctx: 8192,
      placement: { gpus: [0, 1], tensorSplit: [0.5, 0.5] },
      confirmSpill: true,
    });
    expect(parsed.placement?.gpus).toEqual([0, 1]);
    expect(parsed.confirmSpill).toBe(true);
  });

  it("LoadModelBody carries rig-optimizer plan flags (kvCache, nCpuMoe)", () => {
    const parsed = LoadModelBody.parse({
      path: "/models/repo/model.gguf",
      ctx: 8192,
      kvCache: "q8_0",
      nCpuMoe: 36,
    });
    expect(parsed.kvCache).toBe("q8_0");
    expect(parsed.nCpuMoe).toBe(36);
    expect(LoadModelBody.parse({ path: "/m.gguf" }).kvCache).toBeUndefined();
    expect(LoadModelBody.safeParse({ path: "/m.gguf", kvCache: "q4_0" }).success).toBe(false);
  });

  it("LoadedModel surfaces optional kvCache / nCpuMoe", () => {
    const parsed = LoadedModel.parse({
      path: "/models/repo/model.gguf",
      filename: "model.gguf",
      ctx: 8192,
      port: 8080,
      gpus: [0],
      fit: "spill",
      health: "ready",
      kvCache: "q8_0",
      nCpuMoe: 36,
    });
    expect(parsed.kvCache).toBe("q8_0");
    expect(parsed.nCpuMoe).toBe(36);
  });

  it("UnloadModelBody round-trips", () => {
    expect(UnloadModelBody.parse({ path: "/models/repo/model.gguf" }).path).toBe(
      "/models/repo/model.gguf",
    );
  });

  it("ModelSettings and ModelSettingsPatch accept optional disableThinking", () => {
    expect(ModelSettings.parse({ filename: "model.gguf" }).disableThinking).toBeUndefined();
    expect(
      ModelSettingsPatch.parse({ filename: "model.gguf", disableThinking: true }).disableThinking,
    ).toBe(true);
  });

  it("TelemetryFrame.inference accepts the additive models array", () => {
    const result = TelemetryFrame.safeParse({
      ts: 1,
      gpus: [],
      tokensPerSec: 0,
      requestLog: [],
      tunnels: [],
      agents: [],
      inference: {
        activeModel: { filename: "model.gguf", displayName: "Model" },
        queueDepth: 0,
        models: [{ filename: "model.gguf", port: 8080, ctx: 8192, queueDepth: 0, gpus: [0] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("TelemetryFrame.inference still parses without models (back-compat)", () => {
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
    if (result.success) expect(result.data.inference?.models).toBeUndefined();
  });
});

describe("chat image attachments (CONTRACTS §5)", () => {
  const attachment = {
    id: "att-1",
    kind: "image" as const,
    url: "https://demo.example/api/assets/av/abc.png",
    mimeType: "image/png",
  };

  it("Attachment round-trips the minimal shape", () => {
    const parsed = Attachment.parse(attachment);
    expect(parsed.kind).toBe("image");
  });

  it("Attachment accepts optional sizeBytes/width/height", () => {
    const parsed = Attachment.parse({ ...attachment, sizeBytes: 1024, width: 512, height: 512 });
    expect(parsed.sizeBytes).toBe(1024);
  });

  it("Attachment rejects a non-image kind", () => {
    expect(Attachment.safeParse({ ...attachment, kind: "video" }).success).toBe(false);
  });

  it("AttachmentRef round-trips (no id — server assigns it)", () => {
    const parsed = AttachmentRef.parse({ url: attachment.url, mimeType: "image/png" });
    expect(parsed.url).toBe(attachment.url);
  });

  it("ChatMessage accepts optional attachments", () => {
    const m = ChatMessage.parse({
      id: "m1",
      channelId: "c1",
      authorId: "u1",
      authorName: "Cam",
      isAgent: false,
      text: "check this out",
      mentions: [],
      createdAt: "2026-07-13T00:00:00.000Z",
      attachments: [attachment],
    });
    expect(m.attachments).toHaveLength(1);
  });

  it("ChatMessage still parses without attachments (back-compat)", () => {
    const m = ChatMessage.parse({
      id: "m1",
      channelId: "c1",
      authorId: "u1",
      authorName: "Cam",
      isAgent: false,
      text: "hi",
      mentions: [],
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    expect(m.attachments).toBeUndefined();
  });

  it("message.send accepts optional attachments", () => {
    const s = ClientWsMessage.parse({
      type: "message.send",
      channelId: "c1",
      text: "check this out",
      attachments: [{ url: attachment.url, mimeType: "image/png", sizeBytes: 1024 }],
    });
    expect(s.type === "message.send" && s.attachments).toHaveLength(1);
  });

  it("message.send still parses without attachments (stale client simulation)", () => {
    const s = ClientWsMessage.parse({ type: "message.send", channelId: "c1", text: "hi" });
    expect(s.type === "message.send" && s.attachments).toBeUndefined();
  });
});

describe("IdentityGrant schema (CONTRACTS §2)", () => {
  const base = {
    v: 1 as const,
    identityKey: "identity-pub",
    subjectKey: "subject-pub",
    scope: "workspace-device" as const,
    issuedAt: 1000,
    epoch: 0,
    nonce: "n1",
  };

  it("accepts a minimal grant (audience/expiresAt absent)", () => {
    expect(IdentityGrant.safeParse(base).success).toBe(true);
  });

  it("accepts a full grant with audience and expiresAt", () => {
    const full = { ...base, audience: "https://instance.example", expiresAt: 5000 };
    expect(IdentityGrant.safeParse(full).success).toBe(true);
  });

  it("rejects an unknown scope", () => {
    expect(IdentityGrant.safeParse({ ...base, scope: "other" }).success).toBe(false);
  });

  it("rejects a wrong version literal", () => {
    expect(IdentityGrant.safeParse({ ...base, v: 2 }).success).toBe(false);
  });

  it("round-trips a signed envelope of IdentityGrant", () => {
    const env = signedEnvelope(IdentityGrant);
    const result = env.safeParse({ payload: base, key: "identity-pub", sig: "sig" });
    expect(result.success).toBe(true);
  });

  it("is stable under key reordering (canonical-JSON-independent parse equality)", () => {
    const reordered = {
      nonce: base.nonce,
      epoch: base.epoch,
      issuedAt: base.issuedAt,
      scope: base.scope,
      subjectKey: base.subjectKey,
      identityKey: base.identityKey,
      v: base.v,
    };
    const canonicalSort = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalSort);
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
          out[k] = canonicalSort((value as Record<string, unknown>)[k]);
        }
        return out;
      }
      return value;
    };
    const a = IdentityGrant.parse(base);
    const b = IdentityGrant.parse(reordered);
    expect(JSON.stringify(canonicalSort(a))).toBe(JSON.stringify(canonicalSort(b)));
  });
});

describe("IdentityAuthClaim / IdentitySelf / IdentitySessionInfo schemas (CONTRACTS §4)", () => {
  it("accepts a claim without displayName/avatarSha (returning login)", () => {
    expect(
      IdentityAuthClaim.safeParse({ pubKey: "pub", nonce: "n", sig: "s" }).success,
    ).toBe(true);
  });

  it("accepts a first-claim registration payload", () => {
    expect(
      IdentityAuthClaim.safeParse({
        pubKey: "pub",
        nonce: "n",
        sig: "s",
        displayName: "Ada",
        avatarSha: "sha",
      }).success,
    ).toBe(true);
  });

  it("rejects a displayName over 60 chars", () => {
    expect(
      IdentityAuthClaim.safeParse({
        pubKey: "pub",
        nonce: "n",
        sig: "s",
        displayName: "x".repeat(61),
      }).success,
    ).toBe(false);
  });

  it("IdentitySelf accepts optional avatarUrl", () => {
    const result = IdentitySelf.safeParse({ pubKey: "pub", displayName: "Ada", kind: "user" });
    expect(result.success).toBe(true);
  });

  it("IdentitySessionInfo round-trips a masked session row", () => {
    const result = IdentitySessionInfo.safeParse({
      token: "abcd1234",
      current: true,
      createdAt: "2026-07-12T00:00:00Z",
      lastSeenAt: "2026-07-12T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("WorkspaceAssociation / AssociationMutation / ResolvedIdentity schemas (CONTRACTS §4)", () => {
  it("WorkspaceAssociation round-trips", () => {
    const result = WorkspaceAssociation.safeParse({
      instanceUrl: "https://demo.example",
      instanceName: "demo",
      ts: 1,
    });
    expect(result.success).toBe(true);
  });

  it("AssociationMutation narrows join vs leave", () => {
    const join = AssociationMutation.parse({
      kind: "workspace.join",
      pubKey: "pub",
      instanceUrl: "u",
      instanceName: "n",
      ts: 1,
    });
    expect(join.kind).toBe("workspace.join");
    expect(
      AssociationMutation.safeParse({
        kind: "bogus",
        pubKey: "pub",
        instanceUrl: "u",
        instanceName: "n",
        ts: 1,
      }).success,
    ).toBe(false);
  });

  it("ResolvedIdentity accepts an optional avatarUrl", () => {
    expect(ResolvedIdentity.safeParse({ displayName: "Ada", kind: "operator" }).success).toBe(
      true,
    );
  });
});

describe("Device link schemas (CONTRACTS §4)", () => {
  it("LinkSession round-trips", () => {
    expect(LinkSession.safeParse({ linkId: "l1", expiresAt: 1000 }).success).toBe(true);
  });

  it.each([
    ["join", { t: "join", role: "issuer" }],
    ["peer", { t: "peer", present: true }],
    ["offer", { t: "offer", sdp: "v=0..." }],
    ["answer", { t: "answer", sdp: "v=0..." }],
    ["ice", { t: "ice", candidate: { foo: "bar" } }],
    ["blob", { t: "blob", ciphertextB64: "abc", ivB64: "def" }],
    ["done", { t: "done" }],
    ["error", { t: "error", code: "E_LINK_EXPIRED" }],
  ])("LinkSignalFrame parses the %s variant", (_t, frame) => {
    const result = LinkSignalFrame.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it("LinkSignalFrame rejects an unknown t", () => {
    expect(LinkSignalFrame.safeParse({ t: "bogus" }).success).toBe(false);
  });

  it("LinkSignalFrame rejects an unknown error code", () => {
    expect(LinkSignalFrame.safeParse({ t: "error", code: "E_NOPE" }).success).toBe(false);
  });

  it("DeviceKeyPayload round-trips (cleartext payload inside the encrypted blob)", () => {
    const result = DeviceKeyPayload.safeParse({
      v: 1,
      privKey: "priv",
      pubKey: "pub",
      displayName: "Ada",
    });
    expect(result.success).toBe(true);
  });
});

describe("Member requests / approvals (CONTRACTS §5)", () => {
  it("MemberRequest round-trips a pending join request", () => {
    const result = MemberRequest.safeParse({
      memberId: "m1",
      displayName: "Ada",
      requestedAt: "2026-07-12T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("MemberRequest accepts optional avatarUrl/joinMessage/identityKey", () => {
    const result = MemberRequest.safeParse({
      memberId: "m1",
      displayName: "Ada",
      avatarUrl: "https://net.example/a.png",
      joinMessage: "hi, please let me in",
      identityKey: "identity-pub",
      requestedAt: "2026-07-12T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("ServerWsEvent narrows member.request.created", () => {
    const evt = ServerWsEvent.parse({
      type: "member.request.created",
      request: {
        memberId: "m1",
        displayName: "Ada",
        requestedAt: "2026-07-12T00:00:00Z",
      },
    });
    if (evt.type === "member.request.created") {
      expect(evt.request.memberId).toBe("m1");
    } else {
      expect.unreachable();
    }
  });

  it("ServerWsEvent narrows member.request.resolved", () => {
    const evt = ServerWsEvent.parse({
      type: "member.request.resolved",
      memberId: "m1",
      accepted: false,
    });
    if (evt.type === "member.request.resolved") {
      expect(evt.accepted).toBe(false);
    } else {
      expect.unreachable();
    }
  });
});

describe("Member additive fields (CONTRACTS §5)", () => {
  const base = { id: "m1", name: "Ada", isAgent: false, online: true };

  it("Member without status/identityKey still parses (legacy-safe, absent ⇒ active)", () => {
    const result = Member.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBeUndefined();
      expect(result.data.identityKey).toBeUndefined();
    }
  });

  it("Member accepts pending/rejected status and an identityKey", () => {
    const pending = Member.safeParse({ ...base, status: "pending", identityKey: "identity-pub" });
    expect(pending.success).toBe(true);
    if (pending.success) {
      expect(pending.data.status).toBe("pending");
      expect(pending.data.identityKey).toBe("identity-pub");
    }
  });

  it("Member rejects an unknown status", () => {
    expect(Member.safeParse({ ...base, status: "banned" }).success).toBe(false);
  });
});

describe("AgentOperator grant + IdentityPublish/IdentityRecord additions (CONTRACTS §4/§6)", () => {
  it("AgentOperator accepts an optional host-operator grant", () => {
    const result = AgentOperator.safeParse({
      pubKey: "host-pub",
      displayName: "Cam",
      grant: {
        payload: {
          v: 1,
          identityKey: "identity-pub",
          subjectKey: "host-pub",
          scope: "host-operator",
          issuedAt: 1,
          epoch: 0,
          nonce: "n",
        },
        key: "identity-pub",
        sig: "sig",
      },
    });
    expect(result.success).toBe(true);
  });

  it("AgentOperator without grant still parses (backward compat)", () => {
    expect(AgentOperator.safeParse({ pubKey: "host-pub" }).success).toBe(true);
  });

  it("IdentityPublish accepts optional avatarSha and workspaces", () => {
    const result = IdentityPublish.safeParse({
      kind: "user",
      pubKey: "pub",
      displayName: "Ada",
      ts: 1,
      avatarSha: "sha",
      workspaces: [{ instanceUrl: "https://demo.example", instanceName: "demo", ts: 1 }],
    });
    expect(result.success).toBe(true);
  });

  it("IdentityRecord accepts optional avatarUrl and workspaces with joinedAt", () => {
    const result = IdentityRecord.safeParse({
      pubKey: "pub",
      kind: "user",
      displayName: "Ada",
      role: "workspace-member",
      updatedAt: "2026-07-12T00:00:00Z",
      avatarUrl: "https://net.example/a.png",
      workspaces: [{ instanceUrl: "https://demo.example", instanceName: "demo", joinedAt: 1 }],
    });
    expect(result.success).toBe(true);
  });
});
