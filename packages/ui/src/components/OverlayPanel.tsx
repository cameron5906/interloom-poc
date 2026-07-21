import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export interface OverlayPanelProps {
  open: boolean;
  onClose: () => void;
  /** Element the panel anchors near on desktop (ignored for the mobile bottom sheet). */
  anchorRef: RefObject<HTMLElement | null>;
  children?: ReactNode;
  /** Desktop panel width in px. Default 320. */
  width?: number;
  /** Close when the scrim is clicked. Default true. */
  closeOnScrim?: boolean;
  className?: string;
  "aria-label"?: string;
}

const BREAKPOINT = 768;
const GAP = 8;
const MARGIN = 8;
const ANIMATION_MS = 320;

interface Position {
  top: number;
  left: number;
  placement: "below" | "above";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Anchored placement: prefer below-start, flip above when there isn't room
 * below but there is above, clamp to the viewport with an 8px margin.
 */
function computePosition(anchor: HTMLElement, panelWidth: number, panelHeight: number): Position {
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const maxLeft = Math.max(MARGIN, vw - panelWidth - MARGIN);
  const left = Math.min(Math.max(rect.left, MARGIN), maxLeft);

  const spaceBelow = vh - rect.bottom - GAP;
  const spaceAbove = rect.top - GAP;
  let placement: "below" | "above" = "below";
  let top = rect.bottom + GAP;
  if (spaceBelow < panelHeight && spaceAbove > spaceBelow) {
    placement = "above";
    top = rect.top - panelHeight - GAP;
  }
  const maxTop = Math.max(MARGIN, vh - panelHeight - MARGIN);
  top = Math.min(Math.max(top, MARGIN), maxTop);

  return { top, left, placement };
}

/**
 * Generic, content-agnostic overlay primitive. On ≥768px it renders an
 * anchored floating panel near `anchorRef` (positioning: prefer below-start,
 * flip above when clipped, clamp to the viewport with an 8px margin); on
 * <768px it renders a full-width bottom sheet with rounded top corners
 * (DESIGN_NOTES). Scrim click and Escape close it; focus returns to the
 * anchor on close; entry/exit are animated (honors `prefers-reduced-motion`).
 * Content-agnostic — product compositions (e.g. a profile popover) render
 * their own content as `children`.
 */
export function OverlayPanel({
  open,
  onClose,
  anchorRef,
  children,
  width = 320,
  closeOnScrim = true,
  className,
  "aria-label": ariaLabel,
}: OverlayPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < BREAKPOINT,
  );
  const wasOpen = useRef(open);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const ms = prefersReducedMotion() ? 0 : ANIMATION_MS;
      const t = setTimeout(() => {
        setMounted(false);
        setClosing(false);
        setPosition(null);
      }, ms);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (wasOpen.current && !open) anchorRef.current?.focus();
    wasOpen.current = open;
  }, [open, anchorRef]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = panel.getBoundingClientRect();
    setPosition(computePosition(anchor, rect.width || width, rect.height || 0));
  }, [anchorRef, width]);

  useLayoutEffect(() => {
    if (!mounted || isMobile) return;
    reposition();
  }, [mounted, isMobile, reposition]);

  useEffect(() => {
    if (!mounted || isMobile) return;
    const onScrollOrResize = () => reposition();
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [mounted, isMobile, reposition]);

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mounted, onClose]);

  if (!mounted || typeof document === "undefined") return null;

  const classes = [
    "il-overlay__panel",
    closing ? "il-overlay__panel--closing" : null,
    position?.placement === "above" ? "il-overlay__panel--above" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const style: CSSProperties = isMobile
    ? {}
    : {
        position: "fixed",
        top: position ? position.top : 0,
        left: position ? position.left : 0,
        width,
        visibility: position ? "visible" : "hidden",
      };

  return createPortal(
    <div
      className="il-overlay__scrim"
      onClick={
        closeOnScrim
          ? (event) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
      role="presentation"
    >
      <div
        ref={panelRef}
        className={classes}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
