/**
 * Tests for frontier-runtime agent registration (CONTRACTS §14):
 * - buildAgentManifest synthesizes a ModelRef instead of requiring a local
 *   GGUF, and stamps runtime/frontier on the manifest.
 * - registerAgentOnNetwork signs under the agent's OWN per-agent key
 *   (envelope.key === manifest.pubKey === agentPubKey), never the host key,
 *   and never regresses the capability-backfill path for hosted agents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { verifyEnvelope } from "@interloom/keys";
import type { Agent } from "../agents/store.js";

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
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseFrontierAgent: Agent = {
  agentId: "a-frontier-1",
  name: "Codex",
  avatar: { emoji: "🤖", bg: "#eee" },
  persona: "a careful reviewer",
  capabilityBlurb: "reviews code",
  params: { temperature: 0.7, contextLength: 8192 },
  registered: false,
  runtime: "frontier",
  frontier: { provider: "anthropic", model: "claude-sonnet-5" },
};

describe("buildAgentManifest — frontier runtime (CONTRACTS §14)", () => {
  beforeEach(() => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-frontier-register-"));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  it("synthesizes a ModelRef instead of requiring a local model", async () => {
    const { buildAgentManifest } = await import("../agents/register.js");
    const manifest = buildAgentManifest(baseFrontierAgent, "AGENT_PUBKEY");
    expect(manifest.model).toEqual({
      filename: "frontier:anthropic/claude-sonnet-5",
      displayName: "claude-sonnet-5",
      capabilities: { tools: true, vision: false, thinking: true },
    });
  });

  it("stamps runtime and frontier config on the manifest", async () => {
    const { buildAgentManifest } = await import("../agents/register.js");
    const manifest = buildAgentManifest(baseFrontierAgent, "AGENT_PUBKEY");
    expect(manifest.runtime).toBe("frontier");
    expect(manifest.frontier).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("uses the passed-in pubKey (the agent's own key), not a host key", async () => {
    const { buildAgentManifest } = await import("../agents/register.js");
    const manifest = buildAgentManifest(baseFrontierAgent, "AGENT_PUBKEY");
    expect(manifest.pubKey).toBe("AGENT_PUBKEY");
  });

  it("throws when runtime is frontier but frontier config is missing", async () => {
    const { buildAgentManifest } = await import("../agents/register.js");
    const broken = { ...baseFrontierAgent, frontier: undefined };
    expect(() => buildAgentManifest(broken, "AGENT_PUBKEY")).toThrow();
  });

  it("never requires the ignored lookup/model fields hosted agents need", async () => {
    const { buildAgentManifest } = await import("../agents/register.js");
    // No `model` on the agent at all — must not throw for a frontier runtime.
    expect(() => buildAgentManifest(baseFrontierAgent, "AGENT_PUBKEY", () => undefined)).not.toThrow();
  });
});

describe("registerAgentOnNetwork — frontier runtime (CONTRACTS §14)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-frontier-register-net-"));
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agentId: "a-frontier-1" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  });

  it("throws when the agent has no stored frontier keypair yet", async () => {
    const { registerAgentOnNetwork } = await import("../agents/register.js");
    await expect(registerAgentOnNetwork(baseFrontierAgent)).rejects.toThrow(/keypair/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs the manifest envelope under the agent's OWN per-agent key", async () => {
    const { setFrontierConfig } = await import("../agents/frontierKeys.js");
    const keyEntry = setFrontierConfig(baseFrontierAgent.agentId, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    const { registerAgentOnNetwork } = await import("../agents/register.js");
    await registerAgentOnNetwork(baseFrontierAgent);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0] as [string, { body: string }];
    const envelope = JSON.parse(options.body) as {
      payload: { pubKey: string };
      key: string;
      sig: string;
    };
    expect(envelope.key).toBe(keyEntry.agentPubKey);
    expect(envelope.payload.pubKey).toBe(keyEntry.agentPubKey);
    expect(envelope.key).not.toBe("HOST_PUBKEY");
    expect(verifyEnvelope(envelope)).toBe(true);
  });

  it("does not attempt to persist a synthesized model back onto the agent record", async () => {
    const updateAgentSpy = vi.fn();
    vi.doMock("../agents/store.js", () => ({
      listAgents: () => [],
      updateAgent: updateAgentSpy,
    }));
    vi.resetModules();

    const { setFrontierConfig } = await import("../agents/frontierKeys.js");
    setFrontierConfig(baseFrontierAgent.agentId, { provider: "anthropic", model: "claude-sonnet-5" });
    const { registerAgentOnNetwork } = await import("../agents/register.js");

    await registerAgentOnNetwork(baseFrontierAgent);

    expect(updateAgentSpy).not.toHaveBeenCalled();
  });
});
