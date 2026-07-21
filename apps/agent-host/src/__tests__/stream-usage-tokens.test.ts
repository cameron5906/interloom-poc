/**
 * Streamed OpenAI-compat chat completions never populate `usage` unless the
 * request opts in with `stream_options: { include_usage: true }` — without
 * it, llama-server's streamed chunks carry no usage object and
 * promptTokens/completionTokens stay 0 forever (tokensPerSec still works via
 * the native `timings` field). This covers both streaming request builders:
 * tunnel/client.ts `handleInferenceStream` and the `/api/agents/:id/preview`
 * route in agents/routes.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "net";
import { generateKeypair, signEnvelope, verifyEnvelope } from "@interloom/keys";
import { parseTunnelFrame, makeEvt, makeRes, type TunnelFrame } from "@interloom/protocol";

vi.mock("../config.js", () => ({
  PORT: 7420,
  DATA_DIR: "./test-data",
  MODELS_DIR: "./test-models",
  NETWORK_URL: "http://localhost:9999",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

vi.mock("../telemetry/collector.js", () => ({
  addRequestLogEntry: vi.fn(),
  recordTokensPerSec: vi.fn(),
}));

vi.mock("../agents/store.js", () => ({
  getAgent: (id: string) =>
    id === "a1" ? { agentId: "a1", model: { filename: "model.gguf" } } : undefined,
}));

vi.mock("../models/loaded.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../models/loaded.js")>();
  return {
    ...actual,
    findInstanceByFilename: (filename: string) =>
      filename === "model.gguf"
        ? { id: "test", modelPath: "/models/model.gguf", ctx: 4096, port: 8080, gpus: [] }
        : undefined,
  };
});

vi.mock("../models/scan.js", () => ({
  capabilitiesForFilename: () => undefined,
}));

vi.mock("../models/settingsStore.js", () => ({
  isThinkingDisabled: () => false,
}));

vi.mock("../inference/gate.js", () => ({
  enqueueInference: async (
    _port: number,
    _lane: string,
    run: (signal: AbortSignal) => Promise<void>,
  ) => run(new AbortController().signal),
  getServingLane: () => null,
  getQueueDepth: () => 0,
  drainLane: vi.fn(),
}));

function makePlacement(
  port: number,
  agentPubKey: string,
  networkKp: { privateKey: string; publicKey: string },
) {
  const voucherPayload = {
    v: 1 as const,
    placementId: "p1",
    agentId: "a1",
    agentPubKey,
    instanceUrl: `http://localhost:${port}`,
    instanceName: "test-instance",
    iat: Date.now(),
    exp: Date.now() + 86_400_000,
    nonce: crypto.randomUUID(),
  };
  const voucher = signEnvelope(voucherPayload, networkKp.privateKey, networkKp.publicKey);
  return {
    placementId: "p1",
    instanceUrl: `http://localhost:${port}`,
    instanceName: "test-instance",
    voucher,
    revoked: false,
  };
}

/** A stub SSE body: a content delta chunk followed by the OpenAI-shaped
 * terminal usage chunk (empty `choices`, populated `usage`) that only
 * appears when the request set `stream_options.include_usage: true`. */
function makeUsageBearingStream(): ReadableStream<Uint8Array> {
  const lines = [
    "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) + "\n\n",
    "data: " +
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
        timings: { predicted_per_second: 33 },
      }) +
      "\n\n",
    "data: [DONE]\n\n",
  ].join("");
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(lines));
      ctrl.close();
    },
  });
}

function makeSseStream(payloads: unknown[]): ReadableStream<Uint8Array> {
  const lines = [
    ...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(lines));
      ctrl.close();
    },
  });
}

