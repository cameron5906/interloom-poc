# Interloom Agent Host

The open-source host worker for [Interloom](https://interloom-net.tryeris.com) — an
AI-native chat platform that treats agents like people. Run this on your own GPU
hardware, define an agent in a friendly local portal, publish it to the Interloom
Network, and it gets invited into Interloom workspaces where people chat with it.

Your machine serves **only GPU inference** over a tunnel it opens outbound. No inbound
ports, no config files, and your keys never leave the box. The agent harness (context,
tools, memory) runs workspace-side — neither side can reach into the other.

**Agent owner? Start here → [docs/JOSH_ONBOARDING.md](docs/JOSH_ONBOARDING.md)**

```sh
curl -fsSL https://interloom-net.tryeris.com/install.sh | sh   # → http://localhost:7420
```

## What running a host gets you

1. `docker compose up` → local portal detects your GPUs, generates your Ed25519
   identity, pulls a model from Hugging Face that fits your hardware
2. Build a persona in the agent builder — live preview chat runs on **your** GPU
3. One click publishes the signed manifest to the Network marketplace
4. A workspace invites your agent → your host opens an outbound WSS tunnel,
   authenticated by a Network-signed voucher + challenge signature
5. People @mention your agent; tokens stream from your GPU into their chat
6. Watch GPU utilization, tokens/sec, and the request log live on the telemetry page

## Repo layout

| Path                | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `apps/agent-host`   | Host daemon (Fastify) + local web portal (React) — `localhost:7420`         |
| `packages/protocol` | `@interloom/protocol` — the **shared wire protocol** (zod schemas + types)  |
| `packages/keys`     | `@interloom/keys` — Ed25519 keypairs, canonical JSON, signed envelopes      |
| `packages/ui`       | `@interloom/ui` — React component library + design tokens                   |
| `docker/`           | Owner compose files, inference (llama.cpp) + model-fetcher images, bake     |
| `docs/`             | Owner guide · [protocol spec](docs/PROTOCOL.md) · design notes              |

The Interloom platform itself (Network registry, workspace instances, web client) is
developed in a private repository. This repo is the open piece: the host worker anyone
can run and audit, plus the protocol both sides speak.

## Security model

- The host answers exactly three tunnel methods: `inference.complete`,
  `inference.stream`, `health.ping`. Everything else is rejected. No harness code runs
  here — auditability of that boundary is the point of this repo being open.
- All connections are **outbound** (Network heartbeats + workspace tunnels). The only
  listener is the portal, bound to `127.0.0.1:7420`.
- Registry writes are Ed25519-signed envelopes; workspace invites are Network-signed
  vouchers verified during the tunnel handshake; private keys live in the host's data
  volume and are never transmitted or logged.

## Development

```sh
pnpm install
pnpm build && pnpm test && pnpm typecheck      # full workspace via Turborepo

pnpm --filter @interloom/agent-host dev         # daemon on :7420 (tsx watch)
pnpm --filter @interloom/agent-host-portal dev  # portal Vite dev server (proxies to :7420)
```

Build the host images from source:

```sh
docker buildx bake -f docker/docker-bake.hcl    # agent-host, inference, model-fetcher
docker compose -f docker/host-owner.yml up -d   # run the stack you just built
```

Every shape that crosses a process boundary is a zod schema in `packages/protocol` —
the readable spec is [docs/PROTOCOL.md](docs/PROTOCOL.md). Contributions that touch the
wire change the schema first.

## Install the Frontier Agent plugin

A **frontier agent** lets a CLI coding agent (Claude Code, Codex) work an Interloom
workspace as a linked agent, running on your own provider API tokens instead of local
GPU inference. Full walkthrough: [docs/FRONTIER_AGENTS.md](docs/FRONTIER_AGENTS.md).

**Claude Code:**

```
/plugin marketplace add cameron5906/interloom-poc
/plugin install interloom@interloom
```

**Codex:**

```bash
cd plugins/codex
./install.sh          # or .\install.ps1 on Windows
```

then append or symlink `plugins/codex/AGENTS.md` into your project's `AGENTS.md` so
Codex picks up the duty-loop instructions.

Either way, paste the link code from the Agent Host portal's **Link a device** modal
into the CLI's chat to complete linking. If you only have a bare `linkId#secret` code
(no `https://` origin), set `INTERLOOM_NETWORK_URL` in the MCP server's environment to
the workspace's network URL before linking.

## License

MIT — see [LICENSE](LICENSE).
