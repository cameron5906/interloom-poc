import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  HostAgent,
  FrontierRuntimeConfig,
  type AgentManifest,
  type FrontierLinkIssuerAuth,
} from "@interloom/protocol";
import { bytesToB64url, signEnvelope } from "@interloom/keys";
import { MODELS_DIR, NETWORK_URL } from "../config.js";
import { addRequestLogEntry } from "../telemetry/collector.js";
import { normalizeMessages } from "../inference/normalize.js";
import { resolvePreviewOptions, buildPreviewMessages, type PreviewBody } from "./preview.js";
import { findLocalModelPath } from "../models/active.js";
import { findInstanceByFilename, instanceBaseUrl } from "../models/loaded.js";
import { capabilitiesForFilename } from "../models/scan.js";
import { isThinkingDisabled } from "../models/settingsStore.js";
import { enqueueInference } from "../inference/gate.js";
import { clampMaxTokens } from "../inference/limits.js";
import { ThinkStripper } from "../inference/thinkStripper.js";
import { registerAgentOnNetwork } from "./register.js";
import { uploadAgentAvatar } from "./avatar.js";
import { networkCreateLinkSession } from "../network/client.js";
import {
  getFrontierKeyEntry,
  setFrontierConfig,
  deleteFrontierConfig,
  maskFrontierEntry,
} from "./frontierKeys.js";
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from "./store.js";

