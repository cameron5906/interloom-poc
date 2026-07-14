import type { TelemetryGpu } from "@interloom/protocol";
import { ProgressBar } from "@interloom/ui";
import { mbToGB } from "../../lib/format.js";

/**
 * Per-GPU rows inside the wide "GPUs" stat tile (deliverable 4 — the old
 * tile only ever read `frame.gpus[0]`, hiding every GPU past the first on a
 * multi-GPU host). `minmax(0,1fr)` on the name column so a long GPU name
 * can't blow out the row on mobile (CSS grid/fr clipping gotcha).
 */
export function GpuTiles({ gpus }: { gpus: TelemetryGpu[] }) {
  return (
    <div className="il-gputiles">
      {gpus.map((gpu, i) => {
        const util = Math.round(gpu.utilPct);
        const vramFrac = gpu.vramTotalMB > 0 ? gpu.vramUsedMB / gpu.vramTotalMB : 0;
        return (
          <div key={i} className="il-gputiles__row">
            <span className="il-gputiles__name" title={gpu.name}>
              GPU {i} <span className="il-gputiles__name-text">{gpu.name}</span>
            </span>
            <span className="il-gputiles__util il-mono">{util}%</span>
            <div className="il-gputiles__bar-wrap">
              <ProgressBar
                value={vramFrac}
                tone={vramFrac > 0.9 ? "warning" : "accent"}
                className="il-gputiles__bar"
              />
            </div>
            <span className="il-gputiles__vram il-mono">
              {mbToGB(gpu.vramUsedMB)} / {mbToGB(gpu.vramTotalMB)} GB
            </span>
          </div>
        );
      })}
    </div>
  );
}
