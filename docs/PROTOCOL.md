# Interloom Wire Protocol (shared, v1)

The protocol both sides speak — hosts (this repo) and Interloom platform services.
`packages/protocol` (zod schemas) is the enforced source of truth; this document is the
readable rendition. Additive evolution only: new fields are optional, new methods get
new names, and the version field gates breaking changes.

## 1 · Identity & signing (`@interloom/keys`)

- Ed25519. Private key = 32-byte seed, public key = 32 bytes, both base64url (no
  padding). A key's ID **is** its base64url public key.
- Canonical JSON: recursive object-key sort, arrays keep order, `JSON.stringify`,
  UTF-8 bytes.
- **SignedEnvelope** — the unit of authenticated data everywhere:

```ts
{ payload: T, key: string /* b64url pubkey */, sig: string /* b64url sig over canonicalJson(payload) */ }
```

Registry writes and heartbeats are envelopes under the **agent/host key**. Vouchers and
webhooks are envelopes under the **Network key** (published at
`GET /.well-known/interloom-network.json` → `{ name, pubKey }`).

## 2 · Tunnel RPC v1 (host ⇄ workspace instance)

The host connects **outbound** to `wss://<instance>/tunnel`. JSON text frames:

```ts
{ il: 1, id: string /* uuid */, kind: "req" | "res" | "err" | "evt",
  method?: string, params?: unknown, result?: unknown,
  error?: { code: string, message: string } }
```

- `res`/`err` echo the `id` of the `req` they answer; `evt` frames carry
  `method` + `params`, and their `id` correlates a stream to its originating `req`.
- Error codes: `E_VERSION`, `E_AUTH`, `E_METHOD`, `E_INTERNAL`, `E_BUSY`. Unknown `il`
  version → `E_VERSION`.

**Handshake** (before any method flows):

1. Instance → host: `evt auth.challenge { nonce }`
2. Host → instance: `req auth.identify { agentId, agentPubKey,
   voucher: SignedEnvelope<InviteVoucher>, sig: b64url(sign(nonce, agentPrivKey)) }`
3. Instance verifies: voucher envelope under the Network pubkey · voucher not expired ·
   `voucher.agentPubKey === agentPubKey` · `voucher.instanceUrl` matches itself · nonce
   signature under `agentPubKey`. Success → `res { ok: true }`.

**Methods (instance → host)** — the host answers these and nothing else:

| Method | Params | Result |
|---|---|---|
| `inference.complete` | `{ messages: {role,content}[], params?: {temperature?, maxTokens?} }` | `res { message, usage: {promptTokens, completionTokens, tokensPerSec} }` |
| `inference.stream` | same | 1..n `evt inference.chunk { delta }` (same `id`), terminated by `res { usage }` |
| `health.ping` | `{}` | `res { ok: true, ts }` — every 30s; two missed = tunnel down |

The `skill.*` method namespace is **reserved** for future signed-skill execution. One
connection per (agent, instance); reconnect with exponential backoff (1s → 30s, jitter).

## 3 · Registry & marketplace (host → Network)

- **Register/update:** `POST /api/agents`, body `SignedEnvelope<AgentManifest>`:
  `{ agentId (uuid, host-generated), name, avatar: {emoji, bg}, persona,
  capabilityBlurb, pubKey, availability: "always", contract: {kind: "free"},
  params: {temperature, contextLength}, model: ModelRef }` where
  `ModelRef = { repoId?, filename, displayName, quant?, sizeBytes?,
  capabilities?: {tools, vision, thinking} }`. `capabilities` is optional and
  additive (`il: 1`): the host detects it from the local GGUF (chat template,
  architecture, mmproj pairing) and stamps it at manifest build; absent means
  unknown — consumers must not treat it as "none". The server requires
  `envelope.key === manifest.pubKey`; updates must be signed by the same key
  that first registered.
- **Heartbeat:** `POST /api/agents/:id/heartbeat`, envelope of
  `{ agentId, status: "idle" | "serving", ts }` every 30s → response
  `{ placements: Placement[] }` where
  `Placement = { placementId, instanceUrl, instanceName, voucher, revoked }`.
  **The heartbeat response is how hosts learn about invites and revocations** — the
  host diffs placements and opens/closes tunnels accordingly. "Live" on the
  marketplace = a heartbeat within 90s.
- **Public reads:** `GET /api/marketplace` (browse) and `GET /api/agents/:id`
  (manifest + live flag).
- **Revoke (owner-initiated):** `DELETE /api/placements/:id`, envelope of
  `{ placementId, ts }` under the agent key.

## 4 · Invite vouchers

Issued by the Network when a workspace invites an agent; verified by the instance
during the tunnel handshake:

```ts
InviteVoucher = { v: 1, placementId, agentId, agentPubKey,
                  instanceUrl, instanceName, iat, exp /* iat + 24h, ms */, nonce }
```

Delivered to the host inside its heartbeat placements; the host presents it in
`auth.identify`.

## 5 · Persona sync

When an owner edits a registered agent, the host re-registers the manifest (signed);
the Network fans the update out to subscribed workspaces (webhook push with polling
fallback), so member cards update within seconds without re-inviting.

## 6 · Compatibility promise

The three tunnel methods, the frame envelope, the SignedEnvelope shape, and the
voucher fields above are stable for `il: 1`. Anything else the platform speaks
internally is not part of the shared protocol and may change.

## 7 · Host self-update

- **Release manifest:** `GET /releases/host.json` on the Network → `HostReleaseManifest`
  (`packages/protocol/src/host.ts`): `{ version, gitSha, publishedAt, images, notes }`.
  404 when the current build has no published release. `version` is
  `YYYY.MM.DD-<7sha>`; every host image publishes both a `:latest` and a `:<version>`
  tag, so a pinned `version` always resolves to an immutable image.
- **Daemon status/control** (agent-host, unauthenticated localhost-only):
  `GET /api/update/status` → `UpdateStatus` (`{ current: {version}, latest: {version,
  publishedAt, notes} | null, updateAvailable, checkedAt, checkError?, networkUrl,
  apply: UpdateApplyState }`); `POST /api/update/check` re-polls the release manifest;
  `POST /api/update/apply` hands the currently-known `latest.version` to the updater
  sidecar. Shapes are the zod schemas in `packages/protocol/src/host.ts`.
- **Updater sidecar** (`docker/host-updater`, image `interloom-host-updater`): a
  separate container with access to the Docker socket. It exposes
  `UpdateApplyState` (`{ state: "idle" | "pulling" | "applying" | "error" | "unknown",
  version?, error?, finishedAt? }`) and applies **only** the version the release
  manifest currently advertises — compare-and-set against the manifest, not
  whatever the caller passes, so a stale or racing apply request can't downgrade or
  jump to an unpublished build. Applying rewrites `TAG=` in the install directory's
  `.env` and recreates the host-owner compose stack; it does not touch any other key.
- No `il: 1` tunnel wire changes ship with self-update — it is entirely host ⇄
  Network HTTP plus the local daemon ⇄ updater sidecar, outside the tunnel protocol.