const FrontierConfigBody = FrontierRuntimeConfig.extend({
  apiKey: z.string().optional(),
});

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get("/api/agents", async (_req, reply) => {
    return reply.send(listAgents());
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: "not found" });
    return reply.send(agent);
  });

  app.post<{ Body: unknown }>("/api/agents", async (req, reply) => {
    const parsed = HostAgent.omit({ agentId: true, registered: true }).safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const agent = createAgent(parsed.data);
    return reply.status(201).send(agent);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/agents/:id", async (req, reply) => {
    const existing = getAgent(req.params.id);
    if (!existing) return reply.status(404).send({ error: "not found" });

    const parsed = HostAgent.partial()
      .omit({ agentId: true, registered: true, syncedAt: true })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const patch = parsed.data;
    if (existing.registered) {
      const candidate = HostAgent.parse({ ...existing, ...patch });
      let manifest: AgentManifest;
      try {
        manifest = await registerAgentOnNetwork(candidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: `registration failed: ${message}` });
      }
      const updated = updateAgent(req.params.id, {
        ...patch,
        ...(candidate.runtime === "frontier" ? {} : { model: manifest.model }),
        syncedAt: new Date().toISOString(),
      });
      if (!updated) return reply.status(404).send({ error: "not found" });
      return reply.send(updated);
    }

    const updated = updateAgent(req.params.id, patch);
    if (!updated) return reply.status(404).send({ error: "not found" });
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const deleted = deleteAgent(req.params.id);
    if (!deleted) return reply.status(404).send({ error: "not found" });
    deleteFrontierConfig(req.params.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string }; Body: PreviewBody }>(
    "/api/agents/:id/preview",
    { bodyLimit: 12 * 1024 * 1024 },
    async (req, reply) => {
      const agent = getAgent(req.params.id);
      if (!agent) return reply.status(404).send({ error: "not found" });

      // model_required: agent must have a model assigned
      if (!agent.model) {
        return reply.status(400).send({ error: "model_required" });
      }

      // model_not_active: the agent's model must be among the LOADED instances
      // (CONTRACTS §6 multi-instance loading — same error name/shape as before).
      const instance = findInstanceByFilename(agent.model.filename);
      if (!instance) {
        const localPath = agent.model.filename ? findLocalModelPath(agent.model.filename) : null;
        return reply
          .status(409)
          .send({ error: "model_not_active", model: agent.model, path: localPath });
      }

      const { persona, temperature } = resolvePreviewOptions(req.body, agent);
      const { messages, hasImages } = buildPreviewMessages(persona, req.body.messages ?? []);
      if (hasImages && !instance.mmprojPath) {
        return reply.status(400).send({ error: "vision_not_supported" });
      }

      const capabilities = capabilitiesForFilename(MODELS_DIR, agent.model.filename);
      const thinkingDisabled = isThinkingDisabled(agent.model.filename);
      const thinkingActive = capabilities?.thinking === true && !thinkingDisabled;

      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // NOTE: `req.raw` ("close") fires once the REQUEST body has been fully
      // read — normal for a small POST — not when the client disconnects.
      // `reply.raw` ("close") is the response/connection close, which is what
      // "client walked away mid-stream" actually means; using the wrong one
      // here meant the abort flag fired before the first chunk was ever
      // written, so preview never streamed anything to a real HTTP client
      // (only Fastify's synthetic `.inject()` masked it in tests).
      let aborted = false;
      reply.raw.on("close", () => {
        aborted = true;
      });

      let promptTokens = 0;
      let completionTokens = 0;
      let tokensPerSec = 0;

      try {
        await enqueueInference(instance.port, "preview", async (signal) => {
          let inferenceRes: Response;
          try {
            inferenceRes = await fetch(`${instanceBaseUrl(instance.port)}/v1/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                messages: normalizeMessages(messages),
                stream: true,
                stream_options: { include_usage: true },
                temperature,
                max_tokens: clampMaxTokens(undefined, instance.ctx, thinkingActive),
                ...(thinkingDisabled ? { chat_template_kwargs: { enable_thinking: false } } : {}),
              }),
              signal,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
            return;
          }

          if (!inferenceRes.ok || !inferenceRes.body) {
            reply.raw.write(`data: ${JSON.stringify({ error: "inference unavailable" })}\n\n`);
            return;
          }

          const reader = inferenceRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const stripper = new ThinkStripper();

          try {
            while (!aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") continue;
                try {
                  const chunk = JSON.parse(data) as {
                    choices?: Array<{
                      delta?: { content?: string; reasoning_content?: string };
                      finish_reason?: string;
                    }>;
                    usage?: { prompt_tokens?: number; completion_tokens?: number };
                    timings?: { predicted_per_second?: number };
                  };
                  // reasoning_content is separated by the engine (--reasoning-format
                  // deepseek) — never concatenated into visible content (CONTRACTS §6.1).
                  const raw = chunk.choices?.[0]?.delta?.content;
                  if (raw) {
                    const delta = stripper.push(raw);
                    if (delta) {
                      reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    }
                  }
                  if (chunk.usage?.prompt_tokens !== undefined) {
                    promptTokens = chunk.usage.prompt_tokens;
                  }
                  if (chunk.usage?.completion_tokens !== undefined) {
                    completionTokens = chunk.usage.completion_tokens;
                  }
                  if (chunk.timings?.predicted_per_second !== undefined) {
                    tokensPerSec = chunk.timings.predicted_per_second;
                  }
                } catch {
                  // skip malformed SSE lines
                }
              }
            }
            const tail = stripper.flush();
            if (tail && !aborted) {
              reply.raw.write(`data: ${JSON.stringify({ delta: tail })}\n\n`);
            }
          } finally {
            reader.cancel().catch(() => undefined);
          }
        });
      } catch {
        // gate error — response stream already started, just end it
      }

      if (!aborted) {
        reply.raw.write(
          `data: ${JSON.stringify({ done: true, usage: { promptTokens, completionTokens, tokensPerSec } })}\n\n`,
        );
        addRequestLogEntry({
          ts: Date.now(),
          source: "preview",
          agentName: agent.name,
          promptTokens,
          completionTokens,
          tokensPerSec,
        });
      }

      reply.raw.end();
      return reply;
    },
  );

  app.post<{ Params: { id: string }; Body: { dataUrl?: unknown } }>(
    "/api/agents/:id/avatar",
    { bodyLimit: 12 * 1024 * 1024 },
    async (req, reply) => {
      const agent = getAgent(req.params.id);
      if (!agent) return reply.status(404).send({ error: "not found" });

      if (typeof req.body?.dataUrl !== "string") {
        return reply.status(400).send({ error: "bad_image" });
      }

      const result = await uploadAgentAvatar(agent, req.body.dataUrl);
      if (!result.ok) {
        const status = result.error === "network_unreachable" ? 502 : 400;
        return reply.status(status).send({ error: result.error });
      }

      return reply.send({ imageUrl: result.imageUrl });
    },
  );

  app.post<{ Params: { id: string } }>("/api/agents/:id/register", async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: "not found" });

    if (agent.runtime === "frontier") {
      // Frontier agents never carry a local model — they need their runtime
      // config saved (and its keypair generated) instead (CONTRACTS §14).
      if (!agent.frontier) {
        return reply.status(400).send({ error: "frontier_config_required" });
      }
    } else if (!agent.model) {
      // model_required: cannot publish without a model
      return reply.status(400).send({ error: "model_required" });
    }

    try {
      await registerAgentOnNetwork(agent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: `registration failed: ${message}` });
    }

    const updated = updateAgent(req.params.id, {
      registered: true,
      syncedAt: new Date().toISOString(),
    });
    return reply.send(updated);
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/agents/:id/frontier",
    async (req, reply) => {
      const agent = getAgent(req.params.id);
      if (!agent) return reply.status(404).send({ error: "not found" });

      const parsed = FrontierConfigBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const entry = setFrontierConfig(agent.agentId, parsed.data);
      updateAgent(agent.agentId, {
        runtime: "frontier",
        frontier: { provider: entry.provider, model: entry.model },
      });

      return reply.send(maskFrontierEntry(entry));
    },
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id/frontier", async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: "not found" });
    return reply.send(maskFrontierEntry(getFrontierKeyEntry(agent.agentId)));
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/frontier/link", async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: "not found" });
    if (agent.runtime !== "frontier") {
      return reply.status(400).send({ error: "not_frontier_agent" });
    }

    const keyEntry = getFrontierKeyEntry(agent.agentId);
    if (!keyEntry) {
      return reply.status(400).send({ error: "frontier_config_required" });
    }

    let session: { linkId: string };
    try {
      session = await networkCreateLinkSession("frontier-agent", agent.agentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: `link session create failed: ${message}` });
    }

    // The QR-fragment secret (CONTRACTS §4 Device link) — generated here
    // since this route plays the issuer's session-setup role; never sent
    // to the network, only ever appended to the share URL's fragment.
    const secret = bytesToB64url(randomBytes(32));
    const url = `${NETWORK_URL}/link/${session.linkId}#${secret}`;
    const wsUrl = `${NETWORK_URL.replace(/^http/, "ws")}/ws/link/${session.linkId}`;

    // Cleartext FrontierLinkPayload fields (localhost trust surface, same
    // as today's device-link issuer) — the portal encrypts this into the
    // AES-GCM blob once it holds the admitted scanner's ephemeral key.
    const payload = {
      agentId: agent.agentId,
      agentName: agent.name,
      agentPrivKey: keyEntry.agentPrivKey,
      agentPubKey: keyEntry.agentPubKey,
      networkUrl: NETWORK_URL,
      provider: keyEntry.provider,
      model: keyEntry.model,
      ...(keyEntry.apiKey ? { apiKey: keyEntry.apiKey } : {}),
    };

    // The portal browser holds no network identity cookie (CONTRACTS
    // §4/§14), so it joins `/ws/link/:linkId` as issuer with this envelope
    // instead, signed under the same per-agent keypair as the payload above.
    const issuerAuthPayload: FrontierLinkIssuerAuth = {
      linkId: session.linkId,
      role: "issuer",
      nonce: bytesToB64url(randomBytes(24)),
      iat: Date.now(),
    };
    const issuerAuth = signEnvelope(issuerAuthPayload, keyEntry.agentPrivKey, keyEntry.agentPubKey);

    return reply.send({ linkId: session.linkId, secret, url, wsUrl, payload, issuerAuth });
  });
}
