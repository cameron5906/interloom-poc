/**
 * Tests for the operator stale-grant flag (fix wave, CONTRACTS §11.7): a
 * network revoke-all bumps the bound identity's session_epoch, so the next
 * agent register/re-register 403s "operator grant epoch stale". That must
 * surface as `staleGrant: true` on `GET /api/operator` — not vanish into a
 * `log.warn` — so the portal can prompt a reconnect, and clear again once
 * the operator successfully re-binds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { generateKeypair, signEnvelope } from "@interloom/keys";

const state = vi.hoisted(() => ({ dataDir: "" }));

vi.mock("../config.js", () => ({
  PORT: 7420,
  get DATA_DIR() {
    return state.dataDir;
  },
  MODELS_DIR: "./test-models-stale",
  NETWORK_URL: "http://network.test",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

const hostKeypair = generateKeypair();

vi.mock("../keys.js", () => ({
  getKeypair: () => hostKeypair,
  loadOrCreateKeypair: vi.fn(),
  registerKeysRoutes: vi.fn(),
}));

const identityKeypair = generateKeypair();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("operator grant stale flag", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-stale-grant-"));
    fetchMock = vi.fn().mockRejectedValue(new Error("network unreachable in test"));
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const { registerOperatorBindRoutes } = await import("../operatorBind.js");
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerOperatorBindRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  async function bindOperator(): Promise<void> {
    const start = await app.inject({ method: "POST", url: "/api/operator/link/start" });
    const { nonce } = JSON.parse(start.body) as { nonce: string };
    const grant = signEnvelope(
      {
        v: 1 as const,
        identityKey: identityKeypair.publicKey,
        subjectKey: hostKeypair.publicKey,
        scope: "host-operator" as const,
        issuedAt: Date.now(),
        epoch: 0,
        nonce,
      },
      identityKeypair.privateKey,
      identityKeypair.publicKey,
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/link/complete",
      payload: { grant },
    });
    expect(res.statusCode).toBe(200);
  }

  async function createRegisteredAgent() {
    const { createAgent, updateAgent } = await import("../agents/store.js");
    const agent = createAgent({
      name: "Bobby",
      avatar: { emoji: "🤖", bg: "#eee" },
      persona: "helpful",
      capabilityBlurb: "helps",
      params: { temperature: 0.7, contextLength: 8192 },
      model: { filename: "model.gguf", displayName: "Model" },
    });
    return updateAgent(agent.agentId, { registered: true })!;
  }

  it("a 403 stale-grant register response flags staleGrant: true on GET /api/operator", async () => {
    await bindOperator();
    const agent = await createRegisteredAgent();
    const { registerAgentOnNetwork } = await import("../agents/register.js");

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/agents")) {
        return jsonResponse(403, { error: "operator grant epoch stale" });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });

    await expect(registerAgentOnNetwork(agent)).rejects.toThrow();

    const getRes = await app.inject({ method: "GET", url: "/api/operator" });
    expect(JSON.parse(getRes.body)).toMatchObject({ bound: true, staleGrant: true });
  });

  it("a successful register clears a previously-set staleGrant flag", async () => {
    await bindOperator();
    const agent = await createRegisteredAgent();
    const { registerAgentOnNetwork } = await import("../agents/register.js");

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/agents")) {
        return jsonResponse(403, { error: "operator grant epoch stale" });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    await expect(registerAgentOnNetwork(agent)).rejects.toThrow();
    let getRes = await app.inject({ method: "GET", url: "/api/operator" });
    expect(JSON.parse(getRes.body)).toMatchObject({ staleGrant: true });

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/agents")) {
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    await registerAgentOnNetwork(agent);

    getRes = await app.inject({ method: "GET", url: "/api/operator" });
    expect(JSON.parse(getRes.body).staleGrant).toBeUndefined();
  });

  it("clears staleGrant on a fresh successful link/complete (reconnect)", async () => {
    await bindOperator();
    const agent = await createRegisteredAgent();
    const { registerAgentOnNetwork } = await import("../agents/register.js");

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/agents")) {
        return jsonResponse(403, { error: "operator grant epoch stale" });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    await expect(registerAgentOnNetwork(agent)).rejects.toThrow();

    let getRes = await app.inject({ method: "GET", url: "/api/operator" });
    expect(JSON.parse(getRes.body)).toMatchObject({ staleGrant: true });

    // Reconnect — link/complete clears the flag immediately, independent of
    // whether the daemon gets a chance to re-register any agent afterward.
    fetchMock.mockRejectedValue(new Error("network unreachable in test"));
    await bindOperator();

    getRes = await app.inject({ method: "GET", url: "/api/operator" });
    const body = JSON.parse(getRes.body) as { bound: boolean; staleGrant?: boolean };
    expect(body.bound).toBe(true);
    expect(body.staleGrant).toBeUndefined();
  });
});
