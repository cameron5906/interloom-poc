/**
 * Response shapes for the Agent Host daemon API (CONTRACTS §6) that are not
 * already exported by `@interloom/protocol`. Payload types that ARE in the
 * protocol package (SystemInfo, CuratedModel, DownloadJob, LocalModel,
 * HostAgent, TelemetryFrame, PlacementStatus, …) are imported directly from it.
 */

/** `GET /api/keys` — the host keypair public half. */
export interface HostKeys {
  pubKey: string;
  createdAt: string;
}

/** `GET /api/network/session` — owner network-session status. */
export interface NetworkSession {
  signedIn: boolean;
  email?: string;
}

/** `POST /api/network/login` — proxied magic-link stub response. */
export interface NetworkLoginResult {
  loginUrl: string;
}

/** A curated model annotated with a `fits` flag (CONTRACTS §6, `/api/models/curated`). */
export interface FitAnnotatedModel {
  id: string;
  repoId: string;
  filename: string;
  displayName: string;
  sizeBytes: number;
  quant: string;
  minVramMB: number;
  tier: "spark" | "gpu-24gb" | "gpu-10gb" | "cpu";
  blurb: string;
  fits: boolean;
}

/** A single GGUF file in a Hugging Face search result. */
export interface HfSearchFile {
  filename: string;
  sizeBytes: number;
  quant: string;
}

/** `GET /api/models/search?q=` — mapped HF Hub result row (CONTRACTS §6). */
export interface HfSearchResult {
  repoId: string;
  likes: number;
  downloads: number;
  files: HfSearchFile[];
}

/** `POST /api/models/activate` — activation poll result (CONTRACTS §6). */
export interface ActivateResult {
  status: "ready" | "loading" | "error";
  error?: string;
}

/** Local agent as returned by the daemon store (CONTRACTS §6). */
export interface AgentDraft {
  name: string;
  avatar: { emoji: string; bg: string };
  persona: string;
  capabilityBlurb: string;
  params: { temperature: number; contextLength: number };
}
