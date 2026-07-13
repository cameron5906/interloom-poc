import type { AgentManifest, ModelCapabilities } from "@interloom/protocol";
import { signEnvelope } from "@interloom/keys";
import { MODELS_DIR } from "../config.js";
import { getKeypair } from "../keys.js";
import { networkRegisterAgent } from "../network/client.js";
import { capabilitiesForFilename } from "../models/scan.js";
import { listAgents, updateAgent, type Agent } from "./store.js";

type CapabilityLookup = (filename: string) => ModelCapabilities | undefined;

const localLookup: CapabilityLookup = (filename) =>
  capabilitiesForFilename(MODELS_DIR, filename);

/** Manifest for the network registry — model capabilities stamped from the local parse. */
export function buildAgentManifest(
  agent: Agent,
  pubKey: string,
  lookup: CapabilityLookup = localLookup,
): AgentManifest {
  if (!agent.model) {
    throw new Error("agent has no model — cannot register");
  }
  const capabilities = lookup(agent.model.filename) ?? agent.model.capabilities;
  return {
    agentId: agent.agentId,
    name: agent.name,
    avatar: agent.avatar,
    persona: agent.persona,
    capabilityBlurb: agent.capabilityBlurb,
    pubKey,
    availability: "always",
    contract: { kind: "free" },
    params: agent.params,
    model: { ...agent.model, ...(capabilities ? { capabilities } : {}) },
  };
}

export async function registerAgentOnNetwork(agent: Agent): Promise<void> {
  const keypair = getKeypair();
  const manifest = buildAgentManifest(agent, keypair.publicKey);
  const envelope = signEnvelope(manifest, keypair.privateKey, keypair.publicKey);
  await networkRegisterAgent(envelope);
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
