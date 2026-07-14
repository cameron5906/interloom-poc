/**
 * Tests the watchdog-vs-close distinction on the inference.stream path
 * (tunnel/client.ts handleInferenceStream). A watchdog timeout (gate.ts
 * RUN_TIMEOUT_MS) aborts the run's signal but the WS tunnel itself stays
 * open — the client must still send a terminal `err` frame (mirroring the
 * complete path's timeout handling) instead of silently dropping the
 * request the way a real WS close would.
 */

import { describe, it, expect, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "net";
import { generateKeypair, signEnvelope, verify } from "@interloom/keys";
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

// Simulate the gate's watchdog: abort the run's signal shortly after it
// starts WITHOUT closing anything — this is the scenario the real
// InstanceGate.runWithTimeout produces on RUN_TIMEOUT_MS (CONTRACTS-adjacent
// gate.ts docstring: "On watchdog fire the gate ABORTS the run via the
// AbortSignal passed into run()").
vi.mock("../inference/gate.js", () => ({
  enqueueInference: async (
    _port: number,
    _lane: string,
    run: (signal: AbortSignal) => Promise<void>,
  ) => {
    const ac = new AbortController();
    const runPromise = run(ac.signal);
    setTimeout(() => ac.abort(), 50);
    return runPromise;
  },
  getServingLane: () => null,
  getQueueDepth: () => 0,
  drainLane: vi.fn(),
}));

function makePlacement(port: number, agentPubKey: string, networkKp: { privateKey: string; publicKey: string }) {
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

describe("inference.stream watchdog abort (WS stays open)", () => {
  it("sends a terminal E_INTERNAL err frame instead of silently dropping the request", async () => {
    let resolveFirstPull!: () => void;
    const firstPull = new Promise<void>((res) => { resolveFirstPull = res; });

    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          streamController = ctrl;
          opts?.signal?.addEventListener("abort", () => {
            try { streamController.error(new DOMException("The operation was aborted.", "AbortError")); } catch { /* already closed */ }
          });
        },
        pull() {
          if (!resolveFirstPull) return;
          const notify = resolveFirstPull;
          resolveFirstPull = null!;
          const line = "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) + "\n\n";
          streamController.enqueue(new TextEncoder().encode(line));
          notify();
          // Stall: no further chunks — the client's reader.read() blocks
          // until the watchdog aborts the combined signal.
        },
        cancel() {
          try { streamController.close(); } catch { /* already closed */ }
        },
      });
      return Promise.resolve({ ok: true, status: 200, body });
    }));

    const networkKp = generateKeypair();
    const agentKp = generateKeypair();

    const wss = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((res) => wss.on("listening", () => res((wss.address() as AddressInfo).port)));

    const receivedFrames: TunnelFrame[] = [];
    let serverWs: WebSocket | undefined;

    wss.on("connection", (ws) => {
      serverWs = ws;
      const nonce = crypto.randomUUID();
      ws.send(JSON.stringify(makeEvt("auth.challenge", { nonce })));
      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : data.toString();
        let frame: TunnelFrame;
        try { frame = parseTunnelFrame(raw); } catch { return; }
        receivedFrames.push(frame);

        if (frame.kind === "req" && frame.method === "auth.identify") {
          const params = frame.params as { agentPubKey: string; sig: string };
          if (verify(nonce, params.sig, params.agentPubKey)) {
            ws.send(JSON.stringify(makeRes(frame.id, { ok: true })));
            ws.send(JSON.stringify({
              il: 1,
              id: "stream-req-1",
              kind: "req",
              method: "inference.stream",
              params: { messages: [{ role: "user", content: "hello" }] },
            }));
          }
        }
      });
    });

    const { TunnelClient } = await import("../tunnel/client.js");
    const placement = makePlacement(port, agentKp.publicKey, networkKp);
    const client = new TunnelClient(placement, "TestAgent", agentKp.privateKey, agentKp.publicKey);
    client.start();

    await Promise.race([
      firstPull,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("stream read never started")), 5000)),
    ]);

    // Wait past the mocked 50ms watchdog fire, plus slack for the frame to arrive.
    await new Promise<void>((res) => setTimeout(res, 400));

    const errFrame = receivedFrames.find(
      (f) => f.kind === "err" && (f as Extract<TunnelFrame, { kind: "err" }>).id === "stream-req-1",
    ) as Extract<TunnelFrame, { kind: "err" }> | undefined;

    expect(errFrame).toBeDefined();
    expect(errFrame?.error.code).toBe("E_INTERNAL");
    expect(errFrame?.error.message).toBe("inference run timed out");

    // The tunnel itself was never closed by the watchdog — only a real WS
    // close should produce silence.
    expect(serverWs?.readyState).toBe(WebSocket.OPEN);

    client.destroy();
    await new Promise<void>((res) => wss.close(() => res()));
  });
});
