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
});
