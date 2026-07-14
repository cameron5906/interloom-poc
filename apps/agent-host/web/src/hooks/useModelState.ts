import type { DownloadJob, LoadedModel, LocalModel } from "@interloom/protocol";

export type ModelInstallState =
  | "not-installed"
  | "queued"
  | "downloading"
  | "installed"
  | "loaded";

export interface ModelState {
  state: ModelInstallState;
  /** Present when state is "downloading" or "queued". */
  job?: DownloadJob;
  /** Present when state is "installed" or "loaded". */
  localModel?: LocalModel;
}

/**
 * Derives display state for a single model file from the live downloads list,
 * the local model scan, and the loaded-instances set (CONTRACTS §6 — a host
 * can hold N concurrently loaded models, so "loaded" is a membership check
 * against that set, not a single active-model comparison). Used by all model
 * tiles so that state flips automatically when a download completes or a
 * load/unload happens (without a reload).
 */
export function deriveModelState(
  repoId: string,
  filename: string,
  downloads: DownloadJob[],
  localModels: LocalModel[],
  loadedModels: LoadedModel[],
): ModelState {
  const job = downloads.find((d) => d.repoId === repoId && d.filename === filename);

  if (job && job.status !== "done" && job.status !== "error") {
    return { state: job.status === "queued" ? "queued" : "downloading", job };
  }

  const localModel = localModels.find((m) => m.filename === filename);
  if (localModel) {
    // Once resolved to a specific local file, loaded-ness is a path match —
    // matching by filename here would flag a never-loaded file as loaded
    // whenever another file with the same name is loaded from a different path.
    if (loadedModels.some((m) => m.path === localModel.path)) {
      return { state: "loaded", localModel };
    }
    return { state: "installed", localModel };
  }

  return { state: "not-installed" };
}
