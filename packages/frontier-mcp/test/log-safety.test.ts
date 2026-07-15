import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FrontierLinkPayload } from "@interloom/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentCredential, loadCredentials, removeAgentCredential, saveAgentCredential } from "../src/credentials.js";
import { log } from "../src/log.js";
import { FrontierService } from "../src/service.js";

const SECRET_API_KEY = "sk-ant-super-secret-do-not-log-1234567890";
const PRIVATE_KEY = "agent-private-key-must-not-be-logged-either";

let tmpHome: string;
let previousHome: string | undefined;

function payload(): FrontierLinkPayload {
  return {
    v: 1,
    kind: "frontier-agent",
    agentId: "agent-log-safety",
    agentName: "Log Safety Agent",
    agentPrivKey: PRIVATE_KEY,
    agentPubKey: "pub-log-safety",
    networkUrl: "https://network.example.com",
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: SECRET_API_KEY,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-mcp-log-safety-"));
  previousHome = process.env.INTERLOOM_HOME;
  process.env.INTERLOOM_HOME = tmpHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.INTERLOOM_HOME;
  else process.env.INTERLOOM_HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Negative test (pinned-interfaces §E / task brief): captures every byte
 * written to stderr — the ONLY channel this package logs to — while
 * driving the REAL production code paths (credentials, `FrontierService`
 * link/start/status, a failing heartbeat) with a credential that carries a
 * distinctive API key and private key. The captured output must never
 * contain either secret, across every log level.
 */
describe("API keys and agent private keys never reach a log line", () => {
  it("never appear in stderr across credentials + service link/start/status + a failing heartbeat", async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    });

    try {
      const cred = payload();

      // Direct credential-store round trip.
      saveAgentCredential(cred);
      loadCredentials();
      loadAgentCredential(cred.agentId);
      removeAgentCredential(cred.agentId);
      saveAgentCredential(cred);

      // Drive the real FrontierService path: link (injected scanner returns
      // the secret-bearing payload), start (heartbeat fires immediately and
      // fails against an unreachable fetch — network.ts's real catch/log
      // path runs), status.
      const service = new FrontierService({
        scanLinkFn: async () => cred,
        fetchImpl: (async () => {
          throw new Error("network unreachable");
        }) as unknown as typeof fetch,
        heartbeatIntervalMs: 60_000,
        queuePollMs: 60_000,
      });

      await service.linkWithCode("https://network.example.com/link/abc#def");
      service.start();
      // Let the immediate heartbeat tick (and its failure log) flush.
      await new Promise((resolve) => setTimeout(resolve, 20));
      service.status();
      service.stop();
      service.unlink(cred.agentId);
    } finally {
      spy.mockRestore();
    }

    const output = chunks.join("");
    expect(output).not.toContain(SECRET_API_KEY);
    expect(output).not.toContain(PRIVATE_KEY);
  });

  it("log lines only ever go to stderr, never stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      log.info("hello", { agentId: "a1" });
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
