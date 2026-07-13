import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { checkForUpdate, isUpdateAvailable } from "../update/checker.js";
import { registerUpdateRoutes } from "../update/routes.js";

const MANIFEST = {
  version: "2026.07.12-27d3674",
  gitSha: "27d3674",
  publishedAt: "2026-07-12T18:00:00Z",
  images: ["agent-host", "inference", "model-fetcher", "host-updater"],
  notes: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** fetch stub routing by URL suffix: manifest, updater status, updater apply. */
function stubFetch(handlers: {
  manifest?: () => Response | Promise<Response>;
  updaterStatus?: () => Response | Promise<Response>;
  updaterApply?: () => Response | Promise<Response>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/releases/host.json") && handlers.manifest)
        return Promise.resolve(handlers.manifest());
      if (u.endsWith("/status") && handlers.updaterStatus)
        return Promise.resolve(handlers.updaterStatus());
      if (u.endsWith("/apply") && handlers.updaterApply)
        return Promise.resolve(handlers.updaterApply());
      return Promise.reject(new Error(`unreachable: ${u}`));
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("isUpdateAvailable", () => {
  it("is false for dev builds regardless of manifest", () => {
    expect(isUpdateAvailable("dev", "2026.07.12-27d3674")).toBe(false);
  });
  it("is false when versions match", () => {
    expect(isUpdateAvailable("2026.07.12-27d3674", "2026.07.12-27d3674")).toBe(false);
  });
  it("is true when the manifest differs", () => {
    expect(isUpdateAvailable("2026.07.10-abc1234", "2026.07.12-27d3674")).toBe(true);
  });
  it("is false when no manifest has been seen", () => {
    expect(isUpdateAvailable("2026.07.10-abc1234", undefined)).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("stores the parsed manifest, then keeps it when a later check fails", async () => {
    stubFetch({ manifest: () => jsonResponse(200, MANIFEST) });
    let state = await checkForUpdate();
    expect(state.latest?.version).toBe(MANIFEST.version);
    expect(state.checkError).toBeUndefined();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    state = await checkForUpdate();
    expect(state.latest?.version).toBe(MANIFEST.version);
    expect(state.checkError).toContain("boom");
  });

  it("treats 404 as no-release (dev network), not an error", async () => {
    stubFetch({ manifest: () => jsonResponse(404, { error: "no_release" }) });
    const state = await checkForUpdate();
    expect(state.latest).toBeNull();
    expect(state.checkError).toBeUndefined();
  });
});

describe("update routes", () => {
  const DEPS = { ownVersion: "2026.07.10-abc1234", updaterUrl: "http://updater.test:7424" };

  async function primedApp(deps = DEPS) {
    const app = Fastify();
    registerUpdateRoutes(app, deps);
    stubFetch({
      manifest: () => jsonResponse(200, MANIFEST),
      updaterStatus: () => jsonResponse(200, { state: "idle" }),
    });
    await app.inject({ method: "POST", url: "/api/update/check" });
    return app;
  }

  it("status reports updateAvailable with the updater's apply state", async () => {
    const app = await primedApp();
    const res = await app.inject({ method: "GET", url: "/api/update/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.current.version).toBe(DEPS.ownVersion);
    expect(body.latest.version).toBe(MANIFEST.version);
    expect(body.updateAvailable).toBe(true);
    expect(body.apply.state).toBe("idle");
    expect(typeof body.networkUrl).toBe("string");
  });

  it("status degrades apply state to unknown when the updater is unreachable", async () => {
    const app = await primedApp();
    stubFetch({ manifest: () => jsonResponse(200, MANIFEST) });
    const res = await app.inject({ method: "GET", url: "/api/update/status" });
    expect(JSON.parse(res.body).apply.state).toBe("unknown");
  });

  it("apply forwards the latest version to the updater", async () => {
    const app = await primedApp();
    const applyCalls: string[] = [];
    stubFetch({
      manifest: () => jsonResponse(200, MANIFEST),
      updaterStatus: () => jsonResponse(200, { state: "idle" }),
      updaterApply: () => {
        applyCalls.push("called");
        return jsonResponse(200, { status: "started" });
      },
    });
    const res = await app.inject({ method: "POST", url: "/api/update/apply" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "started" });
    expect(applyCalls).toHaveLength(1);
  });

  it("apply 409s with no_update when already on the manifest version", async () => {
    const app = await primedApp({ ...DEPS, ownVersion: MANIFEST.version });
    const res = await app.inject({ method: "POST", url: "/api/update/apply" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "no_update" });
  });

  it("apply 409s with already_updating while the updater is busy", async () => {
    const app = await primedApp();
    stubFetch({
      manifest: () => jsonResponse(200, MANIFEST),
      updaterStatus: () => jsonResponse(200, { state: "pulling", version: MANIFEST.version }),
    });
    const res = await app.inject({ method: "POST", url: "/api/update/apply" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "already_updating" });
  });

  it("apply 502s when the updater is unreachable", async () => {
    const app = await primedApp();
    stubFetch({ manifest: () => jsonResponse(200, MANIFEST) });
    const res = await app.inject({ method: "POST", url: "/api/update/apply" });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "updater_unreachable" });
  });
});
