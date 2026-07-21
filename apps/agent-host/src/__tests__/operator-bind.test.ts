/**
 * Operator binding tests (CONTRACTS §6): the browser receives only an opaque
 * handoff id and confirmation codes. The host keeps the PKCE verifier and
 * nonce, validates the Network status tuple, and accepts a grant only through
 * the one-shot exchange endpoint.
 */

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
  MODELS_DIR: "./test-models",
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
  statusOverrides?: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("operator binding", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;
  let handoffs: Map<string, TestHandoff>;
  let nextHandoff: number;

  beforeEach(async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-operator-bind-"));
    handoffs = new Map();
    nextHandoff = 1;

    fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname === "/api/handoff/grant/start" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as {
          codeChallenge: string;
          subjectKey: string;
          scope: string;
          nonce: string;
        };
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
        const verifierChallenge = createHash("sha256")
          .update(request.codeVerifier, "utf8")
          .digest("base64url");
        if (!handoff || handoff.consumed || verifierChallenge !== handoff.codeChallenge) {
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
          ...handoff.statusOverrides,
        });
      }

      if (url.pathname === "/api/identities/resolve") {
        return jsonResponse(200, { identities: {} });
      }

      throw new Error(`unexpected fetch in test: ${url}`);
    });
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

  function grantFor(handoff: TestHandoff, overrides: Record<string, unknown> = {}) {
    return signEnvelope(
      {
        v: 1 as const,
        identityKey: identityKeypair.publicKey,
        subjectKey: hostKeypair.publicKey,
        scope: "host-operator" as const,
        issuedAt: Date.now(),
        epoch: 0,
        nonce: handoff.nonce,
        ...overrides,
      },
      identityKeypair.privateKey,
      identityKeypair.publicKey,
    );
  }

  async function startLink(): Promise<{ body: Record<string, string>; handoff: TestHandoff }> {
    const response = await app.inject({ method: "POST", url: "/api/operator/link/start" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, string>;
    const handoff = handoffs.get(body.handoffId!)!;
    handoff.userCode = body.userCode;
    handoff.subjectFp = body.subjectFp;
    handoff.grant = grantFor(handoff);
    return { body, handoff };
  }

  async function complete(handoffId: string) {
    return app.inject({
      method: "POST",
      url: "/api/operator/link/complete",
      payload: { handoffId },
    });
  }

  async function bindOperator() {
    const { body } = await startLink();
    const response = await complete(body.handoffId!);
    expect(response.statusCode).toBe(200);
    return response;
  }

  it("reports an unbound host before a link succeeds", async () => {
    const response = await app.inject({ method: "GET", url: "/api/operator" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ bound: false });
  });

  it("starts an opaque PKCE handoff without exposing the nonce or host key", async () => {
    const { body, handoff } = await startLink();

    expect(body).toMatchObject({
      handoffId: handoff.handoffId,
      authorizeUrl: `http://network.test/authorize?grantHandoffId=${handoff.handoffId}`,
      expiresAt: handoff.expiresAt,
    });
    expect(body.userCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(body.subjectFp).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(body).not.toHaveProperty("nonce");
    expect(body).not.toHaveProperty("hostPubKey");
    expect(handoff.subjectKey).toBe(hostKeypair.publicKey);
    expect(handoff.scope).toBe("host-operator");
    expect(handoff.nonce.length).toBeGreaterThan(20);
    expect(handoff.codeChallenge.length).toBeGreaterThan(20);
  });

  it("uses fresh Network rows, nonces, and PKCE challenges for every start", async () => {
    const first = await startLink();
    const second = await startLink();
    expect(first.body.handoffId).not.toBe(second.body.handoffId);
    expect(first.handoff.nonce).not.toBe(second.handoff.nonce);
    expect(first.handoff.codeChallenge).not.toBe(second.handoff.codeChallenge);
  });

  it("returns pending until the exact Network row is completed", async () => {
    const { body, handoff } = await startLink();
    handoff.completed = false;

    const pending = await complete(body.handoffId!);
    expect(pending.statusCode).toBe(200);
    expect(JSON.parse(pending.body)).toEqual({ pending: true });
    expect(fs.existsSync(path.join(state.dataDir, "operator.json"))).toBe(false);

    handoff.completed = true;
    const completed = await complete(body.handoffId!);
    expect(completed.statusCode).toBe(200);
  });

  it("exchanges, persists, and authenticates a valid one-shot grant", async () => {
    const response = await bindOperator();
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      bound: true,
      operator: { identityKey: identityKeypair.publicKey },
    });

    const cookie = response.headers["set-cookie"];
    const cookieText = Array.isArray(cookie) ? cookie[0] : cookie;
    expect(cookieText).toContain("il_portal=");
    expect(cookieText?.toLowerCase()).toContain("httponly");
    expect(cookieText?.toLowerCase()).toContain("secure");
    expect(cookieText?.toLowerCase()).toContain("samesite=lax");

    const stored = JSON.parse(fs.readFileSync(path.join(state.dataDir, "operator.json"), "utf8"));
    expect(stored.identityKey).toBe(identityKeypair.publicKey);

    const status = await app.inject({ method: "GET", url: "/api/operator" });
    expect(JSON.parse(status.body)).toMatchObject({
      bound: true,
      operator: { identityKey: identityKeypair.publicKey },
    });
  });

  it("rejects a Network status tuple that does not match the local handoff", async () => {
    const { body, handoff } = await startLink();
    handoff.statusOverrides = { subjectKey: generateKeypair().publicKey };

    const response = await complete(body.handoffId!);
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: "network_handoff_mismatch" });
    expect(fs.existsSync(path.join(state.dataDir, "operator.json"))).toBe(false);
  });

  it.each([
    [
      "wrong subject",
      (handoff: TestHandoff) => grantFor(handoff, { subjectKey: generateKeypair().publicKey }),
    ],
    ["wrong scope", (handoff: TestHandoff) => grantFor(handoff, { scope: "workspace-device" })],
    ["audience", (handoff: TestHandoff) => grantFor(handoff, { audience: "https://example.test" })],
    [
      "expired grant",
      (handoff: TestHandoff) =>
        grantFor(handoff, { issuedAt: Date.now() - 10_000, expiresAt: Date.now() - 1_000 }),
    ],
  ])("rejects an exchanged grant with %s", async (_label, makeGrant) => {
    const { body, handoff } = await startLink();
    handoff.grant = makeGrant(handoff);
    const response = await complete(body.handoffId!);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_grant" });
  });

  it("rejects a tampered or non-self-signed exchanged grant", async () => {
    const { body, handoff } = await startLink();
    const grant = grantFor(handoff);
    handoff.grant = { ...grant, payload: { ...grant.payload, epoch: 99 } };

    const tampered = await complete(body.handoffId!);
    expect(tampered.statusCode).toBe(400);
    expect(JSON.parse(tampered.body)).toEqual({ error: "invalid_grant" });

    const second = await startLink();
    const impersonator = generateKeypair();
    second.handoff.grant = signEnvelope(
      {
        v: 1 as const,
        identityKey: identityKeypair.publicKey,
        subjectKey: hostKeypair.publicKey,
        scope: "host-operator" as const,
        issuedAt: Date.now(),
        epoch: 0,
        nonce: second.handoff.nonce,
      },
      impersonator.privateKey,
      impersonator.publicKey,
    );
    const nonSelfSigned = await complete(second.body.handoffId!);
    expect(nonSelfSigned.statusCode).toBe(400);
    expect(JSON.parse(nonSelfSigned.body)).toEqual({ error: "invalid_grant" });
  });

  it("rejects direct grant injection and replay of an exchanged row", async () => {
    const direct = await app.inject({
      method: "POST",
      url: "/api/operator/link/complete",
      payload: { grant: { attackerControlled: true } },
    });
    expect(direct.statusCode).toBe(400);
    expect(JSON.parse(direct.body)).toEqual({ error: "invalid_handoff" });

    const { body } = await startLink();
    expect((await complete(body.handoffId!)).statusCode).toBe(200);
    const replay = await complete(body.handoffId!);
    expect(replay.statusCode).toBe(410);
    expect(JSON.parse(replay.body)).toEqual({ error: "handoff_expired" });
  });

  it("signout removes the binding and every portal session", async () => {
    await bindOperator();
    const sessionsPath = path.join(state.dataDir, "sessions.json");
    expect(JSON.parse(fs.readFileSync(sessionsPath, "utf8")).length).toBeGreaterThan(0);

    const response = await app.inject({ method: "POST", url: "/api/operator/signout" });
    expect(response.statusCode).toBe(200);
    expect(fs.existsSync(path.join(state.dataDir, "operator.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(sessionsPath, "utf8"))).toEqual([]);
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/operator" })).body)).toEqual({
      bound: false,
    });
  });
});
