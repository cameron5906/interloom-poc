import { describe, expect, it } from "vitest";
import { clampMaxTokens } from "../inference/limits.js";

describe("clampMaxTokens", () => {
  it("defaults to 512 with a 4k window", () => {
    expect(clampMaxTokens(undefined, 4096)).toBe(512);
    expect(clampMaxTokens(undefined, undefined)).toBe(512);
  });

  it("honors a smaller request", () => {
    expect(clampMaxTokens(256, 4096)).toBe(256);
  });

  it("caps at 1024 regardless of window", () => {
    expect(clampMaxTokens(4000, 32768)).toBe(1024);
  });

  it("caps at half the window for tiny windows, floored at 128", () => {
    expect(clampMaxTokens(512, 512)).toBe(256);
    expect(clampMaxTokens(512, 100)).toBe(128);
  });

  describe("thinking capability (CONTRACTS §6.1)", () => {
    it("non-thinking models keep the 1024 ceiling", () => {
      expect(clampMaxTokens(4000, 32768, false)).toBe(1024);
    });

    it("thinking models get a 4096 ceiling", () => {
      expect(clampMaxTokens(4000, 32768, true)).toBe(4000);
      expect(clampMaxTokens(8000, 32768, true)).toBe(4096);
    });

    it("thinking defaults to false when omitted (back-compat)", () => {
      expect(clampMaxTokens(4000, 32768)).toBe(1024);
    });

    it("thinking models still respect the half-window floor/cap", () => {
      expect(clampMaxTokens(4000, 512, true)).toBe(256);
      expect(clampMaxTokens(4000, 100, true)).toBe(128);
    });

    it("thinking models honor a smaller explicit request", () => {
      expect(clampMaxTokens(300, 32768, true)).toBe(300);
    });
  });
});
