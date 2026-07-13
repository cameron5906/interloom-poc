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
  capabilities?: import("@interloom/protocol").ModelCapabilities;
}

/** `GET /api/models/search?q=` — rail row (CONTRACTS §6). Capabilities are estimates. */
export interface HfSearchResult {
  repoId: string;
  likes: number;
  downloads: number;
  paramsB?: number;
  trainedCtx?: number;
  capabilities?: import("@interloom/protocol").ModelCapabilities;
}

/** One GGUF file in `GET /api/models/hf-detail` (mmproj excluded — paired separately). */
export interface HfDetailFile {
  filename: string;
  sizeBytes: number;
  quant: string;
  /** Largest ctx that fits this host at `fast` tier — same math as activation. */
  maxFastCtx?: number;
}

/** `GET /api/models/hf-detail?repoId=` (CONTRACTS §6). Capabilities are estimates. */
export interface HfRepoDetail {
  repoId: string;
  likes: number;
  downloads: number;
  trainedCtx?: number;
  lastModified?: string;
  capabilities?: import("@interloom/protocol").ModelCapabilities;
  mmprojFilename?: string;
  files: HfDetailFile[];
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
  /** Absolute path of the paired mmproj (vision projector), when loaded. */
  mmprojPath?: string;
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
  avatar: {
    emoji: string;
    bg: string;
    imageUrl?: string;
    character?: import("@interloom/protocol").AvatarCharacter;
  };
  persona: string;
  capabilityBlurb: string;
  title?: string;
  gender?: import("@interloom/protocol").AgentGender;
  specialties?: string[];
  params: { temperature: number; contextLength: number };
  model?: import("@interloom/protocol").ModelRef;
}

/** Shared empty-draft literal — both the "new agent" list row and the editor's
 * blank-agent form derive from this so they can't drift apart. */
export const EMPTY_AGENT_DRAFT: AgentDraft = {
  name: "",
  avatar: { emoji: "🤖", bg: "linear-gradient(135deg,#8b76ee,#6a5acd)" },
  persona: "",
  capabilityBlurb: "",
  params: { temperature: 0.7, contextLength: 4096 },
};
