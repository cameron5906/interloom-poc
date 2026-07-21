import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  bytesToB64url,
  canonicalSha256,
  signEnvelope,
  verifyEnvelope,
  type Keypair,
  type SignedEnvelope,
} from "@interloom/keys";
import {
  canonicalOrigin,
  HostTunnelProofV2Payload,
  makeErr,
  makeEvt,
  makeRes,
  parseTunnelFrame,
  type InviteVoucher,
  type Placement,
  type TunnelAuthChallengeV2,
  type TunnelFrame,
} from "@interloom/protocol";

/**
 * A minimal in-process stand-in for the instance-side tunnel server
 * (`apps/instance/src/tunnel/server.ts`) — enough of the real handshake
 * (voucher envelope verification under the network key, voucher expiry,
 * agentId/agentPubKey cross-match, instanceUrl match, nonce signature
 * verification under the agent key, `features` check) plus scriptable
 * `work.*`/`chat.post` responses to drive `TunnelClient` end to end without
 * spinning up the real instance app.
 */

interface AuthIdentifyMockParams {
  agentId: string;
  agentPubKey: string;
  voucher: SignedEnvelope<InviteVoucher>;
  proof: SignedEnvelope<HostTunnelProofV2Payload>;
  features?: string[];
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Mirrors the real instance's `verifyIdentify` (apps/instance/src/tunnel/server.ts):
 *  (a) voucher is a valid SignedEnvelope under the network public key
 *  (b) voucher not expired
 *  (c) voucher.agentPubKey/agentId match the identify params
 *  (d) voucher.instanceUrl matches this instance
 *  (e) nonce signature verifies under agentPubKey
 * Plus the frontierQueue feature gate (CONTRACTS §14).
 */
function verifyMockIdentify(
  params: AuthIdentifyMockParams,
  challenge: TunnelAuthChallengeV2,
  networkPubKey: string,
  instanceUrl: string,
): { ok: true } | { ok: false; reason: string } {
  // Match the real Instance's non-oracular failure surface: callers can learn
  // only that authentication failed, not which credential check was closest.
  const fail = () => ({ ok: false as const, reason: "authentication failed" });

  const { voucher } = params;
  if (voucher.key !== networkPubKey || !verifyEnvelope(voucher)) {
    return fail();
  }

  const payload = voucher.payload;
  const expMs = payload.exp < 1e12 ? payload.exp * 1000 : payload.exp;
  if (expMs <= Date.now()) return fail();

  if (payload.agentPubKey !== params.agentPubKey) return fail();
  if (payload.agentId !== params.agentId) return fail();

  if (normalizeUrl(payload.instanceUrl) !== normalizeUrl(instanceUrl)) return fail();

  const parsedProof = HostTunnelProofV2Payload.safeParse(params.proof?.payload);
  if (
    !parsedProof.success ||
    params.proof.key !== params.agentPubKey ||
    !verifyEnvelope(params.proof) ||
    parsedProof.data.purpose !== "interloom.tunnel-auth.v2" ||
    parsedProof.data.challengeId !== challenge.challengeId ||
    parsedProof.data.nonce !== challenge.nonce ||
    parsedProof.data.issuedAt !== challenge.issuedAt ||
    parsedProof.data.placementId !== voucher.payload.placementId ||
    parsedProof.data.agentId !== params.agentId ||
    parsedProof.data.instanceOrigin !== canonicalOrigin(instanceUrl) ||
    parsedProof.data.voucherDigest !== canonicalSha256(voucher)
  ) {
    return fail();
  }

  if (!params.features?.includes("frontierQueue")) return fail();

  return { ok: true };
}
/** Thrown by a handler to simulate the instance's `E_STALE_LEASE` rejection (CONTRACTS §14). */
export class MockStaleLeaseError extends Error {}

export interface MockInstanceHandlers {
  onPull?(agentId: string, max: number): unknown;
  onBegin?(workId: string): unknown;
  onComplete?(workId: string, text: string, leaseToken: string | undefined): unknown;
  onFail?(workId: string, reason: string, leaseToken: string | undefined): unknown;
  onChatPost?(channelId: string, text: string): unknown;
}

export interface MockInstance {
  port: number;
  instanceUrl: string;
  connections: WebSocket[];
  /** Sends a raw evt frame to the most recently connected socket (e.g. `work.available`). */
  sendEvt(method: string, params?: unknown): void;
  /** Sends a raw req frame to the most recently connected socket and returns its `res`/`err` result. */
  sendReq(method: string, params?: unknown): Promise<unknown>;
  cleanup(): Promise<void>;
}

export async function startMockInstance(
  networkPubKey: string,
  handlers: MockInstanceHandlers = {},
): Promise<MockInstance> {
  const wss = new WebSocketServer({ port: 0 });
  const connections: WebSocket[] = [];
  const pendingFromServer = new Map<string, (frame: TunnelFrame) => void>();

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

  const addr = wss.address() as AddressInfo;
  const instanceUrl = `http://127.0.0.1:${addr.port}`;

  wss.on("connection", (ws) => {
    connections.push(ws);
    const challenge: TunnelAuthChallengeV2 = {
      challengeId: randomUUID(),
      nonce: bytesToB64url(randomBytes(32)),
      issuedAt: Date.now(),
    };
    ws.send(JSON.stringify(makeEvt("auth.challenge.v2", challenge)));

    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString();
      let frame: TunnelFrame;
      try {
        frame = parseTunnelFrame(raw);
      } catch {
        return;
      }

      if (frame.kind === "req" && frame.method === "auth.identify.v2") {
        const params = frame.params as AuthIdentifyMockParams;
        const outcome = verifyMockIdentify(params, challenge, networkPubKey, instanceUrl);
        if (outcome.ok) {
          ws.send(JSON.stringify(makeRes(frame.id, { ok: true })));
        } else {
          ws.send(JSON.stringify(makeErr(frame.id, "E_AUTH", outcome.reason)));
        }
        return;
      }

      if ((frame.kind === "res" || frame.kind === "err") && pendingFromServer.has(frame.id)) {
        const resolver = pendingFromServer.get(frame.id);
        pendingFromServer.delete(frame.id);
        resolver?.(frame);
        return;
      }

      if (frame.kind === "req") {
        const params = (frame.params ?? {}) as Record<string, unknown>;
        try {
          switch (frame.method) {
            case "work.pull": {
              const result = handlers.onPull?.(params.agentId as string, params.max as number) ?? {
                items: [],
              };
              ws.send(JSON.stringify(makeRes(frame.id, result)));
              return;
            }
            case "work.begin": {
              const result = handlers.onBegin?.(params.workId as string) ?? { ok: true };
              ws.send(JSON.stringify(makeRes(frame.id, result)));
              return;
            }
            case "work.complete": {
              const result = handlers.onComplete?.(
                params.workId as string,
                params.text as string,
                params.leaseToken as string | undefined,
              ) ?? { ok: true, messageId: randomUUID() };
              ws.send(JSON.stringify(makeRes(frame.id, result)));
              return;
            }
            case "work.fail": {
              const result = handlers.onFail?.(
                params.workId as string,
                params.reason as string,
                params.leaseToken as string | undefined,
              ) ?? { ok: true };
              ws.send(JSON.stringify(makeRes(frame.id, result)));
              return;
            }
            case "chat.post": {
              const result = handlers.onChatPost?.(
                params.channelId as string,
                params.text as string,
              ) ?? {
                ok: true,
                messageId: randomUUID(),
              };
              ws.send(JSON.stringify(makeRes(frame.id, result)));
              return;
            }
            default:
              ws.send(
                JSON.stringify(makeErr(frame.id, "E_METHOD", `unsupported: ${frame.method}`)),
              );
          }
        } catch (err) {
          // A handler throwing simulates the instance rejecting the call
          // (unknown work item, ownership mismatch, etc.) — same as
          // `TunnelCallError` on the real instance side. A `MockStaleLeaseError`
          // simulates the specific `E_STALE_LEASE` rejection (CONTRACTS §14).
          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof MockStaleLeaseError ? "E_STALE_LEASE" : "E_INTERNAL";
          ws.send(JSON.stringify(makeErr(frame.id, code, message)));
        }
      }
    });
  });

  return {
    port: addr.port,
    instanceUrl,
    connections,
    sendEvt(method, params) {
      const ws = connections[connections.length - 1];
      ws?.send(JSON.stringify(makeEvt(method, params)));
    },
    sendReq(method, params) {
      const ws = connections[connections.length - 1];
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingFromServer.delete(id);
          reject(new Error(`mock instance req ${method} timed out`));
        }, 5000);
        pendingFromServer.set(id, (frame) => {
          clearTimeout(timer);
          if (frame.kind === "err") {
            reject(new Error(`${frame.error.code}: ${frame.error.message}`));
          } else {
            resolve(frame.kind === "res" ? frame.result : undefined);
          }
        });
        ws?.send(JSON.stringify({ il: 1, id, kind: "req", method, params }));
      });
    },
    cleanup: () =>
      new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function makeVoucher(
  networkKeys: Keypair,
  overrides: Partial<InviteVoucher> = {},
): SignedEnvelope<InviteVoucher> {
  const payload: InviteVoucher = {
    v: 1,
    placementId: overrides.placementId ?? "pl-1",
    agentId: overrides.agentId ?? "agent-1",
    agentPubKey: overrides.agentPubKey ?? "",
    instanceUrl: overrides.instanceUrl ?? "",
    instanceName: overrides.instanceName ?? "Test Instance",
    iat: overrides.iat ?? Date.now(),
    exp: overrides.exp ?? Date.now() + 24 * 60 * 60 * 1000,
    nonce: overrides.nonce ?? randomUUID(),
  };
  return signEnvelope(payload, networkKeys.privateKey, networkKeys.publicKey);
}

export function makePlacement(
  instanceUrl: string,
  voucher: SignedEnvelope<InviteVoucher>,
  overrides: Partial<Placement> = {},
): Placement {
  return {
    placementId: voucher.payload.placementId,
    instanceUrl,
    instanceName: voucher.payload.instanceName,
    voucher,
    revoked: false,
    ...overrides,
  };
}
