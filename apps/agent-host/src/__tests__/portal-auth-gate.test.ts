/**
 * Tests for the portal auth gate (CONTRACTS §6): every `/api/*` and `/ws/*`
 * route requires a live `il_portal` cookie except the bootstrap set
 * (`/api/system`, `/api/keys`, `/api/operator`, `/api/operator/link/*`).
 * While unbound, non-bootstrap routes 401 `operator_not_bound`; while bound,
 * they 401 `portal_auth_required` without a valid cookie and pass through
 * with one. Static (non `/api`, non `/ws`) routes are never gated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";

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

describe("portal auth gate", () => {
  let app: FastifyInstance;
  let bound: boolean;
  let createPortalSession: typeof import("../portalAuth.js").createPortalSession;

  beforeEach(async () => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-portal-gate-"));
    vi.resetModules();
    const portalAuth = await import("../portalAuth.js");
    createPortalSession = portalAuth.createPortalSession;

    bound = false;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    portalAuth.registerPortalAuthGate(app, () => bound);

    app.get("/api/system", async () => ({ ok: true }));
    app.get("/api/keys", async () => ({ ok: true }));
    app.get("/api/operator", async () => ({ bound }));
    app.post("/api/operator/link/start", async () => ({ ok: true }));
    app.post("/api/operator/link/complete", async () => ({ ok: true }));
    app.post("/api/operator/signout", async () => ({ ok: true }));
    app.get("/api/agents", async () => ({ ok: true }));
    app.get("/ws/telemetry", async () => ({ ok: true }));
    app.get("/", async () => "index.html");
    app.get("/assets/app.js", async () => "// js");

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  describe("while unbound", () => {
    it("the bootstrap set stays reachable with no cookie", async () => {
      for (const url of ["/api/system", "/api/keys", "/api/operator"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(200);
      }
      for (const url of ["/api/operator/link/start", "/api/operator/link/complete"]) {
        const res = await app.inject({ method: "POST", url });
        expect(res.statusCode, url).toBe(200);
      }
    });

    it("everything else 401s with operator_not_bound", async () => {
      const agents = await app.inject({ method: "GET", url: "/api/agents" });
      expect(agents.statusCode).toBe(401);
      expect(JSON.parse(agents.body)).toMatchObject({ error: "operator_not_bound" });

      const signout = await app.inject({ method: "POST", url: "/api/operator/signout" });
      expect(signout.statusCode).toBe(401);
      expect(JSON.parse(signout.body)).toMatchObject({ error: "operator_not_bound" });

      const ws = await app.inject({ method: "GET", url: "/ws/telemetry" });
      expect(ws.statusCode).toBe(401);
      expect(JSON.parse(ws.body)).toMatchObject({ error: "operator_not_bound" });
    });

    it("never gates static (non-api, non-ws) routes", async () => {
      const index = await app.inject({ method: "GET", url: "/" });
      expect(index.statusCode).toBe(200);
      const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(asset.statusCode).toBe(200);
    });
  });

  describe("while bound", () => {
    beforeEach(() => {
      bound = true;
    });

    it("401s portal_auth_required on a protected route with no cookie", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toMatchObject({ error: "portal_auth_required" });
    });

    it("401s portal_auth_required with a garbage cookie", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { cookie: "il_portal=not-a-real-token" },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toMatchObject({ error: "portal_auth_required" });
    });

    it("passes through a protected route with a valid session cookie", async () => {
      const { token } = createPortalSession();
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { cookie: `il_portal=${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("the bootstrap set still needs no cookie", async () => {
      const res = await app.inject({ method: "GET", url: "/api/system" });
      expect(res.statusCode).toBe(200);
    });

    it("still gates /api/operator/signout even when bound (requires a valid cookie)", async () => {
      const noCookie = await app.inject({ method: "POST", url: "/api/operator/signout" });
      expect(noCookie.statusCode).toBe(401);

      const { token } = createPortalSession();
      const withCookie = await app.inject({
        method: "POST",
        url: "/api/operator/signout",
        headers: { cookie: `il_portal=${token}` },
      });
      expect(withCookie.statusCode).toBe(200);
    });
  });
});
