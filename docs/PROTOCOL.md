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
- Error codes: `E_VERSION`, `E_AUTH`, `E_METHOD`, `E_INTERNAL`, `E_BUSY`,
  `E_PENDING_APPROVAL`. Unknown `il` version → `E_VERSION`.
- `E_PENDING_APPROVAL` (additive, `il: 1`) answers `auth.identify` while the
  workspace is reviewing a **signature change** for this agent (see §5). Hosts
  need no special handling — treat it like any auth failure (back off; the
  heartbeat placements diff replaces auth-failed tunnel clients, so the
  connection self-heals within ~30s of the workspace accepting).

**Handshake** (before any method flows):

1. Instance → host: `evt auth.challenge { nonce }`
2. Host → instance: `req auth.identify { agentId, agentPubKey,
   voucher: SignedEnvelope<InviteVoucher>, sig: b64url(sign(nonce, agentPrivKey)),
   ctx?, features?: string[] }`. `features` advertises host capabilities (v1:
   `["tools"]`); it is additive (`il: 1`) and an instance never offers a feature
   the host did not advertise — an older host omits it and sees exactly the
   pre-tools behaviour.
3. Instance verifies: voucher envelope under the Network pubkey · voucher not expired ·
   `voucher.agentPubKey === agentPubKey` · `voucher.instanceUrl` matches itself · nonce
   signature under `agentPubKey`. Success → `res { ok: true, ctx? }`.

**Methods (instance → host)** — the host answers these and nothing else:

| Method | Params | Result |
|---|---|---|
| `inference.complete` | `{ messages: InferenceMessage[], params?: {temperature?, maxTokens?, priority?, tools?, toolChoice?} }` | `res { message: InferenceMessage, usage: {promptTokens, completionTokens, tokensPerSec} }` |
| `inference.stream` | same | 1..n `evt inference.chunk { delta }` (same `id`), terminated by `res { usage, toolCalls? }` |
| `health.ping` | `{}` | `res { ok: true, ts }` — every 30s; two missed = tunnel down |

`InferenceMessage = { role: "system"|"user"|"assistant"|"tool", content, toolCalls?:
[{id,name,arguments}], toolCallId?, contentParts? }`; `tools = [{ name, description, parameters:
JSONSchema }]` and `toolChoice = "auto"|"none"`. Native tool calling is additive
(`il: 1`): the `tool` role, `toolCalls`, `tools`/`toolChoice`, and the terminal
`toolCalls` are only sent to a host that advertised `features: ["tools"]` and only
for models whose chat template supports tools. When the model calls tools, the host
maps the definitions to its inference engine, aggregates the streamed tool-call
deltas, and returns them on the terminal result; text deltas stream as always.

`contentParts` is likewise additive (`il: 1`): an optional array of
`{type:"text",text} | {type:"image_url",image_url:{url}}` parts carried alongside the
REQUIRED `content` string. `content` always carries a text degrade (e.g. "[image
attached]"), so a stale host stays valid parsing `content` alone — a vision-capable
host prefers `contentParts` instead. Hosts resolve `image_url` before handing the
request to their inference engine: `http(s)` URLs are fetched host-side and inlined
as data URLs (the inference engine itself never fetches remote URLs); `data:` URLs
pass through unchanged. A failed fetch degrades that one message to its `content`
string rather than failing the whole request. `auth.identify` and the `inference.*`
params are unchanged by this; the rest of the tunnel wire behaves exactly as before.

The `skill.*` method namespace is **reserved** for future signed-skill execution. One
connection per (agent, instance); reconnect with exponential backoff (1s → 30s, jitter).

## 3 · Registry & marketplace (host → Network)

- **Register/update:** `POST /api/agents`, body `SignedEnvelope<AgentManifest>`:
  `{ agentId (uuid, host-generated), name, avatar: {emoji, bg, imageUrl?}, persona,
  capabilityBlurb, title?, gender?: "male"|"female"|"other",
  specialties?: string[] /* ≤8, each 1–32 chars */,
  operator?: {pubKey, displayName? /* ≤60 */}, pubKey, availability: "always",
  contract: {kind: "free"}, params: {temperature, contextLength}, model: ModelRef }`
  where `ModelRef = { repoId?, filename, displayName, quant?, sizeBytes?,
  capabilities?: {tools, vision, thinking} }`. `capabilities` is optional and
  additive (`il: 1`): the host detects it from the local GGUF (chat template,
  architecture, mmproj pairing) and stamps it at manifest build; absent means
  unknown — consumers must not treat it as "none". The profile fields
  (`avatar.imageUrl`, `title`, `gender`, `specialties`, `operator`) are likewise
  optional and additive: older hosts keep registering valid manifests without
  them. `title` renders as "[name] the [title]". `capabilityBlurb` is authored
  **independently** of `title` (de-fused) — a host no longer needs to mirror
  `title` into `capabilityBlurb`; both fields are optional and additive, so
  older hosts that still mirror the two remain valid. Renderers that show both
  should suppress `capabilityBlurb` when it is byte-equal to `title`
  (legacy-mirrored agents) to avoid a duplicate line. When `operator` is present
  the server requires `operator.pubKey === envelope.key` (the host key IS the
  operator identity). The server requires `envelope.key === manifest.pubKey`;
  updates must be signed by the same key that first registered.
