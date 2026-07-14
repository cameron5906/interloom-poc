import type { TelemetryFrame } from "@interloom/protocol";
import { Sparkline } from "../../components/Sparkline.js";
import { GpuTiles } from "./GpuTiles.js";

interface StatTilesProps {
  frame: TelemetryFrame | undefined;
  tokensHistory: number[];
  connected: boolean;
}

/**
 * Deliverable 4 (multi-model correctness sweep): renders every detected GPU,
 * not just `frame.gpus[0]` — a two-3090 host used to lose its second card
 * entirely. The "loaded models" tile prefers the additive
 * `inference.models` list and falls back to the legacy singular
 * `inference.activeModel` field when a stale daemon hasn't shipped it yet.
 */
export function StatTiles({ frame, tokensHistory, connected }: StatTilesProps) {
  const gpus = frame?.gpus ?? [];
  const hasGpu = gpus.length > 0;
  const tps = frame ? Math.round(frame.tokensPerSec) : 0;
  const tunnelCount = frame ? frame.tunnels.filter((t) => t.status === "connected").length : 0;
  const inference = frame?.inference;
  const loadedModels = inference?.models;
  const totalQueueDepth = loadedModels
    ? loadedModels.reduce((sum, m) => sum + m.queueDepth, 0)
    : (inference?.queueDepth ?? 0);

  return (
    <div className="il-tiles">
      <Tile label="GPU" wide={hasGpu}>
        {hasGpu ? (
          <GpuTiles gpus={gpus} />
        ) : (
          <div className="il-tile__empty">CPU mode · no GPU</div>
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
          <Tile label="Loaded models" wide={!!loadedModels && loadedModels.length > 1}>
            {loadedModels ? (
              loadedModels.length > 0 ? (
                <div className="il-tile__models">
                  {loadedModels.map((m) => (
                    <span key={m.filename} className="il-tile__model-chip il-mono" title={m.filename}>
                      {m.filename} <span className="il-tile__model-ctx">@ {fmtCtx(m.ctx)}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="il-tile__empty">no models loaded</div>
              )
            ) : inference.activeModel ? (
              <>
                <div className="il-tile__value il-tile__value--sm">{inference.activeModel.filename}</div>
                <div className="il-tile__spark il-tile__spark--muted">
                  {inference.activeModel.quant ?? null}
                </div>
              </>
            ) : (
              <div className="il-tile__empty">no model loaded</div>
            )}
          </Tile>

          <Tile label="Queue depth">
            <div className="il-tile__value">{totalQueueDepth}</div>
            <div className="il-tile__spark il-tile__spark--muted">
              {totalQueueDepth === 0
                ? "inference idle"
                : `${totalQueueDepth} request${totalQueueDepth === 1 ? "" : "s"} queued`}
            </div>
          </Tile>
        </>
      ) : null}
    </div>
  );
}

function Tile({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`il-tile${wide ? " il-tile--wide" : ""}`}>
      <div className="il-tile__label">{label}</div>
      {children}
    </div>
  );
}

function fmtCtx(ctx: number): string {
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}k`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}
