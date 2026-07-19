#!/usr/bin/env node
import { loadAgentCredential } from "./credentials.js";
import { log } from "./log.js";
import { main as serveStdio } from "./server.js";
import { FrontierService } from "./service.js";

const HELP = `interloom-mcp — Eris frontier agent MCP server

Usage:
  interloom-mcp                    Start the stdio MCP server (default; run this
                                    from your Claude Code / Codex MCP config)
  interloom-mcp status             One-shot status of every linked agent, then exit
  interloom-mcp print-key <agentId>
                                    Print the stored provider API key for <agentId>
                                    to stdout, then exit.

                                    WARNING: this prints a SECRET. It is an explicit
                                    user command, never an MCP tool — no MCP tool in
                                    this server ever returns or logs a provider API
                                    key or agent private key. Only run this yourself,
                                    in a terminal you trust, and never paste the
                                    output into chat with any agent.
`;

async function runStatus(): Promise<void> {
  const service = new FrontierService();
  const loaded = service.loadCredentials();
  if (loaded.length === 0) {
    process.stdout.write(`${JSON.stringify({ agents: [] })}\n`);
    return;
  }
  service.start();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const report = service.status();
  service.stop();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function runPrintKey(agentId: string | undefined): void {
  if (!agentId) {
    process.stderr.write("interloom-mcp print-key: missing <agentId>\n");
    process.exitCode = 1;
    return;
  }
  const cred = loadAgentCredential(agentId);
  if (!cred) {
    process.stderr.write(`interloom-mcp print-key: no linked agent found for "${agentId}"\n`);
    process.exitCode = 1;
    return;
  }
  if (!cred.apiKey) {
    process.stderr.write(`interloom-mcp print-key: agent "${agentId}" has no stored provider API key\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${cred.apiKey}\n`);
}

async function run(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case undefined:
    case "serve":
      await serveStdio();
      return;
    case "status":
      await runStatus();
      return;
    case "print-key":
      runPrintKey(rest[0]);
      return;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`interloom-mcp: unknown command "${command}"\n\n${HELP}`);
      process.exitCode = 1;
  }
}

run().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
