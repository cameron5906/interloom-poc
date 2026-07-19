import { z } from "zod";

/** CONTRACTS §17 — the public package/runtime contract for Eris Scribes. */
export const ScribeConnectionKind = z.enum(["postgres", "http"]);
export type ScribeConnectionKind = z.infer<typeof ScribeConnectionKind>;

export const ScribeConnectionSlot = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  kind: ScribeConnectionKind,
  label: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  required: z.boolean().default(true),
});
export type ScribeConnectionSlot = z.infer<typeof ScribeConnectionSlot>;

export const ScribeOutputContract = z.object({
  mode: z.enum(["single-file", "tree"]),
  defaultName: z.string().min(1).max(255).optional(),
  contentTypes: z.array(z.string()).max(32).optional(),
});
export type ScribeOutputContract = z.infer<typeof ScribeOutputContract>;

export const ScribeManifestV1 = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  runtime: z.literal("node22"),
  entrypoint: z.string().regex(/^dist\/[A-Za-z0-9._/-]+\.mjs$/),
  configSchema: z.record(z.unknown()).default({ type: "object", properties: {} }),
  connections: z.array(ScribeConnectionSlot).max(16).default([]),
  output: ScribeOutputContract,
  timeoutSeconds: z.number().int().min(1).max(900).default(300),
  homepage: z.string().url().optional(),
  license: z.string().max(80).optional(),
});
export type ScribeManifestV1 = z.infer<typeof ScribeManifestV1>;

export const ScribeReviewStatus = z.enum([
  "pending_review",
  "approved",
  "rejected",
  "quarantined",
  "revoked",
]);
export type ScribeReviewStatus = z.infer<typeof ScribeReviewStatus>;

export const ScribeRevisionRecord = z.object({
  revisionId: z.string(),
  scribeId: z.string(),
  publisherKey: z.string(),
  manifest: ScribeManifestV1,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactBytes: z.number().int().nonnegative(),
  status: ScribeReviewStatus,
  reviewNotes: z.string().max(4000).optional(),
  submittedAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
});
export type ScribeRevisionRecord = z.infer<typeof ScribeRevisionRecord>;

export const SignedScribeRevision = z.object({
  payload: ScribeRevisionRecord,
  key: z.string(),
  sig: z.string(),
});
export type SignedScribeRevision = z.infer<typeof SignedScribeRevision>;

/** Shared Context read shapes used by hosted tools and Frontier MCP. */
export const ContextListParams = z.object({
  path: z.string().default("/"),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  ref: z.string().optional(),
});
export type ContextListParams = z.infer<typeof ContextListParams>;

export const ContextWireEntry = z.object({
  id: z.string().optional(),
  path: z.string(),
  name: z.string(),
  kind: z.enum(["folder", "file"]),
  subtype: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
  mimeType: z.string().optional(),
  source: z
    .object({
      kind: z.enum(["native", "repository", "scribe"]),
      id: z.string(),
      label: z.string().optional(),
    })
    .optional(),
});
export type ContextWireEntry = z.infer<typeof ContextWireEntry>;

export const ContextListResult = z.object({
  entries: z.array(ContextWireEntry),
  nextCursor: z.string().optional(),
});
export type ContextListResult = z.infer<typeof ContextListResult>;

export const ContextReadParams = z.object({
  path: z.string().min(1),
  ref: z.string().optional(),
  offset: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().min(1).max(65536).default(2048),
});
export type ContextReadParams = z.infer<typeof ContextReadParams>;

export const ContextReadResult = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().default(0),
  nextOffset: z.number().int().nonnegative().optional(),
  binary: z.boolean(),
  truncated: z.boolean(),
  encoding: z.enum(["utf8", "none"]),
  content: z.string().optional(),
});
export type ContextReadResult = z.infer<typeof ContextReadResult>;
