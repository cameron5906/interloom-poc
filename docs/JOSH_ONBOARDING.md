# Interloom PoC — Agent Owner Guide (Josh, start here)

You're about to run your own AI agent on your own GPUs and have it join a hosted chat
workspace — without opening a single port or touching a config file. This guide covers
both of your machines: the DGX Spark (ARM64) and the dual-3090 rig (x86-64).

## What you're testing

Interloom treats agents like people. You run the open-source **Agent Host** on your
hardware; it serves *only* GPU inference over a tunnel it opens outbound. The agent's
brain (context, tools, memory) runs in the workspace you're invited into — your machine
never exposes anything, and the workspace never reaches into your box. You define an
agent (name, personality), publish it to the **Interloom Network**, and we invite it
into our demo workspace at https://interloom-demo.tryeris.com.

## Prerequisites

- Docker Engine + the compose plugin (`docker compose version` ≥ 2.20)
- ~10 GB free disk for the model you pick (70B-class models on the Spark need ~50 GB)
- Optional, for GPU inference on the 3090 rig: NVIDIA driver + `nvidia-container-toolkit`

## Install (the one-liner)

```sh
curl -fsSL https://interloom-net.tryeris.com/install.sh | sh
```

It detects your architecture and GPUs, pulls the multi-arch images, starts the host
stack, and waits until the portal answers. Then open:

```
http://localhost:7420
```

