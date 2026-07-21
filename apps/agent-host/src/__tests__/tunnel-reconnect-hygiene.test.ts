import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeypair, signEnvelope } from "@interloom/keys";
import { makeEvt, makeRes } from "@interloom/protocol";

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

const { FakeWebSocket, instances } = vi.hoisted(() => {
  const instances: InstanceType<typeof FakeWebSocket>[] = [];
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    url: string;
    sent: string[] = [];
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      // Mirror real `ws` readyState transitions so `send()`'s OPEN check behaves.
      if (event === "open") this.readyState = FakeWebSocket.OPEN;
      if (event === "close") this.readyState = FakeWebSocket.CLOSED;
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  return { FakeWebSocket, instances };
});

vi.mock("ws", () => ({ default: FakeWebSocket }));

function makePlacement(agentPubKey: string, networkKp: { privateKey: string; publicKey: string }) {
  const voucherPayload = {
    v: 1 as const,
    placementId: "p1",
    agentId: "a1",
    agentPubKey,
    instanceUrl: "http://localhost:9999",
    instanceName: "test-instance",
    iat: Date.now(),
    exp: Date.now() + 86_400_000,
    nonce: crypto.randomUUID(),
  };
  const voucher = signEnvelope(voucherPayload, networkKp.privateKey, networkKp.publicKey);
  return {
    placementId: "p1",
    instanceUrl: "http://localhost:9999",
    instanceName: "test-instance",
    voucher,
    revoked: false,
  };
}

describe("TunnelClient reconnect hygiene", () => {
  const networkKp = generateKeypair();
  const agentKp = generateKeypair();

  beforeEach(() => {
    instances.length = 0;
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules exactly one reconnect when a failed socket emits both error and close", async () => {
    const { TunnelClient } = await import("../tunnel/client.js");
    const placement = makePlacement(agentKp.publicKey, networkKp);
    const client = new TunnelClient(placement, "TestAgent", agentKp.privateKey, agentKp.publicKey);
    client.start();

    expect(instances).toHaveLength(1);
    const socketA = instances[0]!;

    socketA.emit("error", new Error("connect failed"));
    socketA.emit("close");

    // Advance well past the max possible (jittered) backoff delay for a single
    // reconnect cycle — if more than one reconnect were scheduled, this would
    // create more than one additional socket.
    await vi.advanceTimersByTimeAsync(5000);

    expect(instances).toHaveLength(2);

    client.destroy();
  });

  it("ignores a stale socket's close after a newer socket has replaced it", async () => {
    const { TunnelClient } = await import("../tunnel/client.js");
    const placement = makePlacement(agentKp.publicKey, networkKp);
    const client = new TunnelClient(placement, "TestAgent", agentKp.privateKey, agentKp.publicKey);
    client.start();

    const socketA = instances[0]!;
    socketA.emit("close");
    await vi.advanceTimersByTimeAsync(5000);
    expect(instances).toHaveLength(2);
    const socketB = instances[1]!;

    const statusBeforeStaleClose = client.info.status;

    // socketA is stale — its close handler firing again must be a no-op.
    socketA.emit("close");

    expect(client.info.status).toBe(statusBeforeStaleClose);
    await vi.advanceTimersByTimeAsync(5000);
    // No extra reconnect from the stale event.
    expect(instances).toHaveLength(2);

    // socketB is still the live socket — its own close still reconnects normally.
    socketB.emit("close");
    await vi.advanceTimersByTimeAsync(5000);
    expect(instances).toHaveLength(3);

    client.destroy();
  });

  it("grows backoff across repeated pre-auth failures and resets only after auth succeeds", async () => {
    const { TunnelClient } = await import("../tunnel/client.js");
    const placement = makePlacement(agentKp.publicKey, networkKp);
    const client = new TunnelClient(placement, "TestAgent", agentKp.privateKey, agentKp.publicKey);
    client.start();

    const socketA = instances[0]!;
    socketA.emit("open");
    socketA.emit("close");

    // backoffMs was 1000 at schedule time (jitter stubbed to 0).
    await vi.advanceTimersByTimeAsync(999);
    expect(instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(2);

    const socketB = instances[1]!;
    socketB.emit("open");
    socketB.emit("close");

    // backoffMs should now be 2000 — NOT reset back to 1000 by socketB's "open".
    await vi.advanceTimersByTimeAsync(1999);
    expect(instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(3);

    const socketC = instances[2]!;
    socketC.emit("open");

    // Complete the auth handshake on socketC.
    const challenge = {
      challengeId: crypto.randomUUID(),
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
      issuedAt: Date.now(),
    };
    socketC.emit("message", JSON.stringify(makeEvt("auth.challenge.v2", challenge)));
    await vi.advanceTimersByTimeAsync(0);

    const identifyFrame = socketC.sent
      .map((raw) => JSON.parse(raw))
      .find((f) => f.kind === "req" && f.method === "auth.identify.v2");
    expect(identifyFrame).toBeDefined();

    socketC.emit(
      "message",
      JSON.stringify(makeRes(identifyFrame.id, { ok: true, ctx: identifyFrame.params.ctx })),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(client.info.status).toBe("connected");

    // Now fail again — backoff must have reset to 1000 by the successful auth,
    // not still be at 4000 from the pre-auth failure chain.
    socketC.emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(4);

    client.destroy();
  });
});
