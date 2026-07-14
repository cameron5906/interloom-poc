import { describe, expect, it } from "vitest";
import {
  AuthIdentifyParams,
  AuthOkResult,
  InferenceCompleteParams,
  InferenceMessage,
  InferenceStreamResult,
  makeErr,
  makeEvt,
  makeReq,
  makeRes,
  parseTunnelFrame,
  TunnelFrame,
  TunnelFrameError,
  TunnelErrorCode,
  TUNNEL_VERSION,
} from "./index.js";
import { ContentPart, ToolCall, ToolDef } from "./tunnel.js";

describe("tunnel frame constructors", () => {
  it("makeReq builds a req frame with a uuid id", () => {
    const frame = makeReq("inference.complete", { messages: [] });
    expect(frame.kind).toBe("req");
    expect(frame.il).toBe(TUNNEL_VERSION);
    expect(frame.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    if (frame.kind === "req") {
      expect(frame.method).toBe("inference.complete");
    }
  });

  it("makeRes echoes the provided id", () => {
    const frame = makeRes("req-123", { ok: true });
    expect(frame.kind).toBe("res");
    expect(frame.id).toBe("req-123");
  });

  it("makeErr carries a code and message", () => {
    const frame = makeErr("req-123", "E_AUTH", "bad voucher");
    expect(frame.kind).toBe("err");
    if (frame.kind === "err") {
      expect(frame.error.code).toBe("E_AUTH");
      expect(frame.error.message).toBe("bad voucher");
    }
  });

  it("makeEvt builds an evt frame with a method", () => {
    const frame = makeEvt("inference.chunk", { delta: "hi" });
    expect(frame.kind).toBe("evt");
    if (frame.kind === "evt") {
      expect(frame.method).toBe("inference.chunk");
    }
  });
});

describe("parseTunnelFrame round-trips", () => {
  it.each([
    ["req", makeReq("health.ping", {})],
    ["res", makeRes("id-1", { ok: true, ts: 1 })],
    ["evt", makeEvt("inference.chunk", { delta: "x" })],
    ["err", makeErr("id-1", "E_BUSY", "busy")],
  ])("round-trips a %s frame", (_kind, frame) => {
    const raw = JSON.stringify(frame);
    const parsed = parseTunnelFrame(raw);
    expect(parsed).toEqual(frame);
  });
});

describe("parseTunnelFrame version rejection", () => {
  it("throws E_VERSION on a mismatched version", () => {
    const raw = JSON.stringify({ il: 2, id: "x", kind: "req", method: "health.ping" });
    expect(() => parseTunnelFrame(raw)).toThrow(TunnelFrameError);
    try {
      parseTunnelFrame(raw);
    } catch (err) {
      expect((err as TunnelFrameError).code).toBe("E_VERSION");
    }
  });

  it("throws E_INTERNAL on malformed JSON", () => {
    try {
      parseTunnelFrame("{not json");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as TunnelFrameError).code).toBe("E_INTERNAL");
    }
  });

  it("throws E_INTERNAL on a structurally invalid frame", () => {
    const raw = JSON.stringify({ il: 1, id: "x", kind: "bogus" });
    try {
      parseTunnelFrame(raw);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as TunnelFrameError).code).toBe("E_INTERNAL");
    }
  });
});

describe("AuthIdentifyParams ctx field (additive, optional)", () => {
  const base = {
    agentId: "agent-1",
    agentPubKey: "pk",
    voucher: { payload: {}, key: "k", sig: "s" },
    sig: "nonce-sig",
  };

  it("parses without ctx (ctx absent → undefined)", () => {
    const result = AuthIdentifyParams.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ctx).toBeUndefined();
  });

  it("parses with ctx present", () => {
    const result = AuthIdentifyParams.safeParse({ ...base, ctx: 8192 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ctx).toBe(8192);
  });

  it("rejects non-numeric ctx", () => {
    const result = AuthIdentifyParams.safeParse({ ...base, ctx: "8192" });
    expect(result.success).toBe(false);
  });
});

