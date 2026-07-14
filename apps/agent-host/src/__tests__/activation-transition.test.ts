/**
 * Tests for activation-transition tunnel open/close decisions (pure function).
 * Verifies CONTRACTS §6 active model semantics: only agents whose model.filename
 * matches the active model get tunnels opened/kept.
 */

import { describe, it, expect, vi } from "vitest";
import { diffPlacements } from "../tunnel/manager.js";
import type { LiveTunnel } from "../tunnel/manager.js";
import type { Placement } from "@interloom/protocol";

vi.mock("../config.js", () => ({
  PORT: 7420,
  DATA_DIR: "./test-data",
  MODELS_DIR: "./test-models",
  NETWORK_URL: "http://localhost:9999",
  INFERENCE_URL: "http://localhost:8080",
  FETCHER_URL: "http://localhost:7423",
}));

// We'll control what getAgent returns per test
const agentStore = new Map<string, { model?: { filename: string } }>();

vi.mock("../agents/store.js", () => ({
  getAgent: (id: string) => agentStore.get(id),
}));

function makeVoucher(agentId: string, instanceUrl: string, placementId: string) {
  return {
    payload: {
      v: 1 as const,
      placementId,
      agentId,
      agentPubKey: "pubkey",
      instanceUrl,
      instanceName: "test",
      iat: Date.now(),
      exp: Date.now() + 86_400_000,
      nonce: "nonce",
    },
    key: "networkpubkey",
    sig: "sig",
  };
}

function makePlacement(id: string, agentId: string, revoked = false): Placement {
  return {
    placementId: id,
    instanceUrl: `http://instance-${id}.example.com`,
    instanceName: `instance-${id}`,
    voucher: makeVoucher(agentId, `http://instance-${id}.example.com`, id),
    revoked,
  };
}

function makeClientMap(ids: string[]): Map<string, LiveTunnel> {
  return new Map(ids.map((id) => [id, { voucherSig: "sig", authFailed: false }]));
}