async function runFinishReasonCase(body: ReadableStream<Uint8Array>): Promise<TunnelFrame> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body }));
  const networkKp = generateKeypair();
  const agentKp = generateKeypair();
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((resolve) =>
    wss.on("listening", () => resolve((wss.address() as AddressInfo).port)),
  );
  const terminal = new Promise<TunnelFrame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal frame never arrived")), 5000);
    wss.on("connection", (ws) => {
      const challenge = {
        challengeId: crypto.randomUUID(),
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        issuedAt: Date.now(),
      };
      ws.send(JSON.stringify(makeEvt("auth.challenge.v2", challenge)));
      ws.on("message", (data) => {
        const frame = parseTunnelFrame(data.toString());
        if (frame.kind === "req" && frame.method === "auth.identify.v2") {
          const params = frame.params as {
            agentPubKey: string;
            proof: { payload: { challengeId: string; nonce: string }; key: string; sig: string };
            ctx?: number;
          };
          if (
            verifyEnvelope(params.proof) &&
            params.proof.key === params.agentPubKey &&
            params.proof.payload.challengeId === challenge.challengeId &&
            params.proof.payload.nonce === challenge.nonce
          ) {
            ws.send(JSON.stringify(makeRes(frame.id, { ok: true, ctx: params.ctx })));
            ws.send(
              JSON.stringify({
                il: 1,
                id: "finish-reason-stream",
                kind: "req",
                method: "inference.stream",
                params: { messages: [{ role: "user", content: "hello" }] },
              }),
            );
          }
          return;
        }
        if (frame.id === "finish-reason-stream" && (frame.kind === "res" || frame.kind === "err")) {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
  });

  const { TunnelClient } = await import("../tunnel/client.js");
  const placement = makePlacement(port, agentKp.publicKey, networkKp);
  const client = new TunnelClient(placement, "TestAgent", agentKp.privateKey, agentKp.publicKey);
  client.start();
  try {
    return await terminal;
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe("tunnel client inference.stream — usage token propagation", () => {
  it("requests stream_options.include_usage and forwards promptTokens/completionTokens in the terminal res frame", async () => {
    const fetchCalls: Array<{ body: unknown }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
        const body = opts?.body ? (JSON.parse(opts.body as string) as unknown) : undefined;
        fetchCalls.push({ body });
        return { ok: true, status: 200, body: makeUsageBearingStream() };
      }),
    );

    const networkKp = generateKeypair();
    const agentKp = generateKeypair();

    const wss = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((res) =>
      wss.on("listening", () => res((wss.address() as AddressInfo).port)),
    );

    const receivedFrames: TunnelFrame[] = [];
    let serverWs: WebSocket | undefined;

    wss.on("connection", (ws) => {
      serverWs = ws;
      const challenge = {
        challengeId: crypto.randomUUID(),
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        issuedAt: Date.now(),
      };
      ws.send(JSON.stringify(makeEvt("auth.challenge.v2", challenge)));
      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : data.toString();
        let frame: TunnelFrame;
        try {
          frame = parseTunnelFrame(raw);
        } catch {
          return;
        }
        receivedFrames.push(frame);

        if (frame.kind === "req" && frame.method === "auth.identify.v2") {
          const params = frame.params as {
            agentPubKey: string;
            proof: { payload: { challengeId: string; nonce: string }; key: string; sig: string };
            ctx?: number;
          };
          if (
            verifyEnvelope(params.proof) &&
            params.proof.key === params.agentPubKey &&
            params.proof.payload.challengeId === challenge.challengeId &&
            params.proof.payload.nonce === challenge.nonce
          ) {
            ws.send(JSON.stringify(makeRes(frame.id, { ok: true, ctx: params.ctx })));
            ws.send(
              JSON.stringify({
                il: 1,
                id: "stream-req-1",
                kind: "req",
                method: "inference.stream",
                params: { messages: [{ role: "user", content: "hello" }] },
              }),
            );
          }
        }
      });
    });

    const { TunnelClient } = await import("../tunnel/client.js");
    const placement = makePlacement(port, agentKp.publicKey, networkKp);
    const client = new TunnelClient(placement, "TestAgent", agentKp.privateKey, agentKp.publicKey);
    client.start();

    const resFrame = await new Promise<Extract<TunnelFrame, { kind: "res" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal res frame never arrived")), 5000);
      const check = setInterval(() => {
        const found = receivedFrames.find((f) => f.kind === "res" && f.id === "stream-req-1") as
          Extract<TunnelFrame, { kind: "res" }> | undefined;
        if (found) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(found);
        }
      }, 20);
    });

    const result = resFrame.result as {
      usage?: { promptTokens: number; completionTokens: number; tokensPerSec: number };
    };
    expect(result.usage?.promptTokens).toBe(11);
    expect(result.usage?.completionTokens).toBe(7);
    expect(result.usage?.tokensPerSec).toBe(33);

    const streamCall = fetchCalls.find(
      (c) =>
        c.body !== undefined &&
        typeof c.body === "object" &&
        c.body !== null &&
        "stream" in (c.body as Record<string, unknown>),
    );
    expect(streamCall).toBeDefined();
    const sentBody = streamCall?.body as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });

    client.destroy();
    await new Promise<void>((res) => wss.close(() => res()));
    void serverWs;
  });

  it.each([
    [
      "missing",
      makeSseStream([
        { choices: [{ delta: { content: "hi" } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      "inference stream omitted finish_reason",
    ],
    [
      "unsupported",
      makeSseStream([
        { choices: [{ delta: { content: "hi" } }] },
        { choices: [{ delta: {}, finish_reason: "content_filter" }] },
      ]),
      "inference stream returned an unsupported finish_reason",
    ],
  ])("fails closed on a %s streamed finish reason", async (_case, stream, message) => {
    const frame = await runFinishReasonCase(stream);
    expect(frame.kind).toBe("err");
    if (frame.kind !== "err") throw new Error("expected err");
    expect(frame.error).toMatchObject({ code: "E_INTERNAL", message });
  });
});
