/**
 * Endpoint functions mapped 1:1 to CONTRACTS §6. Grouped by domain so pages
 * import intent (`system.get()`) rather than raw paths.
 */
import type {
  SystemInfo,
  DownloadJob,
  LocalModel,
  HostAgent,
  PlacementStatus,
  UpdateStatus,
} from "@interloom/protocol";
import { api } from "./client.js";
import type {
  HostKeys,
  NetworkSession,
  NetworkLoginResult,
  ModelRegistryResponse,
  HfSearchResult,
  HfRepoDetail,
  ActivateOptions,
  ActivateResult,
  ActiveModel,
  ContextOptions,
  HfSettings,
  HfTokenResult,
  AgentDraft,
} from "./types.js";

export const system = {
  get: (signal?: AbortSignal) => api.get<SystemInfo>("/api/system", signal),
};

export const keys = {
  get: (signal?: AbortSignal) => api.get<HostKeys>("/api/keys", signal),
};

export const network = {
  login: (email: string) => api.post<NetworkLoginResult>("/api/network/login", { email }),
  session: (signal?: AbortSignal) => api.get<NetworkSession>("/api/network/session", signal),
};

export const models = {
  registry: (signal?: AbortSignal) =>
    api.get<ModelRegistryResponse>("/api/models/registry", signal),
  search: (q: string, signal?: AbortSignal) =>
    api.get<HfSearchResult[]>(`/api/models/search?q=${encodeURIComponent(q)}`, signal),
  hfDetail: (repoId: string, signal?: AbortSignal) =>
    api.get<HfRepoDetail>(`/api/models/hf-detail?repoId=${encodeURIComponent(repoId)}`, signal),
  local: (signal?: AbortSignal) => api.get<LocalModel[]>("/api/models/local", signal),
  downloads: (signal?: AbortSignal) => api.get<DownloadJob[]>("/api/models/downloads", signal),
  download: (repoId: string, filename: string, mmprojFilename?: string) =>
    api.post<{ id: string }>(
      "/api/models/download",
      mmprojFilename ? { repoId, filename, mmprojFilename } : { repoId, filename },
    ),
  contextOptions: (path: string, signal?: AbortSignal) =>
    api.get<ContextOptions>(`/api/models/context-options?path=${encodeURIComponent(path)}`, signal),
  activate: (path: string, opts: ActivateOptions = {}) =>
    api.post<ActivateResult>("/api/models/activate", {
      path,
      ...(opts.ctx != null ? { ctx: opts.ctx } : {}),
      ...(opts.kvCache != null ? { kvCache: opts.kvCache } : {}),
      ...(opts.nCpuMoe != null ? { nCpuMoe: opts.nCpuMoe } : {}),
    }),
  active: (signal?: AbortSignal) => api.get<ActiveModel | null>("/api/models/active", signal),
  removeLocal: (path: string) => api.del<void>("/api/models/local", { path }),
};

export const agents = {
  list: (signal?: AbortSignal) => api.get<HostAgent[]>("/api/agents", signal),
  create: (draft: AgentDraft) => api.post<HostAgent>("/api/agents", draft),
  update: (id: string, draft: Partial<AgentDraft>) =>
    api.patch<HostAgent>(`/api/agents/${id}`, draft),
  remove: (id: string) => api.del<void>(`/api/agents/${id}`),
  register: (id: string) => api.post<HostAgent>(`/api/agents/${id}/register`),
  uploadAvatar: (id: string, dataUrl: string) =>
    api.post<{ imageUrl: string }>(`/api/agents/${id}/avatar`, { dataUrl }),
};

export const placements = {
  list: (signal?: AbortSignal) => api.get<PlacementStatus[]>("/api/placements", signal),
  revoke: (id: string) => api.del<void>(`/api/placements/${id}`),
};

export const settings = {
  hf: (signal?: AbortSignal) => api.get<HfSettings>("/api/settings/hf", signal),
  setHfToken: (token: string) => api.post<HfTokenResult>("/api/settings/hf-token", { token }),
  deleteHfToken: () => api.del<void>("/api/settings/hf-token"),
  operator: (signal?: AbortSignal) =>
    api.get<{ displayName: string }>("/api/settings/operator", signal),
  setOperator: (displayName: string) =>
    api.post<{ displayName: string }>("/api/settings/operator", { displayName }),
};

export const update = {
  status: (signal?: AbortSignal) => api.get<UpdateStatus>("/api/update/status", signal),
  check: () => api.post<UpdateStatus>("/api/update/check"),
  apply: () => api.post<{ status: "started" }>("/api/update/apply"),
};
