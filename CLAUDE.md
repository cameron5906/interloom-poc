# Interloom Agent Host — contributor conventions

This is the open-source Agent Host + shared wire protocol. The Interloom platform
(Network, workspaces) is developed privately; changes here affect the host that agent
owners run on their own hardware, against published `cameron59061/interloom-*` images.

## Conventions

- pnpm 10 workspaces + Turborepo, Node ≥ 22, ESM everywhere, TypeScript strict.
- **`packages/protocol` is the wire truth.** Change the zod schema first; apps import
  shapes, never redefine them. The human-readable spec is `docs/PROTOCOL.md`.
- **Wire compatibility promise:** within tunnel version `il: 1`, evolution is
  additive-only — new fields optional, new methods new names. Hosts and workspaces
  update independently; never assume lockstep.
- Frontends: plain CSS on `--il-*` design tokens from `@interloom/ui`
  (`docs/DESIGN_NOTES.md`), Geist via fontsource, no Tailwind. Human avatars are
  circles; agent avatars are rounded squares; the AGENT badge appears wherever an
  agent is named.
- Gates before any PR: `pnpm install && pnpm build && pnpm test && pnpm typecheck`
  all green from the root.

## Verification expectations (not optional)

- **Dockerfile changes:** boot the image and hit an endpoint — pnpm workspace
  `node_modules` are symlinks, so an image can build fine and crash on start. Runtime
  stages do a real workspace-layout `pnpm install`; keep that pattern.
- **Portal (UI) changes:** drive the affected flow in a browser. Typecheck can't see
  runtime response-shape mistakes.
- **Daemon inference paths:** strict chat templates (e.g. Gemma-2) reject
  non-alternating conversation roles — all llama.cpp payloads go through
  `src/inference/normalize.ts`. Don't bypass it; multi-party chat produces
  consecutive same-role turns by nature.

## Architecture invariants (the point of this repo being open)

- The host answers exactly three tunnel methods: `inference.complete`,
  `inference.stream`, `health.ping` — the agent harness never runs on the owner's
  machine. Everything else is rejected.
- All connections are outbound (Network heartbeats, workspace tunnels). The only
  listener is the portal on `127.0.0.1:7420`.
- Private keys live in the data volume, are never transmitted, logged, or returned by
  any API. HF tokens likewise never appear in responses or logs.
- The active model determines agent availability: hosts heartbeat and tunnel only for
  agents attached to the loaded model, and all of a model's agents share one
  inference instance through the priority gate (interactive > maintenance).
