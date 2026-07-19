import { z } from "zod";
import { signedEnvelope } from "./envelope.js";
import { IdentityGrant } from "./identity.js";

export const ShellNotifyPayload = z.object({
  workspaceOrigin: z.string(),
  channelId: z.string(),
  title: z.string(),
  body: z.string(),
  iconUrl: z.string().optional(),
});
export type ShellNotifyPayload = z.infer<typeof ShellNotifyPayload>;

export const ShellNotificationClickPayload = z.object({
  workspaceOrigin: z.string(),
  channelId: z.string(),
});
export type ShellNotificationClickPayload = z.infer<typeof ShellNotificationClickPayload>;

export interface InterloomShellBridge {
  readonly version: 1;
  notify(payload: ShellNotifyPayload): void;
  onNotificationClick(handler: (payload: ShellNotificationClickPayload) => void): () => void;
}

// §15a postMessage transport for iframe-hosted workspaces (Capacitor/mobile
// shell). `il_shell` versions this transport independently of the tunnel's
// `il`; evolution is additive-only.
export const ShellBridgeNotifyMessage = z.object({
  il_shell: z.literal(1),
  type: z.literal("notify"),
  payload: ShellNotifyPayload,
});
export type ShellBridgeNotifyMessage = z.infer<typeof ShellBridgeNotifyMessage>;

export const ShellBridgeNotificationClickMessage = z.object({
  il_shell: z.literal(1),
  type: z.literal("notification-click"),
  payload: ShellNotificationClickPayload,
});
export type ShellBridgeNotificationClickMessage = z.infer<
  typeof ShellBridgeNotificationClickMessage
>;

const WorkspaceAuthAddress = z.object({
  workspaceId: z.string().min(1).max(200),
  workspaceOrigin: z.string().url(),
});

/** Parent shell -> embedded workspace: begin or resume shell-owned authentication. */
export const ShellBridgeWorkspaceAuthInitMessage = z.object({
  il_shell: z.literal(1),
  type: z.literal("workspace-auth-init"),
  payload: WorkspaceAuthAddress.extend({
    /** Canonical Network identity the workspace must report after authentication. */
    expectedIdentityKey: z.string().min(1).optional(),
    /** Authentication mechanism available to this shell installation. */
    authMethod: z.enum(["omni-device", "workspace-grant"]).optional(),
  }),
});
export type ShellBridgeWorkspaceAuthInitMessage = z.infer<
  typeof ShellBridgeWorkspaceAuthInitMessage
>;

/**
 * Legacy embedded workspace -> parent shell request. Kept for rolling upgrades:
 * released shells and workspaces use this origin-scoped browser grant flow.
 */
export const ShellBridgeWorkspaceAuthRequestV1Message = z.object({
  il_shell: z.literal(1),
  type: z.literal("workspace-auth-request"),
  payload: WorkspaceAuthAddress.extend({
    requestId: z.string().min(1).max(200),
    subjectKey: z.string().min(1),
  }),
});
export type ShellBridgeWorkspaceAuthRequestV1Message = z.infer<
  typeof ShellBridgeWorkspaceAuthRequestV1Message
>;

/** Embedded workspace -> parent shell: sign this instance-issued live nonce. */
export const ShellBridgeWorkspaceAuthRequestMessage = z.object({
  il_shell: z.literal(2),
  type: z.literal("workspace-auth-request"),
  payload: WorkspaceAuthAddress.extend({
    requestId: z.string().min(1).max(200),
    nonce: z.string().min(1).max(4096),
  }),
});
export type ShellBridgeWorkspaceAuthRequestMessage = z.infer<
  typeof ShellBridgeWorkspaceAuthRequestMessage
>;

/** Legacy parent shell -> embedded workspace origin-scoped browser grant. */
export const ShellBridgeWorkspaceAuthGrantV1Message = z.object({
  il_shell: z.literal(1),
  type: z.literal("workspace-auth-grant"),
  payload: WorkspaceAuthAddress.extend({
    requestId: z.string().min(1).max(200),
    grant: signedEnvelope(IdentityGrant),
  }),
});
export type ShellBridgeWorkspaceAuthGrantV1Message = z.infer<
  typeof ShellBridgeWorkspaceAuthGrantV1Message
>;

/** Parent shell -> embedded workspace: proof from the identity-authorized Omni device. */
export const ShellBridgeWorkspaceAuthGrantMessage = z.object({
  il_shell: z.literal(2),
  type: z.literal("workspace-auth-grant"),
  payload: WorkspaceAuthAddress.extend({
    requestId: z.string().min(1).max(200),
    pubKey: z.string().min(1),
    nonce: z.string().min(1).max(4096),
    sig: z.string().min(1),
    displayName: z.string().min(1).max(60).optional(),
    grant: signedEnvelope(IdentityGrant),
  }),
});
export type ShellBridgeWorkspaceAuthGrantMessage = z.infer<
  typeof ShellBridgeWorkspaceAuthGrantMessage
>;

/** Embedded workspace -> parent shell: the same-origin claim is complete (or failed). */
export const ShellBridgeWorkspaceAuthStateMessage = z.object({
  il_shell: z.literal(1),
  type: z.literal("workspace-auth-state"),
  payload: WorkspaceAuthAddress.extend({
    state: z.enum(["ready", "pending", "rejected", "failed"]),
    /** Server-confirmed canonical identity for non-failed states. */
    identityKey: z.string().min(1).optional(),
    message: z.string().max(240).optional(),
  }),
});
export type ShellBridgeWorkspaceAuthStateMessage = z.infer<
  typeof ShellBridgeWorkspaceAuthStateMessage
>;

/**
 * Exact message signed by a reusable Omni device key. Binding the instance
 * origin prevents one workspace from using the shell as a signing oracle for
 * another workspace's live nonce.
 */
export function omniWorkspaceProofMessage(workspaceOrigin: string, nonce: string): string {
  const origin = new URL(workspaceOrigin).origin;
  return JSON.stringify({ purpose: "eris.omni-workspace-auth", v: 1, origin, nonce });
}

declare global {
  interface Window {
    interloomShell?: InterloomShellBridge;
  }
}
