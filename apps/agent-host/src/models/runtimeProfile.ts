import { createHash } from "node:crypto";
import path from "node:path";
import {
  catalogGgufRepoIds,
  type CatalogModel,
  type ModelReasoningControl,
  type ModelRef,
  type ModelRuntimeProfile,
} from "@interloom/protocol";
import { MODELS_DIR } from "../config.js";
import { capabilitiesForFilename } from "./scan.js";
import { getRegistry } from "./registry.js";
import { instanceBaseUrl, type InstanceRecord } from "./loaded.js";
import { isThinkingDisabled } from "./settingsStore.js";

interface LlamaProps {
  default_generation_settings?: { params?: { chat_format?: unknown } };
  chat_template?: unknown;
  chat_template_caps?: Record<string, unknown>;
  build_info?: unknown;
}

interface LoadedRuntimeProbe {
  props: LlamaProps | null;
  features: { exactInputTokens: boolean; jsonSchema: boolean };
}

// Runtime/template probes include one constrained generation. Cache them for
// the lifetime of the exact loaded instance so tunnel reconnects are cheap;
// model path, port, or physical window changes create a different key.
const loadedRuntimeProbeCache = new Map<string, Promise<LoadedRuntimeProbe>>();

async function probeLoadedRuntime(instance: InstanceRecord): Promise<LoadedRuntimeProbe> {
  const key = `${instance.id}:${instance.port}:${instance.ctx}:${instance.modelPath}`;
  const existing = loadedRuntimeProbeCache.get(key);
  if (existing) return existing;
  const pending = Promise.all([readProps(instance.port), probeRequestFeatures(instance.port)]).then(
    ([props, features]) => ({ props, features }),
  );
  loadedRuntimeProbeCache.set(key, pending);
  if (loadedRuntimeProbeCache.size > 32) {
    const oldest = loadedRuntimeProbeCache.keys().next().value;
    if (oldest !== undefined && oldest !== key) loadedRuntimeProbeCache.delete(oldest);
  }
  return pending;
}

async function probeRequestFeatures(
  port: number,
): Promise<{ exactInputTokens: boolean; jsonSchema: boolean }> {
  let exactInputTokens = false;
  try {
    const response = await fetch(`${instanceBaseUrl(port)}/v1/chat/completions/input_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "runtime capability probe" }],
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok) {
      const payload = (await response.json()) as { input_tokens?: unknown };
      exactInputTokens = typeof payload.input_tokens === "number";
    }
  } catch {}

  let jsonSchema = false;
  try {
    const response = await fetch(`${instanceBaseUrl(port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: 'Return exactly {"ok":true}.' }],
        max_tokens: 16,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const payload = (await response.json()) as {
        choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
      };
      const choice = payload.choices?.[0];
      if (choice?.finish_reason === "stop" && typeof choice.message?.content === "string") {
        const parsed = JSON.parse(choice.message.content) as { ok?: unknown };
        jsonSchema = typeof parsed.ok === "boolean";
      }
    }
  } catch {}
  return { exactInputTokens, jsonSchema };
}

export function selectAgentAdapter(input: {
  detectedTools?: boolean;
  catalogToolLevel?: string;
  runtimeToolSupport: boolean;
  jsonSchema: boolean;
}): { adapter: "native_tools" | "schema_actions"; tools: boolean } {
  const catalogDeclaresNative = input.catalogToolLevel === "native";
  const catalogDeclaresNone = input.catalogToolLevel === "none";
  const nativeTools =
    input.runtimeToolSupport &&
    !catalogDeclaresNone &&
    (input.detectedTools !== false || catalogDeclaresNative);
  if (nativeTools) return { adapter: "native_tools", tools: true };
  if (input.jsonSchema) return { adapter: "schema_actions", tools: true };
  return { adapter: "native_tools", tools: false };
}

/** Advertise only the inference methods verified for this exact runtime. */
export function tunnelFeaturesForRuntime(
  profile?: Pick<ModelRuntimeProfile, "features">,
): string[] {
  const features = ["finish_reason_v1"];
  // Preserve the pre-profile handshake for injected/legacy clients. The
  // production manager always supplies a profiler for a resolved instance.
  if (!profile) return ["tools", ...features, "input_tokens_v1", "json_schema_v1"];
  if (profile.features.tools) features.unshift("tools");
  if (profile.features.exactInputTokens) features.push("input_tokens_v1");
  if (profile.features.jsonSchema) features.push("json_schema_v1");
  features.push("model_runtime_profile_v1");
  return features;
}

function localRepoId(modelPath: string): string | undefined {
  const candidate = path.basename(path.dirname(modelPath)).replace("__", "/");
  return candidate.includes("/") ? candidate : undefined;
}

