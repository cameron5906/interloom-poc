import { useState } from "react";
import type { HTMLAttributes } from "react";
import { Button } from "./Button.js";
import { StatusPill } from "./StatusPill.js";
import { TextArea } from "./TextArea.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRequestProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** What the agent wants to do, e.g. "Run database migration". */
  title: string;
  /** The agent's justification for the request. */
  reason: string;
  /** Tool being authorized, e.g. "shell.exec" — rendered as a mono chip. */
  toolName?: string;
  status?: ApprovalStatus;
  /** Who resolved the request (shown once status is not pending). */
  resolvedBy?: string;
  /** Preformatted resolution time, e.g. "14:32". */
  resolvedAt?: string;
  /** Note the rejecter left for the agent. */
  rejectionMessage?: string;
  /** Decision in flight — actions disabled. */
  busy?: boolean;
  onApprove?: () => void;
  /** Rejection note is optional by design. */
  onReject?: (message?: string) => void;
}

export function ApprovalRequest({
  title,
  reason,
  toolName,
  status = "pending",
  resolvedBy,
  resolvedAt,
  rejectionMessage,
  busy = false,
  onApprove,
  onReject,
  className,
  ...rest
}: ApprovalRequestProps) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const pending = status === "pending";

  const classes = ["il-approval", `il-approval--${status}`, className].filter(Boolean).join(" ");

  return (
    <div className={classes} {...rest}>
      <div className="il-approval__kicker">
        <span className={`il-approval__chip il-approval__chip--${status}`} aria-hidden>
          <ShieldGlyph />
        </span>
        <span className="il-approval__label">Approval request</span>
        {toolName && <code className="il-approval__tool">{toolName}</code>}
      </div>

      <div className="il-approval__title">{title}</div>
      <p className="il-approval__reason">{reason}</p>

      {pending && !rejecting && (
        <div className="il-approval__actions">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onApprove?.()}>
            Approve
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </Button>
        </div>
      )}

      {pending && rejecting && (
        <div className="il-approval__reject">
          <TextArea
            rows={2}
            autoFocus
            placeholder="Add a note for the agent (optional)"
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="il-approval__actions">
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => onReject?.(note.trim() || undefined)}
            >
              Confirm reject
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
                setNote("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!pending && (
        <div className="il-approval__resolution">
          <StatusPill tone={status === "approved" ? "success" : "danger"}>
            {status === "approved" ? "approved" : "rejected"}
          </StatusPill>
          {(resolvedBy || resolvedAt) && (
            <span className="il-approval__meta">
              {[resolvedBy && `by ${resolvedBy}`, resolvedAt].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
      )}

      {status === "rejected" && rejectionMessage && (
        <div className="il-approval__note">&ldquo;{rejectionMessage}&rdquo;</div>
      )}
    </div>
  );
}

function ShieldGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 1.4 12 3.1v3.5c0 3-2 5.3-5 6.4-3-1.1-5-3.4-5-6.4V3.1L7 1.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="5.9" r="1.05" fill="currentColor" />
      <path d="M7 6.9v2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
