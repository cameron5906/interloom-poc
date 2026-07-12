import fs from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { generateKeypair, type Keypair } from "@interloom/keys";
import { DATA_DIR } from "./config.js";

interface KeysFile {
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

let _keypair: Keypair | null = null;
let _createdAt: string | null = null;

function keysFilePath(): string {
  return path.join(DATA_DIR, "keys.json");
}

export function loadOrCreateKeypair(): { keypair: Keypair; createdAt: string } {
  if (_keypair && _createdAt) {
    return { keypair: _keypair, createdAt: _createdAt };
  }

  const filePath = keysFilePath();
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    const data: KeysFile = JSON.parse(raw) as KeysFile;
    _keypair = { publicKey: data.publicKey, privateKey: data.privateKey };
    _createdAt = data.createdAt;
    return { keypair: _keypair, createdAt: _createdAt };
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const keypair = generateKeypair();
  const createdAt = new Date().toISOString();
  const data: KeysFile = { publicKey: keypair.publicKey, privateKey: keypair.privateKey, createdAt };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  _keypair = keypair;
  _createdAt = createdAt;
  return { keypair, createdAt };
}

export function getKeypair(): Keypair {
  return loadOrCreateKeypair().keypair;
}

export function registerKeysRoutes(app: FastifyInstance): void {
  app.get("/api/keys", async (_req, reply) => {
    const { keypair, createdAt } = loadOrCreateKeypair();
    return reply.send({ pubKey: keypair.publicKey, createdAt });
  });
}
