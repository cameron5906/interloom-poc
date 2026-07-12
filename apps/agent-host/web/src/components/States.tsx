import type { ReactNode } from "react";
import { Button, Spinner } from "@interloom/ui";
import type { ApiError } from "../api/client.js";

/** A page title block with optional subtitle and right-aligned actions. */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="il-page__head il-page__head--row">
      <div>
        <h1 className="il-page__title">{title}</h1>
        {sub ? <p className="il-page__sub">{sub}</p> : null}
      </div>
      {actions ? <div className="il-page__actions">{actions}</div> : null}
    </div>
  );
}

/** Inline retriable error card. */
export function LoadError({
  error,
  onRetry,
  compact = false,
}: {
  error: ApiError;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const message = error.isOffline
    ? "Can't reach the Agent Host daemon. Make sure it's running on port 7420."
    : error.message;
  return (
    <div className={`il-error${compact ? " il-error--compact" : ""}`} role="alert">
      <span className="il-error__msg">{message}</span>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Centered spinner block for first loads without a skeleton design. */
export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="il-loading-block">
      <Spinner size="md" />
      <span className="il-loading-block__label">{label}</span>
    </div>
  );
}

/** A single shimmering skeleton line/box. */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = 8,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
}) {
  return (
    <span
      className={`il-skel${className ? ` ${className}` : ""}`}
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
      }}
    />
  );
}
