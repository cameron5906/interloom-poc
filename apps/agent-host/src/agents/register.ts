import type {
  AgentManifest,
  ModelCapabilities,
  ModelRef,
  FrontierRuntimeConfig,
  FrontierHostAttestation,
} from "@interloom/protocol";
import { signEnvelope, type Keypair } from "@interloom/keys";
import { MODELS_DIR } from "../config.js";
import { getKeypair } from "../keys.js";
import { getFrontierKeyEntry } from "./frontierKeys.js";
import { getOperatorDisplayName } from "../settings.js";
import { getOperatorBinding, setOperatorGrantStale } from "../operatorBind.js";
import { networkRegisterAgent, NetworkApiError } from "../network/client.js";
import { capabilitiesForFilename } from "../models/scan.js";
import { listAgents, updateAgent, type Agent } from "./store.js";

type CapabilityLookup = (filename: string) => ModelCapabilities | undefined;

const localLookup: CapabilityLookup = (filename) => capabilitiesForFilename(MODELS_DIR, filename);

/**
 * The ModelRef a frontier agent's manifest declares in place of a local GGUF
 * (CONTRACTS §14) — frontier agents never require a local model download or
 * load, so `publish`/`register` must not gate on one.
 */
function synthesizeFrontierModelRef(frontier: FrontierRuntimeConfig): ModelRef {
  return {
    filename: `frontier:${frontier.provider}/${frontier.model}`,
    displayName: frontier.model,
    capabilities: { tools: true, vision: false, thinking: true },
  };
}

/** The agent's own per-agent Ed25519 keypair (CONTRACTS §14 key custody) —
 * frontier manifests are signed under this key, never the host key, so
 * `envelope.key === manifest.pubKey` holds and the agent can heartbeat under
 * its own key once linked. */
function requireFrontierKeypair(agent: Agent): Keypair {
  const entry = getFrontierKeyEntry(agent.agentId);
  if (!entry) {
    throw new Error("frontier agent has no stored keypair — configure frontier settings first");
  }
  return { publicKey: entry.agentPubKey, privateKey: entry.agentPrivKey };
}

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
 * verifies the grant chain instead). The production registration path refuses
 * to publish until that binding exists; the legacy shape remains constructible
 * here only for additive protocol fixtures and local rendering tests.
 *
 * `hostAttestation` (CONTRACTS §6/§14) extends that grant chain one hop
 * further to operator→host→agent: a frontier agent's manifest is signed
 * under its OWN keypair, never the host key, so the network's grant-chain
 * check (`grant.payload.subjectKey === envelope.key`) can never hold for it.
 * Stamped only when both `isFrontier` and `operatorBinding` hold — a
 * host-key-signed envelope over `{agentId, agentPubKey: pubKey, iat}` the
 * network verifies before treating `hostKeypair.publicKey` as the grant's
 * subject in place of `envelope.key`. Absent only for hosted manifests and
 * additive legacy fixtures.
 */
export function buildAgentManifest(
  agent: Agent,
  pubKey: string,
  lookup: CapabilityLookup = localLookup,
  operatorDisplayName: string = getOperatorDisplayName(),
  operatorBinding: ReturnType<typeof getOperatorBinding> = getOperatorBinding(),
  hostKeypair: Keypair = getKeypair(),
): AgentManifest {
  const isFrontier = agent.runtime === "frontier";
  let model: AgentManifest["model"];
  if (isFrontier) {
    if (!agent.frontier) {
      throw new Error("frontier agent has no runtime config — cannot register");
    }
    model = synthesizeFrontierModelRef(agent.frontier);
  } else {
    if (!agent.model) {
      throw new Error("agent has no model — cannot register");
    }
    const capabilities = lookup(agent.model.filename) ?? agent.model.capabilities;
    model = { ...agent.model, ...(capabilities ? { capabilities } : {}) };
  }
  const hostAttestation =
    isFrontier && operatorBinding
      ? signEnvelope<FrontierHostAttestation>(
          { agentId: agent.agentId, agentPubKey: pubKey, iat: Date.now() },
          hostKeypair.privateKey,
          hostKeypair.publicKey,
        )
      : undefined;
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
    model,
    ...(agent.title ? { title: agent.title } : {}),
    ...(agent.gender ? { gender: agent.gender } : {}),
    ...(agent.specialties && agent.specialties.length > 0
      ? { specialties: agent.specialties }
      : {}),
    ...(isFrontier ? { runtime: "frontier" as const, frontier: agent.frontier } : {}),
    ...(hostAttestation ? { hostAttestation } : {}),
    operator: operatorBinding
      ? {
          pubKey: operatorBinding.identityKey,
          displayName: operatorBinding.displayName,
          grant: operatorBinding.grant,
        }
      : { pubKey, displayName: operatorDisplayName },
  };
}

export async function registerAgentOnNetwork(agent: Agent): Promise<AgentManifest> {
  const isFrontier = agent.runtime === "frontier";
  const keypair = isFrontier ? requireFrontierKeypair(agent) : getKeypair();
  const operatorBinding = getOperatorBinding();
  if (!operatorBinding) {
    throw new Error("operator binding is required before agent registration");
  }
  const manifest = buildAgentManifest(
    agent,
    keypair.publicKey,
    localLookup,
    operatorBinding.displayName,
    operatorBinding,
  );
  const envelope = signEnvelope(manifest, keypair.privateKey, keypair.publicKey);
  try {
    await networkRegisterAgent(envelope);
  } catch (err) {
    // Surface a stale operator grant (CONTRACTS §11.7 — the network revoked
    // all grants for this identity since it was issued) on the binding state
    // instead of letting it disappear into a per-call catch/log — this is
    // the ONE place every register/re-register path funnels through.
    if (
      err instanceof NetworkApiError &&
      err.status === 403 &&
      err.body.includes("operator grant epoch stale")
    ) {
      setOperatorGrantStale(true);
    }
    throw err;
  }
  setOperatorGrantStale(false);

  // Frontier agents have no local GGUF to detect capabilities from — the
  // manifest's synthesized model ref is derived, not stored, on `agent`.
  if (isFrontier) return manifest;

  if (
    manifest.model.capabilities &&
    JSON.stringify(manifest.model.capabilities) !== JSON.stringify(agent.model?.capabilities)
  ) {
    updateAgent(agent.agentId, { model: manifest.model });
  }
  return manifest;
}

export function capabilitiesNeedRefresh(
  stored: ModelCapabilities | undefined,
  detected: ModelCapabilities,
): boolean {
  return (
    !stored ||
    stored.tools !== detected.tools ||
    stored.vision !== detected.vision ||
    stored.thinking !== detected.thinking
  );
}

/**
 * One-time boot reconciliation: registered agents whose stored capabilities
 * are missing OR differ from the definitive local detector get re-registered,
 * so publisher-backed corrections reach existing agents without a manual edit.
 */
export async function backfillCapabilities(log: (msg: string) => void): Promise<void> {
  for (const agent of listAgents()) {
    if (!agent.registered || !agent.model) continue;
    const detected = localLookup(agent.model.filename);
    if (!detected || !capabilitiesNeedRefresh(agent.model.capabilities, detected)) continue;
    try {
      await registerAgentOnNetwork(agent);
      updateAgent(agent.agentId, { syncedAt: new Date().toISOString() });
      log(`capability reconciliation re-registered ${agent.name}`);
    } catch (err) {
      log(`capability reconciliation failed for ${agent.name}: ${String(err)}`);
    }
  }
}
