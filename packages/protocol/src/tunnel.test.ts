import { describe, expect, it } from "vitest";
import {
  makeErr,
  makeEvt,
  makeReq,
  makeRes,
  parseTunnelFrame,
  TunnelFrame,
  TunnelFrameError,
  TUNNEL_VERSION,
} from "./index.js";

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
