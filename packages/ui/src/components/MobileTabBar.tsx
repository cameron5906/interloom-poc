import type { ReactNode } from "react";

export interface MobileTabBarItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** Unread/notification count. Renders a small accent badge when > 0. */
  badge?: number;
}

export interface MobileTabBarProps {
  items: MobileTabBarItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  className?: string;
}

/**
 * Floating bottom pill nav — the signature mobile element (design spec §2).
 * Presentational only: apps wire `onSelect` to their own router. Hidden at
 * ≥768px via CSS; the active item reveals its label with a buttery
 * grid-template-columns + opacity/translate animation that honors
 * `prefers-reduced-motion`.
 */
export function MobileTabBar({ items, activeKey, onSelect, className }: MobileTabBarProps) {
  const classes = ["il-tabbar", className].filter(Boolean).join(" ");

  return (
    <nav className={classes} aria-label="Primary">
      {items.map((item) => {
        const active = item.key === activeKey;
        const hasBadge = typeof item.badge === "number" && item.badge > 0;
        return (
          <button
            key={item.key}
            type="button"
            className={`il-tabbar__item${active ? " il-tabbar__item--active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(item.key)}
          >
            <span className="il-tabbar__iconwrap">
              <span className="il-tabbar__icon">{item.icon}</span>
              {hasBadge && (
                <span className="il-tabbar__badge">{item.badge! > 99 ? "99+" : item.badge}</span>
              )}
            </span>
            <span className="il-tabbar__labelwrap">
              <span className="il-tabbar__label">{item.label}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
