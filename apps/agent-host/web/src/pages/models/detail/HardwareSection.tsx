import type { SystemInfo } from "@interloom/protocol";
import type { CatalogHardware, CatalogTaxonomy } from "../../../api/types.js";

interface HardwareSectionProps {
  hardware: CatalogHardware;
  taxonomy: CatalogTaxonomy;
  rig: SystemInfo | null;
}

/** Rig memory the weights must fit into, in GB: VRAM, unified memory, or system
 * RAM for CPU-only rigs. null = no rig data. */
function rigMemoryGB(rig: SystemInfo | null): { gb: number; label: string } | null {
  if (!rig) return null;
  const gpu = rig.gpus[0];
  if (gpu && gpu.vramMB > 0) return { gb: gpu.vramMB / 1024, label: "your VRAM" };
  if (rig.unifiedMemoryMB && rig.unifiedMemoryMB > 0) {
    return { gb: rig.unifiedMemoryMB / 1024, label: "your unified memory" };
  }
  if (rig.systemRamMB && rig.systemRamMB > 0) {
    return { gb: rig.systemRamMB / 1024, label: "your system RAM" };
  }
  return null;
}

export function HardwareSection({ hardware, taxonomy, rig }: HardwareSectionProps) {
  const [lo, hi] = hardware.estimated_q4_weight_size_gb;
  const mem = rigMemoryGB(rig);
  const scale = Math.max(hi, mem?.gb ?? 0) * 1.15 || hi * 1.15;

  const pct = (gb: number) => `${Math.min(100, (gb / scale) * 100)}%`;
  const bandLeft = pct(lo);
  const bandWidth = `${Math.min(100, (hi / scale) * 100) - Math.min(100, (lo / scale) * 100)}%`;
  const fitsOnRig = mem != null && hi <= mem.gb;

  return (
    <div className="il-hwsection">
      <div className="il-hwsection__bar-wrap">
        <div className="il-hwsection__bar" role="img" aria-label={`Q4 weights ${lo}–${hi} GB`}>
          <div
            className={`il-hwsection__band${fitsOnRig ? " il-hwsection__band--fits" : mem ? " il-hwsection__band--over" : ""}`}
            style={{ left: bandLeft, width: bandWidth }}
          />
          {mem ? (
            <div
              className={`il-hwsection__marker${markerEdgeClass(mem.gb / scale)}`}
              style={{ left: pct(mem.gb) }}
            >
              <span className="il-hwsection__marker-label il-meta">
                {mem.label} {mem.gb.toFixed(0)} GB
              </span>
            </div>
          ) : null}
        </div>
        <div className="il-hwsection__bar-caption il-meta">
          Q4 weights ≈ {lo}–{hi} GB
          {mem ? (
            fitsOnRig ? (
              <span className="il-hwsection__verdict il-hwsection__verdict--ok"> · fits your memory</span>
            ) : (
              <span className="il-hwsection__verdict il-hwsection__verdict--over">
                {" "}· larger than your memory
              </span>
            )
          ) : (
            <span className="il-hwsection__verdict"> · weights live in system RAM on this rig</span>
          )}
        </div>
      </div>

      <dl className="il-hwsection__specs">
        <Spec label="Recommended VRAM" value={`${hardware.recommended_vram_gb_full_offload} GB`} />
        <Spec label="Recommended RAM" value={`${hardware.recommended_system_ram_gb} GB`} />
        <Spec label="CPU viability" value={hardware.cpu_viability.replace(/_/g, " ")} />
        <Spec
          label="Hardware tier"
          value={
            <span
              className="il-tierchip"
              title={taxonomy.hardware_tiers[hardware.enthusiast_hardware_tier]}
            >
              {hardware.enthusiast_hardware_tier}
            </span>
          }
        />
      </dl>

      {hardware.notes ? <p className="il-hwsection__notes">{hardware.notes}</p> : null}
      <p className="il-hwsection__basis il-meta">
        {hardware.estimate_basis ?? "Editorial estimate; exact file size varies by quantizer."}
      </p>
    </div>
  );
}

function markerEdgeClass(frac: number): string {
  if (frac > 0.65) return " il-hwsection__marker--right";
  if (frac < 0.2) return " il-hwsection__marker--left";
  return "";
}

function Spec({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="il-hwsection__spec">
      <dt className="il-meta">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
