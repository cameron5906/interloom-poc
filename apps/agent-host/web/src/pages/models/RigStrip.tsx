import type { LoadedModel, SystemInfo } from "@interloom/protocol";
import { mbToGB } from "../../lib/format.js";
import { Skeleton } from "../../components/States.js";

interface RigStripProps {
  rig: SystemInfo | null;
  loadedModels: LoadedModel[];
  loading: boolean;
}

/** The persistent frame of reference for every fit badge on the page: what the
 * operator's rig is, and what's loaded right now (CONTRACTS §6 — N models may be
 * loaded at once). */
export function RigStrip({ rig, loadedModels, loading }: RigStripProps) {
  if (loading && !rig) {
    return (
      <div className="il-rigstrip">
        {[0, 1, 2].map((i) => (
          <div key={i} className="il-rigtile">
            <Skeleton width={80} height={11} />
            <Skeleton width={130} height={20} />
          </div>
        ))}
      </div>
    );
  }

  const gpu = rig?.gpus?.[0];
  const hasGpu = !!gpu && gpu.kind !== "none";
  const unifiedGB = rig?.unifiedMemoryMB ? mbToGB(rig.unifiedMemoryMB) : null;
  const ramGB = rig?.systemRamMB ? mbToGB(rig.systemRamMB) : null;
  const showRamTile = hasGpu && ramGB != null;

  return (
    <div className={`il-rigstrip${showRamTile ? " il-rigstrip--4" : ""}`}>
      <RigTile label="Accelerator">
        <div className="il-rigtile__value" title={hasGpu ? gpu!.name : undefined}>
          {hasGpu ? gpu!.name : "CPU-only rig"}
        </div>
        <div className="il-rigtile__sub il-meta">
          {hasGpu
            ? `${gpu!.kind.toUpperCase()}${gpu!.driver ? ` · ${gpu!.driver}` : ""}`
            : rig
              ? `${rig.os} · ${rig.arch}`
              : "detecting…"}
        </div>
      </RigTile>

      <RigTile label={hasGpu ? "VRAM" : "Memory"}>
        {hasGpu ? (
          <>
            <div className="il-rigtile__value">
              {mbToGB(gpu!.vramMB)}
              <span className="il-rigtile__unit"> GB</span>
            </div>
            <div className="il-rigtile__sub il-meta">graphics memory</div>
          </>
        ) : unifiedGB ? (
          <>
            <div className="il-rigtile__value">
              {unifiedGB}
              <span className="il-rigtile__unit"> GB</span>
            </div>
            <div className="il-rigtile__sub il-meta">unified memory</div>
          </>
        ) : ramGB != null ? (
          <>
            <div className="il-rigtile__value">
              {ramGB}
              <span className="il-rigtile__unit"> GB</span>
            </div>
            <div className="il-rigtile__sub il-meta">system RAM · no GPU detected</div>
          </>
        ) : (
          <>
            <div className="il-rigtile__value il-rigtile__value--muted">system RAM</div>
            <div className="il-rigtile__sub il-meta">no GPU detected</div>
          </>
        )}
      </RigTile>

      {showRamTile ? (
        <RigTile label="System RAM">
          <div className="il-rigtile__value">
            {ramGB}
            <span className="il-rigtile__unit"> GB</span>
          </div>
          <div className="il-rigtile__sub il-meta">spill-over headroom</div>
        </RigTile>
      ) : null}

      <RigTile label={loadedModels.length > 1 ? "Loaded models" : "Loaded model"}>
        {loadedModels.length > 0 ? (
          <>
            <div
              className="il-rigtile__value il-rigtile__value--sm il-mono"
              title={loadedModels.map((m) => m.filename).join(", ")}
            >
              {loadedModels[0]!.filename}
              {loadedModels.length > 1 ? ` +${loadedModels.length - 1}` : ""}
            </div>
            <div className="il-rigtile__sub il-meta">
              {loadedModels.length > 1
                ? `${loadedModels.length} models serving`
                : loadedModels[0]!.ctx
                  ? `${fmtCtx(loadedModels[0]!.ctx)} context loaded`
                  : "serving inference"}
            </div>
          </>
        ) : (
          <>
            <div className="il-rigtile__value il-rigtile__value--muted">No model loaded</div>
            <div className="il-rigtile__sub il-meta">load one from Installed</div>
          </>
        )}
      </RigTile>
    </div>
  );
}

function RigTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="il-rigtile">
      <div className="il-rigtile__label">{label}</div>
      {children}
    </div>
  );
}

function fmtCtx(ctx: number): string {
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}K`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}
