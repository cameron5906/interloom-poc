import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DownloadJob } from "@interloom/protocol";
import { models as modelsApi } from "../api/endpoints.js";
import { usePoll } from "../hooks/usePoll.js";
import { useToasts } from "../components/Toasts.js";

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 20000;

export interface DownloadsSummary {
  jobs: DownloadJob[];
  /** Queued or downloading — not yet done or errored. */
  active: DownloadJob[];
  /** Aggregate progress across active jobs, 0..1 (bytes-weighted). */
  aggregatePct: number;
  refresh: () => void;
}

const DownloadsCtx = createContext<DownloadsSummary | null>(null);

/**
 * App-shell-level download polling (deliverable 2). Polls gently: fast while
 * something is queued/downloading, slow otherwise so an idle host isn't
 * hammering the daemon from a background tab. Fires a success toast the
 * moment a job flips to "done" so completion is visible from any screen.
 */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  const toasts = useToasts();
  const [intervalMs, setIntervalMs] = useState(ACTIVE_POLL_MS);
  const { data, refresh } = usePoll<DownloadJob[]>((s) => modelsApi.downloads(s), intervalMs, true);
  const jobs = data ?? [];
  const active = jobs.filter((j) => j.status === "queued" || j.status === "downloading");

  const prevStatusRef = useRef<Map<string, DownloadJob["status"]>>(new Map());

  useEffect(() => {
    setIntervalMs(active.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length > 0]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    for (const job of jobs) {
      const was = prev.get(job.id);
      if (was && was !== "done" && job.status === "done") {
        toasts.success(`${job.filename} finished downloading`);
      }
    }
    prevStatusRef.current = new Map(jobs.map((j) => [j.id, j.status]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  const totalBytes = active.reduce((sum, j) => sum + Math.max(j.bytesTotal, 0), 0);
  const doneBytes = active.reduce((sum, j) => sum + Math.max(j.bytesDone, 0), 0);
  const aggregatePct = totalBytes > 0 ? doneBytes / totalBytes : 0;

  return (
    <DownloadsCtx.Provider value={{ jobs, active, aggregatePct, refresh }}>
      {children}
    </DownloadsCtx.Provider>
  );
}

export function useDownloads(): DownloadsSummary {
  const ctx = useContext(DownloadsCtx);
  if (!ctx) throw new Error("useDownloads must be used within a DownloadsProvider");
  return ctx;
}