function findCatalogModel(
  repoId: string | undefined,
  catalogId: string | undefined,
): CatalogModel | null {
  const registry = getRegistry();
  if (!registry) return null;
  if (catalogId) {
    const exact = registry.doc.catalog.models.find(
      (model) => model.id.toLowerCase() === catalogId.toLowerCase(),
    );
    if (exact) return exact;
  }
  if (!repoId) return null;
  const target = repoId.toLowerCase();
  return (
    registry.doc.catalog.models.find((model) =>
      catalogGgufRepoIds(model).some((candidate) => candidate.toLowerCase() === target),
    ) ?? null
  );
}

function reasoningControl(level: string | undefined): ModelReasoningControl {
  if (level === "native_toggleable") return "toggle";
  if (level === "native_configurable") return "effort";
  if (level === "implicit") return "implicit";
  if (level === "none" || level === undefined) return "none";
  return "always";
}

function reasoningMinimumContext(model: CatalogModel | null): number | null {
  return model?.capabilities.thinking.minimum_context_tokens ?? null;
}

export function reasoningActiveForRuntime(input: {
  detectedThinking: boolean;
  catalogLevel?: string;
  disabled: boolean;
  contextWindow: number;
  minimumContextTokens: number | null;
}): boolean {
  const supportsThinking =
    input.detectedThinking || (input.catalogLevel !== undefined && input.catalogLevel !== "none");
  const meetsContextFloor =
    input.minimumContextTokens === null || input.contextWindow >= input.minimumContextTokens;
  return supportsThinking && meetsContextFloor && !input.disabled;
}

async function readProps(port: number): Promise<LlamaProps | null> {
  try {
    const response = await fetch(`${instanceBaseUrl(port)}/props`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as LlamaProps;
  } catch {
    return null;
  }
}

/** Build the exact loaded-model contract advertised during tunnel auth. */
export async function buildRuntimeProfile(
  instance: InstanceRecord,
  modelRef?: ModelRef,
): Promise<ModelRuntimeProfile> {
  const filename = path.basename(instance.modelPath);
  const repoId = modelRef?.repoId ?? localRepoId(instance.modelPath);
  const catalog = findCatalogModel(repoId, modelRef?.catalogId);
  const { props, features: probed } = await probeLoadedRuntime(instance);
  const detected = capabilitiesForFilename(MODELS_DIR, filename);
  const template = typeof props?.chat_template === "string" ? props.chat_template : null;
  const chatFormatRaw = props?.default_generation_settings?.params?.chat_format;
  const chatFormat = typeof chatFormatRaw === "string" && chatFormatRaw ? chatFormatRaw : null;
  const toolLevel = catalog?.capabilities.tool_use.level;
  const propsToolSupport =
    props?.chat_template_caps?.["supports_tools"] === true ||
    props?.chat_template_caps?.["supports_tool_calls"] === true;
  const runtimeToolSupport =
    propsToolSupport ||
    (toolLevel === "native" &&
      detected?.tools === true &&
      chatFormat !== null &&
      chatFormat.toLowerCase() !== "generic");
  const agentAdapter = selectAgentAdapter({
    detectedTools: detected?.tools,
    catalogToolLevel: toolLevel,
    runtimeToolSupport,
    jsonSchema: probed.jsonSchema,
  });
  const minimumContextTokens = reasoningMinimumContext(catalog);
  const thinkingActive = reasoningActiveForRuntime({
    detectedThinking: detected?.thinking === true,
    catalogLevel: catalog?.capabilities.thinking.level,
    disabled: isThinkingDisabled(filename),
    contextWindow: instance.ctx,
    minimumContextTokens,
  });
  const toolFormat = catalog?.capabilities.tool_use.formats?.[0] ?? chatFormat;

  return {
    version: 1,
    ...(catalog ? { catalogId: catalog.id } : {}),
    contextWindow: instance.ctx,
    maxOutputTokens: catalog?.context_window.max_output_tokens ?? null,
    chatFormat,
    templateHash: template ? createHash("sha256").update(template).digest("hex") : null,
    runtimeBuild: typeof props?.build_info === "string" ? props.build_info.slice(0, 256) : null,
    probeStatus: props && probed.exactInputTokens ? "verified" : props ? "degraded" : "unavailable",
    adapter: agentAdapter.adapter,
    toolFormat: toolFormat ?? null,
    reasoning: {
      control: reasoningControl(catalog?.capabilities.thinking.level),
      active: thinkingActive,
      minimumContextTokens,
    },
    features: {
      tools: agentAdapter.tools,
      structuredOutput: probed.jsonSchema,
      exactInputTokens: probed.exactInputTokens,
      jsonSchema: probed.jsonSchema,
      vision: Boolean(instance.mmprojPath),
      audio: false,
    },
  };
}