describe("activation-transition: diffPlacements with active model filter", () => {
  it("opens tunnels only for agents matching the active model filename", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });
    agentStore.set("agent-b", { model: { filename: "llama.gguf" } });

    const current = makeClientMap([]);
    const incoming = [
      makePlacement("p-a", "agent-a"),
      makePlacement("p-b", "agent-b"),
    ];

    const { toOpen, toClose } = diffPlacements(current, incoming, "qwen.gguf");
    expect(toOpen.map((p) => p.placementId)).toEqual(["p-a"]);
    expect(toClose).toHaveLength(0);
  });

  it("closes existing tunnels for agents whose model no longer matches", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });
    agentStore.set("agent-b", { model: { filename: "llama.gguf" } });

    // Both tunnels were open under old model
    const current = makeClientMap(["p-a", "p-b"]);
    const incoming = [
      makePlacement("p-a", "agent-a"),
      makePlacement("p-b", "agent-b"),
    ];

    // Activate qwen — agent-b should lose its tunnel
    const { toOpen, toClose } = diffPlacements(current, incoming, "qwen.gguf");
    expect(toOpen).toHaveLength(0);
    expect(toClose).toContain("p-b");
    expect(toClose).not.toContain("p-a");
  });

  it("opens tunnels for agents entering the active set on activation", () => {
    agentStore.set("agent-a", { model: { filename: "llama.gguf" } });
    agentStore.set("agent-b", { model: { filename: "qwen.gguf" } });

    // Only p-a was open under the old model
    const current = makeClientMap(["p-a"]);
    const incoming = [
      makePlacement("p-a", "agent-a"),
      makePlacement("p-b", "agent-b"),
    ];

    // Activate qwen: p-a (llama) leaves, p-b (qwen) enters
    const { toOpen, toClose } = diffPlacements(current, incoming, "qwen.gguf");
    expect(toOpen.map((p) => p.placementId)).toContain("p-b");
    expect(toClose).toContain("p-a");
  });

  it("closes all tunnels when no agents match the newly activated model", () => {
    agentStore.set("agent-a", { model: { filename: "llama.gguf" } });

    const current = makeClientMap(["p-a"]);
    const incoming = [makePlacement("p-a", "agent-a")];

    const { toOpen, toClose } = diffPlacements(current, incoming, "qwen.gguf");
    expect(toOpen).toHaveLength(0);
    expect(toClose).toContain("p-a");
  });

  it("excludes agents without a model field from the active set", () => {
    agentStore.set("agent-a", {}); // no model
    agentStore.set("agent-b", { model: { filename: "qwen.gguf" } });

    const current = makeClientMap([]);
    const incoming = [
      makePlacement("p-a", "agent-a"),
      makePlacement("p-b", "agent-b"),
    ];

    const { toOpen, toClose } = diffPlacements(current, incoming, "qwen.gguf");
    expect(toOpen.map((p) => p.placementId)).toEqual(["p-b"]);
    expect(toClose).toHaveLength(0);
  });

  it("with no active model filter (undefined), falls back to original placement diff logic", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });

    const current = makeClientMap([]);
    const incoming = [makePlacement("p-a", "agent-a")];

    // No filter — behaves like the pre-activation diff (all non-revoked placements are eligible)
    const { toOpen, toClose } = diffPlacements(current, incoming, undefined);
    expect(toOpen.map((p) => p.placementId)).toContain("p-a");
    expect(toClose).toHaveLength(0);
  });

  // --- multi-load (CONTRACTS §6 multi-instance loading): agents of ALL
  // loaded models get tunnels — the filter takes the whole loaded SET. ---

  it("multi-load: opens tunnels for agents of EVERY loaded model, not just one", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });
    agentStore.set("agent-b", { model: { filename: "llama.gguf" } });
    agentStore.set("agent-c", { model: { filename: "mistral.gguf" } }); // not loaded

    const current = makeClientMap([]);
    const incoming = [
      makePlacement("p-a", "agent-a"),
      makePlacement("p-b", "agent-b"),
      makePlacement("p-c", "agent-c"),
    ];

    const loaded = new Set(["qwen.gguf", "llama.gguf"]);
    const { toOpen, toClose } = diffPlacements(current, incoming, loaded);
    expect(toOpen.map((p) => p.placementId).sort()).toEqual(["p-a", "p-b"]);
    expect(toClose).toHaveLength(0);
  });

  it("multi-load: unloading one of two models closes only that model's agents' tunnels", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });
    agentStore.set("agent-b", { model: { filename: "llama.gguf" } });

    // Both were loaded and tunneled; llama.gguf gets unloaded.
    const current = makeClientMap(["p-a", "p-b"]);
    const incoming = [makePlacement("p-a", "agent-a"), makePlacement("p-b", "agent-b")];

    const loaded = new Set(["qwen.gguf"]); // llama.gguf left the loaded set
    const { toOpen, toClose } = diffPlacements(current, incoming, loaded);
    expect(toClose).toEqual(["p-b"]);
    expect(toOpen).toHaveLength(0);
  });

  it("multi-load: loading a second model opens tunnels for its agents without closing the first model's", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });
    agentStore.set("agent-b", { model: { filename: "llama.gguf" } });

    // qwen.gguf already tunneled; llama.gguf just finished loading.
    const current = makeClientMap(["p-a"]);
    const incoming = [makePlacement("p-a", "agent-a"), makePlacement("p-b", "agent-b")];

    const loaded = new Set(["qwen.gguf", "llama.gguf"]);
    const { toOpen, toClose } = diffPlacements(current, incoming, loaded);
    expect(toOpen.map((p) => p.placementId)).toEqual(["p-b"]);
    expect(toClose).toHaveLength(0);
  });

  it("multi-load: an empty loaded set (everything unloaded) closes every agent-gated tunnel", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });
    agentStore.set("agent-b", { model: { filename: "llama.gguf" } });

    const current = makeClientMap(["p-a", "p-b"]);
    const incoming = [makePlacement("p-a", "agent-a"), makePlacement("p-b", "agent-b")];

    const loaded = new Set<string>();
    const { toOpen, toClose } = diffPlacements(current, incoming, loaded);
    expect(toClose.sort()).toEqual(["p-a", "p-b"]);
    expect(toOpen).toHaveLength(0);
  });

  it("multi-load: null loaded set (nothing loaded, distinct from undefined = no filter) closes everything", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });

    const current = makeClientMap(["p-a"]);
    const incoming = [makePlacement("p-a", "agent-a")];

    const { toOpen, toClose } = diffPlacements(current, incoming, null);
    expect(toClose).toEqual(["p-a"]);
    expect(toOpen).toHaveLength(0);
  });

  it("multi-load: single-string filter (legacy activate-style callers) still works", () => {
    agentStore.set("agent-a", { model: { filename: "qwen.gguf" } });
    agentStore.set("agent-b", { model: { filename: "llama.gguf" } });

    const current = makeClientMap([]);
    const incoming = [makePlacement("p-a", "agent-a"), makePlacement("p-b", "agent-b")];

    const { toOpen, toClose } = diffPlacements(current, incoming, "qwen.gguf");
    expect(toOpen.map((p) => p.placementId)).toEqual(["p-a"]);
    expect(toClose).toHaveLength(0);
  });
});
