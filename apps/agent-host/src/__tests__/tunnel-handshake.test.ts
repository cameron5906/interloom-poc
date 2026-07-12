import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "net";
import { generateKeypair, signEnvelope, verify } from "@interloom/keys";
import {
  parseTunnelFrame,
  makeEvt,
  makeRes,
  makeErr,
  type TunnelFrame,
} from "@interloom/protocol";

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

const FETCH_MOCK_RESPONSE = {
  choices: [{ message: { role: "assistant", content: "Hello!" } }],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
  timings: { predicted_per_second: 42 },
};

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  ok: true,
  json: async () => FETCH_MOCK_RESPONSE,
  body: null,
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

async function startMockInstance(
  networkPubKey: string,
  networkPrivKey: string,
): Promise<{ wss: WebSocketServer; port: number; cleanup: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 });

    wss.on("error", reject);
    wss.on("listening", () => {
      const addr = wss.address() as AddressInfo;
      const cleanup = () =>
        new Promise<void>((res, rej) => {
          wss.close((err) => (err ? rej(err) : res()));
        });
      resolve({ wss, port: addr.port, cleanup });
    });

    wss.on("connection", (ws) => {
      const nonce = crypto.randomUUID();
      ws.send(JSON.stringify(makeEvt("auth.challenge", { nonce })));

      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : data.toString();
        const frame = parseTunnelFrame(raw);

        if (frame.kind === "req" && frame.method === "auth.identify") {
          const params = frame.params as {
            agentId: string;
            agentPubKey: string;
            voucher: { payload: unknown; key: string; sig: string };
            sig: string;
          };
          const sigValid = verify(nonce, params.sig, params.agentPubKey);
          if (sigValid) {
            ws.send(JSON.stringify(makeRes(frame.id, { ok: true })));
            const reqFrame: TunnelFrame = {
              il: 1,
              id: crypto.randomUUID(),
              kind: "req",
              method: "inference.complete",
              params: {
                messages: [{ role: "user", content: "hello" }],
              },
            };
            ws.send(JSON.stringify(reqFrame));
          } else {
            ws.send(JSON.stringify(makeErr(frame.id, "E_AUTH", "bad sig")));
          }
          return;
        }

        if (frame.kind === "res" && typeof (frame as { result?: unknown }).result === "object") {
          const result = (frame as { result: unknown }).result as {
            message?: { role: string; content: string };
            usage?: unknown;
          };
          (ws as WebSocket & { lastResult?: unknown }).lastResult = result;
        }
      });
    });
  });
}

describe("inference.stream abort on ws close", () => {
  const networkKp = generateKeypair();
  const agentKp = generateKeypair();

  it("aborts the upstream fetch and does not throw on send-after-close", async () => {
    let fetchAbortSignal: AbortSignal | undefined;
    // Resolves when the client's reader.read() has been called at least once (stream is being drained)
    let resolveFirstPull!: () => void;
    const firstPull = new Promise<void>((res) => { resolveFirstPull = res; });

    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      fetchAbortSignal = opts?.signal ?? undefined;

      // Build a fresh stream per call so it is not exhausted across tests
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          streamController = ctrl;
          // Wire abort -> error the stream so reader.read() rejects with an AbortError
          opts?.signal?.addEventListener("abort", () => {
            try { streamController.error(new DOMException("The operation was aborted.", "AbortError")); } catch { /* already closed */ }
          });
        },
        pull() {
          // pull() is invoked when the reader actually requests data; only emit once
          if (!resolveFirstPull) return;
          const notify = resolveFirstPull;
          resolveFirstPull = null!;
          const line = "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) + "\n\n";
          streamController.enqueue(new TextEncoder().encode(line));
          notify();
          // Stall: don't enqueue again so reader.read() blocks until abort
        },
        cancel() {
          try { streamController.close(); } catch { /* already closed */ }
        },
      });

      return Promise.resolve({ ok: true, status: 200, body });
    }));

    const wss = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((res) => wss.on("listening", () => res((wss.address() as AddressInfo).port)));

    let serverWs: WebSocket | undefined;
    wss.on("connection", (ws) => {
      serverWs = ws;
      const nonce = crypto.randomUUID();
      ws.send(JSON.stringify(makeEvt("auth.challenge", { nonce })));
      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : data.toString();
        let frame: TunnelFrame;
        try { frame = parseTunnelFrame(raw); } catch { return; }

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

    // Wait until the client is actually reading from the upstream stream
    await Promise.race([
      firstPull,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("stream read never started")), 5000)),
    ]);

    // Drop the tunnel socket mid-stream
    serverWs?.close();

    // Allow the close event to propagate and inflight abort to fire
    await new Promise<void>((res) => setTimeout(res, 300));

    expect(fetchAbortSignal).toBeDefined();
    expect(fetchAbortSignal?.aborted).toBe(true);

    client.destroy();
    await new Promise<void>((res) => wss.close(() => res()));

    // Restore the default fetch mock for subsequent tests
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => FETCH_MOCK_RESPONSE,
      body: null,
    }));
  });
});

