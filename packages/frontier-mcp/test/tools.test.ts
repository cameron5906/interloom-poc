import { describe, expect, it, vi } from "vitest";
import { GUIDANCE, EXTRA_GUIDANCE } from "../src/guidance.js";
import { createToolHandlers, type FrontierServiceLike } from "../src/tools.js";

function textOf(result: { content: Array<{ type: "text"; text: string }> }, index: number): string {
  const block = result.content[index];
  if (!block) throw new Error(`missing content block ${index}`);
  return block.text;
}

function makeService(overrides: Partial<FrontierServiceLike> = {}): FrontierServiceLike {
  return {
    linkWithCode: vi.fn(async () => ({ agentName: "Test Agent" })),
    status: vi.fn(() => ({ agents: [] })),
    nextWork: vi.fn(async () => null),
    submit: vi.fn(async () => ({ messageId: "msg-1" })),
    skip: vi.fn(async () => undefined),
    post: vi.fn(async () => ({ messageId: "msg-2" })),
    unlink: vi.fn(() => undefined),
    ...overrides,
  };
}

describe("createToolHandlers", () => {
  it("interloom_link persists via the facade and returns the linked guidance", async () => {
    const service = makeService();
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_link({ code: "https://net.example/l#abc" });

    expect(service.linkWithCode).toHaveBeenCalledWith("https://net.example/l#abc");
    expect(JSON.parse(textOf(result, 0))).toEqual({ agentName: "Test Agent" });
    expect(textOf(result, 1)).toBe(GUIDANCE.linked);
  });

  it("interloom_link surfaces facade errors as an isError result instead of throwing", async () => {
    const service = makeService({
      linkWithCode: vi.fn(async () => {
        throw new Error("invalid link code");
      }),
    });
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_link({ code: "bogus" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result, 0))).toEqual({ error: "invalid link code" });
  });

  it("interloom_status reports the facade's status verbatim", async () => {
    const status = { agents: [{ agentId: "a1", agentName: "A", online: true, placements: [], queueDepth: 0, doneThisSession: 0 }] };
    const service = makeService({ status: vi.fn(() => status) });
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_status();

    expect(JSON.parse(textOf(result, 0))).toEqual(status);
    expect(textOf(result, 1)).toBe(EXTRA_GUIDANCE.status);
  });

  it("interloom_next_work returns afterWork guidance and calls work.begin via the facade when an item is available", async () => {
    const item = { workId: "w1", agentId: "a1" } as unknown;
    const service = makeService({ nextWork: vi.fn(async () => ({ item, placementRef: "p1" }) as never) });
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_next_work({ waitSeconds: 5 });

    expect(service.nextWork).toHaveBeenCalledWith(5000);
    expect(JSON.parse(textOf(result, 0))).toEqual({ item });
    expect(textOf(result, 1)).toBe(GUIDANCE.afterWork);
  });

  it("interloom_next_work returns emptyQueue guidance (never 'stop') when the queue is empty", async () => {
    const service = makeService({ nextWork: vi.fn(async () => null) });
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_next_work({});

    expect(JSON.parse(textOf(result, 0))).toEqual({ item: null });
    expect(textOf(result, 1)).toBe(GUIDANCE.emptyQueue);
  });

  it("interloom_next_work defaults waitSeconds to 25 and clamps above 60", async () => {
    const service = makeService();
    const handlers = createToolHandlers(service);

    await handlers.interloom_next_work({});
    expect(service.nextWork).toHaveBeenCalledWith(25_000);

    await handlers.interloom_next_work({ waitSeconds: 500 });
    expect(service.nextWork).toHaveBeenCalledWith(60_000);
  });

  it("interloom_submit delegates to the facade and returns afterSubmit guidance", async () => {
    const service = makeService();
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_submit({ workId: "w1", text: "done" });

    expect(service.submit).toHaveBeenCalledWith("w1", "done");
    expect(JSON.parse(textOf(result, 0))).toEqual({ messageId: "msg-1" });
    expect(textOf(result, 1)).toBe(GUIDANCE.afterSubmit);
  });

  it("interloom_skip delegates to the facade", async () => {
    const service = makeService();
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_skip({ workId: "w1", reason: "not applicable" });

    expect(service.skip).toHaveBeenCalledWith("w1", "not applicable");
    expect(JSON.parse(textOf(result, 0))).toEqual({ ok: true });
    expect(textOf(result, 1)).toBe(EXTRA_GUIDANCE.afterSkip);
  });

  it("interloom_post passes a null agentId through when omitted", async () => {
    const service = makeService();
    const handlers = createToolHandlers(service);

    await handlers.interloom_post({ channelId: "c1", text: "hi" });

    expect(service.post).toHaveBeenCalledWith(null, "c1", "hi");
  });

  it("interloom_post forwards an explicit agentId", async () => {
    const service = makeService();
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_post({ agentId: "a1", channelId: "c1", text: "hi" });

    expect(service.post).toHaveBeenCalledWith("a1", "c1", "hi");
    expect(textOf(result, 1)).toBe(EXTRA_GUIDANCE.afterPost);
  });

  it("interloom_unlink delegates to the facade", async () => {
    const service = makeService();
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_unlink({ agentId: "a1" });

    expect(service.unlink).toHaveBeenCalledWith("a1");
    expect(JSON.parse(textOf(result, 0))).toEqual({ ok: true });
    expect(textOf(result, 1)).toBe(EXTRA_GUIDANCE.afterUnlink);
  });

  it("never lets a provider API key or private key leak into a tool result", async () => {
    const service = makeService({
      status: vi.fn(() => ({ agents: [{ agentId: "a1", agentName: "A", online: true, placements: [], queueDepth: 0, doneThisSession: 0 }] })),
    });
    const handlers = createToolHandlers(service);

    const result = await handlers.interloom_status();
    const combined = result.content.map((c) => c.text).join(" ");

    expect(combined).not.toMatch(/apiKey/i);
    expect(combined).not.toMatch(/privKey/i);
  });
});
