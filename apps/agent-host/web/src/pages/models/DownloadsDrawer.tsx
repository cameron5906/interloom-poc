import { useState } from "react";
import { ProgressBar } from "@interloom/ui";
import type { DownloadJob } from "@interloom/protocol";
import { formatBytes, formatSpeed } from "../../lib/format.js";

/**
 * Persistent bottom drawer showing active/queued downloads. Rendered only when
 * there is at least one job that isn't done. Collapsible so it never obscures
 * the model list while staying glanceable.
 */
export function DownloadsDrawer({ jobs }: { jobs: DownloadJob[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const active = jobs.filter((j) => j.status !== "done");
  if (active.length === 0) return null;

  const downloading = active.filter((j) => j.status === "downloading").length;

  return (
    <div className="il-dl">
      <button className="il-dl__head" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
        <span className="il-dl__title">
          <span className="il-dl__spinner" aria-hidden />
          {downloading > 0
            ? `Downloading ${downloading} model${downloading === 1 ? "" : "s"}`
            : `${active.length} download${active.length === 1 ? "" : "s"} queued`}
        </span>
        <span className="il-dl__toggle">{collapsed ? "Show" : "Hide"}</span>
      </button>
      {!collapsed ? (
        <ul className="il-dl__list">
          {active.map((job) => (
            <DownloadRow key={job.id} job={job} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DownloadRow({ job }: { job: DownloadJob }) {
  const frac = job.bytesTotal > 0 ? job.bytesDone / job.bytesTotal : 0;
  const pct = Math.round(frac * 100);
  const tone = job.status === "error" ? "danger" : job.status === "done" ? "success" : "accent";

  return (
    <li className="il-dl__row">
      <div className="il-dl__row-top">
        <span className="il-mono il-dl__file">{job.filename}</span>
        <span className="il-meta il-dl__pct">
          {job.status === "error"
            ? "failed"
            : job.status === "queued"
              ? "queued"
              : `${pct}%`}
        </span>
      </div>
      <ProgressBar value={frac} tone={tone} className="il-dl__bar" />
      <div className="il-dl__row-meta">
        <span className="il-meta">
          {formatBytes(job.bytesDone)} / {formatBytes(job.bytesTotal)}
        </span>
        {job.status === "downloading" ? (
          <span className="il-meta">{formatSpeed(job.speedBps)}</span>
        ) : job.status === "error" ? (
          <span className="il-dl__err">{job.error ?? "download error"}</span>
        ) : null}
      </div>
    </li>
  );
}
