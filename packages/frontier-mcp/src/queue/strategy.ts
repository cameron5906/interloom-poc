/** Anything with an `enqueuedAt` ISO timestamp — the FCFS ordering key (CONTRACTS §14). */
export interface QueuedRef {
  workId: string;
  enqueuedAt: string;
}

/**
 * Cross-workspace ordering (pinned-interfaces §C) — v1 is strict FCFS by
 * `enqueuedAt` ascending across every placement of every linked agent. This
 * is the pinned plumbing point for future priority/condition-based
 * ordering; callers should route all merge-ordering decisions through here
 * rather than sorting inline.
 */
export function orderWork<T extends QueuedRef>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0));
}
