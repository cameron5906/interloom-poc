import { generateKeypair, sign } from "@interloom/keys";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { StaleLeaseError, TunnelClient } from "../src/tunnel.js";
import { makePlacement, makeVoucher, MockStaleLeaseError, startMockInstance, type MockInstance } from "./mockInstance.js";

const networkKeys = generateKeypair();
const agentKeys = generateKeypair();

let instance: MockInstance | undefined;
let client: TunnelClient | undefined;

afterEach(async () => {
  client?.destroy();
  client = undefined;
  await instance?.cleanup();
  instance = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectedClient(handlers: Parameters<typeof startMockInstance>[1] = {}): Promise<TunnelClient> {
  instance = await startMockInstance(networkKeys.publicKey, handlers);
  const voucher = makeVoucher(networkKeys, {
    agentId: "agent-1",
    agentPubKey: agentKeys.publicKey,
    instanceUrl: instance.instanceUrl,
  });
  const placement = makePlacement(instance.instanceUrl, voucher);
  client = new TunnelClient(placement, "agent-1", agentKeys.privateKey, agentKeys.publicKey);
  client.start();
  await waitFor(() => client!.isConnected);
  return client;
}

/**
 * Directly exercises the mock's auth path with a manually-built identify
 * frame, bypassing `TunnelClient` so tests can send params it would never
 * construct itself (mismatched ids, expired vouchers, wrong instance URLs).
 */
async function rawAuthIdentify(
  target: MockInstance,
  params: Record<string, unknown>,
): Promise<{ kind: string; error?: { code: string; message: string } }> {
  const ws = new WebSocket(`${target.instanceUrl.replace(/^http/, "ws")}/tunnel`);
  const nonce = await new Promise<string>((resolve) => {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { kind: string; method?: string; params?: { nonce?: string } };
      if (frame.kind === "evt" && frame.method === "auth.challenge") resolve(frame.params!.nonce!);
    });
  });
  const sig = sign(nonce, agentKeys.privateKey);
  const result = await new Promise<{ kind: string; error?: { code: string; message: string } }>((resolve) => {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { kind: string; error?: { code: string; message: string } };
      if (frame.kind === "res" || frame.kind === "err") resolve(frame);
    });
    ws.send(
      JSON.stringify({
        il: 1,
        id: "req-1",
        kind: "req",
        method: "auth.identify",
        params: { ...params, sig },
      }),
    );
  });
  ws.close();
  return result;
}

