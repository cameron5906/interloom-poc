import type { NetworkSession } from "../api/types.js";
import type { StatusPillTone } from "@interloom/ui";

export interface SessionPillState {
  tone: StatusPillTone;
  label: string;
  live: boolean;
}

/**
 * Shared daemon/network status → StatusPill mapping. Used by both the
 * desktop NavRail footer and the mobile top bar so the two surfaces never
 * drift out of sync.
 */
export function sessionPillState(
  daemonOnline: boolean,
  session: NetworkSession | undefined,
): SessionPillState {
  if (!daemonOnline) return { tone: "danger", label: "daemon offline", live: false };
  if (session?.signedIn) return { tone: "success", label: "network · online", live: true };
  return { tone: "warning", label: "not signed in", live: false };
}
