/** Operator session-epoch invalidation and reconnect tests (CONTRACTS §11.7). */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const identityKeypair = generateKeypair();

vi.mock("../keys.js", () => ({
  getKeypair: () => hostKeypair,
  loadOrCreateKeypair: vi.fn(),
  registerKeysRoutes: vi.fn(),
}));

interface TestHandoff {
  handoffId: string;
  codeChallenge: string;
  subjectKey: string;
  scope: string;
  nonce: string;
  expiresAt: string;
  userCode?: string;
  subjectFp?: string;
  completed: boolean;
  consumed: boolean;
  grant?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("operator grant stale flag", () => {
  let app: FastifyInstance;
  let handoffs: Map<string, TestHandoff>;
  let agentStatus: 200 | 403;
  let nextHandoff: number;

  beforeEach(async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-stale-grant-"));
    handoffs = new Map();
    agentStatus = 200;
    nextHandoff = 1;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/handoff/grant/start" && init?.method === "POST") {
          const request = JSON.parse(String(init.body)) as Omit<
            TestHandoff,
            "handoffId" | "expiresAt" | "completed" | "consumed"
          >;
          const handoffId = `handoff-${nextHandoff++}`;
          const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
          handoffs.set(handoffId, {
            handoffId,
            expiresAt,
            completed: true,
            consumed: false,
            ...request,
          });
          return jsonResponse(200, { handoffId, expiresAt });
        }
        if (url.pathname === "/api/handoff/grant/exchange" && init?.method === "POST") {
          const request = JSON.parse(String(init.body)) as {
            handoffId: string;
            codeVerifier: string;
          };
          const handoff = handoffs.get(request.handoffId);
          const challenge = createHash("sha256")
            .update(request.codeVerifier, "utf8")
            .digest("base64url");
          if (!handoff || handoff.consumed || challenge !== handoff.codeChallenge) {
            return jsonResponse(400, { error: "invalid_handoff" });
          }
          handoff.consumed = true;
          return jsonResponse(200, { grant: handoff.grant });
        }
        const statusMatch = /^\/api\/handoff\/grant\/([^/]+)$/.exec(url.pathname);
        if (statusMatch && (!init?.method || init.method === "GET")) {
          const handoff = handoffs.get(decodeURIComponent(statusMatch[1]!));
          if (!handoff) return jsonResponse(404, { error: "not_found" });
          return jsonResponse(200, {
            subjectKey: handoff.subjectKey,
            scope: handoff.scope,
            nonce: handoff.nonce,
            userCode: handoff.userCode,
            subjectFp: handoff.subjectFp,
            completed: handoff.completed,
            consumed: handoff.consumed,
          });
        }
        if (url.pathname === "/api/identities/resolve") {
          return jsonResponse(200, { identities: {} });
        }
        if (url.pathname === "/api/agents") {
          return agentStatus === 403
            ? jsonResponse(403, { error: "operator grant epoch stale" })
            : jsonResponse(200, { ok: true });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      }),
    );

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
    expect(start.statusCode).toBe(200);
    const started = JSON.parse(start.body) as {
      handoffId: string;
      userCode: string;
      subjectFp: string;
    };
    const handoff = handoffs.get(started.handoffId)!;
    handoff.userCode = started.userCode;
    handoff.subjectFp = started.subjectFp;
    handoff.grant = signEnvelope(
      {
        v: 1 as const,
        identityKey: identityKeypair.publicKey,
        subjectKey: hostKeypair.publicKey,
        scope: "host-operator" as const,
        issuedAt: Date.now(),
        epoch: 0,
        nonce: handoff.nonce,
      },
      identityKeypair.privateKey,
      identityKeypair.publicKey,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/operator/link/complete",
      payload: { handoffId: started.handoffId },
    });
    expect(response.statusCode).toBe(200);
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

  async function getOperator() {
    return JSON.parse((await app.inject({ method: "GET", url: "/api/operator" })).body) as {
      bound: boolean;
      staleGrant?: boolean;
    };
  }

  it("surfaces a stale operator grant after Network rejects registration", async () => {
    await bindOperator();
    const agent = await createRegisteredAgent();
    const { registerAgentOnNetwork } = await import("../agents/register.js");
    agentStatus = 403;

    await expect(registerAgentOnNetwork(agent)).rejects.toThrow();
    expect(await getOperator()).toMatchObject({ bound: true, staleGrant: true });
  });

  it("clears the flag after a later successful registration", async () => {
    await bindOperator();
    const agent = await createRegisteredAgent();
    const { registerAgentOnNetwork } = await import("../agents/register.js");
    agentStatus = 403;
    await expect(registerAgentOnNetwork(agent)).rejects.toThrow();
    expect(await getOperator()).toMatchObject({ staleGrant: true });

    agentStatus = 200;
    await registerAgentOnNetwork(agent);
    expect((await getOperator()).staleGrant).toBeUndefined();
  });

  it("clears the flag after a fresh PKCE reconnect", async () => {
    await bindOperator();
    const agent = await createRegisteredAgent();
    const { registerAgentOnNetwork } = await import("../agents/register.js");
    agentStatus = 403;
    await expect(registerAgentOnNetwork(agent)).rejects.toThrow();
    expect(await getOperator()).toMatchObject({ staleGrant: true });

    agentStatus = 200;
    await bindOperator();
    expect(await getOperator()).toMatchObject({ bound: true });
    expect((await getOperator()).staleGrant).toBeUndefined();
  });
});