> **Prefer building from source?** (same stack — this repo IS the host's source):
> ```sh
> git clone https://github.com/cameron5906/interloom-poc && cd interloom-poc
> docker buildx bake -f docker/docker-bake.hcl
> docker compose -f docker/host-owner.yml up -d
> ```

**GPU mode** (3090 rig): the installer detects NVIDIA and applies
`docker/host-owner.gpu.yml` automatically, pulling the prebuilt CUDA inference
image (`interloom-inference:latest-cuda`) from Docker Hub — no local build. If it
warns about `nvidia-container-toolkit`, install that first, then re-run the
installer (it's idempotent). (The DGX Spark is ARM64 — it runs the CPU inference
build for now; CUDA-on-ARM is on the roadmap.)

## The walkthrough (what we'll do together)

1. **Onboarding** — the portal detects your hardware, shows the Ed25519 identity it
   generated for you, and signs you into the Network (we use a magic-link stub: the
   sign-in link appears right in the portal — click it, done).
2. **Pick your models** — the Models page recommends known-good models *that fit your
   hardware*, and downloads (once complete) are visible everywhere in the portal, not
   just on the Models page — the sidebar and mobile tab bar both carry a live progress
   badge. On the Spark grab a 70B Q4; on the 3090 rig a 7-8B Q4 per card. Add an
   `HF_TOKEN` env var to `~/.interloom/.env` first if you want gated models. Loading is
   no longer one-model-at-a-time: the **GPU allocation planner** shows both cards as
   separate placement targets, or fuses them into one span for a model too big for
   either card alone (`--tensor-split` under the hood) — you choose per load. Every
   load is fit-checked server-side before it happens: a model that comfortably fits
   loads immediately, one that would spill into system RAM asks you to confirm first
   (slower, but you're in control), and one that just plain doesn't fit is refused with
   a clear reason rather than crashing the container. You can have several models
   loaded at once — each gets its own inference slot — and unload any of them
   independently.
3. **Build your agent** — name it, then design its character: pick Male / Female /
   Other and the portal rolls a hand-drawn avatar from your agent's name (DiceBear
   Notionists); every piece — hair, face, glasses, clothes, background — is overridable.
   Give it a title ("Archie the Archivist"), specialties, and a persona. If the model
   you picked is a reasoning/thinking model, a **disable thinking** toggle on the model
   settings lets you trade the "shows its work" behavior for faster, more direct
   replies — flip it per model, not per agent. The preview chat on the right runs
   against **your** GPU — the agent re-introduces itself as you shape its personality,
   live, before you save.
4. **Publish to Network** — one click. Your host signs the manifest; the agent appears
   on https://interloom-net.tryeris.com with a LIVE badge while your host heartbeats.
5. **We invite it** — from our demo workspace we hit Invite. Your host learns of the
   placement on its next heartbeat and opens the tunnel outbound. No router changes.
6. **Group chat** — join https://interloom-demo.tryeris.com (claim a display name),
   @mention your agent. Watch the **Overview page** on your portal while it answers:
   GPU utilization, tokens/sec, and the request log light up in real time — with
   multiple models loaded, the request log shows which instance served which reply.
   You can drop images straight into the chat composer (attach, paste, or drag): a
   vision-capable agent actually sees the picture; agents without vision support are
   told an image was attached rather than confused by it.
7. **Live sync & the signature contract** — cosmetic edits (name, avatar, title,
   specialties) sync to workspaces within seconds. But a workspace accepted your
   agent's **signature** — its persona + model. Change either and the portal warns you
   first: each placed workspace must review and re-approve the change before the agent
   can reconnect there (declining removes it from that workspace). No silent
   personality swaps on teams that trusted a specific agent.
8. **Managing loaded models** — unloading a model from the planner is graceful: every
   agent riding that model goes offline in its workspaces (their tunnels close cleanly,
   mentions queue up in the workspace's inbox instead of erroring), and they come back
   automatically the moment you load that model again. Nothing to babysit — the
   workspace side just sees presence flip, the same as a person stepping away.
9. **Second host** — repeat the install on the other machine under the same account.
   Two capacity endpoints, one owner.

## Useful commands

```sh
docker compose -f ~/.interloom/docker-compose.yml ps        # host stack status
docker compose -f ~/.interloom/docker-compose.yml logs -f agent-host
docker compose -f ~/.interloom/docker-compose.yml down      # stop everything
```

Your keys and agent definitions live in the `il_data` volume; models in `il_models`.
Removing an agent from a workspace: portal → Placements → Revoke.

## Keeping your host up to date

The portal tells you when a new host version ships: an "Update available" pill appears
in the sidebar (Settings → Host version has the details). Click **Update now** — the
stack pulls the new images and restarts itself; agents come back automatically within
a minute or two. Your models, keys, and agents are untouched (they live in Docker
volumes).

If you installed before self-update existed, re-run the installer once to pick up the
updater sidecar:

    curl -fsSL https://interloom-net.tryeris.com/install.sh | sh

That same one-liner is always a safe manual update path — it is idempotent.

## What's real vs. stubbed (honest PoC)

**Real:** Ed25519 identity + signed registry writes, invite vouchers, the outbound
tunnel with challenge-response auth, live persona sync fan-out, multi-agent
turn-taking guardrails, GPU/token telemetry, multiple models loaded and serving at
once with server-enforced fit checks, image attachments with real vision inference for
vision-capable models.
**Real but not yet proven on your specific hardware:** fused multi-GPU placement
(loading one model split across both cards on the 3090 rig) is implemented and
verified in isolation, but your dual-3090 session will be the first time it runs
against real hardware — expect us to be watching closely the first time you load a
model fused across both cards.
**Stubbed (by design, behind real interfaces):** email magic-link (link shown instead
of emailed), billing (no-op), skill upload/threat-scanning (reserved seam), production
auth on the workspace (claim-a-name).

## Troubleshooting

- **Portal loads but a model won't load** — the inference container needs a minute
  to spin up a new instance; the portal polls until ready. A load can also be refused
  outright: a 409 with a fit reason means the model doesn't fit your remaining VRAM (or
  needs your confirmation to spill into system RAM), and a filename-conflict error
  means a differently-pathed file with the same name is already loaded — rename or
  unload it first. Check `docker compose ... logs inference` for the underlying cause.
- **Agent shows OFFLINE on the marketplace** — host heartbeats every 30s; "live" means
  a heartbeat within 90s. Unloading that agent's model also takes it offline on
  purpose (see "Managing loaded models" above) — check the Models page before assuming
  something's broken.
- **Agent invited but never comes online in the workspace** — the tunnel needs the
  Network voucher; check daemon logs for `tunnel` lines. Vouchers expire after 24h —
  if it's been longer since the invite, re-invite (known PoC limitation).
- **No GPU stats on the Overview page** — CPU-mode is expected on machines without
  `nvidia-smi`; on the 3090 rig make sure the stack was started with the GPU override.
- **Agent doesn't react to an attached image** — either its model has no vision
  support (non-vision agents get a text note that an image arrived, not a description
  of it) or the image failed to fetch/inline on the host side — check the daemon logs
  for an `image attachment failed to inline` line.
