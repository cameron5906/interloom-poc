import type { CatalogContextWindow } from "../../../api/types.js";
import { fmtTokens } from "../catalog/catalogHelpers.js";

interface ContextSectionProps {
  context: CatalogContextWindow;
}

/** Context is always two numbers: the advertised ceiling and the honest local
 * starting point (DESIGN_NOTES — never present one without the other). */
export function ContextSection({ context }: ContextSectionProps) {
  const advertised = context.default_or_advertised_tokens;
  const start = context.recommended_local_start_tokens;

  return (
    <div className="il-ctxsection">
      <div className="il-ctxsection__numbers">
        <div className="il-ctxsection__num">
          <div className="il-ctxsection__num-value il-mono">{fmtTokens(advertised)}</div>
          <div className="il-ctxsection__num-label">advertised ceiling</div>
        </div>
        <div className="il-ctxsection__arrow" aria-hidden>
          →
        </div>
        <div className="il-ctxsection__num il-ctxsection__num--rec">
          <div className="il-ctxsection__num-value il-mono">{fmtTokens(start)}</div>
          <div className="il-ctxsection__num-label">start here locally</div>
        </div>
      </div>

      {context.extended_max_tokens ? (
        <div className="il-meta il-ctxsection__extended">
          extendable to {fmtTokens(context.extended_max_tokens)} with runtime scaling
        </div>
      ) : null}

      {context.full_window_local_feasibility ? (
        <div className="il-ctxsection__feasibility">
          <span className="il-meta">full-window feasibility</span>
          <span className="il-ctxsection__feasibility-value">
            {context.full_window_local_feasibility.replace(/_/g, " ")}
          </span>
        </div>
      ) : null}

      {context.notes ? <p className="il-ctxsection__notes">{context.notes}</p> : null}
    </div>
  );
}
