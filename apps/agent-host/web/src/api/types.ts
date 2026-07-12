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

/** `GET /api/models/active` — currently loaded model or null (CONTRACTS §6). */
export interface ActiveModel {
  path: string;
  filename: string;
  /** Context window the model was loaded with (added by daemon post-R2b). */
  ctx?: number;
}

/** One candidate context-size entry from `GET /api/models/context-options`. */
export interface ContextOption {
  ctx: number;
  kvBytes: number;
  fit: "fast" | "spill" | "no";
}

/**
 * `GET /api/models/context-options?path=` — CONTRACTS §6 "Context sizing".
 * `exact:false` means the daemon couldn't parse GGUF metadata and used
 * heuristics; the UI must show an "estimated" note.
 */
export interface ContextOptions {
  trainedMax: number;
  options: ContextOption[];
  recommendedCtx: number;
  exact: boolean;
}

/** `GET /api/settings/hf` — HF account connection status (CONTRACTS §6). */
export interface HfSettings {
  connected: boolean;
  username?: string;
}

/** `POST /api/settings/hf-token` — HF token validation result (CONTRACTS §6). */
export interface HfTokenResult {
  username: string;
}

/** Local agent as returned by the daemon store (CONTRACTS §6). */
export interface AgentDraft {
  name: string;
  avatar: { emoji: string; bg: string };
  persona: string;
  capabilityBlurb: string;
  params: { temperature: number; contextLength: number };
  model?: import("@interloom/protocol").ModelRef;
}
