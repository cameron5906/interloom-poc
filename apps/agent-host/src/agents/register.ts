import type { AgentManifest, ModelCapabilities } from "@interloom/protocol";
import { signEnvelope } from "@interloom/keys";
import { MODELS_DIR } from "../config.js";
import { getKeypair } from "../keys.js";
import { getOperatorDisplayName } from "../settings.js";
import { getOperatorBinding, setOperatorGrantStale } from "../operatorBind.js";
import { networkRegisterAgent, NetworkApiError } from "../network/client.js";
import { capabilitiesForFilename } from "../models/scan.js";
import { listAgents, updateAgent, type Agent } from "./store.js";

type CapabilityLookup = (filename: string) => ModelCapabilities | undefined;

const localLookup: CapabilityLookup = (filename) =>
  capabilitiesForFilename(MODELS_DIR, filename);

/**
 * Manifest for the network registry — model capabilities stamped from the
 * local parse; `title`/`gender`/`specialties`/`operator` stamped from the
 * stored agent + host identity (CONTRACTS §6). The DiceBear `character`
 * recipe (§12) stays host-side — only the rendered `imageUrl` travels.
 * `title` and `capabilityBlurb` are authored independently (CONTRACTS §4
 * de-fusion) — the manifest carries whatever the operator set for each.
 *
 * `operator` reflects the bound network identity when this host has
 * completed operator binding (`operator: { pubKey: identityKey, displayName,
 * grant }`, `operator.pubKey ≠` the manifest-signing host key — the network
 * verifies the grant chain instead). An unbound host keeps the legacy rule
 * (`operator.pubKey === envelope.key`, no grant) so old hosts keep working.
 */
export function buildAgentManifest(
  agent: Agent,
  pubKey: string,
  lookup: CapabilityLookup = localLookup,
  operatorDisplayName: string = getOperatorDisplayName(),
  operatorBinding: ReturnType<typeof getOperatorBinding> = getOperatorBinding(),
): AgentManifest {
  if (!agent.model) {
    throw new Error("agent has no model — cannot register");
  }
  const capabilities = lookup(agent.model.filename) ?? agent.model.capabilities;
  return {
    agentId: agent.agentId,
    name: agent.name,
    avatar: {
      emoji: agent.avatar.emoji,
      bg: agent.avatar.bg,
      ...(agent.avatar.imageUrl ? { imageUrl: agent.avatar.imageUrl } : {}),
    },
    persona: agent.persona,
    capabilityBlurb: agent.capabilityBlurb,
    pubKey,
    availability: "always",
    contract: { kind: "free" },
    params: { ...agent.params, contextLength: 0 },
    model: { ...agent.model, ...(capabilities ? { capabilities } : {}) },
    ...(agent.title ? { title: agent.title } : {}),
    ...(agent.gender ? { gender: agent.gender } : {}),
    ...(agent.specialties && agent.specialties.length > 0 ? { specialties: agent.specialties } : {}),
    operator: operatorBinding
      ? {
          pubKey: operatorBinding.identityKey,
          displayName: operatorBinding.displayName,
          grant: operatorBinding.grant,
        }
      : { pubKey, displayName: operatorDisplayName },
  };
}

export async function registerAgentOnNetwork(agent: Agent): Promise<void> {
  const keypair = getKeypair();
  const manifest = buildAgentManifest(agent, keypair.publicKey);
  const envelope = signEnvelope(manifest, keypair.privateKey, keypair.publicKey);
  try {
    await networkRegisterAgent(envelope);
  } catch (err) {
    // Surface a stale operator grant (CONTRACTS §11.7 — the network revoked
    // all grants for this identity since it was issued) on the binding state
    // instead of letting it disappear into a per-call catch/log — this is
    // the ONE place every register/re-register path funnels through.
    if (err instanceof NetworkApiError && err.status === 403 && err.body.includes("operator grant epoch stale")) {
      setOperatorGrantStale(true);
    }
    throw err;
  }
  setOperatorGrantStale(false);
  if (
    manifest.model.capabilities &&
    JSON.stringify(manifest.model.capabilities) !== JSON.stringify(agent.model?.capabilities)
  ) {
    updateAgent(agent.agentId, { model: manifest.model });
  }
}

/**
 * One-time boot backfill: registered agents whose stored model lacks
 * capabilities but is locally parseable get re-registered once, so existing
 * agents don't wait for a manual edit (spec: cross-service flow).
 */
export async function backfillCapabilities(log: (msg: string) => void): Promise<void> {
  for (const agent of listAgents()) {
    if (!agent.registered || !agent.model || agent.model.capabilities) continue;
    if (!localLookup(agent.model.filename)) continue;
    try {
      await registerAgentOnNetwork(agent);
      updateAgent(agent.agentId, { syncedAt: new Date().toISOString() });
      log(`capability backfill re-registered ${agent.name}`);
    } catch (err) {
      log(`capability backfill failed for ${agent.name}: ${String(err)}`);
    }
  }
}
