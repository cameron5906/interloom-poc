import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeypair } from "@interloom/keys";
import type { FrontierLinkPayload, HeartbeatResponse } from "@interloom/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsFilePath } from "../src/credentials.js";
import { FrontierService } from "../src/service.js";
import { makePlacement, makeVoucher, MockStaleLeaseError, startMockInstance, type MockInstance } from "./mockInstance.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let tmpHome: string;
let previousHome: string | undefined;
let instance: MockInstance | undefined;

const networkKeys = generateKeypair();
const agentKeys = generateKeypair();

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-mcp-service-"));
  previousHome = process.env.INTERLOOM_HOME;
  process.env.INTERLOOM_HOME = tmpHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.INTERLOOM_HOME;
  else process.env.INTERLOOM_HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  await instance?.cleanup();
  instance = undefined;
});

function credentialFor(agentId: string): FrontierLinkPayload {
  return {
    v: 1,
    kind: "frontier-agent",
    agentId,
    agentName: "Wired Agent",
    agentPrivKey: agentKeys.privateKey,
    agentPubKey: agentKeys.publicKey,
    networkUrl: "https://network.invalid",
    provider: "anthropic",
    model: "claude-sonnet-5",
  };
}

describe("FrontierService facade wiring (fake network + real tunnel round trip)", () => {
  it("link → credentials persisted → start → status online → nextWork/submit round trip", async () => {
    const agentId = "agent-wired";
    const workItemFixture = {
      workId: "work-1",
      agentId,
      channelId: "ch-1",
      channelName: "general",
      workspaceName: "Test Workspace",
      trigger: {
        id: "msg-1",
        channelId: "ch-1",
        authorId: "user-1",
        authorName: "User",
        isAgent: false,
        text: "@Wired Agent help",
        mentions: [agentId],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      recentMessages: [],
      members: [{ name: "User", isAgent: false }],
      persona: { name: "Wired Agent" },
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    };

    let beginCalled: string | undefined;
    let completeCalled: { workId: string; text: string } | undefined;

    instance = await startMockInstance(networkKeys.publicKey, {
      onPull: (pulledAgentId) => (pulledAgentId === agentId ? { items: [workItemFixture] } : { items: [] }),
      onBegin: (workId) => {
        beginCalled = workId;
        return { ok: true };
      },
      onComplete: (workId, text) => {
        completeCalled = { workId, text };
        return { ok: true, messageId: "message-42" };
      },
    });

    const cred = credentialFor(agentId);
    const voucher = makeVoucher(networkKeys, {
      agentId,
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });
    const placement = makePlacement(instance.instanceUrl, voucher);

    const heartbeatFetch = (async () => {
      const body: HeartbeatResponse = { placements: [placement] };
      return {
        ok: true,
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const service = new FrontierService({
      scanLinkFn: async () => cred,
      fetchImpl: heartbeatFetch,
      heartbeatIntervalMs: 60_000,
      queuePollMs: 60_000,
    });

    const linkResult = await service.linkWithCode("https://network.invalid/link/abc#def");
    expect(linkResult).toEqual({ agentName: "Wired Agent" });

    // Credentials persisted to disk (pinned-interfaces §E).
    const onDisk = JSON.parse(fs.readFileSync(credentialsFilePath(), "utf8")) as { agents: FrontierLinkPayload[] };
    expect(onDisk.agents.map((a) => a.agentId)).toEqual([agentId]);

    service.start();

    await waitFor(() => service.status().agents[0]?.online === true);
    const statusAfterStart = service.status();
    expect(statusAfterStart.agents).toHaveLength(1);
    expect(statusAfterStart.agents[0]?.agentId).toBe(agentId);
    expect(statusAfterStart.agents[0]?.online).toBe(true);
    expect(statusAfterStart.agents[0]?.placements).toHaveLength(1);

    const next = await service.nextWork(2000);
    expect(next?.item.workId).toBe("work-1");
    expect(next?.item.trigger.text).toContain("help");
    await waitFor(() => beginCalled === "work-1");

    const submitResult = await service.submit("work-1", "On it!");
    expect(submitResult).toEqual({ messageId: "message-42" });
    expect(completeCalled).toEqual({ workId: "work-1", text: "On it!" });

    const statusAfterSubmit = service.status();
    expect(statusAfterSubmit.agents[0]?.doneThisSession).toBe(1);

    service.stop();
  });

  it("skip() sends work.fail and clears the work location", async () => {
    const agentId = "agent-skip";
    const workItemFixture = {
      workId: "work-skip",
      agentId,
      channelId: "ch-1",
      channelName: "general",
      workspaceName: "Test Workspace",
      trigger: {
        id: "msg-1",
        channelId: "ch-1",
        authorId: "user-1",
        authorName: "User",
        isAgent: false,
        text: "hello",
        mentions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      recentMessages: [],
      members: [{ name: "User", isAgent: false }],
      persona: { name: "Skip Agent" },
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    };

    let failCalled: { workId: string; reason: string } | undefined;
    instance = await startMockInstance(networkKeys.publicKey, {
      onPull: () => ({ items: [workItemFixture] }),
      onFail: (workId, reason) => {
        failCalled = { workId, reason };
        return { ok: true };
      },
    });

    const cred = credentialFor(agentId);
    const voucher = makeVoucher(networkKeys, {
      agentId,
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });
    const placement = makePlacement(instance.instanceUrl, voucher);

    const heartbeatFetch = (async () =>
      ({ ok: true, json: async () => ({ placements: [placement] }) }) as unknown as Response) as unknown as typeof fetch;

    const service = new FrontierService({
      scanLinkFn: async () => cred,
      fetchImpl: heartbeatFetch,
      heartbeatIntervalMs: 60_000,
      queuePollMs: 60_000,
    });

    await service.linkWithCode("https://network.invalid/link/abc#def");
    service.start();
    await waitFor(() => service.status().agents[0]?.online === true);

    const next = await service.nextWork(2000);
    expect(next?.item.workId).toBe("work-skip");

    await service.skip("work-skip", "could not complete");
    expect(failCalled).toEqual({ workId: "work-skip", reason: "could not complete" });
    await expect(service.skip("work-skip", "again")).rejects.toThrow(/unknown work item/);

    service.stop();
  });

  it("submit() on a stale lease (E_STALE_LEASE) drops the local item and returns guidance instead of crashing (CONTRACTS §14)", async () => {
    const agentId = "agent-stale";
    const workItemFixture = {
      workId: "work-stale",
      agentId,
      channelId: "ch-1",
      channelName: "general",
      workspaceName: "Test Workspace",
      trigger: {
        id: "msg-1",
        channelId: "ch-1",
        authorId: "user-1",
        authorName: "User",
        isAgent: false,
        text: "hello",
        mentions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      recentMessages: [],
      members: [{ name: "User", isAgent: false }],
      persona: { name: "Stale Agent" },
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      leaseToken: "lease-original",
    };

    instance = await startMockInstance(networkKeys.publicKey, {
      onPull: () => ({ items: [workItemFixture] }),
      onComplete: () => {
        throw new MockStaleLeaseError("reassigned");
      },
    });

    const cred = credentialFor(agentId);
    const voucher = makeVoucher(networkKeys, {
      agentId,
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });
    const placement = makePlacement(instance.instanceUrl, voucher);
    const heartbeatFetch = (async () =>
      ({ ok: true, json: async () => ({ placements: [placement] }) }) as unknown as Response) as unknown as typeof fetch;

    const service = new FrontierService({
      scanLinkFn: async () => cred,
      fetchImpl: heartbeatFetch,
      heartbeatIntervalMs: 60_000,
      queuePollMs: 60_000,
    });

    await service.linkWithCode("https://network.invalid/link/abc#def");
    service.start();
    await waitFor(() => service.status().agents[0]?.online === true);

    const next = await service.nextWork(2000);
    expect(next?.item.workId).toBe("work-stale");

    await expect(service.submit("work-stale", "too late")).rejects.toThrow(/reassigned/i);

    // The local item was dropped — a second attempt reports it unknown rather than retrying.
    await expect(service.submit("work-stale", "again")).rejects.toThrow(/unknown work item/);
    expect(service.status().agents[0]?.doneThisSession).toBe(0);

    service.stop();
  });

  it("submit() on a non-stale work.complete failure (post-claim revert) surfaces the instance's requeue message instead of crashing or dropping the item (CONTRACTS §14)", async () => {
    const agentId = "agent-revert";
    const workItemFixture = {
      workId: "work-revert",
      agentId,
      channelId: "ch-1",
      channelName: "general",
      workspaceName: "Test Workspace",
      trigger: {
        id: "msg-1",
        channelId: "ch-1",
        authorId: "user-1",
        authorName: "User",
        isAgent: false,
        text: "hello",
        mentions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      recentMessages: [],
      members: [{ name: "User", isAgent: false }],
      persona: { name: "Revert Agent" },
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      leaseToken: "lease-original",
    };

    instance = await startMockInstance(networkKeys.publicKey, {
      onPull: () => ({ items: [workItemFixture] }),
      onComplete: () => {
        // Mirrors the instance's non-stale E_INTERNAL rejection when the
        // post-claim send fails and the item is reverted to queued.
        throw new Error("failed to post the agent's reply — the item was requeued for redelivery via work.pull, do not resubmit it");
      },
    });

    const cred = credentialFor(agentId);
    const voucher = makeVoucher(networkKeys, {
      agentId,
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });
    const placement = makePlacement(instance.instanceUrl, voucher);
    const heartbeatFetch = (async () =>
      ({ ok: true, json: async () => ({ placements: [placement] }) }) as unknown as Response) as unknown as typeof fetch;

    const service = new FrontierService({
      scanLinkFn: async () => cred,
      fetchImpl: heartbeatFetch,
      heartbeatIntervalMs: 60_000,
      queuePollMs: 60_000,
    });

    await service.linkWithCode("https://network.invalid/link/abc#def");
    service.start();
    await waitFor(() => service.status().agents[0]?.online === true);

    const next = await service.nextWork(2000);
    expect(next?.item.workId).toBe("work-revert");

    // Not a crash, not a silent drop — the tool caller sees the instance's
    // own requeue guidance verbatim, distinct from stale-lease guidance.
    await expect(service.submit("work-revert", "hey!")).rejects.toThrow(/requeued for redelivery/i);
    expect(service.status().agents[0]?.doneThisSession).toBe(0);

    service.stop();
  });

  it("skip() on a stale lease (E_STALE_LEASE) drops the local item and returns guidance instead of crashing (CONTRACTS §14)", async () => {
    const agentId = "agent-stale-skip";
    const workItemFixture = {
      workId: "work-stale-skip",
      agentId,
      channelId: "ch-1",
      channelName: "general",
      workspaceName: "Test Workspace",
      trigger: {
        id: "msg-1",
        channelId: "ch-1",
        authorId: "user-1",
        authorName: "User",
        isAgent: false,
        text: "hello",
        mentions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      recentMessages: [],
      members: [{ name: "User", isAgent: false }],
      persona: { name: "Stale Agent" },
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      leaseToken: "lease-original",
    };

    instance = await startMockInstance(networkKeys.publicKey, {
      onPull: () => ({ items: [workItemFixture] }),
      onFail: () => {
        throw new MockStaleLeaseError("reassigned");
      },
    });

    const cred = credentialFor(agentId);
    const voucher = makeVoucher(networkKeys, {
      agentId,
      agentPubKey: agentKeys.publicKey,
      instanceUrl: instance.instanceUrl,
    });
    const placement = makePlacement(instance.instanceUrl, voucher);
    const heartbeatFetch = (async () =>
      ({ ok: true, json: async () => ({ placements: [placement] }) }) as unknown as Response) as unknown as typeof fetch;

    const service = new FrontierService({
      scanLinkFn: async () => cred,
      fetchImpl: heartbeatFetch,
      heartbeatIntervalMs: 60_000,
      queuePollMs: 60_000,
    });

    await service.linkWithCode("https://network.invalid/link/abc#def");
    service.start();
    await waitFor(() => service.status().agents[0]?.online === true);

    const next = await service.nextWork(2000);
    expect(next?.item.workId).toBe("work-stale-skip");

    await expect(service.skip("work-stale-skip", "giving up")).rejects.toThrow(/reassigned/i);
    await expect(service.skip("work-stale-skip", "again")).rejects.toThrow(/unknown work item/);

    service.stop();
  });

  it("unlink() removes the credential and stops serving that agent", async () => {
    const agentId = "agent-unlink";
    const cred = credentialFor(agentId);
    const service = new FrontierService({
      scanLinkFn: async () => cred,
      fetchImpl: (async () => {
        throw new Error("network unreachable");
      }) as unknown as typeof fetch,
    });

    await service.linkWithCode("https://network.invalid/link/abc#def");
    expect(JSON.parse(fs.readFileSync(credentialsFilePath(), "utf8")).agents).toHaveLength(1);

    service.unlink(agentId);
    expect(JSON.parse(fs.readFileSync(credentialsFilePath(), "utf8")).agents).toHaveLength(0);
    expect(service.status().agents).toHaveLength(0);
  });
});
