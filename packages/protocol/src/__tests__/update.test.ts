import { describe, it, expect } from "vitest";
import { HostReleaseManifest, UpdateApplyState, UpdateStatus, SystemInfo } from "../index.js";

describe("host release schemas", () => {
  it("parses a release manifest", () => {
    const m = HostReleaseManifest.parse({
      version: "2026.07.12-27d3674",
      gitSha: "27d3674",
      publishedAt: "2026-07-12T18:00:00Z",
      images: ["agent-host", "inference", "model-fetcher", "host-updater"],
      notes: null,
    });
    expect(m.version).toBe("2026.07.12-27d3674");
    expect(m.notes).toBeNull();
  });

  it("rejects a manifest without a version", () => {
    expect(() =>
      HostReleaseManifest.parse({ gitSha: "x", publishedAt: "", images: [], notes: null }),
    ).toThrow();
  });

  it("SystemInfo.version is optional (additive wire evolution)", () => {
    const base = { os: "linux", arch: "x64", dockerized: true as const, gpus: [] };
    expect(SystemInfo.parse(base).version).toBeUndefined();
    expect(SystemInfo.parse({ ...base, version: "2026.07.12-27d3674" }).version).toBe(
      "2026.07.12-27d3674",
    );
  });

  it("UpdateApplyState accepts the unknown state (updater unreachable)", () => {
    expect(UpdateApplyState.parse({ state: "unknown" }).state).toBe("unknown");
  });

  it("UpdateStatus round-trips the full shape", () => {
    const s = UpdateStatus.parse({
      current: { version: "2026.07.10-abc1234" },
      latest: { version: "2026.07.12-27d3674", publishedAt: "2026-07-12T18:00:00Z", notes: null },
      updateAvailable: true,
      checkedAt: "2026-07-12T18:05:00Z",
      networkUrl: "https://interloom-net.tryeris.com",
      apply: { state: "idle" },
    });
    expect(s.updateAvailable).toBe(true);
    expect(s.latest?.version).toBe("2026.07.12-27d3674");
  });
});
