/**
 * Tests for operator binding (CONTRACTS §6 "Operator binding"):
 * - GET /api/operator reflects bound/unbound state
 * - POST /api/operator/link/start issues a one-shot nonce
 * - POST /api/operator/link/complete: happy path + the bad-grant matrix
 *   (wrong subject, wrong scope, tampered signature, nonce mismatch/reuse)
 * - POST /api/operator/signout wipes the binding + every portal session
 *
 * Uses the real `@interloom/keys` sign/verify path (not mocked) so the grant
 * matrix exercises actual cryptographic verification, not a stub.
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
  MODELS_DIR: "./test-models",
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

describe("operator binding", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-operator-bind-"));
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

  function grantPayload(overrides: Record<string, unknown> = {}, nonce: string) {
    return {
      v: 1 as const,
      identityKey: identityKeypair.publicKey,
      subjectKey: hostKeypair.publicKey,
      scope: "host-operator" as const,
      issuedAt: Date.now(),
      epoch: 0,
      nonce,
      ...overrides,
    };
  }

  async function startLink(): Promise<{ nonce: string; hostPubKey: string; networkUrl: string }> {
    const res = await app.inject({ method: "POST", url: "/api/operator/link/start" });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  describe("GET /api/operator", () => {
    it("reports bound: false before any bind", async () => {
      const res = await app.inject({ method: "GET", url: "/api/operator" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ bound: false });
    });
  });

  describe("POST /api/operator/link/start", () => {
    it("returns the network URL, host pubKey, and a fresh nonce", async () => {
      const start = await startLink();
      expect(start.networkUrl).toBe("http://network.test");
      expect(start.hostPubKey).toBe(hostKeypair.publicKey);
      expect(typeof start.nonce).toBe("string");
      expect(start.nonce.length).toBeGreaterThan(0);
    });

    it("issues a different nonce each call", async () => {
      const a = await startLink();
      const b = await startLink();
      expect(a.nonce).not.toBe(b.nonce);
    });
  });

  describe("POST /api/operator/link/complete — happy path", () => {
    it("binds the operator, persists operator.json, and sets the portal cookie", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({}, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );

      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bound).toBe(true);
      expect(body.operator.identityKey).toBe(identityKeypair.publicKey);
      expect(body.operator.boundAt).toBeDefined();

      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toContain("il_portal=");
      expect(cookieStr?.toLowerCase()).toContain("httponly");

      const stored = JSON.parse(
        fs.readFileSync(path.join(state.dataDir, "operator.json"), "utf8"),
      );
      expect(stored.identityKey).toBe(identityKeypair.publicKey);

      const getRes = await app.inject({ method: "GET", url: "/api/operator" });
      expect(JSON.parse(getRes.body)).toMatchObject({
        bound: true,
        operator: { identityKey: identityKeypair.publicKey },
      });
    });

    it("binds a grant signed like AuthorizePage with audience explicitly undefined", async () => {
      // Regression (grant-auth wave): a host-operator bind is always audience-less,
      // and AuthorizePage signs `audience: request.audience` — so the key is present
      // with the value undefined. The grant then reaches the daemon as a JSON POST
      // body, which drops that key. The earlier happy-path test omitted `audience`
      // entirely, so canonicalJson's phantom `"audience":undefined` never surfaced;
      // signing it explicitly (as the browser does) reproduces the real flow.
      const { nonce } = await startLink();
      const grant = signEnvelope(
        { ...grantPayload({}, nonce), audience: undefined },
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bound).toBe(true);
      expect(body.operator.identityKey).toBe(identityKeypair.publicKey);
    });

    it("is one-shot — replaying the same grant a second time fails (nonce consumed)", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({}, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );

      const first = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(second.statusCode).toBe(400);
      expect(JSON.parse(second.body)).toMatchObject({ error: "nonce_expired" });
    });
  });

  describe("POST /api/operator/link/complete — bad grant matrix", () => {
    it("rejects a grant whose subjectKey is not this host's pubKey", async () => {
      const { nonce } = await startLink();
      const other = generateKeypair();
      const grant = signEnvelope(
        grantPayload({ subjectKey: other.publicKey }, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant" });
    });

    it("rejects a grant with the wrong scope", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({ scope: "workspace-device" }, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant" });
    });

    it("rejects a tampered envelope (payload changed after signing)", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({}, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      const tampered = { ...grant, payload: { ...grant.payload, epoch: 99 } };
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant: tampered },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant" });
    });

    it("rejects a grant not self-signed by its identityKey (envelope.key mismatch)", async () => {
      const { nonce } = await startLink();
      const impersonator = generateKeypair();
      // Signed by a DIFFERENT key than the payload's identityKey claims.
      const grant = signEnvelope(
        grantPayload({}, nonce),
        impersonator.privateKey,
        impersonator.publicKey,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant" });
    });

    it("rejects an expired grant", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({ issuedAt: Date.now() - 10_000, expiresAt: Date.now() - 1_000 }, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant" });
    });

    it("rejects a grant carrying a mismatched nonce (never started)", async () => {
      const grant = signEnvelope(
        grantPayload({}, "some-nonce-nobody-issued"),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "nonce_expired" });
    });

    it("rejects a grant carrying an audience (host-operator grants are issued audience-less)", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({ audience: "https://some-portal.example" }, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant" });
    });

    it("400s on a structurally invalid body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant: { nope: true } },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant" });
    });
  });

  describe("POST /api/operator/signout", () => {
    it("wipes operator.json and clears the portal cookie", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({}, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });
      expect(fs.existsSync(path.join(state.dataDir, "operator.json"))).toBe(true);

      const res = await app.inject({ method: "POST", url: "/api/operator/signout" });
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(path.join(state.dataDir, "operator.json"))).toBe(false);

      const getRes = await app.inject({ method: "GET", url: "/api/operator" });
      expect(JSON.parse(getRes.body)).toEqual({ bound: false });
    });

    it("wipes every portal session (sessions.json emptied)", async () => {
      const { nonce } = await startLink();
      const grant = signEnvelope(
        grantPayload({}, nonce),
        identityKeypair.privateKey,
        identityKeypair.publicKey,
      );
      await app.inject({
        method: "POST",
        url: "/api/operator/link/complete",
        payload: { grant },
      });

      const sessionsPath = path.join(state.dataDir, "sessions.json");
      const before = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      expect(before.length).toBeGreaterThan(0);

      await app.inject({ method: "POST", url: "/api/operator/signout" });

      const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      expect(after).toEqual([]);
    });
  });
});