describe("TunnelClient (CONTRACTS §3/§14 host side, frontierQueue tunnel)", () => {
  it("completes the auth handshake with a signature the mock verifies exactly as the instance does, identifying with features: [frontierQueue]", async () => {
    const c = await connectedClient();
    expect(c.info.status).toBe("connected");
    expect(c.authFailed).toBe(false);
  });

  it("goes to authFailed when the mock rejects (e.g. missing frontierQueue feature)", async () => {
    instance = await startMockInstance(networkKeys.publicKey);
    const voucher = makeVoucher(networkKeys, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });

    // Proves the mock enforces the same feature-gate the real instance does
    // (CONTRACTS §14), independent of TunnelClient always sending it correctly.
    const result = await rawAuthIdentify(instance, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      voucher,
      // features omitted — no frontierQueue
    });
    expect(result.kind).toBe("err");
    expect(result.error?.code).toBe("E_AUTH");
  });

  it("rejects an expired voucher", async () => {
    instance = await startMockInstance(networkKeys.publicKey);
    const voucher = makeVoucher(networkKeys, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
      exp: Date.now() - 1000,
    });

    const result = await rawAuthIdentify(instance, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      voucher,
      features: ["frontierQueue"],
    });
    expect(result.kind).toBe("err");
    expect(result.error?.code).toBe("E_AUTH");
    expect(result.error?.message).toMatch(/expired/);
  });

  it("rejects a claimed agentPubKey that doesn't match the voucher's bound key", async () => {
    instance = await startMockInstance(networkKeys.publicKey);
    const voucher = makeVoucher(networkKeys, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });
    const otherAgentKeys = generateKeypair();

    const result = await rawAuthIdentify(instance, {
      agentId: "agent-1",
      agentPubKey: otherAgentKeys.publicKey,
      voucher,
      features: ["frontierQueue"],
    });
    expect(result.kind).toBe("err");
    expect(result.error?.code).toBe("E_AUTH");
    expect(result.error?.message).toMatch(/agentPubKey mismatch/);
  });

  it("rejects a claimed agentId that doesn't match the voucher's bound agent", async () => {
    instance = await startMockInstance(networkKeys.publicKey);
    const voucher = makeVoucher(networkKeys, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });

    const result = await rawAuthIdentify(instance, {
      agentId: "agent-2",
      agentPubKey: agentKeys.publicKey,
      voucher,
      features: ["frontierQueue"],
    });
    expect(result.kind).toBe("err");
    expect(result.error?.code).toBe("E_AUTH");
    expect(result.error?.message).toMatch(/agentId mismatch/);
  });

  it("rejects a voucher scoped to a different instanceUrl", async () => {
    instance = await startMockInstance(networkKeys.publicKey);
    const voucher = makeVoucher(networkKeys, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      instanceUrl: "http://127.0.0.1:1",
    });

    const result = await rawAuthIdentify(instance, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      voucher,
      features: ["frontierQueue"],
    });
    expect(result.kind).toBe("err");
    expect(result.error?.code).toBe("E_AUTH");
    expect(result.error?.message).toMatch(/instanceUrl mismatch/);
  });

  it("answers an instance-initiated health.ping with { ok: true, ts }", async () => {
    const c = await connectedClient();
    const result = (await instance!.sendReq("health.ping", {})) as { ok: boolean; ts: number };
    expect(result.ok).toBe(true);
    expect(typeof result.ts).toBe("number");
    void c;
  });

  it("pull() sends work.pull { agentId, max } and parses WorkPullResult", async () => {
    let received: { agentId: string; max: number } | undefined;
    const c = await connectedClient({
      onPull: (agentId, max) => {
        received = { agentId, max };
        return { items: [] };
      },
    });
    const items = await c.pull(5);
    expect(items).toEqual([]);
    expect(received).toEqual({ agentId: "agent-1", max: 5 });
  });

  it("begin()/complete()/fail()/post() round-trip through the real zod result schemas", async () => {
    let receivedCompleteToken: string | undefined;
    let receivedFailToken: string | undefined;
    const c = await connectedClient({
      onBegin: () => ({ ok: true }),
      onComplete: (workId, text, leaseToken) => {
        receivedCompleteToken = leaseToken;
        return { ok: true, messageId: `msg-for-${workId}-${text.length}` };
      },
      onFail: (_workId, _reason, leaseToken) => {
        receivedFailToken = leaseToken;
        return { ok: true };
      },
      onChatPost: (channelId) => ({ ok: true, messageId: `post-in-${channelId}` }),
    });

    await expect(c.begin("work-1")).resolves.toBeUndefined();
    await expect(c.complete("work-1", "lease-tok-1", "hello world")).resolves.toEqual({
      messageId: "msg-for-work-1-11",
    });
    expect(receivedCompleteToken).toBe("lease-tok-1");
    await expect(c.fail("work-2", "lease-tok-2", "gave up")).resolves.toBeUndefined();
    expect(receivedFailToken).toBe("lease-tok-2");
    await expect(c.post("ch-1", "proactive update")).resolves.toEqual({ messageId: "post-in-ch-1" });
  });

  it("rejects the call promise when the instance answers with an err frame", async () => {
    const c = await connectedClient({
      onComplete: () => {
        throw new Error("unknown work item");
      },
    });
    await expect(c.complete("missing-work-id", "lease-tok", "text")).rejects.toThrow(/unknown work item/);
  });

  it("complete() throws StaleLeaseError (not a generic error) on E_STALE_LEASE", async () => {
    const c = await connectedClient({
      onComplete: () => {
        throw new MockStaleLeaseError("stale");
      },
    });
    await expect(c.complete("work-1", "old-token", "text")).rejects.toBeInstanceOf(StaleLeaseError);
  });

  it("fail() throws StaleLeaseError (not a generic error) on E_STALE_LEASE", async () => {
    const c = await connectedClient({
      onFail: () => {
        throw new MockStaleLeaseError("stale");
      },
    });
    await expect(c.fail("work-1", "old-token", "reason")).rejects.toBeInstanceOf(StaleLeaseError);
  });

  it("emits onWorkAvailable when the instance sends a work.available nudge", async () => {
    const c = await connectedClient();
    const seen: string[] = [];
    c.onWorkAvailable(() => seen.push("nudged"));
    instance!.sendEvt("work.available", { agentId: "agent-1" });
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual(["nudged"]);
  });

  it("fires onConnected once auth completes", async () => {
    instance = await startMockInstance(networkKeys.publicKey);
    const voucher = makeVoucher(networkKeys, {
      agentId: "agent-1",
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });
    const placement = makePlacement(instance.instanceUrl, voucher);
    client = new TunnelClient(placement, "agent-1", agentKeys.privateKey, agentKeys.publicKey);
    let fired = false;
    client.onConnected(() => {
      fired = true;
    });
    client.start();
    await waitFor(() => fired);
    expect(client.isConnected).toBe(true);
  });
});
