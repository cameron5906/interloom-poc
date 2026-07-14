import { useId } from "react";
import { NavLink } from "react-router-dom";
import { StatusPill, Avatar } from "@interloom/ui";
import type { OperatorState } from "../api/types.js";
import { sessionPillState } from "../lib/sessionState.js";
import "./NavRail.css";

interface NavRailProps {
  operator: OperatorState | undefined;
  daemonOnline: boolean;
  updateAvailable: boolean;
  version: string | undefined;
  /** Active-download summary (deliverable 2) — renders a footer pill when non-null. */
  downloads?: { count: number; pct: number } | null;
}

export const NAV = [
  { to: "/", label: "Overview", end: true, icon: OverviewIcon },
  { to: "/models", label: "Models", end: false, icon: ModelsIcon },
  { to: "/agents", label: "Agents", end: false, icon: AgentsIcon },
  { to: "/placements", label: "Placements", end: false, icon: PlacementsIcon },
  { to: "/settings", label: "Settings", end: false, icon: SettingsIcon },
];

export function NavRail({
  operator,
  daemonOnline,
  updateAvailable,
  version,
  downloads,
}: NavRailProps) {
  const sessionState = sessionPillState(daemonOnline, operator);
  const identity = operator?.bound ? operator.operator : undefined;

  return (
    <nav className="il-nav" aria-label="Primary">
      <div className="il-nav__brand">
        <span className="il-nav__mark" aria-hidden>
          <LoomGlyph />
        </span>
        <span className="il-nav__wordmark">Interloom</span>
      </div>

      <div className="il-nav__group-label">Host</div>
      <ul className="il-nav__list">
        {NAV.map(({ to, label, end, icon: Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `il-nav__row${isActive ? " il-nav__row--active" : ""}`
              }
            >
              <span className="il-nav__icon" aria-hidden>
                <Icon />
              </span>
              {label}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="il-nav__footer">
        {downloads && downloads.count > 0 && (
          <NavLink to="/models" className="il-nav__downloads">
            <span className="il-nav__downloads-spinner" aria-hidden />
            {downloads.count} download{downloads.count === 1 ? "" : "s"} · {Math.round(downloads.pct * 100)}%
          </NavLink>
        )}
        {updateAvailable && (
          <NavLink to="/settings" className="il-nav__update">
            <span className="il-nav__update-dot" aria-hidden />
            Update available
          </NavLink>
        )}
        {identity ? (
          <NavLink to="/settings" className="il-nav__operator" title={identity.identityKey}>
            <Avatar
              name={identity.displayName}
              isAgent={false}
              imageUrl={identity.avatarUrl}
              size="sm"
            />
            <span className="il-nav__operator-name">{identity.displayName}</span>
          </NavLink>
        ) : null}
        <StatusPill tone={sessionState.tone} live={sessionState.live}>
          {sessionState.label}
        </StatusPill>
        <div className="il-nav__version il-mono">
          {version === undefined ? "" : version === "dev" ? "dev build" : `v${version}`}
        </div>
      </div>
    </nav>
  );
}

/** The Interloom brand mark — also reused by MobileTopBar and OnboardingPage. */
export function LoomGlyph({ size = 18 }: { size?: number }) {
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="1" y="1" width="16" height="16" rx="5" fill={`url(#il-loom-${gid})`} />
      <path
        d="M5 6.2h8M5 9h8M5 11.8h8"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.92"
      />
      <path d="M6.6 4.4v9.2M11.4 4.4v9.2" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" opacity="0.5" />
      <defs>
        <linearGradient id={`il-loom-${gid}`} x1="1" y1="1" x2="17" y2="17" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d98544" />
          <stop offset="1" stopColor="#c0662b" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8.5" y="1.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="8.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8.5" y="8.5" width="5" height="5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path
        d="M7.5 1.5 13 4.3v6.4L7.5 13.5 2 10.7V4.3L7.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M2 4.3 7.5 7l5.5-2.7M7.5 7v6.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function AgentsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="2.5" y="4" width="10" height="8" rx="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.5 1.6v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5.6" cy="7.6" r="0.9" fill="currentColor" />
      <circle cx="9.4" cy="7.6" r="0.9" fill="currentColor" />
    </svg>
  );
}

function PlacementsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path
        d="M7.5 1.5c2.6 0 4.5 2 4.5 4.5 0 3.2-4.5 7.5-4.5 7.5S3 9.2 3 6C3 3.5 4.9 1.5 7.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="7.5" cy="7.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M7.5 1v1.4M7.5 12.6V14M1 7.5h1.4M12.6 7.5H14M2.9 2.9l1 1M11.1 11.1l1 1M2.9 12.1l1-1M11.1 3.9l1-1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
