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
} from "@interloom/protocol";
import { api } from "./client.js";
import type {
  HostKeys,
  NetworkSession,
  NetworkLoginResult,
  FitAnnotatedModel,
  HfSearchResult,
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
  curated: (signal?: AbortSignal) =>
    api.get<FitAnnotatedModel[]>("/api/models/curated", signal),
  search: (q: string, signal?: AbortSignal) =>
    api.get<HfSearchResult[]>(`/api/models/search?q=${encodeURIComponent(q)}`, signal),
  local: (signal?: AbortSignal) => api.get<LocalModel[]>("/api/models/local", signal),
  downloads: (signal?: AbortSignal) => api.get<DownloadJob[]>("/api/models/downloads", signal),
  download: (repoId: string, filename: string) =>
    api.post<{ id: string }>("/api/models/download", { repoId, filename }),
  contextOptions: (path: string, signal?: AbortSignal) =>
    api.get<ContextOptions>(`/api/models/context-options?path=${encodeURIComponent(path)}`, signal),
  activate: (path: string, ctx?: number) =>
    api.post<ActivateResult>("/api/models/activate", ctx != null ? { path, ctx } : { path }),
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
};

export const placements = {
  list: (signal?: AbortSignal) => api.get<PlacementStatus[]>("/api/placements", signal),
  revoke: (id: string) => api.del<void>(`/api/placements/${id}`),
};

export const settings = {
  hf: (signal?: AbortSignal) => api.get<HfSettings>("/api/settings/hf", signal),
  setHfToken: (token: string) => api.post<HfTokenResult>("/api/settings/hf-token", { token }),
  deleteHfToken: () => api.del<void>("/api/settings/hf-token"),
};
