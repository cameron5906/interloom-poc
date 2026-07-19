import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const bundlePath = path.join(pkgRoot, "dist", "interloom-mcp.js");
const bundleExists = fs.existsSync(bundlePath);

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

function readNdjsonLines(chunk: string, carry: string, onLine: (line: string) => void): string {
  let buf = carry + chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim().length > 0) onLine(line);
  }
  return buf;
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-mcp-bundle-smoke-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe.skipIf(!bundleExists)("dist/interloom-mcp.js stdio smoke test", () => {
  it("speaks MCP initialize over stdio and lists exactly the 10 pinned tools", async () => {
    const child = spawn("node", [bundlePath], {
      env: { ...process.env, INTERLOOM_HOME: tmpHome },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: JsonRpcMessage[] = [];
    let carry = "";
    child.stdout.on("data", (chunk: Buffer) => {
      carry = readNdjsonLines(chunk.toString("utf8"), carry, (line) => {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      });
    });

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));

    async function waitForResponse(id: number): Promise<JsonRpcMessage> {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const message = messages.find((item) => item.id === id);
        if (message) return message;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `timed out waiting for JSON-RPC response ${id}; stderr: ${stderrChunks.join("")}`,
      );
    }

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "bundle-smoke-test", version: "0.0.0" },
          },
        })}\n`,
      );

      const initializeResponse = await waitForResponse(1);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      );

      const toolsListResponse = await waitForResponse(2);
      expect(initializeResponse?.result).toMatchObject({ serverInfo: { name: "interloom" } });

      const tools =
        (toolsListResponse?.result as { tools: Array<{ name: string }> } | undefined)?.tools ?? [];
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...TOOL_NAMES].sort());

      // Every stdout line parsed as JSON-RPC above (a stray log line would have
      // thrown in the JSON.parse above); logs land on stderr instead.
      expect(stderrChunks.join("")).toMatch(/interloom-mcp stdio server ready/);
    } finally {
      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (!child.killed) child.kill("SIGKILL");
    }
  }, 15_000);
});

if (!bundleExists) {
  describe("dist/interloom-mcp.js stdio smoke test", () => {
    it.skip(`skipped: bundle not built — run "pnpm --filter @interloom/frontier-mcp bundle" first`, () => {});
  });
}