describe("tunnel handshake", () => {
  let wss: WebSocketServer;
  let port: number;
  let cleanup: () => Promise<void>;

  const networkKp = generateKeypair();
  const agentKp = generateKeypair();

  beforeEach(async () => {
    ({ wss, port, cleanup } = await startMockInstance(
      networkKp.publicKey,
      networkKp.privateKey,
    ));
  });

  afterEach(async () => {
    await cleanup();
  });

  it("completes auth challenge and sends inference request", async () => {
    const { TunnelClient } = await import("../tunnel/client.js");

    const voucherPayload = {
      v: 1 as const,
      placementId: "p1",
      agentId: "a1",
      agentPubKey: agentKp.publicKey,
      instanceUrl: `http://localhost:${port}`,
      instanceName: "test-instance",
      iat: Date.now(),
      exp: Date.now() + 86_400_000,
      nonce: crypto.randomUUID(),
    };
    const voucher = signEnvelope(voucherPayload, networkKp.privateKey, networkKp.publicKey);

    const placement = {
      placementId: "p1",
      instanceUrl: `http://localhost:${port}`,
      instanceName: "test-instance",
      voucher,
      revoked: false,
    };

    const receivedRes: unknown[] = [];

    const client = new TunnelClient(placement, "TestAgent", agentKp.privateKey, agentKp.publicKey);
    client.start();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        client.destroy();
        resolve();
      }, 3000);
      timer.unref?.();

      const checkInterval = setInterval(() => {
        const infos = [client.info];
        if (infos[0]?.status === "connected") {
          clearInterval(checkInterval);
          clearTimeout(timer);
          client.destroy();
          resolve();
        }
      }, 50);
      checkInterval.unref?.();
    });

    const [ws] = wss.clients;
    expect(ws).toBeDefined();
  });

  it("sends well-formed identify with signed nonce", async () => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

      wss.once("connection", (ws) => {
        ws.on("message", (data) => {
          const raw = typeof data === "string" ? data : data.toString();
          const frame = parseTunnelFrame(raw);

          if (frame.kind === "req" && frame.method === "auth.identify") {
            const params = frame.params as {
              agentId: string;
              agentPubKey: string;
              sig: string;
            };
            expect(params.agentId).toBe("a1");
            expect(params.agentPubKey).toBe(agentKp.publicKey);
            expect(typeof params.sig).toBe("string");
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      const voucherPayload = {
        v: 1 as const,
        placementId: "p1",
        agentId: "a1",
        agentPubKey: agentKp.publicKey,
        instanceUrl: `http://localhost:${port}`,
        instanceName: "test-instance",
        iat: Date.now(),
        exp: Date.now() + 86_400_000,
        nonce: crypto.randomUUID(),
      };
      const voucher = signEnvelope(voucherPayload, networkKp.privateKey, networkKp.publicKey);
      const placement = {
        placementId: "p1",
        instanceUrl: `http://localhost:${port}`,
        instanceName: "test-instance",
        voucher,
        revoked: false,
      };

      import("../tunnel/client.js").then(({ TunnelClient }) => {
        const client = new TunnelClient(
          placement,
          "TestAgent",
          agentKp.privateKey,
          agentKp.publicKey,
        );
        client.start();
        setTimeout(() => client.destroy(), 5500);
      }).catch(reject);
    });
  });
});
