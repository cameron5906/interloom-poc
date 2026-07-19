/**
 * Tests for the frontier key/credential store (CONTRACTS §14 key custody,
 * DATA_DIR/frontier-keys.json): per-agent keypair generation + stability,
 * API key masking, and 0600 file permissions (POSIX only).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-frontier-keys-"));
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    PORT: 7420,
    DATA_DIR: tmpDataDir,
    MODELS_DIR: "./test-models",
    NETWORK_URL: "http://localhost:9999",
    INFERENCE_URL: "http://inference:8080",
    FETCHER_URL: "http://localhost:7423",
  }));
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  vi.doUnmock("../config.js");
});

describe("frontier keys store", () => {
  it("getFrontierKeyEntry returns undefined when no file exists", async () => {
    const { getFrontierKeyEntry } = await import("../agents/frontierKeys.js");
    expect(getFrontierKeyEntry("a1")).toBeUndefined();
  });

  it("setFrontierConfig generates a fresh Ed25519 keypair on first save", async () => {
    const { setFrontierConfig } = await import("../agents/frontierKeys.js");
    const entry = setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5" });
    expect(entry.provider).toBe("anthropic");
    expect(entry.model).toBe("claude-sonnet-5");
    expect(typeof entry.agentPrivKey).toBe("string");
    expect(entry.agentPrivKey.length).toBeGreaterThan(0);
    expect(typeof entry.agentPubKey).toBe("string");
    expect(entry.agentPubKey.length).toBeGreaterThan(0);
    expect(entry.createdAt).toBeDefined();
  });

  it("keeps the same keypair across config updates (never rotates silently)", async () => {
    const { setFrontierConfig } = await import("../agents/frontierKeys.js");
    const first = setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5" });
    const second = setFrontierConfig("a1", { provider: "openai", model: "gpt-5-codex" });
    expect(second.agentPrivKey).toBe(first.agentPrivKey);
    expect(second.agentPubKey).toBe(first.agentPubKey);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.provider).toBe("openai");
    expect(second.model).toBe("gpt-5-codex");
  });

  it("different agents get different keypairs", async () => {
    const { setFrontierConfig } = await import("../agents/frontierKeys.js");
    const a = setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5" });
    const b = setFrontierConfig("a2", { provider: "anthropic", model: "claude-sonnet-5" });
    expect(a.agentPrivKey).not.toBe(b.agentPrivKey);
    expect(a.agentPubKey).not.toBe(b.agentPubKey);
  });

  it("persists across module reloads (round-trip through the file)", async () => {
    const store1 = await import("../agents/frontierKeys.js");
    const written = store1.setFrontierConfig("a1", {
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "sk-ant-abc123xyz",
    });

    vi.resetModules();
    const store2 = await import("../agents/frontierKeys.js");
    const read = store2.getFrontierKeyEntry("a1");
    expect(read).toEqual(written);
  });

  it("apiKey omitted on update leaves a previously stored key untouched", async () => {
    const { setFrontierConfig, getFrontierKeyEntry } = await import("../agents/frontierKeys.js");
    setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-secret-1" });
    setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5-2" });
    expect(getFrontierKeyEntry("a1")?.apiKey).toBe("sk-secret-1");
  });

  it("apiKey: '' clears a previously stored key", async () => {
    const { setFrontierConfig, getFrontierKeyEntry } = await import("../agents/frontierKeys.js");
    setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-secret-1" });
    setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5", apiKey: "" });
    expect(getFrontierKeyEntry("a1")?.apiKey).toBeUndefined();
  });

  it("deleteFrontierConfig removes the stored entry", async () => {
    const { setFrontierConfig, deleteFrontierConfig, getFrontierKeyEntry } = await import(
      "../agents/frontierKeys.js"
    );
    setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5" });
    deleteFrontierConfig("a1");
    expect(getFrontierKeyEntry("a1")).toBeUndefined();
  });

  it("deleteFrontierConfig on an unknown agent is a no-op", async () => {
    const { deleteFrontierConfig } = await import("../agents/frontierKeys.js");
    expect(() => deleteFrontierConfig("nope")).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "writes frontier-keys.json with 0600 permissions (POSIX)",
    async () => {
      const { setFrontierConfig } = await import("../agents/frontierKeys.js");
      setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5" });
      const filePath = path.join(tmpDataDir, "frontier-keys.json");
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  describe("maskFrontierEntry (CONTRACTS §14 — apiKey never leaves via this path)", () => {
    it("returns nulls/false for an undefined entry", async () => {
      const { maskFrontierEntry } = await import("../agents/frontierKeys.js");
      expect(maskFrontierEntry(undefined)).toEqual({
        provider: null,
        model: null,
        hasKey: false,
        last4: null,
      });
    });

    it("reports hasKey: false and last4: null when no key is stored", async () => {
      const { setFrontierConfig, maskFrontierEntry } = await import("../agents/frontierKeys.js");
      const entry = setFrontierConfig("a1", { provider: "anthropic", model: "claude-sonnet-5" });
      const masked = maskFrontierEntry(entry);
      expect(masked).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-5",
        hasKey: false,
        last4: null,
      });
    });

    it("reports hasKey: true and last4 without ever including the raw apiKey", async () => {
      const { setFrontierConfig, maskFrontierEntry } = await import("../agents/frontierKeys.js");
      const entry = setFrontierConfig("a1", {
        provider: "openai",
        model: "gpt-5-codex",
        apiKey: "sk-openai-abcd1234wxyz",
      });
      const masked = maskFrontierEntry(entry);
      expect(masked.hasKey).toBe(true);
      expect(masked.last4).toBe("wxyz");
      expect(JSON.stringify(masked)).not.toContain("sk-openai");
    });
  });
});
