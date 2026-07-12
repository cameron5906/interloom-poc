import type { TelemetryFrame } from "@interloom/protocol";
import { ProgressBar } from "@interloom/ui";
import { Sparkline } from "../../components/Sparkline.js";
import { mbToGB } from "../../lib/format.js";
import type { ActiveModel } from "../../api/types.js";

interface StatTilesProps {
  frame: TelemetryFrame | undefined;
  tokensHistory: number[];
  connected: boolean;
  /** Polled from /api/models/active — carries the optional ctx field. */
  activeModel?: ActiveModel | null;
}

export function StatTiles({ frame, tokensHistory, connected, activeModel }: StatTilesProps) {
  const gpu = frame?.gpus[0];
  const hasGpu = !!gpu;
  const util = gpu ? Math.round(gpu.utilPct) : 0;
  const vramFrac = gpu && gpu.vramTotalMB > 0 ? gpu.vramUsedMB / gpu.vramTotalMB : 0;
  const tps = frame ? Math.round(frame.tokensPerSec) : 0;
  const tunnelCount = frame ? frame.tunnels.filter((t) => t.status === "connected").length : 0;
  const inference = frame?.inference;

  return (
    <div className="il-tiles">
      <Tile label="GPU utilization">
        {hasGpu ? (
          <>
            <div className="il-tile__value">
              {util}
              <span className="il-tile__unit">%</span>
            </div>
            <div className="il-tile__spark">
              <UtilBar value={util / 100} />
            </div>
          </>
        ) : (
          <div className="il-tile__empty">CPU mode · no GPU</div>
        )}
      </Tile>

      <Tile label="VRAM used">
        {hasGpu ? (
          <>
            <div className="il-tile__value">
              {mbToGB(gpu.vramUsedMB)}
              <span className="il-tile__unit"> / {mbToGB(gpu.vramTotalMB)} GB</span>
            </div>
            <div className="il-tile__spark">
              <ProgressBar value={vramFrac} tone={vramFrac > 0.9 ? "warning" : "accent"} />
            </div>
          </>
        ) : (
          <div className="il-tile__empty">—</div>
        )}
      </Tile>

      <Tile label="Tokens / sec">
        <div className="il-tile__value">
          {connected ? tps : "—"}
          {connected ? <span className="il-tile__unit"> tok/s</span> : null}
        </div>
        <div className="il-tile__spark">
          <Sparkline data={tokensHistory} height={34} />
        </div>
      </Tile>

      <Tile label="Active tunnels">
        <div className="il-tile__value">
          {connected ? tunnelCount : "—"}
        </div>
        <div className="il-tile__spark il-tile__spark--muted">
          {connected
            ? tunnelCount === 0
              ? "no instances connected"
              : `${tunnelCount} instance${tunnelCount === 1 ? "" : "s"} serving`
            : "telemetry offline"}
        </div>
      </Tile>

      {connected && inference ? (
        <>
          <Tile label="Active model">
            {inference.activeModel ? (
              <>
                <div className="il-tile__value il-tile__value--sm">
                  {inference.activeModel.filename}
                </div>
                <div className="il-tile__spark il-tile__spark--muted">
                  {inference.activeModel.quant ? inference.activeModel.quant : null}
                  {activeModel?.ctx ? (
                    <span className="il-mono">
                      {inference.activeModel.quant ? " · " : ""}@ {fmtCtx(activeModel.ctx)} ctx
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="il-tile__empty">no model loaded</div>
            )}
          </Tile>

          <Tile label="Queue depth">
            <div className="il-tile__value">{inference.queueDepth}</div>
            <div className="il-tile__spark il-tile__spark--muted">
              {inference.queueDepth === 0
                ? "inference idle"
                : `${inference.queueDepth} request${inference.queueDepth === 1 ? "" : "s"} queued`}
            </div>
          </Tile>
        </>
      ) : null}
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="il-tile">
      <div className="il-tile__label">{label}</div>
      {children}
    </div>
  );
}

function UtilBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="il-utilbar">
      <div className="il-utilbar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function fmtCtx(ctx: number): string {
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}k`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}
