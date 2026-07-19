import { beforeEach, describe, expect, it, vi } from "vitest";

const networkAgentExists = vi.fn();
const registerAgentOnNetwork = vi.fn();
const listAgents = vi.fn();
const updateAgent = vi.fn();

vi.mock("../network/client.js", () => ({ networkAgentExists }));
vi.mock("../agents/register.js", () => ({ registerAgentOnNetwork }));
vi.mock("../agents/store.js", () => ({ listAgents, updateAgent }));

describe("Network registry reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("restores only missing locally registered agents, including frontier agents", async () => {
    const hostedPresent = {
      agentId: "hosted-present",
      name: "Present",
      registered: true,
      model: { filename: "present.gguf" },
    };
    const hostedMissing = {
      agentId: "hosted-missing",
      name: "Missing",
      registered: true,
      model: { filename: "missing.gguf" },
    };
    const frontierMissing = {
      agentId: "frontier-missing",
      name: "Frontier",
      registered: true,
      runtime: "frontier",
    };
    const neverPublished = {
      agentId: "draft",
      name: "Draft",
      registered: false,
      model: { filename: "draft.gguf" },
    };
    listAgents.mockReturnValue([hostedPresent, hostedMissing, frontierMissing, neverPublished]);
    networkAgentExists.mockImplementation(async (agentId: string) => agentId === "hosted-present");
    registerAgentOnNetwork.mockResolvedValue(undefined);

    const log = vi.fn();
    const { reconcileNetworkRegistry } = await import("../agents/reconcile.js");
    await reconcileNetworkRegistry(log);

    expect(networkAgentExists).toHaveBeenCalledTimes(3);
    expect(registerAgentOnNetwork).toHaveBeenCalledTimes(2);
    expect(registerAgentOnNetwork).toHaveBeenCalledWith(hostedMissing);
    expect(registerAgentOnNetwork).toHaveBeenCalledWith(frontierMissing);
    expect(updateAgent).toHaveBeenCalledTimes(2);
    expect(updateAgent).toHaveBeenCalledWith("hosted-missing", {
      syncedAt: expect.any(String),
    });
    expect(updateAgent).toHaveBeenCalledWith("frontier-missing", {
      syncedAt: expect.any(String),
    });
    expect(log).toHaveBeenCalledWith("registry reconciliation restored Missing");
    expect(log).toHaveBeenCalledWith("registry reconciliation restored Frontier");
  });

  it("continues reconciling other agents after one lookup fails", async () => {
    const first = { agentId: "first", name: "First", registered: true };
    const second = { agentId: "second", name: "Second", registered: true };
    listAgents.mockReturnValue([first, second]);
    networkAgentExists.mockImplementation(async (agentId: string) => {
      if (agentId === "first") throw new Error("network unavailable");
      return false;
    });
    registerAgentOnNetwork.mockResolvedValue(undefined);

    const log = vi.fn();
    const { reconcileNetworkRegistry } = await import("../agents/reconcile.js");
    await reconcileNetworkRegistry(log);

    expect(registerAgentOnNetwork).toHaveBeenCalledOnce();
    expect(registerAgentOnNetwork).toHaveBeenCalledWith(second);
    expect(log).toHaveBeenCalledWith(
      "registry reconciliation failed for First: network unavailable",
    );
    expect(log).toHaveBeenCalledWith("registry reconciliation restored Second");
  });

  it("runs immediately, repeats on the configured interval, and stops cleanly", async () => {
    vi.useFakeTimers();
    listAgents.mockReturnValue([]);

    const { startNetworkRegistryReconciliation } = await import("../agents/reconcile.js");
    const stop = startNetworkRegistryReconciliation(vi.fn(), 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(listAgents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listAgents).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listAgents).toHaveBeenCalledTimes(2);
  });
});
