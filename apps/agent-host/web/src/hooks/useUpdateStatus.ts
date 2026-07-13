import type { UpdateStatus } from "@interloom/protocol";
import { update as updateApi } from "../api/endpoints.js";
import { usePoll } from "./usePoll.js";

const POLL_MS = 30 * 60 * 1000;

/** App-level update poll — one instance in App, passed down via props. */
export function useUpdateStatus(): { status: UpdateStatus | undefined; refresh: () => void } {
  const { data, refresh } = usePoll<UpdateStatus>((s) => updateApi.status(s), POLL_MS, true);
  return { status: data, refresh };
}
