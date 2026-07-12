import fs from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { DATA_DIR } from "../config.js";
import { networkMagicLink } from "./client.js";

interface NetworkSession {
  email?: string;
  loggedIn: boolean;
  loginUrl?: string;
  createdAt?: string;
}

function sessionFilePath(): string {
  return path.join(DATA_DIR, "network.json");
}

function readSession(): NetworkSession {
  const filePath = sessionFilePath();
  if (!fs.existsSync(filePath)) return { loggedIn: false };
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as NetworkSession;
  } catch {
    return { loggedIn: false };
  }
}

function writeSession(session: NetworkSession): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = sessionFilePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), "utf8");
  fs.renameSync(tmp, sessionFilePath());
}

export function registerNetworkSessionRoutes(app: FastifyInstance): void {
  app.post<{ Body: { email: string } }>("/api/network/login", async (req, reply) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return reply.status(400).send({ error: "email required" });
    }
    try {
      const { loginUrl } = await networkMagicLink(email);
      writeSession({ email, loggedIn: false, loginUrl, createdAt: new Date().toISOString() });
      return reply.send({ loginUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: `network unavailable: ${message}` });
    }
  });

  app.get("/api/network/session", async (_req, reply) => {
    const session = readSession();
    return reply.send(session);
  });
}
