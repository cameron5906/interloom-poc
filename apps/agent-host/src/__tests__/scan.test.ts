import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { scanLocalModels, capabilitiesForFilename } from "../models/scan.js";
import { buildGguf, textModelKvs } from "./fixtures/gguf.js";

const TOOL_TEMPLATE = "{% if tools %}{{ tools }}{% endif %}";

let tmp: string;
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "il-scan-"));
  const repo = path.join(tmp, "Qwen__Qwen3-8B-GGUF");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "Qwen3-8B-Q4_K_M.gguf"), buildGguf(textModelKvs(TOOL_TEMPLATE)));
  fs.writeFileSync(path.join(repo, "mmproj-f16.gguf"), buildGguf({ "general.architecture": { t: "str", v: "clip" } }));
  return tmp;
}

describe("scanLocalModels (CONTRACTS §6 local)", () => {
  it("excludes mmproj files and pairs them with directory siblings", () => {
    const models = scanLocalModels(setup());
    expect(models).toHaveLength(1);
    const m = models[0]!;
    expect(m.filename).toBe("Qwen3-8B-Q4_K_M.gguf");
    expect(m.mmprojPath).toContain("mmproj-f16.gguf");
    expect(m.mmprojBytes).toBeGreaterThan(0);
  });

  it("returns definitive capabilities (vision via paired mmproj)", () => {
    const models = scanLocalModels(setup());
    expect(models[0]!.capabilities).toEqual({ tools: true, vision: true, thinking: true });
  });

  it("caches by path+mtime: second scan does not re-read headers", () => {
    const dir = setup();
    const first = scanLocalModels(dir);
    const spy = { reads: 0 };
    const orig = fs.openSync;
    (fs as { openSync: typeof fs.openSync }).openSync = ((...args: Parameters<typeof fs.openSync>) => {
      spy.reads += 1;
      return orig(...args);
    }) as typeof fs.openSync;
    try {
      const second = scanLocalModels(dir);
      expect(second).toEqual(first);
      expect(spy.reads).toBe(0);
    } finally {
      (fs as { openSync: typeof fs.openSync }).openSync = orig;
    }
  });

  it("late-arriving mmproj upgrades vision despite cached header caps", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "il-scan-"));
    const repo = path.join(tmp, "Qwen__Qwen3-8B-GGUF");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "Qwen3-8B-Q4_K_M.gguf"), buildGguf(textModelKvs(TOOL_TEMPLATE)));

    const first = scanLocalModels(tmp);
    expect(first).toHaveLength(1);
    expect(first[0]!.capabilities?.vision).toBe(false);
    expect(first[0]!.mmprojPath).toBeUndefined();

    fs.writeFileSync(
      path.join(repo, "mmproj-f16.gguf"),
      buildGguf({ "general.architecture": { t: "str", v: "clip" } }),
    );

    const second = scanLocalModels(tmp);
    expect(second).toHaveLength(1);
    expect(second[0]!.capabilities?.vision).toBe(true);
    expect(second[0]!.mmprojPath).toContain("mmproj-f16.gguf");
  });

  it("missing dir → empty list", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "il-scan-"));
    expect(scanLocalModels(path.join(tmp, "nope"))).toEqual([]);
  });

  it("capabilitiesForFilename resolves through the same cache", () => {
    const dir = setup();
    expect(capabilitiesForFilename(dir, "Qwen3-8B-Q4_K_M.gguf")?.tools).toBe(true);
    expect(capabilitiesForFilename(dir, "missing.gguf")).toBeUndefined();
  });
});