describe("AuthOkResult ctx field", () => {
  it("parses without ctx", () => {
    const result = AuthOkResult.safeParse({ ok: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ctx).toBeUndefined();
  });

  it("parses with ctx", () => {
    const result = AuthOkResult.safeParse({ ok: true, ctx: 4096 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ctx).toBe(4096);
  });
});

describe("TunnelFrame discriminated union narrowing", () => {
  it("narrows on kind", () => {
    const frame: TunnelFrame = makeReq("m", { a: 1 });
    if (frame.kind === "req") {
      // method is only present on req/evt; this compiles + runs.
      expect(typeof frame.method).toBe("string");
    } else {
      expect.unreachable();
    }
  });
});

describe("tool-calling wire shapes (additive, CONTRACTS §3)", () => {
  it("InferenceParams accepts tools + toolChoice", () => {
    const p = InferenceCompleteParams.parse({
      messages: [{ role: "user", content: "hi" }],
      params: {
        tools: [
          {
            name: "platform.read_history",
            description: "Read earlier messages",
            parameters: { type: "object", properties: {} },
          },
        ],
        toolChoice: "auto",
      },
    });
    expect(p.params?.tools?.[0]?.name).toBe("platform.read_history");
  });

  it("assistant message carries toolCalls; tool role carries toolCallId", () => {
    const call = ToolCall.parse({ id: "c1", name: "platform.list_members", arguments: "{}" });
    const assistant = InferenceMessage.parse({
      role: "assistant",
      content: "",
      toolCalls: [call],
    });
    const toolResult = InferenceMessage.parse({
      role: "tool",
      content: '{"members":[]}',
      toolCallId: "c1",
    });
    expect(assistant.toolCalls).toHaveLength(1);
    expect(toolResult.toolCallId).toBe("c1");
  });

  it("stream terminal result may carry toolCalls", () => {
    const r = InferenceStreamResult.parse({
      usage: { promptTokens: 1, completionTokens: 2, tokensPerSec: 3 },
      toolCalls: [{ id: "c1", name: "x", arguments: "{}" }],
    });
    expect(r.toolCalls).toHaveLength(1);
  });

  it("old shapes still parse (additive)", () => {
    expect(
      InferenceCompleteParams.parse({ messages: [{ role: "user", content: "hi" }] }).params,
    ).toBeUndefined();
    expect(
      InferenceStreamResult.parse({ usage: { promptTokens: 0, completionTokens: 0, tokensPerSec: 0 } })
        .toolCalls,
    ).toBeUndefined();
  });

  it("TunnelErrorCode round-trips E_PENDING_APPROVAL (CONTRACTS §3 drift fix)", () => {
    expect(TunnelErrorCode.safeParse("E_PENDING_APPROVAL").success).toBe(true);
    const frame = makeErr("id-1", "E_PENDING_APPROVAL", "signature change awaits approval");
    const parsed = parseTunnelFrame(JSON.stringify(frame));
    if (parsed.kind === "err") {
      expect(TunnelErrorCode.parse(parsed.error.code)).toBe("E_PENDING_APPROVAL");
    } else {
      expect.unreachable();
    }
  });

  it("auth.identify accepts features", () => {
    const p = AuthIdentifyParams.parse({
      agentId: "a",
      agentPubKey: "k",
      voucher: { payload: {}, key: "k", sig: "s" },
      sig: "s",
      ctx: 8192,
      features: ["tools"],
    });
    expect(p.features).toEqual(["tools"]);
  });
});

describe("image attachment wire shapes (additive, CONTRACTS §3)", () => {
  it("ContentPart discriminates text vs image_url", () => {
    const text = ContentPart.parse({ type: "text", text: "hi" });
    const image = ContentPart.parse({ type: "image_url", image_url: { url: "https://x/y.png" } });
    expect(text.type).toBe("text");
    expect(image.type).toBe("image_url");
  });

  it("ContentPart rejects an unknown type", () => {
    expect(ContentPart.safeParse({ type: "video", url: "x" }).success).toBe(false);
  });

  it("InferenceMessage accepts optional contentParts alongside the required content degrade", () => {
    const m = InferenceMessage.parse({
      role: "user",
      content: "[image attached]",
      contentParts: [
        { type: "text", text: "check this out" },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    });
    expect(m.contentParts).toHaveLength(2);
    expect(m.content).toBe("[image attached]");
  });

  it("InferenceMessage still parses without contentParts (stale host simulation)", () => {
    const m = InferenceMessage.parse({ role: "user", content: "hi" });
    expect(m.contentParts).toBeUndefined();
  });

  it("InferenceCompleteParams round-trips a message carrying contentParts", () => {
    const p = InferenceCompleteParams.parse({
      messages: [
        {
          role: "user",
          content: "[image attached]",
          contentParts: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
        },
      ],
    });
    expect(p.messages[0]?.contentParts?.[0]?.type).toBe("image_url");
  });
});
