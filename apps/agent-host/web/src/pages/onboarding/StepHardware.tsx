import { Badge, Button } from "@interloom/ui";
import { system as systemApi } from "../../api/endpoints.js";
import { useAsync } from "../../hooks/useAsync.js";
import { LoadError, Skeleton } from "../../components/States.js";
import { mbToGB } from "../../lib/format.js";

export function StepHardware({ onNext }: { onNext: () => void }) {
  const sys = useAsync((s) => systemApi.get(s), []);

  const gpus = sys.data?.gpus ?? [];
  const isArm = sys.data?.arch === "arm64";
  const hasUnified = !!sys.data?.unifiedMemoryMB;

  return (
    <div className="il-onb__step-body">
      <h2 className="il-onb__title">Let's check your hardware</h2>
      <p className="il-onb__lede">
        Eris runs models locally on your machine. Here's what we detected — nothing
        leaves this device.
      </p>

      {sys.loading && sys.initialLoad ? (
        <div className="il-hw-grid">
          {[0, 1].map((i) => (
            <div key={i} className="il-hw-card">
              <Skeleton width={140} height={15} />
              <Skeleton width={90} height={12} />
              <Skeleton width={60} height={20} radius={6} />
            </div>
          ))}
        </div>
      ) : sys.error ? (
        <LoadError error={sys.error} onRetry={sys.reload} />
      ) : gpus.length === 0 ? (
        <div className="il-hw-cpu">
          <div className="il-hw-cpu__icon" aria-hidden>
            🖥️
          </div>
          <div>
            <div className="il-hw-cpu__title">No GPU detected — CPU mode</div>
            <div className="il-hw-cpu__hint">
              You can still run smaller quantized models on CPU. We'll recommend models that
              fit comfortably.
            </div>
          </div>
        </div>
      ) : (
        <div className="il-hw-grid">
          {gpus.map((gpu, i) => (
            <div key={i} className="il-hw-card">
              <div className="il-hw-card__name">{gpu.name}</div>
              <div className="il-meta il-hw-card__vram">{mbToGB(gpu.vramMB)} GB VRAM</div>
              <div className="il-hw-card__badges">
                <KindBadge kind={gpu.kind} />
                {gpu.driver ? <span className="il-meta">driver {gpu.driver}</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {(isArm || hasUnified) && !sys.error && (
        <div className="il-hw-callout">
          <span className="il-hw-callout__badge">arm64</span>
          <div>
            <strong>Unified memory detected.</strong> On NVIDIA Spark and Apple silicon, the GPU
            shares system memory
            {hasUnified ? ` (${mbToGB(sys.data!.unifiedMemoryMB!)} GB available)` : ""} — larger
            models fit than a discrete GPU of the same class.
          </div>
        </div>
      )}

      <div className="il-onb__actions">
        <span />
        <Button variant="primary" onClick={onNext} disabled={sys.loading && sys.initialLoad}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: "cuda" | "metal" | "none" }) {
  if (kind === "cuda") return <Badge variant="success">CUDA</Badge>;
  if (kind === "metal") return <Badge variant="agent">Metal</Badge>;
  return <Badge variant="neutral">CPU only</Badge>;
}
