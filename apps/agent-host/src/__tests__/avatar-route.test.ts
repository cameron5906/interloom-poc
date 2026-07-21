/**
 * Tests for POST /api/agents/:id/avatar (CONTRACTS §6 "Agent avatar upload"):
 * - 404 unknown agent
 * - 400 bad_image (malformed data URL)
 * - 400 image_too_large (decoded bytes > 512 KB)
 * - 502 network_unreachable (upload call fails)
 * - success stores imageUrl and re-registers when already registered
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

vi.mock("../keys.js", () => ({
  getKeypair: () => ({ privateKey: "priv", publicKey: "PUBKEY" }),
  loadOrCreateKeypair: vi.fn(),
  registerKeysRoutes: vi.fn(),
}));

// Re-registration is only reachable after the Host has been bound to an
// operator identity. The unbound gate has its own focused test suite.
vi.mock("../operatorBind.js", () => ({
  getOperatorBinding: () => ({
    identityKey: "operator-pub",
    displayName: "Test Operator",
    grant: {
      payload: {
        v: 1,
        identityKey: "operator-pub",
        subjectKey: "PUBKEY",
        scope: "host-operator",
        issuedAt: 1,
        epoch: 0,
        nonce: "test-nonce",
      },
      key: "operator-pub",
      sig: "mocksig",
    },
    boundAt: "2026-01-01T00:00:00.000Z",
  }),
  setOperatorGrantStale: vi.fn(),
}));

vi.mock("@interloom/keys", () => ({
  signEnvelope: (payload: unknown, _priv: string, key: string) => ({
    payload,
    key,
    sig: "mocksig",
  }),
  sign: vi.fn().mockReturnValue("mocksig"),
  verify: vi.fn().mockReturnValue(true),
}));

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

let uploadResult: { sha: string; url: string } | Error = {
  sha: "abc",
  url: "https://net.example/assets/av/abc.png",
};
let registerSpy: ReturnType<typeof vi.fn>;

vi.mock("../network/client.js", () => ({
  NetworkApiError: class NetworkApiError extends Error {
    status = 500;
    body = "";
  },
  networkUploadAvatar: async () => {
    if (uploadResult instanceof Error) throw uploadResult;
    return uploadResult;
  },
  networkRegisterAgent: (...args: unknown[]) => registerSpy(...args),
}));

vi.mock("../models/scan.js", () => ({
  capabilitiesForFilename: () => undefined,
}));

// 1x1 transparent PNG, well under the 512 KB cap.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("POST /api/agents/:id/avatar", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAgents = new Map();
    uploadResult = { sha: "abc", url: "https://net.example/assets/av/abc.png" };
    registerSpy = vi.fn().mockResolvedValue(undefined);

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

  it("404s for an unknown agent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/nope/avatar",
      payload: { dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 bad_image for a malformed data URL", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#fff" },
      persona: "helpful",
      capabilityBlurb: "does stuff",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/avatar",
      payload: { dataUrl: "not-a-data-url" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "bad_image" });
  });

  it("400 bad_image for an unsupported content type", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#fff" },
      persona: "helpful",
      capabilityBlurb: "does stuff",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/avatar",
      payload: { dataUrl: `data:image/gif;base64,${TINY_PNG_B64}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "bad_image" });
  });

  it("400 image_too_large when decoded bytes exceed 512 KB", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#fff" },
      persona: "helpful",
      capabilityBlurb: "does stuff",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
    });

    const bigBytes = Buffer.alloc(600 * 1024, 1);
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/avatar",
      payload: { dataUrl: `data:image/png;base64,${bigBytes.toString("base64")}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "image_too_large" });
  });

  it("502 network_unreachable when the network upload call fails", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#fff" },
      persona: "helpful",
      capabilityBlurb: "does stuff",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
    });
    uploadResult = new Error("network down");

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/avatar",
      payload: { dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: "network_unreachable" });
    expect(mockAgents.get("a1")).toMatchObject({ avatar: { emoji: "🤖", bg: "#fff" } });
  });

  it("stores the returned imageUrl and does not re-register an unregistered agent", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#fff" },
      persona: "helpful",
      capabilityBlurb: "does stuff",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/avatar",
      payload: { dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ imageUrl: "https://net.example/assets/av/abc.png" });
    expect((mockAgents.get("a1") as { avatar: { imageUrl?: string } }).avatar.imageUrl).toBe(
      "https://net.example/assets/av/abc.png",
    );
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("re-registers an already-registered agent after a successful upload", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#fff" },
      persona: "helpful",
      capabilityBlurb: "does stuff",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: true,
      model: { filename: "qwen.gguf", displayName: "Qwen" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/avatar",
      payload: { dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    });
    expect(res.statusCode).toBe(200);
    expect(registerSpy).toHaveBeenCalledOnce();
    const updated = mockAgents.get("a1") as { syncedAt?: string };
    expect(updated.syncedAt).toBeDefined();
  });

  it("does not save a registered agent's imageUrl when re-registration fails", async () => {
    mockAgents.set("a1", {
      agentId: "a1",
      name: "Ada",
      avatar: { emoji: "🤖", bg: "#fff" },
      persona: "helpful",
      capabilityBlurb: "does stuff",
      params: { temperature: 0.7, contextLength: 4096 },
      registered: true,
      syncedAt: "2026-01-01T00:00:00.000Z",
      model: { filename: "qwen.gguf", displayName: "Qwen" },
    });
    registerSpy.mockRejectedValueOnce(new Error("network down"));

    const res = await app.inject({
      method: "POST",
      url: "/api/agents/a1/avatar",
      payload: { dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "network_unreachable" });
    expect(mockAgents.get("a1")).toMatchObject({
      avatar: { emoji: "🤖", bg: "#fff" },
      syncedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
