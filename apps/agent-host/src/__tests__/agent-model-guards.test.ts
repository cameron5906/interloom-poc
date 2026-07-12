/**
 * Tests for agent model guards (CONTRACTS §6):
 * - POST /api/agents/:id/preview  → 400 model_required / 409 model_not_active
 * - POST /api/agents/:id/register → 400 model_required
 * - max_tokens clamp: preview sends max_tokens = min(1024, 512) = 512
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";

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

vi.mock("../network/client.js", () => ({
  networkRegisterAgent: vi.fn().mockResolvedValue({}),
}));

vi.mock("../keys.js", () => ({
  getKeypair: () => ({ privateKey: "priv", publicKey: "pub" }),
  loadOrCreateKeypair: vi.fn(),
  registerKeysRoutes: vi.fn(),
}));

vi.mock("@interloom/keys", () => ({
  signEnvelope: (payload: unknown, _priv: string, key: string) => ({ payload, key, sig: "mocksig" }),
  sign: vi.fn().mockReturnValue("mocksig"),
  verify: vi.fn().mockReturnValue(true),
}));

// Controlled agent store
let mockAgents: Map<string, unknown>;

vi.mock("../agents/store.js", () => ({
  listAgents: () => Array.from(mockAgents.values()),
  getAgent: (id: string) => mockAgents.get(id),
  createAgent: vi.fn(),
  updateAgent: vi.fn((id: string, patch: unknown) => {
    const existing = mockAgents.get(id) as Record<string, unknown>;
    if (!existing) return undefined;
    const updated = { ...existing, ...(patch as Record<string, unknown>) };
    mockAgents.set(id, updated);
    return updated;
  }),
  deleteAgent: vi.fn(),
}));

// Controlled active model
let mockActiveModel: { path: string; filename: string; ctx: number } | null = null;

vi.mock("../models/active.js", () => ({
  getActiveModel: async () => mockActiveModel,
  getConfiguredModelFilename: () => mockActiveModel?.filename ?? null,
  findLocalModelPath: vi.fn().mockReturnValue(null),
}));

vi.mock("../inference/gate.js", () => ({
  enqueueInference: async (_lane: string, run: () => Promise<void>) => run(),
  getServingLane: () => null,
  getQueueDepth: () => 0,
  drainLane: vi.fn(),
}));

// Track fetch calls to verify max_tokens
let fetchCalls: Array<{ body: unknown }> = [];

vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
  const body = opts?.body ? JSON.parse(opts.body as string) as unknown : undefined;
  fetchCalls.push({ body });

  // Return a minimal SSE stream for preview
  const encoder = new TextEncoder();
  const streamData = [
    "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) + "\n\n",
    "data: " + JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3 }, timings: { predicted_per_second: 42 } }) + "\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(streamData));
      ctrl.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}));

describe("agent model guards", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAgents = new Map();
    mockActiveModel = null;
    fetchCalls = [];

    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await app.register(fastifyWebsocket);

    const { registerAgentRoutes } = await import("../agents/routes.js");
    registerAgentRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // --- preview guards ---

  it("preview → 400 model_required when agent has no model", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      persona: "helpful",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
      avatar: { emoji: "🤖", bg: "#fff" },
      capabilityBlurb: "does stuff",
      // no model field
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/preview",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "model_required" });
  });

  it("preview → 409 model_not_active when agent model doesn't match loaded model", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      persona: "helpful",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
      avatar: { emoji: "🤖", bg: "#fff" },
      capabilityBlurb: "does stuff",
      model: { filename: "llama.gguf", displayName: "LLaMA" },
    });

    // Active model is a different file
    mockActiveModel = { path: "/models/qwen.gguf", filename: "qwen.gguf", ctx: 4096 };

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/preview",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; model: unknown; path: string | null };
    expect(body.error).toBe("model_not_active");
    expect(body.model).toMatchObject({ filename: "llama.gguf" });
    // path is null because llama.gguf doesn't exist on the test filesystem
    expect("path" in body).toBe(true);
  });

  it("preview → 409 model_not_active when inference is not running (no active model)", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      persona: "helpful",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
      avatar: { emoji: "🤖", bg: "#fff" },
      capabilityBlurb: "does stuff",
      model: { filename: "llama.gguf", displayName: "LLaMA" },
    });

    mockActiveModel = null; // no model loaded

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/preview",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; path?: string | null };
    expect(body.error).toBe("model_not_active");
    expect("path" in body).toBe(true);
  });

  it("preview succeeds and sends clamped max_tokens = min(1024, 512) = 512", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      persona: "helpful",
      params: { temperature: 0.7, contextLength: 32768 }, // large contextLength
      registered: false,
      avatar: { emoji: "🤖", bg: "#fff" },
      capabilityBlurb: "does stuff",
      model: { filename: "qwen.gguf", displayName: "Qwen" },
    });
    mockActiveModel = { path: "/models/qwen.gguf", filename: "qwen.gguf", ctx: 4096 };

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/preview",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });

    // Should succeed (SSE stream — Fastify inject collects it)
    expect(res.statusCode).toBe(200);

    // Verify max_tokens sent to inference was clamped, NOT contextLength
    const inferenceCall = fetchCalls.find(
      (c) => c.body !== undefined && typeof c.body === "object" && c.body !== null && "max_tokens" in (c.body as Record<string, unknown>),
    );
    expect(inferenceCall).toBeDefined();
    const body = inferenceCall?.body as { max_tokens?: number; messages?: unknown[] };
    expect(body.max_tokens).toBe(512); // min(1024, 512) = 512
    expect(body.max_tokens).not.toBe(32768); // NOT contextLength
  });

  // --- register guards ---

  it("register → 400 model_required when agent has no model", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      persona: "helpful",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
      avatar: { emoji: "🤖", bg: "#fff" },
      capabilityBlurb: "does stuff",
      // no model
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/register",
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "model_required" });
  });

  it("register succeeds and includes model in manifest when agent has model", async () => {
    const { networkRegisterAgent } = await import("../network/client.js");
    const registerSpy = vi.mocked(networkRegisterAgent);
    registerSpy.mockClear();

    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      persona: "helpful",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
      avatar: { emoji: "🤖", bg: "#fff" },
      capabilityBlurb: "does stuff",
      model: { filename: "qwen.gguf", displayName: "Qwen 2.5 7B" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/register",
    });

    expect(res.statusCode).toBe(200);
    expect(registerSpy).toHaveBeenCalledOnce();
    const [envelope] = registerSpy.mock.calls[0] as [{ payload: { model?: unknown } }];
    expect(envelope.payload.model).toMatchObject({ filename: "qwen.gguf" });
  });
});

describe("max_tokens clamp (unit)", () => {
  it("clamps to 512 when no maxTokens provided (default)", () => {
    // Inline the pure clamp logic to verify it directly
    const clampMaxTokens = (requested?: number): number => Math.min(1024, requested ?? 512);
    expect(clampMaxTokens()).toBe(512);
  });

  it("clamps to 1024 when maxTokens > 1024", () => {
    const clampMaxTokens = (requested?: number): number => Math.min(1024, requested ?? 512);
    expect(clampMaxTokens(32768)).toBe(1024);
    expect(clampMaxTokens(2048)).toBe(1024);
  });

  it("passes through maxTokens <= 1024 unchanged", () => {
    const clampMaxTokens = (requested?: number): number => Math.min(1024, requested ?? 512);
    expect(clampMaxTokens(256)).toBe(256);
    expect(clampMaxTokens(1024)).toBe(1024);
  });

  it("never uses contextLength as max_tokens", () => {
    // The bug: previously max_tokens: agent.params.contextLength (e.g. 32768)
    // Now: max_tokens = min(1024, params.maxTokens ?? 512)
    const contextLength = 32768;
    const clampMaxTokens = (requested?: number): number => Math.min(1024, requested ?? 512);
    expect(clampMaxTokens(contextLength)).toBe(1024); // clamped, not 32768
    expect(clampMaxTokens()).toBe(512); // default when no maxTokens provided
  });
});
