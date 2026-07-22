import { describe, expect, it } from "vitest";
import { allocateMaxTokens } from "../inference/limits.js";

describe("allocateMaxTokens", () => {
  it("allocates the unused physical window when the caller has no preference", () => {
    expect(allocateMaxTokens(undefined, 4096, 1000)).toBe(3064);
  });

  it("uses half the window when exact input counting is unavailable", () => {
    expect(allocateMaxTokens(undefined, 4096)).toBe(2048);
  });

  it("honors a smaller request", () => {
    expect(allocateMaxTokens(256, 4096, 1000)).toBe(256);
  });

  it("has no fixed 4k or 8k output ceiling", () => {
    expect(allocateMaxTokens(20_000, 32_768, 2_000)).toBe(20_000);
  });

  it("clamps only to exact request-local remaining capacity", () => {
    expect(allocateMaxTokens(20_000, 8_192, 7_000)).toBe(1_160);
  });

  it("honors a catalog-declared model output maximum when present", () => {
    expect(allocateMaxTokens(20_000, 32_768, 2_000, 8_192)).toBe(8_192);
  });
});
