// Interloom host-updater sidecar (CONTRACTS §8).
// Applies stack updates for the agent-host daemon: rewrites TAG in the install
// dir's .env, pulls, recreates the app services, then recreates itself LAST via
// a detached finisher container so it never dies mid-apply.
// Reachable ONLY on the compose network — never published to the host.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isValidVersion, rewriteTag, parseEnv, managedState } from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 7424);
const CONFIG_DIR = process.env.HOST_CONFIG_DIR ?? "/host-config";
const NETWORK_URL = process.env.NETWORK_URL ?? "https://interloom-net.tryeris.com";
const UPDATER_IMAGE = "interloom-host-updater";

const ENV_FILE = join(CONFIG_DIR, ".env");
const COMPOSE_FILE = join(CONFIG_DIR, "docker-compose.yml");
const GPU_COMPOSE_FILE = join(CONFIG_DIR, "docker-compose.gpu.yml");
const STATE_FILE = join(CONFIG_DIR, ".updater-state.json");

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { state: "idle" };
  }
}

function readEnvSafe() {
  try {
    return readFileSync(ENV_FILE, "utf-8");
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

const busy = () => ["pulling", "applying"].includes(readState().state);

function composeArgs(gpu) {
  const args = ["compose", "-f", COMPOSE_FILE];
  if (gpu) args.push("-f", GPU_COMPOSE_FILE);
  args.push("--env-file", ENV_FILE);
  return args;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: CONFIG_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout.on("data", (c) => (output += c.toString()));
    proc.stderr.on("data", (c) => (output += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${output.slice(-2000)}`));
    });
  });
}

async function fetchAdvertised() {
  const res = await fetch(`${NETWORK_URL}/releases/host.json`);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return res.json();
}

async function downloadComposeFiles() {
  const files = [
    [`${NETWORK_URL}/compose/host-owner.yml`, COMPOSE_FILE],
    [`${NETWORK_URL}/compose/host-owner.gpu.yml`, GPU_COMPOSE_FILE],
  ];
  for (const [url, dest] of files) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`compose download failed: ${url} → ${res.status}`);
    writeFileSync(dest, await res.text());
  }
}

async function applyUpdate(version) {
  const envRaw = readEnvSafe();
  const m = managedState(envRaw);
  if (!m.managed) {
    throw new Error(
      `host is not installer-managed (${m.reason}) — run the installer once to enable self-update`,
    );
  }
  const envBefore = envRaw;
  const backups = new Map([[ENV_FILE, envBefore]]);
  for (const f of [COMPOSE_FILE, GPU_COMPOSE_FILE]) {
    if (existsSync(f)) backups.set(f, readFileSync(f, "utf-8"));
  }

  const env = parseEnv(envBefore);
  const gpu = env.GPU === "1";
  const dockerOrg = env.DOCKER_ORG || "cameron59061";
  const installDir = env.INTERLOOM_DIR;
  if (!installDir) {
    throw new Error("INTERLOOM_DIR missing from .env — re-run the installer to migrate this host");
  }

  try {
    writeState({ state: "pulling", version });
    await downloadComposeFiles();
    writeFileSync(ENV_FILE, rewriteTag(envBefore, version));
    await run("docker", [...composeArgs(gpu), "pull", "-q"]);
  } catch (err) {
    for (const [file, content] of backups) writeFileSync(file, content);
    throw err;
  }

  // Point of no return: images are local. Recreating the app services kills the
  // daemon — the portal expects this window and polls for the new version.
  writeState({ state: "applying", version });
  await run("docker", [...composeArgs(gpu), "up", "-d", "agent-host", "inference", "model-fetcher"]);

  // Self-recreate LAST via a detached finisher running the freshly pulled
  // updater image. A finisher failure is tolerable: the app stack is already
  // updated; a stale updater just retries at the next apply.
  const finisher = ["compose", "-f", "/host-config/docker-compose.yml"];
  if (gpu) finisher.push("-f", "/host-config/docker-compose.gpu.yml");
  finisher.push("--env-file", "/host-config/.env", "up", "-d", "updater");
  try {
    await run("docker", [
      "run", "--rm", "-d",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${installDir}:/host-config`,
      "-w", "/host-config",
      // The finisher's own container env otherwise shadows --env-file: the
      // host-updater image bakes a NETWORK_URL default, and compose's
      // variable precedence has the process environment win over --env-file,
      // silently reverting the recreated updater to that baked default.
      "-e", `NETWORK_URL=${NETWORK_URL}`,
      "-e", `DOCKER_ORG=${dockerOrg}`,
      "--entrypoint", "docker",
      `${dockerOrg}/${UPDATER_IMAGE}:${version}`,
      ...finisher,
    ]);
  } catch (err) {
    console.error(`finisher launch failed (updater stays on old version): ${err.message}`);
  }

  writeState({ state: "idle", version, finishedAt: new Date().toISOString() });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/status")
    return send(res, 200, { ...readState(), ...managedState(readEnvSafe()) });

  if (req.method === "POST" && req.url === "/apply") {
    let raw = "";
    req.on("data", (c) => (raw += c.toString()));
    req.on("end", () => {
      void (async () => {
        let version;
        try {
          version = JSON.parse(raw || "{}").version;
        } catch {
          return send(res, 400, { error: "invalid_json" });
        }
        if (!isValidVersion(version)) return send(res, 400, { error: "invalid_version" });
        if (busy()) return send(res, 409, { error: "already_updating" });

        const m = managedState(readEnvSafe());
        if (!m.managed) return send(res, 409, { error: "not_installer_managed", reason: m.reason });

        let advertised;
        try {
          advertised = await fetchAdvertised();
        } catch (err) {
          return send(res, 502, { error: `manifest unreachable: ${err.message}` });
        }
        if (advertised.version !== version) {
          return send(res, 409, { error: "version_moved", advertised: advertised.version });
        }

        send(res, 200, { status: "started" });
        applyUpdate(version).catch((err) => {
          console.error(`apply failed: ${err.message}`);
          writeState({
            state: "error",
            version,
            error: err.message,
            finishedAt: new Date().toISOString(),
          });
        });
      })().catch((err) => {
        if (!res.headersSent) send(res, 500, { error: err.message });
      });
    });
    return;
  }
  send(res, 404, { error: "not_found" });
});

// A crash mid-apply leaves a stale busy state; the updater only (re)starts
// outside an apply or because an apply just recreated it — reset to idle.
if (busy()) writeState({ state: "idle" });

server.listen(PORT, "0.0.0.0", () => {
  console.log(`host-updater listening on ${PORT}`);
});
