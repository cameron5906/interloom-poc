import type { OperatorState } from "../api/types.js";
import type { StatusPillTone } from "@interloom/ui";

export interface SessionPillState {
  tone: StatusPillTone;
  label: string;
  live: boolean;
}

/**
 * Shared daemon/operator status → StatusPill mapping. Used by both the
 * desktop NavRail footer and the mobile top bar so the two surfaces never
 * drift out of sync.
 */
export function sessionPillState(
  daemonOnline: boolean,
  operator: OperatorState | undefined,
): SessionPillState {
  if (!daemonOnline) return { tone: "danger", label: "daemon offline", live: false };
  if (operator?.bound) return { tone: "success", label: "operator connected", live: true };
  return { tone: "warning", label: "not connected", live: false };
}