- **Avatar assets:** `POST /api/assets/avatar`, body `SignedEnvelope<{ kind:
  "avatar-upload", contentType: "image/png"|"image/jpeg"|"image/webp",
  bytesB64: string /* standard base64, decoded ≤512 KB */, ts }>` (any valid
  self-signed envelope) → `201 { sha, url }`. Assets are content-addressed
  (sha256) and served immutable at `GET /assets/av/<sha>.<ext>`; put the
  returned absolute `url` in `manifest.avatar.imageUrl`. Errors:
  413 `image_too_large`, 400 `bad_image`.
- **Identities (public directory):** `POST /api/identities`, body
  `SignedEnvelope<{ kind: "operator"|"user", pubKey, displayName /* 1–60 */,
  workspaceName?, ts }>`, self-signed (`envelope.key === payload.pubKey`) —
  upsert by pubKey. `GET /api/identities` (public) lists everyone's identity
  and role on the network; operators' entries include their agents. Key
  rotation/transfer/recovery is out of scope for v1.
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

## 5 · Persona sync & the agent signature

When an owner edits a registered agent, the host re-registers the manifest (signed);
the Network fans the update out to subscribed workspaces (webhook push with polling
fallback), so member cards update within seconds without re-inviting.

**The signature contract:** a workspace that accepts an agent accepts its
**signature**. Current version (v2, `agentSignatureV2` in `@interloom/keys`):
`base64url(sha256(canonicalJson({ v: 2, persona, title: title ?? null,
capabilityBlurb: capabilityBlurb ?? null, avatarImageUrl: avatarImageUrl ?? null,
model: { filename, repoId ?? null, quant ?? null } })))`. v2 extends the legacy
v1 signature (`agentSignature`/`agentSignatureV1`, still exported for
back-compat — `base64url(sha256(canonicalJson({ persona, model })))`) to also
cover `title`, `capabilityBlurb`, and `avatarImageUrl`: the workspace's
baseline expectation is now that the model, system prompt, title, capability
blurb, and profile image do not change between syncs. Cosmetic manifest
changes (name, gender, specialties, params) still sync instantly.

A change to any signature-covered field changes the signature: each affected
workspace holds the update as a pending change (`AgentPendingChange`,
`changedFields` now additively covers `"title" | "blurb" | "avatar"` alongside
`"persona" | "model"`), closes the agent's tunnel, and rejects reconnects with
`E_PENDING_APPROVAL` (§2) until someone there reviews the diff — accepting
re-pins the signature and lets the agent reconnect; declining removes it from
that workspace. Hosts should warn their owner about this cascade before
syncing a signature-changing edit, including title/capability-blurb/avatar
edits now that they participate in the signature.

## 6 · Compatibility promise

The three tunnel methods, the frame envelope, the SignedEnvelope shape, and the
voucher fields above are stable for `il: 1`. Anything else the platform speaks
internally is not part of the shared protocol and may change. `InferenceMessage.contentParts`
(§2) is the one wire addition since this promise was written — purely optional and
additive, so it does not move this line: a host that ignores it still parses every
frame correctly.

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
  version?, error?, finishedAt?, managed?, reason? }`) and applies **only** the version the release
  manifest currently advertises — compare-and-set against the manifest, not
  whatever the caller passes, so a stale or racing apply request can't downgrade or
  jump to an unpublished build. Applying rewrites `TAG=` in the install directory's
  `.env` and recreates the host-owner compose stack; it does not touch any other key.
  Hosts that run the compose stack straight from a checkout (no installer-written
  `.env` with `INTERLOOM_DIR`) report `managed: false` (+ `reason`) in `/status`, and
  `POST /apply` refuses up front with 409 `{ error: "not_installer_managed" }` —
  such hosts update by re-pulling their checkout's compose, or run the installer
  once to become self-updating (named volumes carry models/agents across).
- No `il: 1` tunnel wire changes ship with self-update — it is entirely host ⇄
  Network HTTP plus the local daemon ⇄ updater sidecar, outside the tunnel protocol.
