import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, "../web/dist");

export async function registerStatic(app: FastifyInstance): Promise<void> {
  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: "/",
    });

    app.setNotFoundHandler((req, reply) => {
      if (!req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({ error: "not found" });
    });
  } else {
    app.get("/", async (_req, reply) => {
      return reply
        .type("text/plain")
        .send("portal not built — run pnpm build in apps/agent-host/web");
    });
  }
}
