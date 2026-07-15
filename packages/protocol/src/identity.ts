import { z } from "zod";
import { signedEnvelope } from "./envelope.js";

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

/**
 * `POST /api/link/sessions` response. `kind` (additive) distinguishes a
 * frontier-agent link from an ordinary device link (CONTRACTS §14); absent ⇒ device.
 */
export const LinkSession = z.object({
  linkId: z.string(),
  expiresAt: z.number(),
  kind: z.enum(["device", "frontier-agent"]).optional(),
});
export type LinkSession = z.infer<typeof LinkSession>;

/** Client-asserted device fingerprint shown to the issuer during device-link approval (CONTRACTS §4). Spoofable — display-only, never a security boundary. */
export const LinkCandidateFingerprint = z.object({
  os: z.string().optional(),
  browser: z.string().optional(),
  deviceType: z.string().optional(),
});
export type LinkCandidateFingerprint = z.infer<typeof LinkCandidateFingerprint>;

/**
 * Signed-envelope auth carried in the issuer's `join` frame on
 * `/ws/link/:linkId` for `kind: "frontier-agent"` sessions (CONTRACTS §4/§14).
 * The agent-host portal browser holds no network identity cookie (that's a
 * browser-only credential the headless daemon never has), so a frontier
 * session's issuer authenticates the WS join with this envelope instead —
 * exclusively; device-kind sessions never consult it, cookie path only.
 * `envelope.key` must equal the session's `issuer_pub_key`; `linkId` must
 * match the room being joined. Lives here (not `frontier.ts`) because
 * `frontier.ts` sits inside the frontier↔chat↔registry schema cycle and this
 * file is a leaf relative to it — importing this schema back from
 * `frontier.ts` would close that cycle through here.
 */
export const FrontierLinkIssuerAuth = z.object({
  linkId: z.string(),
  role: z.literal("issuer"),
  nonce: z.string(),
  iat: z.number(),
});
export type FrontierLinkIssuerAuth = z.infer<typeof FrontierLinkIssuerAuth>;

/**
 * Host-signed key attestation extending the operator→host grant chain one
 * hop further to operator→host→agent (CONTRACTS §6/§14). Crosses the wire
 * as `SignedEnvelope<FrontierHostAttestation>` in `AgentManifest`'s additive
 * `hostAttestation` field, signed under the HOST key. A frontier manifest is
 * (correctly, by key-custody design) self-signed under the agent's own
 * keypair, never the host key, so the network's operator-grant check
 * (`grant.payload.subjectKey === envelope.key`) can never hold there without
 * this: the attestation vouches that the host with the bound operator grant
 * also vouches for `agentPubKey`, so the grant chain's `subjectKey` check
 * runs against `hostAttestation.key` instead of `envelope.key`. Lives here
 * (not `frontier.ts`) for the same schema-cycle reason as
 * `FrontierLinkIssuerAuth` above.
 */
export const FrontierHostAttestation = z.object({
  agentId: z.string(),
  agentPubKey: z.string(),
  iat: z.number(),
});
export type FrontierHostAttestation = z.infer<typeof FrontierHostAttestation>;

/**
 * `/ws/link/:linkId` signaling frames — relayed verbatim between peers in the room.
 * `candidateId` / `issuerEphPk` are base64 raw ECDH P-256 public keys of the scanner's
 * and issuer's ephemeral keypairs (respectively), generated fresh per link and used to
 * derive the v2 blob key (CONTRACTS §4) — they identify a candidate device for the
 * duration of one pairing session, never persisted beyond it.
 */
export const LinkSignalFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("join"),
    role: z.enum(["issuer", "scanner"]),
    /** Additive (CONTRACTS §4/§14) — a frontier-agent-kind session's issuer
     * carries this instead of an identity cookie; ignored for every other
     * join (device-kind issuer, and scanner joins of either kind). */
    auth: signedEnvelope(FrontierLinkIssuerAuth).optional(),
  }),
  z.object({ t: z.literal("peer"), present: z.boolean() }),
  z.object({ t: z.literal("hello"), candidateId: z.string(), fp: LinkCandidateFingerprint }),
  z.object({ t: z.literal("candidate"), candidateId: z.string(), fp: LinkCandidateFingerprint, ip: z.string().optional() }),
  z.object({ t: z.literal("approve"), candidateId: z.string(), issuerEphPk: z.string() }),
  z.object({ t: z.literal("approved"), issuerEphPk: z.string(), issuerName: z.string().optional() }),
  z.object({ t: z.literal("reject"), candidateId: z.string() }),
  z.object({ t: z.literal("rejected") }),
  z.object({ t: z.literal("confirm") }),
  z.object({ t: z.literal("candidate_gone"), candidateId: z.string() }),
  z.object({ t: z.literal("offer"), sdp: z.string() }),
  z.object({ t: z.literal("answer"), sdp: z.string() }),
  z.object({ t: z.literal("ice"), candidate: z.unknown() }),
  z.object({
    t: z.literal("blob"),
    ciphertextB64: z.string(),
    ivB64: z.string(),
    v: z.literal(2).optional(),
  }),
  z.object({ t: z.literal("done") }),
  z.object({
    t: z.literal("error"),
    code: z.enum([
      "E_LINK_EXPIRED",
      "E_LINK_CONSUMED",
      "E_LINK_FULL",
      "E_LINK_EPOCH",
      "E_UNAUTH",
      "E_LINK_REJECTED",
    ]),
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
