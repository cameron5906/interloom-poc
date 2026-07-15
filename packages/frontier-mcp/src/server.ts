import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "./log.js";
import { FrontierService } from "./service.js";
import {
  LinkInput,
  NextWorkInput,
  PostInput,
  SkipInput,
  StatusInput,
  SubmitInput,
  UnlinkInput,
  createToolHandlers,
  type FrontierServiceLike,
} from "./tools.js";

/** Registers the 7 pinned-interfaces §C tools against `service` on `server`. */
export function registerTools(server: McpServer, service: FrontierServiceLike): void {
  const handlers = createToolHandlers(service);

  server.registerTool(
    "interloom_link",
    {
      title: "Link an Interloom frontier agent",
      description:
        "Runs the scanner role of the Interloom device-link flow against the network relay for a pasted link code (full link URL, or a bare linkId#secret — a bare code needs INTERLOOM_NETWORK_URL set or an already-linked agent to resolve the network). On approval it persists the credential and starts serving that agent.",
      inputSchema: LinkInput,
    },
    handlers.interloom_link,
  );

  server.registerTool(
    "interloom_status",
    {
      title: "Interloom frontier agent status",
      description: "Reports online/offline, placements, tunnel states, queue depth, and items done this session for every linked agent.",
      inputSchema: StatusInput,
    },
    handlers.interloom_status,
  );

  server.registerTool(
    "interloom_next_work",
    {
      title: "Pull the next Interloom work item",
      description:
        "Long-polls the merged FCFS queue across every placement of every linked agent. Call this again after every result — an empty result means keep polling, not stop.",
      inputSchema: NextWorkInput,
    },
    handlers.interloom_next_work,
  );

  server.registerTool(
    "interloom_submit",
    {
      title: "Submit a reply for an Interloom work item",
      description: "Delivers the composed reply for a work item pulled from interloom_next_work.",
      inputSchema: SubmitInput,
    },
    handlers.interloom_submit,
  );

  server.registerTool(
    "interloom_skip",
    {
      title: "Skip an Interloom work item",
      description: "Fails a work item with a reason; it is requeued up to 3 attempts before being marked dead.",
      inputSchema: SkipInput,
    },
    handlers.interloom_skip,
  );

  server.registerTool(
    "interloom_post",
    {
      title: "Post proactively to an Interloom channel",
      description: "Sends a proactive message as a linked agent to a channel it is a member of (agentId optional when exactly one agent is linked).",
      inputSchema: PostInput,
    },
    handlers.interloom_post,
  );

  server.registerTool(
    "interloom_unlink",
    {
      title: "Unlink an Interloom frontier agent",
      description: "Removes the stored credential for an agent and closes its tunnels.",
      inputSchema: UnlinkInput,
    },
    handlers.interloom_unlink,
  );
}

/**
 * Boots the stdio MCP server: loads persisted credentials, starts the
 * facade, registers tools, and connects the stdio transport. Never writes
 * to stdout outside the transport — `log` is stderr-only.
 */
export async function main(): Promise<void> {
  const service = new FrontierService();
  service.loadCredentials();
  service.start();

  const server = new McpServer({ name: "interloom", version: "0.1.0" });
  registerTools(server, service);

  const shutdown = (): void => {
    log.info("shutting down");
    service.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("interloom-mcp stdio server ready");
}
