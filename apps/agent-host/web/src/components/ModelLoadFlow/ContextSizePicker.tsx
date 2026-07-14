import type { ContextOption } from "../../api/types.js";

/** Format a context token count as "8k", "16k", "128k", etc. */
export function fmtCtx(ctx: number): string {
  if (ctx >= 1024 && ctx % 1024 === 0) return `${ctx / 1024}k`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}

/** Format KV cache bytes as "+2.1 GB" or "+512 MB". */
export function fmtKv(bytes: number): string {
  if (bytes >= 1024 ** 3) return `+${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `+${Math.round(bytes / 1024 ** 2)} MB`;
  return `+${Math.round(bytes / 1024)} KB`;
}

/**
 * Radio list of candidate context sizes with fit badges (CONTRACTS §6
 * context-sizing). `no` options are disabled with a reason; `spill` carries
 * the standing warning inline so the choice is informed before the user ever
 * reaches the confirm step.
 */
export function ContextSizePicker({
  options,
  selected,
  onSelect,
}: {
  options: ContextOption[];
  selected: number | null;
  onSelect: (ctx: number) => void;
}) {
  return (
    <div className="il-ctx-picker__list" role="radiogroup" aria-label="Context size">
      {options.map((opt) => {
        const isNo = opt.fit === "no";
        const isSelected = selected === opt.ctx;
        return (
          <button
            key={opt.ctx}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={isNo}
            title={isNo ? "Won't fit even with spill — pick a smaller context or free VRAM" : undefined}
            className={[
              "il-ctx-picker__row",
              isSelected ? "il-ctx-picker__row--sel" : "",
              isNo ? "il-ctx-picker__row--disabled" : "",
            ]
              .join(" ")
              .trim()}
            onClick={() => !isNo && onSelect(opt.ctx)}
          >
            <span className="il-ctx-picker__ctx-label il-mono">{fmtCtx(opt.ctx)}</span>
            {opt.kvBytes > 0 ? (
              <span className="il-ctx-picker__kv il-meta il-mono">{fmtKv(opt.kvBytes)} KV</span>
            ) : null}
            <span className="il-ctx-picker__fit-wrap">
              <FitBadge fit={opt.fit} />
            </span>
            {opt.fit === "spill" && isSelected ? (
              <span className="il-ctx-picker__spill-note">
                exceeds VRAM — offloads to system RAM, expect slower generation; may fail to load
              </span>
            ) : null}
            {isNo ? (
              <span className="il-ctx-picker__spill-note il-ctx-picker__spill-note--no">
                won&apos;t fit — try a smaller context or free VRAM by unloading a model
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function FitBadge({ fit }: { fit: "fast" | "spill" | "no" }) {
  if (fit === "fast") {
    return <span className="il-ctx-fit il-ctx-fit--fast">fast</span>;
  }
  if (fit === "spill") {
    return (
      <span
        className="il-ctx-fit il-ctx-fit--spill"
        title="exceeds VRAM — offloads to system RAM, expect slower generation; may fail to load"
      >
        spill
      </span>
    );
  }
  return <span className="il-ctx-fit il-ctx-fit--no">won&apos;t load</span>;
}
