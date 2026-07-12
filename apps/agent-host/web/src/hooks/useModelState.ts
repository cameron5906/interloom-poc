import type { DownloadJob, LocalModel } from "@interloom/protocol";
import type { ActiveModel } from "../api/types.js";

export type ModelInstallState =
  | "not-installed"
  | "queued"
  | "downloading"
  | "installed"
  | "active";

export interface ModelState {
  state: ModelInstallState;
  /** Present when state is "downloading" or "queued". */
  job?: DownloadJob;
  /** Present when state is "installed" or "active". */
  localModel?: LocalModel;
}

/**
 * Derives display state for a single model file from the live downloads list,
 * the local model scan, and the active model path. Used by all model tiles so
 * that state flips automatically when a download completes (without a reload).
 */
export function deriveModelState(
  repoId: string,
  filename: string,
  downloads: DownloadJob[],
  localModels: LocalModel[],
  activeModel: ActiveModel | null | undefined,
): ModelState {
  const job = downloads.find((d) => d.repoId === repoId && d.filename === filename);

  if (job && job.status !== "done" && job.status !== "error") {
    return { state: job.status === "queued" ? "queued" : "downloading", job };
  }

  const localModel = localModels.find((m) => m.filename === filename);
  if (localModel) {
    if (activeModel && activeModel.filename === filename) {
      return { state: "active", localModel };
    }
    return { state: "installed", localModel };
  }

  return { state: "not-installed" };
}
