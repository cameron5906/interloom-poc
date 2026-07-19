/**
 * Tests for the frontier agent REST surface (CONTRACTS §14):
 * - PUT/GET /api/agents/:id/frontier — masked config { provider, model,
 *   hasKey, last4 }; the raw apiKey must NEVER appear in either response.
 * - POST /api/agents/:id/frontier/link — creates a network link session
 *   (kind "frontier-agent") and returns the payload fields for the portal
 *   to encrypt as issuer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { verifyEnvelope, type SignedEnvelope } from "@interloom/keys";
import type { FrontierLinkIssuerAuth, FrontierLinkSessionAuth } from "@interloom/protocol";

const state = vi.hoisted(() => ({ dataDir: "" }));

vi.mock("../config.js", () => ({
  PORT: 7420,
  get DATA_DIR() {
    return state.dataDir;
  },
  MODELS_DIR: "./test-models",
  NETWORK_URL: "http://network.test",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

vi.mock("../keys.js", () => ({
  getKeypair: () => ({ privateKey: "host-priv", publicKey: "HOST_PUBKEY" }),
  loadOrCreateKeypair: vi.fn(),
  registerKeysRoutes: vi.fn(),
}));

vi.mock("../telemetry/collector.js", () => ({
  addRequestLogEntry: vi.fn(),
  recordTokensPerSec: vi.fn(),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RAW_API_KEY = "sk-ant-super-secret-abcd1234";

describe("frontier agent routes", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function createFrontierAgent(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Codex",
        avatar: { emoji: "🤖", bg: "#eee" },
        persona: "a careful reviewer",
        capabilityBlurb: "reviews code",
        params: { temperature: 0.7, contextLength: 8192 },
        runtime: "frontier",
      },
    });
    expect(res.statusCode).toBe(201);
    return (JSON.parse(res.body) as { agentId: string }).agentId;
  }

  beforeEach(async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-frontier-routes-"));
    fetchMock = vi.fn().mockRejectedValue(new Error("unexpected fetch in test"));
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const { registerAgentRoutes } = await import("../agents/routes.js");
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await app.register(fastifyWebsocket);
    registerAgentRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  describe("PUT /api/agents/:id/frontier", () => {
    it("404s for an unknown agent", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/agents/nope/frontier",
        payload: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("400s on an invalid body (missing provider)", async () => {
      const agentId = await createFrontierAgent();
      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { model: "claude-sonnet-5" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("saves the config and returns the masked shape — no apiKey stored", async () => {
      const agentId = await createFrontierAgent();
      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-5",
        hasKey: false,
        last4: null,
      });
    });

    it("saves an apiKey and returns hasKey/last4 without ever echoing the raw key", async () => {
      const agentId = await createFrontierAgent();
      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5", apiKey: RAW_API_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-5",
        hasKey: true,
        last4: RAW_API_KEY.slice(-4),
      });
      expect(res.body).not.toContain(RAW_API_KEY);
    });

    it("stamps runtime/frontier onto the agent record", async () => {
      const agentId = await createFrontierAgent();
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "openai", model: "gpt-5-codex" },
      });
      const getRes = await app.inject({ method: "GET", url: `/api/agents/${agentId}` });
      const agent = JSON.parse(getRes.body);
      expect(agent.runtime).toBe("frontier");
      expect(agent.frontier).toEqual({ provider: "openai", model: "gpt-5-codex" });
    });
  });

  describe("GET /api/agents/:id/frontier", () => {
    it("404s for an unknown agent", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents/nope/frontier" });
      expect(res.statusCode).toBe(404);
    });

    it("returns the unconfigured masked shape before any PUT", async () => {
      const agentId = await createFrontierAgent();
      const res = await app.inject({ method: "GET", url: `/api/agents/${agentId}/frontier` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        provider: null,
        model: null,
        hasKey: false,
        last4: null,
      });
    });

    it("reflects a previously saved config without ever including apiKey", async () => {
      const agentId = await createFrontierAgent();
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5", apiKey: RAW_API_KEY },
      });

      const res = await app.inject({ method: "GET", url: `/api/agents/${agentId}/frontier` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-5",
        hasKey: true,
        last4: RAW_API_KEY.slice(-4),
      });
      expect(res.body).not.toContain(RAW_API_KEY);
    });
  });

  describe("apiKey never leaks (negative test)", () => {
    it("never appears anywhere in PUT or GET response bodies, or in logged output", async () => {
      const consoleSpies = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "info").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
      ];

      const agentId = await createFrontierAgent();
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5", apiKey: RAW_API_KEY },
      });
      const getRes = await app.inject({ method: "GET", url: `/api/agents/${agentId}/frontier` });
      const getAllRes = await app.inject({ method: "GET", url: `/api/agents/${agentId}` });

      expect(putRes.body).not.toContain(RAW_API_KEY);
      expect(getRes.body).not.toContain(RAW_API_KEY);
      expect(getAllRes.body).not.toContain(RAW_API_KEY);

      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(RAW_API_KEY);
        }
        spy.mockRestore();
      }
    });
  });

  describe("POST /api/agents/:id/frontier/link", () => {
    it("404s for an unknown agent", async () => {
      const res = await app.inject({ method: "POST", url: "/api/agents/nope/frontier/link" });
      expect(res.statusCode).toBe(404);
    });

    it("400s not_frontier_agent for a hosted-runtime agent", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: {
          name: "Hosted",
          avatar: { emoji: "🤖", bg: "#eee" },
          persona: "p",
          capabilityBlurb: "b",
          params: { temperature: 0.7, contextLength: 8192 },
        },
      });
      const agentId = (JSON.parse(createRes.body) as { agentId: string }).agentId;

      const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/frontier/link` });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "not_frontier_agent" });
    });

    it("400s frontier_config_required when no frontier config has been saved yet", async () => {
      const agentId = await createFrontierAgent();
      const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/frontier/link` });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "frontier_config_required" });
    });

    it("502s when the network link-session create call fails", async () => {
      const agentId = await createFrontierAgent();
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      fetchMock.mockResolvedValue(jsonResponse(500, { error: "boom" }));

      const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/frontier/link` });
      expect(res.statusCode).toBe(502);
    });

    it("creates the link session (kind frontier-agent) and returns linkId/secret/url/wsUrl/payload", async () => {
      const agentId = await createFrontierAgent();
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5", apiKey: RAW_API_KEY },
      });

      fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
        expect(String(url)).toBe("http://network.test/api/link/sessions");
        const body = JSON.parse(init?.body ?? "{}") as {
          kind: string;
          auth?: SignedEnvelope<FrontierLinkSessionAuth>;
        };
        expect(body.kind).toBe("frontier-agent");

        // The network verifies this envelope (CONTRACTS §14/§4) in place of
        // the identity cookie the headless daemon has no way to hold.
        const auth = body.auth;
        expect(auth).toBeDefined();
        expect(verifyEnvelope(auth!)).toBe(true);
        expect(auth!.payload).toMatchObject({ kind: "frontier-agent", agentId });
        expect(typeof auth!.payload.nonce).toBe("string");
        expect(Math.abs(Date.now() - auth!.payload.iat)).toBeLessThan(5000);

        return jsonResponse(201, { linkId: "link-123", expiresAt: Date.now() + 600_000, kind: "frontier-agent" });
      });

      const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/frontier/link` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.linkId).toBe("link-123");
      expect(typeof body.secret).toBe("string");
      expect(body.secret.length).toBeGreaterThan(0);
      expect(body.url).toBe(`http://network.test/link/link-123#${body.secret}`);
      expect(body.wsUrl).toBe("ws://network.test/ws/link/link-123");

      expect(body.payload).toMatchObject({
        agentId,
        agentName: "Codex",
        networkUrl: "http://network.test",
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: RAW_API_KEY,
      });
      expect(typeof body.payload.agentPrivKey).toBe("string");
      expect(typeof body.payload.agentPubKey).toBe("string");
    });

    it("mints a signed issuerAuth envelope the portal can use to join the WS relay as issuer (CONTRACTS §4/§14)", async () => {
      const agentId = await createFrontierAgent();
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      fetchMock.mockResolvedValue(
        jsonResponse(201, { linkId: "link-789", expiresAt: Date.now() + 600_000, kind: "frontier-agent" }),
      );

      const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/frontier/link` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        linkId: string;
        payload: { agentPubKey: string };
        issuerAuth?: SignedEnvelope<FrontierLinkIssuerAuth>;
      };

      expect(body.issuerAuth).toBeDefined();
      const { issuerAuth } = body;
      expect(verifyEnvelope(issuerAuth!)).toBe(true);
      expect(issuerAuth!.key).toBe(body.payload.agentPubKey);
      expect(issuerAuth!.payload).toMatchObject({ linkId: "link-789", role: "issuer" });
      expect(typeof issuerAuth!.payload.nonce).toBe("string");
      expect(Math.abs(Date.now() - issuerAuth!.payload.iat)).toBeLessThan(5000);
    });

    it("omits apiKey from the payload when no key is stored", async () => {
      const agentId = await createFrontierAgent();
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/frontier`,
        payload: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      fetchMock.mockResolvedValue(
        jsonResponse(201, { linkId: "link-456", expiresAt: Date.now() + 600_000 }),
      );

      const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/frontier/link` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect("apiKey" in body.payload).toBe(false);
    });
  });
});
