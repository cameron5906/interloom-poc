import { useEffect, useId } from "react";
import type { ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Close when the overlay backdrop is clicked. Default true. */
  closeOnOverlay?: boolean;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  closeOnOverlay = true,
  className,
}: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const classes = ["il-modal__card", className].filter(Boolean).join(" ");

  return (
    <div
      className="il-modal__overlay"
      onClick={closeOnOverlay ? onClose : undefined}
      role="presentation"
    >
      <div
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="il-modal__header" id={titleId}>
            {title}
          </div>
        ) : null}
        <div className="il-modal__body">{children}</div>
        {footer ? <div className="il-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
