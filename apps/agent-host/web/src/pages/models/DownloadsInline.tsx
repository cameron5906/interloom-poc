import { useState } from "react";
import { ProgressBar } from "@interloom/ui";
import type { DownloadJob } from "@interloom/protocol";
import { formatBytes, formatSpeed } from "../../lib/format.js";

/**
 * Inline, non-occluding downloads section rendered near the top of the Models
 * page while at least one job is active. Replaces the old fixed-overlay
 * drawer — this never sits on top of page content, it just takes up its own
 * row in the normal document flow.
 */
export function DownloadsInline({ jobs }: { jobs: DownloadJob[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const active = jobs.filter((j) => j.status !== "done");
  if (active.length === 0) return null;

  const downloading = active.filter((j) => j.status === "downloading").length;

  return (
    <div className="il-dl-inline">
      <button
        className="il-dl-inline__head"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <span className="il-dl-inline__title">
          <span className="il-dl-inline__spinner" aria-hidden />
          {downloading > 0
            ? `Downloading ${downloading} model${downloading === 1 ? "" : "s"}`
            : `${active.length} download${active.length === 1 ? "" : "s"} queued`}
        </span>
        <span className="il-dl-inline__toggle">{collapsed ? "Show" : "Hide"}</span>
      </button>
      {!collapsed ? (
        <ul className="il-dl-inline__list">
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
    <li className="il-dl-inline__row">
      <div className="il-dl-inline__row-top">
        <span className="il-mono il-dl-inline__file">{job.filename}</span>
        <span className="il-meta il-dl-inline__pct">
          {job.status === "error"
            ? "failed"
            : job.status === "queued"
              ? "queued"
              : `${pct}%`}
        </span>
      </div>
      <ProgressBar value={frac} tone={tone} className="il-dl-inline__bar" />
      <div className="il-dl-inline__row-meta">
        <span className="il-meta">
          {formatBytes(job.bytesDone)} / {formatBytes(job.bytesTotal)}
        </span>
        {job.status === "downloading" ? (
          <span className="il-meta">{formatSpeed(job.speedBps)}</span>
        ) : job.status === "error" ? (
          <span className="il-dl-inline__err">{job.error ?? "download error"}</span>
        ) : null}
      </div>
    </li>
  );
}
