import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { parseGgufMeta } from "../models/gguf.js";
import {
  detectCapabilities,
  estimateCapabilities,
  isMmprojFilename,
  pickMmproj,
} from "../models/capabilities.js";
import { buildGguf, textModelKvs } from "./fixtures/gguf.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "il-caps-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeGguf(name: string, kvs: Parameters<typeof buildGguf>[0]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buildGguf(kvs));
  return p;
}

const TOOL_TEMPLATE =
  "{% if tools %}{{ tools }}{% endif %}{% for m in messages %}{{ m.content }}{% endfor %}";
const THINK_TEMPLATE =
  "{% for m in messages %}{{ m.content }}{% endfor %}{% if enable_thinking %}<think>{% endif %}";

describe("gguf chatTemplate extraction", () => {
  it("exposes tokenizer.chat_template on GgufMeta", () => {
    const p = writeGguf("tpl.gguf", textModelKvs(TOOL_TEMPLATE));
    const meta = parseGgufMeta(p);
    expect(meta?.chatTemplate).toBe(TOOL_TEMPLATE);
  });

  it("meta parses without a chat template (chatTemplate undefined)", () => {
    const p = writeGguf("notpl.gguf", textModelKvs());
    const meta = parseGgufMeta(p);
    expect(meta).not.toBeNull();
    expect(meta?.chatTemplate).toBeUndefined();
  });
});

describe("detectCapabilities (definitive, CONTRACTS §4)", () => {
  it("tools from a template that declares tools handling", () => {
    const p = writeGguf("tools.gguf", textModelKvs(TOOL_TEMPLATE));
    const caps = detectCapabilities({ meta: parseGgufMeta(p), filename: "tools.gguf" });
    expect(caps).toEqual({ tools: true, vision: false, thinking: true }); // qwen3 family → thinking
  });

  it("no tools when the template has none", () => {
    const p = writeGguf("plain.gguf", textModelKvs("{% for m in messages %}{{ m.content }}{% endfor %}"));
    const caps = detectCapabilities({
      meta: parseGgufMeta(p),
      filename: "plain.gguf",
      repoId: "acme/Plain-7B-GGUF",
    });
    expect(caps?.tools).toBe(false);
  });

  it("thinking from template markers", () => {
    const p = writeGguf("think.gguf", textModelKvs(THINK_TEMPLATE));
    const caps = detectCapabilities({
      meta: parseGgufMeta(p),
      filename: "think.gguf",
      repoId: "acme/Plain-7B-GGUF",
    });
    expect(caps?.thinking).toBe(true);
  });

  it("applies the publisher-backed GPT-OSS tool + thinking correction without template markers", () => {
    const p = writeGguf("gpt-oss-20b.gguf", textModelKvs("{% for m in messages %}{{ m.content }}{% endfor %}"));
    const caps = detectCapabilities({
      meta: parseGgufMeta(p),
      filename: "gpt-oss-20b-Q4_K_M.gguf",
      repoId: "openai/gpt-oss-20b-GGUF",
    });
    expect(caps).toEqual({ tools: true, vision: false, thinking: true });
  });

  it("vision from an mmproj sibling", () => {
    const p = writeGguf("vis.gguf", textModelKvs());
    const caps = detectCapabilities({
      meta: parseGgufMeta(p),
      filename: "vis.gguf",
      repoId: "acme/Plain-7B-GGUF",
      siblingFilenames: ["vis.gguf", "mmproj-model-f16.gguf"],
    });
    expect(caps?.vision).toBe(true);
  });

  it("returns undefined (unknown) when meta is null — never guesses", () => {
    expect(detectCapabilities({ meta: null, filename: "broken.gguf" })).toBeUndefined();
  });

  it("curated override wins: gemma-2 never reports tools", () => {
    const p = writeGguf("gemma.gguf", textModelKvs(TOOL_TEMPLATE));
    const caps = detectCapabilities({
      meta: parseGgufMeta(p),
      filename: "gemma-2-27b-it-Q4_K_M.gguf",
      repoId: "bartowski/Gemma-2-27B-it-GGUF",
    });
    expect(caps?.tools).toBe(false);
  });
});

describe("estimateCapabilities (search results)", () => {
  it("family heuristics: qwen3 repo → tools + thinking", () => {
    const caps = estimateCapabilities({ repoId: "Qwen/Qwen3-8B-GGUF" });
    expect(caps).toEqual({ tools: true, vision: false, thinking: true });
  });

  it("family heuristics: gpt_oss variants are tool- and thinking-capable", () => {
    expect(estimateCapabilities({ repoId: "openai/gpt_oss_120b-GGUF" })).toEqual({
      tools: true,
      vision: false,
      thinking: true,
    });
  });

  it("mmproj sibling or vision tag → vision", () => {
    expect(
      estimateCapabilities({
        repoId: "acme/Some-7B-GGUF",
        siblingFilenames: ["a.gguf", "mmproj-f16.gguf"],
      }).vision,
    ).toBe(true);
    expect(
      estimateCapabilities({ repoId: "acme/Some-7B-GGUF", tags: ["image-text-to-text"] }).vision,
    ).toBe(true);
  });

  it("hf-provided chat template upgrades the tools estimate", () => {
    expect(
      estimateCapabilities({ repoId: "acme/Obscure-GGUF", chatTemplate: TOOL_TEMPLATE }).tools,
    ).toBe(true);
  });
});

describe("mmproj helpers", () => {
  it("isMmprojFilename matches the conventional names", () => {
    expect(isMmprojFilename("mmproj-model-f16.gguf")).toBe(true);
    expect(isMmprojFilename("Qwen3-8B-Q4_K_M.gguf")).toBe(false);
  });

  it("pickMmproj prefers f16, else largest", () => {
    expect(
      pickMmproj([
        { filename: "mmproj-q8_0.gguf", sizeBytes: 900 },
        { filename: "mmproj-f16.gguf", sizeBytes: 500 },
      ])?.filename,
    ).toBe("mmproj-f16.gguf");
    expect(
      pickMmproj([
        { filename: "mmproj-a.gguf", sizeBytes: 100 },
        { filename: "mmproj-b.gguf", sizeBytes: 300 },
      ])?.filename,
    ).toBe("mmproj-b.gguf");
    expect(pickMmproj([])).toBeNull();
  });
});
