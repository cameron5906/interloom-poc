import type { LoadedModel } from "@interloom/protocol";
import { modelColor } from "./colors.js";

/**
 * The visual "bridge" between two adjacent GPU bars when a fused model spans
 * both (CONTRACTS §6 multi-instance loading, `tensorSplit` across GPUs) — so
 * two 3090s read as one combinable pool rather than two disconnected bars.
 */
export function GpuBridgeConnector({ model, colorIndex }: { model: LoadedModel; colorIndex: number }) {
  const color = modelColor(colorIndex);
  return (
    <div className="il-gpubridge" style={{ ["--il-bridge-color" as string]: color }}>
      <div className="il-gpubridge__line" />
      <div className="il-gpubridge__pill">
        <span className="il-gpubridge__icon" aria-hidden>
          ⛓
        </span>
        fused · {model.filename}
      </div>
      <div className="il-gpubridge__line" />
    </div>
  );
}
