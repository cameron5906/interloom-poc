import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FrontierLinkPayload } from "@interloom/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialsDir,
  credentialsFilePath,
  loadAgentCredential,
  loadCredentials,
  removeAgentCredential,
  saveAgentCredential,
} from "../src/credentials.js";

let tmpHome: string;
let previousHome: string | undefined;

function payload(agentId: string, overrides: Partial<FrontierLinkPayload> = {}): FrontierLinkPayload {
  return {
    v: 1,
    kind: "frontier-agent",
    agentId,
    agentName: `Agent ${agentId}`,
    agentPrivKey: `priv-${agentId}`,
    agentPubKey: `pub-${agentId}`,
    networkUrl: "https://network.example.com",
    provider: "anthropic",
    model: "claude-sonnet-5",
    ...overrides,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-mcp-creds-"));
  previousHome = process.env.INTERLOOM_HOME;
  process.env.INTERLOOM_HOME = tmpHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.INTERLOOM_HOME;
  else process.env.INTERLOOM_HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("credentials store (pinned-interfaces §E)", () => {
  it("returns an empty list when no file exists yet", () => {
    expect(loadCredentials()).toEqual([]);
  });

  it("respects INTERLOOM_HOME for the store location", () => {
    expect(credentialsDir()).toBe(tmpHome);
    expect(credentialsFilePath()).toBe(path.join(tmpHome, "credentials.json"));
  });

  it("persists an agent and reloads it", () => {
    saveAgentCredential(payload("a1"));
    const loaded = loadCredentials();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.agentId).toBe("a1");
    expect(loadAgentCredential("a1")?.agentName).toBe("Agent a1");
  });

  it("supports multiple linked agents", () => {
    saveAgentCredential(payload("a1"));
    saveAgentCredential(payload("a2"));
    const loaded = loadCredentials();
    expect(loaded.map((a) => a.agentId).sort()).toEqual(["a1", "a2"]);
  });

  it("overwrites an existing entry for the same agentId instead of duplicating", () => {
    saveAgentCredential(payload("a1", { model: "claude-sonnet-5" }));
    saveAgentCredential(payload("a1", { model: "gpt-5-codex", provider: "openai" }));
    const loaded = loadCredentials();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.model).toBe("gpt-5-codex");
    expect(loaded[0]?.provider).toBe("openai");
  });

  it("removes an agent by id and reports whether it existed", () => {
    saveAgentCredential(payload("a1"));
    saveAgentCredential(payload("a2"));
    expect(removeAgentCredential("a1")).toBe(true);
    expect(removeAgentCredential("a1")).toBe(false);
    expect(loadCredentials().map((a) => a.agentId)).toEqual(["a2"]);
  });

  it("writes the file with mode 0600 and the dir with mode 0700 (POSIX only)", () => {
    if (process.platform === "win32") return;
    saveAgentCredential(payload("a1"));
    const fileMode = fs.statSync(credentialsFilePath()).mode & 0o777;
    const dirMode = fs.statSync(credentialsDir()).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("tolerates a corrupt/invalid credentials file by treating it as empty", () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(credentialsFilePath(), "not json at all", "utf8");
    expect(loadCredentials()).toEqual([]);
  });

  it("shape on disk matches { v: 1, agents: [...] }", () => {
    saveAgentCredential(payload("a1"));
    const raw = JSON.parse(fs.readFileSync(credentialsFilePath(), "utf8")) as unknown;
    expect(raw).toEqual({ v: 1, agents: [payload("a1")] });
  });
});
