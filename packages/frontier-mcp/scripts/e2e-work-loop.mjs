#!/usr/bin/env node
// A persistent MCP client session that behaves like a real CLI agent on
// duty: ONE spawned interloom-mcp server process, repeated
// interloom_next_work / interloom_submit calls over the SAME stdio
// connection (matching the pinned §D guidance loop). Do not spawn a fresh
// server per tool call for work-loop testing — each server process owns
// its own in-memory queue buffer and tunnel, so a one-shot driver process
// per call races the queue against itself. Run one of these per linked
// agent session you want "on duty" during manual verification.
//
// Usage (run from packages/frontier-mcp so the SDK resolves):
//   node scripts/e2e-work-loop.mjs <serverPath> <homeDir> <logPath> [replyPrefix]
//
// Replies are canned text (no real provider call — a fake API key is
// expected in the linked credential). Ctrl+C / SIGTERM closes the client
// cleanly (tears the tunnel down, so the agent goes offline in the UI).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const [, , serverPath, homeDir, logPath, replyPrefix] = process.argv;
if (!serverPath || !homeDir || !logPath) {
  console.error("usage: node scripts/e2e-work-loop.mjs <serverPath> <homeDir> <logPath> [replyPrefix]");
  process.exit(1);
}

function log(line) {
  fs.appendFileSync(logPath, `[work-loop ${new Date().toISOString()}] ${line}\n`);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, INTERLOOM_HOME: homeDir },
    stderr: "pipe",
  });
  const client = new Client({ name: "interloom-e2e-work-loop", version: "0.0.1" });
  await client.connect(transport);
  transport.stderr?.on("data", (c) => fs.appendFileSync(logPath, `[server-stderr] ${c}`));
  log("connected");

  const shutdown = async () => {
    log("shutting down");
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let n = 0;
  for (;;) {
    n++;
    const res = await client.callTool(
      { name: "interloom_next_work", arguments: { waitSeconds: 20 } },
      undefined,
      { timeout: 30000 },
    );
    const parsed = JSON.parse(res.content[0].text);
    if (parsed.item) {
      log(
        `[poll ${n}] got work item workId=${parsed.item.workId} channel=${parsed.item.channelName} trigger="${parsed.item.trigger.text}"`,
      );
      const replyText = `${replyPrefix ?? "Hello! This is the frontier agent replying"} (work ${parsed.item.workId.slice(0, 8)}).`;
      const submitRes = await client.callTool(
        { name: "interloom_submit", arguments: { workId: parsed.item.workId, text: replyText } },
        undefined,
        { timeout: 30000 },
      );
      log(`[poll ${n}] submitted: ${JSON.stringify(submitRes.content[0].text)}`);
    } else {
      log(`[poll ${n}] empty queue`);
    }
  }
}

main().catch((e) => {
  log(`fatal: ${e.stack || e}`);
  process.exit(1);
});
