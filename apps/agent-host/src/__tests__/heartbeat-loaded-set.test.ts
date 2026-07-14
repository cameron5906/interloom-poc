/**
 * Tests for heartbeat.ts's loaded-set filtering (CONTRACTS §6 multi-instance
 * loading): agents heartbeat (and keep tunnels) iff their model is among the
 * LOADED SET, not just a single "active model".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  PORT: 7420,
  DATA_DIR: "./test-data",
  MODELS_DIR: "./test-models",
  NETWORK_URL: "http://localhost:9999",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

vi.mock("../keys.js", () => ({
  getKeypair: () => ({ privateKey: "priv", publicKey: "pub" }),
}));

vi.mock("@interloom/keys", () => ({
  signEnvelope: (payload: unknown, _priv: string, key: string) => ({ payload, key, sig: "mocksig" }),
}));

let mockAgents: Array<{ agentId: string; registered: boolean; model?: { filename: string } }> = [];
vi.mock("../agents/store.js", () => ({
  listAgents: () => mockAgents,
}));

let mockInstances: Array<{ modelPath: string }> = [];
vi.mock("../models/loaded.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../models/loaded.js")>();
  return {
    ...actual,
    readInstances: () => mockInstances,
  };
});

const heartbeatCalls: string[] = [];
vi.mock("../network/client.js", () => ({
  networkHeartbeat: async (agentId: string) => {
    heartbeatCalls.push(agentId);
    return { placements: [] };
  },
}));

describe("heartbeat loop — loaded-set filtering", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAgents = [];
    mockInstances = [];
    heartbeatCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("heartbeats only agents whose model is in the loaded set", async () => {
    mockAgents = [
      { agentId: "a1", registered: true, model: { filename: "qwen.gguf" } },
      { agentId: "a2", registered: true, model: { filename: "llama.gguf" } },
      { agentId: "a3", registered: true }, // no model
    ];
    mockInstances = [{ modelPath: "/models/qwen.gguf" }];

    const applyPlacementsCalls: Array<[unknown, unknown]> = [];
    const tunnelManager = {
      applyPlacements: (placements: unknown, loaded: unknown) => {
        applyPlacementsCalls.push([placements, loaded]);
      },
    };

    const { startHeartbeatLoop, stopHeartbeatLoop } = await import("../heartbeat.js");
    startHeartbeatLoop(tunnelManager as never);
    // The first run is fired synchronously (void run()); flush microtasks.
    await new Promise((r) => setTimeout(r, 10));
    stopHeartbeatLoop();

    expect(heartbeatCalls).toEqual(["a1"]);
    expect(heartbeatCalls).not.toContain("a2");
    expect(heartbeatCalls).not.toContain("a3");

    // applyPlacements is called with the loaded SET (a Set, not a single filename).
    const [, loadedArg] = applyPlacementsCalls[0]!;
    expect(loadedArg).toBeInstanceOf(Set);
    expect((loadedArg as Set<string>).has("qwen.gguf")).toBe(true);
    expect((loadedArg as Set<string>).has("llama.gguf")).toBe(false);
  });

  it("heartbeats agents of MULTIPLE loaded models (not just the first)", async () => {
    mockAgents = [
      { agentId: "a1", registered: true, model: { filename: "qwen.gguf" } },
      { agentId: "a2", registered: true, model: { filename: "llama.gguf" } },
    ];
    mockInstances = [{ modelPath: "/models/qwen.gguf" }, { modelPath: "/models/llama.gguf" }];

    const tunnelManager = { applyPlacements: vi.fn() };
    const { startHeartbeatLoop, stopHeartbeatLoop } = await import("../heartbeat.js");
    startHeartbeatLoop(tunnelManager as never);
    await new Promise((r) => setTimeout(r, 10));
    stopHeartbeatLoop();

    expect(heartbeatCalls.sort()).toEqual(["a1", "a2"]);
  });

  it("still applies the (empty) placements diff when nothing is loaded, closing stale tunnels", async () => {
    mockAgents = [{ agentId: "a1", registered: true, model: { filename: "qwen.gguf" } }];
    mockInstances = []; // nothing loaded

    const applyPlacementsCalls: Array<[unknown, unknown]> = [];
    const tunnelManager = {
      applyPlacements: (placements: unknown, loaded: unknown) => {
        applyPlacementsCalls.push([placements, loaded]);
      },
    };

    const { startHeartbeatLoop, stopHeartbeatLoop } = await import("../heartbeat.js");
    startHeartbeatLoop(tunnelManager as never);
    await new Promise((r) => setTimeout(r, 10));
    stopHeartbeatLoop();

    expect(heartbeatCalls).toEqual([]);
    expect(applyPlacementsCalls).toHaveLength(1);
    const [placements, loaded] = applyPlacementsCalls[0]!;
    expect(placements).toEqual([]);
    expect((loaded as Set<string>).size).toBe(0);
  });

  it("excludes unregistered agents even if their model is loaded", async () => {
    mockAgents = [{ agentId: "a1", registered: false, model: { filename: "qwen.gguf" } }];
    mockInstances = [{ modelPath: "/models/qwen.gguf" }];

    const tunnelManager = { applyPlacements: vi.fn() };
    const { startHeartbeatLoop, stopHeartbeatLoop } = await import("../heartbeat.js");
    startHeartbeatLoop(tunnelManager as never);
    await new Promise((r) => setTimeout(r, 10));
    stopHeartbeatLoop();

    expect(heartbeatCalls).toEqual([]);
  });
});
