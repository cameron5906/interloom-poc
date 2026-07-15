#!/usr/bin/env node
// Scripted stdio MCP client for exercising the real bundled interloom-mcp
// server (packages/frontier-mcp/dist/interloom-mcp.js or either
// plugins/*/server/interloom-mcp.js copy) exactly like Claude Code / Codex
// would — speaks the real @modelcontextprotocol/sdk client protocol, not a
// hand-rolled JSON-RPC shim. One tool call per invocation; see
// e2e-work-loop.mjs for a persistent multi-call session.
//
// Usage (run from packages/frontier-mcp so @modelcontextprotocol/sdk
// resolves — Node ESM resolves bare specifiers relative to the importing
// file's own location, not the process cwd):
//   node scripts/e2e-driver.mjs <serverPath> <toolName> [jsonArgs] \
//     [--home <dir>] [--network <url>] [--capture <file>]
//
// INTERLOOM_HOME / INTERLOOM_NETWORK_URL env vars are forwarded to the
// spawned server if --home/--network are not given. All server stderr
// (never stdout — the transport owns stdout) is appended to --capture, if
// given, alongside the JSON result, for auditing (e.g. confirming an API
// key never appears in server logs).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") opts.home = argv[++i];
    else if (a === "--network") opts.network = argv[++i];
    else if (a === "--capture") opts.capture = argv[++i];
    else positional.push(a);
  }
  return { positional, opts };
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [serverPath, toolName, jsonArgsRaw] = positional;
  if (!serverPath || !toolName) {
    console.error(
      "usage: node scripts/e2e-driver.mjs <serverPath> <toolName> [jsonArgs] [--home dir] [--network url] [--capture file]",
    );
    process.exit(1);
  }
  const toolArgs = jsonArgsRaw ? JSON.parse(jsonArgsRaw) : {};

  const env = { ...process.env };
  if (opts.home) env.INTERLOOM_HOME = opts.home;
  if (opts.network) env.INTERLOOM_NETWORK_URL = opts.network;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
    stderr: "pipe",
  });

  if (opts.capture) {
    fs.appendFileSync(
      opts.capture,
      `\n--- launch ${new Date().toISOString()} tool=${toolName} args=${JSON.stringify(toolArgs)} ---\n`,
    );
  }

  const client = new Client({ name: "interloom-e2e-driver", version: "0.0.1" });
  await client.connect(transport);

  if (opts.capture && transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      fs.appendFileSync(opts.capture, `[server-stderr] ${chunk.toString()}`);
    });
  }

  try {
    const result = await client.callTool(
      { name: toolName, arguments: toolArgs },
      undefined,
      { timeout: 180000 }, // generous — interloom_link waits on human approval
    );
    if (opts.capture) {
      fs.appendFileSync(opts.capture, `[result] ${JSON.stringify(result)}\n`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("driver failed:", err);
  process.exit(1);
});
