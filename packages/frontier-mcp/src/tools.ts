import { z } from "zod";
import type { NextWorkResult, StatusReport } from "./service.js";
import type { ContextListResult, ContextReadResult } from "@interloom/protocol";
import { EXTRA_GUIDANCE, GUIDANCE } from "./guidance.js";

/**
 * The slice of `FrontierService`'s public API the tool handlers depend on —
 * kept as a structural interface (rather than importing the concrete class)
 * so unit tests can stub it directly instead of standing up the real
 * credentials/tunnel/queue machinery.
 */
export interface FrontierServiceLike {
  linkWithCode(code: string): Promise<{ agentName: string }>;
  status(): StatusReport;
  nextWork(waitMs: number): Promise<NextWorkResult | null>;
  submit(workId: string, text: string): Promise<{ messageId?: string; posted?: boolean }>;
  pass(workId: string): Promise<void>;
  skip(workId: string, reason: string): Promise<void>;
  post(agentId: string | null, channelId: string, text: string): Promise<{ messageId: string }>;
  contextList(
    agentId: string | null,
    params: { path?: string; ref?: string; limit?: number },
  ): Promise<ContextListResult>;
  contextRead(
    agentId: string | null,
    params: { path: string; ref?: string; offset?: number; maxBytes?: number },
  ): Promise<ContextReadResult>;
  unlink(agentId: string): void;
}

/** Frontier MCP tool surface, extended additively with shared Context reads. */
export const TOOL_NAMES = [
  "interloom_link",
  "interloom_status",
  "interloom_next_work",
  "interloom_submit",
  "interloom_pass",
  "interloom_skip",
  "interloom_post",
  "interloom_context_list",
  "interloom_context_read",
  "interloom_unlink",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(json: unknown, guidance: string): ToolTextResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(json) },
      { type: "text", text: guidance },
    ],
  };
}

function err(message: string): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

async function guarded(fn: () => Promise<ToolTextResult>): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const LinkInput = { code: z.string().min(1) };
export const StatusInput = {};
export const NextWorkInput = { waitSeconds: z.number().int().min(1).max(60).optional() };
export const SubmitInput = { workId: z.string().min(1), text: z.string().min(1) };
export const PassInput = { workId: z.string().min(1) };
export const SkipInput = { workId: z.string().min(1), reason: z.string().min(1) };
export const PostInput = {
  agentId: z.string().min(1).optional(),
  channelId: z.string().min(1),
  text: z.string().min(1),
};
export const UnlinkInput = { agentId: z.string().min(1) };
export const ContextListInput = {
  agentId: z.string().min(1).optional(),
  path: z.string().optional(),
  ref: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
export const ContextReadInput = {
  agentId: z.string().min(1).optional(),
  path: z.string().min(1),
  ref: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  maxBytes: z.number().int().min(1).max(65536).optional(),
};

const DEFAULT_WAIT_SECONDS = 25;
const MAX_WAIT_SECONDS = 60;

/**
 * Thin handlers: validate (zod, via the SDK's own inputSchema check) →
 * call the `FrontierService` facade verbatim → format as compact JSON +
 * the pinned §D guidance string. No business logic lives here.
 */
export function createToolHandlers(service: FrontierServiceLike) {
  return {
    interloom_link: (args: { code: string }) =>
      guarded(async () => {
        const result = await service.linkWithCode(args.code);
        return ok(result, GUIDANCE.linked);
      }),

    interloom_status: () =>
      guarded(async () => {
        const result = service.status();
        return ok(result, EXTRA_GUIDANCE.status);
      }),

    interloom_next_work: (args: { waitSeconds?: number }) =>
      guarded(async () => {
        const waitSeconds = Math.min(args.waitSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
        const result = await service.nextWork(waitSeconds * 1000);
        if (!result) {
          return ok({ item: null }, GUIDANCE.emptyQueue);
        }
        return ok(
          { item: result.item },
          result.item.kind === "attention" ? GUIDANCE.afterAttention : GUIDANCE.afterWork,
        );
      }),

    interloom_submit: (args: { workId: string; text: string }) =>
      guarded(async () => {
        const result = await service.submit(args.workId, args.text);
        return ok(
          result,
          result.posted === false ? GUIDANCE.afterSuppressed : GUIDANCE.afterSubmit,
        );
      }),

    interloom_pass: (args: { workId: string }) =>
      guarded(async () => {
        await service.pass(args.workId);
        return ok({ ok: true }, GUIDANCE.afterPass);
      }),

    interloom_skip: (args: { workId: string; reason: string }) =>
      guarded(async () => {
        await service.skip(args.workId, args.reason);
        return ok({ ok: true }, EXTRA_GUIDANCE.afterSkip);
      }),

    interloom_post: (args: { agentId?: string; channelId: string; text: string }) =>
      guarded(async () => {
        const result = await service.post(args.agentId ?? null, args.channelId, args.text);
        return ok(result, EXTRA_GUIDANCE.afterPost);
      }),

    interloom_context_list: (args: {
      agentId?: string;
      path?: string;
      ref?: string;
      limit?: number;
    }) =>
      guarded(async () =>
        ok(
          await service.contextList(args.agentId ?? null, {
            path: args.path,
            ref: args.ref,
            limit: args.limit,
          }),
          "Use interloom_context_read to inspect a file; list nested folders by passing their path.",
        ),
      ),

    interloom_context_read: (args: {
      agentId?: string;
      path: string;
      ref?: string;
      offset?: number;
      maxBytes?: number;
    }) =>
      guarded(async () =>
        ok(
          await service.contextRead(args.agentId ?? null, {
            path: args.path,
            ref: args.ref,
            offset: args.offset,
            maxBytes: args.maxBytes,
          }),
          "If nextOffset is present, call this tool again with that offset to continue.",
        ),
      ),

    interloom_unlink: (args: { agentId: string }) =>
      guarded(async () => {
        service.unlink(args.agentId);
        return ok({ ok: true }, EXTRA_GUIDANCE.afterUnlink);
      }),
  };
}
