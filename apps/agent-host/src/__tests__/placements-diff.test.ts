import { describe, it, expect } from "vitest";
import { diffPlacements } from "../tunnel/manager.js";
import type { LiveTunnel } from "../tunnel/manager.js";
import type { Placement } from "@interloom/protocol";

function makeVoucher(agentId: string, instanceUrl: string, placementId: string, sig = "sig") {
  return {
    payload: {
      v: 1 as const,
      placementId,
      agentId,
      agentPubKey: "pubkey",
      instanceUrl,
      instanceName: "test",
      iat: Date.now(),
      exp: Date.now() + 86_400_000,
      nonce: "nonce",
    },
    key: "networkpubkey",
    sig,
  };
}

function makePlacement(id: string, revoked = false, sig = "sig"): Placement {
  return {
    placementId: id,
    instanceUrl: `http://instance-${id}.example.com`,
    instanceName: `instance-${id}`,
    voucher: makeVoucher("agent1", `http://instance-${id}.example.com`, id, sig),
    revoked,
  };
}

function makeLiveTunnel(voucherSig = "sig", authFailed = false): LiveTunnel {
  return { voucherSig, authFailed };
}

function makeClientMap(ids: string[]): Map<string, LiveTunnel> {
  return new Map(ids.map((id) => [id, makeLiveTunnel()]));
}

describe("diffPlacements", () => {
  it("opens new non-revoked placements not in current map", () => {
    const current = makeClientMap([]);
    const incoming = [makePlacement("p1"), makePlacement("p2")];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toOpen).toHaveLength(2);
    expect(toOpen.map((p) => p.placementId)).toContain("p1");
    expect(toOpen.map((p) => p.placementId)).toContain("p2");
    expect(toClose).toHaveLength(0);
  });

  it("does not re-open already connected placements", () => {
    const current = makeClientMap(["p1"]);
    const incoming = [makePlacement("p1")];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toOpen).toHaveLength(0);
    expect(toClose).toHaveLength(0);
  });

  it("closes revoked placements that are currently connected", () => {
    const current = makeClientMap(["p1"]);
    const incoming = [makePlacement("p1", true)];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toOpen).toHaveLength(0);
    expect(toClose).toContain("p1");
  });

  it("does not try to close a revoked placement that was not open", () => {
    const current = makeClientMap([]);
    const incoming = [makePlacement("p1", true)];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toOpen).toHaveLength(0);
    expect(toClose).toHaveLength(0);
  });

  it("closes placements removed from heartbeat response", () => {
    const current = makeClientMap(["p1", "p2"]);
    const incoming = [makePlacement("p1")];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toClose).toContain("p2");
    expect(toClose).not.toContain("p1");
  });

  it("handles mixed scenario: new + revoked + removed + existing", () => {
    const current = makeClientMap(["p1", "p2", "p3"]);
    const incoming = [
      makePlacement("p1"),
      makePlacement("p2", true),
      makePlacement("p4"),
    ];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toOpen.map((p) => p.placementId)).toEqual(["p4"]);
    expect(toClose).toContain("p2");
    expect(toClose).toContain("p3");
    expect(toClose).not.toContain("p1");
    expect(toClose).not.toContain("p4");
  });

  it("replaces a placement when the incoming voucher sig differs (voucher refresh)", () => {
    const current = new Map([["p1", makeLiveTunnel("old", false)]]);
    const incoming = [makePlacement("p1", false, "new")];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toClose).toContain("p1");
    expect(toOpen.map((p) => p.placementId)).toContain("p1");
  });

  it("replaces a placement when the client is auth-failed, even with the same voucher sig", () => {
    const current = new Map([["p1", makeLiveTunnel("sig", true)]]);
    const incoming = [makePlacement("p1", false, "sig")];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toClose).toContain("p1");
    expect(toOpen.map((p) => p.placementId)).toContain("p1");
  });

  it("steady state: same sig, authFailed=false — placement in neither list", () => {
    const current = new Map([["p1", makeLiveTunnel("sig", false)]]);
    const incoming = [makePlacement("p1", false, "sig")];
    const { toOpen, toClose } = diffPlacements(current, incoming);
    expect(toClose).not.toContain("p1");
    expect(toOpen.map((p) => p.placementId)).not.toContain("p1");
  });
});
