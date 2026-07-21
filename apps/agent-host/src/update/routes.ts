import type { FastifyInstance } from "fastify";
import { UpdateApplyState, type UpdateStatus } from "@interloom/protocol";
import { HOST_VERSION, UPDATER_URL, NETWORK_URL } from "../config.js";
import { checkForUpdate, getCheckState, isUpdateAvailable } from "./checker.js";

export interface UpdateRouteDeps {
  ownVersion: string;
  updaterUrl: string;
}

async function fetchApplyState(updaterUrl: string): Promise<UpdateApplyState> {
  try {
    const res = await fetch(`${updaterUrl}/status`);
    if (!res.ok) return { state: "unknown" };
    return UpdateApplyState.parse(await res.json());
  } catch {
    return { state: "unknown" };
  }
}

function buildStatus(ownVersion: string, apply: UpdateApplyState): UpdateStatus {
  const { latest, checkedAt, checkError } = getCheckState();
  return {
    current: { version: ownVersion },
    latest: latest
      ? { version: latest.version, publishedAt: latest.publishedAt, notes: latest.notes }
      : null,
    updateAvailable: isUpdateAvailable(ownVersion, latest?.version),
    checkedAt,
    ...(checkError !== undefined && { checkError }),
    networkUrl: NETWORK_URL,
    apply,
  };
}

export function registerUpdateRoutes(
  app: FastifyInstance,
  deps: UpdateRouteDeps = { ownVersion: HOST_VERSION, updaterUrl: UPDATER_URL },
): void {
  app.get("/api/update/status", async (_req, reply) => {
    return reply.send(buildStatus(deps.ownVersion, await fetchApplyState(deps.updaterUrl)));
  });

  app.post("/api/update/check", async (_req, reply) => {
    await checkForUpdate();
    return reply.send(buildStatus(deps.ownVersion, await fetchApplyState(deps.updaterUrl)));
  });

  app.post("/api/update/apply", async (_req, reply) => {
    const { latest } = getCheckState();
    if (!latest || !isUpdateAvailable(deps.ownVersion, latest.version)) {
      return reply.status(409).send({ error: "no_update" });
    }
    const apply = await fetchApplyState(deps.updaterUrl);
    if (apply.state === "pulling" || apply.state === "applying") {
      return reply.status(409).send({ error: "already_updating" });
    }

    let res: Response;
    try {
      res = await fetch(`${deps.updaterUrl}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: latest.version }),
      });
    } catch {
      return reply.status(502).send({ error: "updater_unreachable" });
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const slug = body?.error;
      if (slug === "version_moved") {
        // Manifest moved between our check and the updater's CAS — refresh ours.
        void checkForUpdate().catch((error) =>
          app.log.warn({ error }, "release manifest refresh failed"),
        );
        return reply.status(409).send({ error: "version_moved" });
      }
      return reply.status(409).send({ error: slug ?? "updater_conflict" });
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return reply.status(502).send({ error: body?.error ?? `updater error ${res.status}` });
    }
    return reply.send({ status: "started" });
  });
}
