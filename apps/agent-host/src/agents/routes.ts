import type { FastifyInstance } from "fastify";
import { HostAgent } from "@interloom/protocol";
import { INFERENCE_URL } from "../config.js";
import { addRequestLogEntry } from "../telemetry/collector.js";
import { normalizeMessages } from "../inference/normalize.js";
import { resolvePreviewOptions, buildPreviewMessages, type PreviewBody } from "./preview.js";
import { getActiveModel, findLocalModelPath } from "../models/active.js";
import { enqueueInference } from "../inference/gate.js";
import { clampMaxTokens } from "../inference/limits.js";
import { registerAgentOnNetwork } from "./register.js";
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
} from "./store.js";

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

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/agents/:id",
    async (req, reply) => {
      const existing = getAgent(req.params.id);
      if (!existing) return reply.status(404).send({ error: "not found" });

      const parsed = HostAgent.partial().omit({ agentId: true }).safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const patch = parsed.data;
      let updated = updateAgent(req.params.id, patch);
      if (!updated) return reply.status(404).send({ error: "not found" });

      if (existing.registered) {
        try {
          await registerAgentOnNetwork(updated);
          updated = updateAgent(req.params.id, { syncedAt: new Date().toISOString() }) ?? updated;
        } catch (err) {
          app.log.warn({ err }, "auto re-register failed on patch");
        }
      }

      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const deleted = deleteAgent(req.params.id);
    if (!deleted) return reply.status(404).send({ error: "not found" });
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

      // model_not_active: the agent's model must be the currently loaded model
      const active = await getActiveModel();
      if (!active || active.filename !== agent.model.filename) {
        const localPath = agent.model.filename ? findLocalModelPath(agent.model.filename) : null;
        return reply.status(409).send({ error: "model_not_active", model: agent.model, path: localPath });
      }

      const { persona, temperature } = resolvePreviewOptions(req.body, agent);
      const { messages, hasImages } = buildPreviewMessages(persona, req.body.messages ?? []);
      if (hasImages && !active.mmprojPath) {
        return reply.status(400).send({ error: "vision_not_supported" });
      }

      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      let aborted = false;
      req.raw.on("close", () => {
        aborted = true;
      });

      let promptTokens = 0;
      let completionTokens = 0;
      let tokensPerSec = 0;

      try {
        await enqueueInference("preview", async () => {
          let inferenceRes: Response;
          try {
            inferenceRes = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                messages: normalizeMessages(messages),
                stream: true,
                temperature,
                max_tokens: clampMaxTokens(undefined, active.ctx),
              }),
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
                    choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
                    usage?: { prompt_tokens?: number; completion_tokens?: number };
                    timings?: { predicted_per_second?: number };
                  };
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) {
                    reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
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

  app.post<{ Params: { id: string } }>("/api/agents/:id/register", async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: "not found" });

    // model_required: cannot publish without a model
    if (!agent.model) {
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
}
