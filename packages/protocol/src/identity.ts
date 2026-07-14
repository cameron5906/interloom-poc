import { z } from "zod";

/**
 * Identity grant — an identity key delegates bounded authority to a subject
 * key (a workspace device key or a host machine key). Crosses the wire as
 * `SignedEnvelope<IdentityGrant>` where `envelope.key === payload.identityKey`
 * (self-signed by the grantor). Verification lives in `@interloom/keys`
 * (`verifyGrant`) — never re-implemented at a call site (CONTRACTS §2).
 */
export const IdentityGrant = z.object({
  v: z.literal(1),
  identityKey: z.string(),
  subjectKey: z.string(),
  scope: z.enum(["workspace-device", "host-operator"]),
  audience: z.string().optional(),
  issuedAt: z.number(),
  expiresAt: z.number().optional(),
  /** The grantor identity's `session_epoch` at issuance; void once it advances. */
  epoch: z.number(),
  nonce: z.string(),
});
export type IdentityGrant = z.infer<typeof IdentityGrant>;

/** `POST /api/identity/auth/claim` body (CONTRACTS §4). */
export const IdentityAuthClaim = z.object({
  pubKey: z.string(),
  nonce: z.string(),
  sig: z.string(),
  displayName: z.string().min(1).max(60).optional(),
  avatarSha: z.string().optional(),
});
export type IdentityAuthClaim = z.infer<typeof IdentityAuthClaim>;

/** `GET /api/identity/auth/me` / claim response shape (CONTRACTS §4). */
export const IdentitySelf = z.object({
  pubKey: z.string(),
  displayName: z.string(),
  kind: z.enum(["operator", "user"]),
  avatarUrl: z.string().optional(),
});
export type IdentitySelf = z.infer<typeof IdentitySelf>;

/** `GET /api/identity/sessions` entry (CONTRACTS §4). `token` is masked (first 8 chars). */
export const IdentitySessionInfo = z.object({
  token: z.string(),
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  userAgent: z.string().optional(),
});
export type IdentitySessionInfo = z.infer<typeof IdentitySessionInfo>;

/** A workspace an identity has joined — `meta.workspaces` entry / associations body (CONTRACTS §4). */
export const WorkspaceAssociation = z.object({
  instanceUrl: z.string(),
  instanceName: z.string(),
  ts: z.number(),
});
export type WorkspaceAssociation = z.infer<typeof WorkspaceAssociation>;

/** `POST /api/identities/associations` payload (self-signed envelope inner, CONTRACTS §4). */
export const AssociationMutation = z.object({
  kind: z.enum(["workspace.join", "workspace.leave"]),
  pubKey: z.string(),
  instanceUrl: z.string(),
  instanceName: z.string(),
  ts: z.number(),
});
export type AssociationMutation = z.infer<typeof AssociationMutation>;

/** `GET /api/identities/resolve` value (CONTRACTS §4/§5). */
export const ResolvedIdentity = z.object({
  displayName: z.string(),
  avatarUrl: z.string().optional(),
  kind: z.enum(["operator", "user"]),
});
export type ResolvedIdentity = z.infer<typeof ResolvedIdentity>;

// --- Device link (QR / WebRTC raw-key transfer, CONTRACTS §4) ---

/** `POST /api/link/sessions` response. */
export const LinkSession = z.object({
  linkId: z.string(),
  expiresAt: z.number(),
});
export type LinkSession = z.infer<typeof LinkSession>;

/** `/ws/link/:linkId` signaling frames — relayed verbatim between the two peers. */
export const LinkSignalFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("join"), role: z.enum(["issuer", "scanner"]) }),
  z.object({ t: z.literal("peer"), present: z.boolean() }),
  z.object({ t: z.literal("offer"), sdp: z.string() }),
  z.object({ t: z.literal("answer"), sdp: z.string() }),
  z.object({ t: z.literal("ice"), candidate: z.unknown() }),
  z.object({ t: z.literal("blob"), ciphertextB64: z.string(), ivB64: z.string() }),
  z.object({ t: z.literal("done") }),
  z.object({
    t: z.literal("error"),
    code: z.enum(["E_LINK_EXPIRED", "E_LINK_CONSUMED", "E_LINK_FULL", "E_LINK_EPOCH", "E_UNAUTH"]),
  }),
]);
export type LinkSignalFrame = z.infer<typeof LinkSignalFrame>;

/** The cleartext payload carried INSIDE the AES-GCM encrypted device-link blob. */
export const DeviceKeyPayload = z.object({
  v: z.literal(1),
  privKey: z.string(),
  pubKey: z.string(),
  displayName: z.string(),
  avatarSha: z.string().optional(),
});
export type DeviceKeyPayload = z.infer<typeof DeviceKeyPayload>;
