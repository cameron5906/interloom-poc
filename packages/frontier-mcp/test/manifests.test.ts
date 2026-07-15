import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function readJson(relPath: string): unknown {
  const full = path.join(repoRoot, relPath);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

describe("Claude Code plugin manifest (plugins/claude-code/.claude-plugin/plugin.json)", () => {
  const manifest = readJson("plugins/claude-code/.claude-plugin/plugin.json") as Record<string, unknown>;

  it("parses and carries every required field", () => {
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.displayName).toBe("string");
    expect(typeof manifest.version).toBe("string");
    expect(typeof manifest.description).toBe("string");
    expect(manifest.mcpServers).toBe("./.mcp.json");
  });

  it("matches the pinned plugin.json contents exactly", () => {
    expect(manifest).toEqual({
      name: "interloom",
      displayName: "Interloom Frontier Agent",
      version: "0.1.0",
      description: "Work Interloom workspaces as a linked frontier agent",
      mcpServers: "./.mcp.json",
    });
  });
});

describe("Claude Code plugin MCP config (plugins/claude-code/.mcp.json)", () => {
  const config = readJson("plugins/claude-code/.mcp.json") as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };

  it("registers the interloom server via node + the plugin-root-relative bundle", () => {
    expect(config.mcpServers.interloom).toBeDefined();
    expect(config.mcpServers.interloom.command).toBe("node");
    expect(config.mcpServers.interloom.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/interloom-mcp.js"]);
  });
});

describe("repo-root marketplace manifest (.claude-plugin/marketplace.json)", () => {
  const manifest = readJson(".claude-plugin/marketplace.json") as {
    name: string;
    owner: { name: string };
    plugins: Array<{ name: string; source: string; description: string; version: string }>;
  };

  it("parses and carries every required field", () => {
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.owner?.name).toBe("string");
    expect(Array.isArray(manifest.plugins)).toBe(true);
    expect(manifest.plugins.length).toBeGreaterThan(0);
    for (const plugin of manifest.plugins) {
      expect(typeof plugin.name).toBe("string");
      expect(typeof plugin.source).toBe("string");
      expect(typeof plugin.description).toBe("string");
      expect(typeof plugin.version).toBe("string");
    }
  });

  it("lists the interloom plugin pointing at plugins/claude-code", () => {
    const entry = manifest.plugins.find((p) => p.name === "interloom");
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("./plugins/claude-code");
  });
});

describe("committed plugin bundles", () => {
  it("both plugins ship the interloom-mcp.js bundle", () => {
    for (const rel of ["plugins/claude-code/server/interloom-mcp.js", "plugins/codex/server/interloom-mcp.js"]) {
      const full = path.join(repoRoot, rel);
      expect(fs.existsSync(full), `${rel} should exist (run: pnpm --filter @interloom/frontier-mcp bundle)`).toBe(true);
      const contents = fs.readFileSync(full, "utf8");
      expect(contents.startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });
});
