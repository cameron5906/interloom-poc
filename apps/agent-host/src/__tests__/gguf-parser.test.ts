/**
 * Tests for the GGUF metadata parser (CONTRACTS §6 context sizing).
 *
 * Builds synthetic minimal GGUF buffers in-test and verifies that the parser
 * extracts the correct architecture metadata. Also tests null-return on invalid input.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { parseGgufMeta } from "../models/gguf.js";

// ---------------------------------------------------------------------------
// GGUF binary builder utilities
// ---------------------------------------------------------------------------

const GGUF_MAGIC = 0x46554747; // "GGUF" LE u32

type GgufScalarValue =
  | { type: "uint32"; value: number }
  | { type: "uint64"; value: number }
  | { type: "float32"; value: number }
  | { type: "string"; value: string };

interface KvEntry {
  key: string;
  value: GgufScalarValue;
}

const ValueType = {
  UINT32:  4,
  FLOAT32: 6,
  STRING:  8,
  UINT64:  10,
} as const;

function writeU8(buf: number[], v: number): void {
  buf.push(v & 0xff);
}

function writeU16LE(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >> 8) & 0xff);
}

function writeU32LE(buf: number[], v: number): void {
  buf.push(
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >> 24) & 0xff,
  );
}

function writeU64LE(buf: number[], v: number): void {
  // Split into lo (u32) and hi (u32)
  const lo = v >>> 0;
  const hi = Math.floor(v / 0x100000000) >>> 0;
  writeU32LE(buf, lo);
  writeU32LE(buf, hi);
}

function writeF32LE(buf: number[], v: number): void {
  const tmp = Buffer.allocUnsafe(4);
  tmp.writeFloatLE(v, 0);
  for (const b of tmp) buf.push(b);
}

function writeGgufString(buf: number[], s: string): void {
  const bytes = Buffer.from(s, "utf8");
  writeU64LE(buf, bytes.length);
  for (const b of bytes) buf.push(b);
}

function writeScalarValue(buf: number[], val: GgufScalarValue): void {
  switch (val.type) {
    case "uint32":
      writeU32LE(buf, val.value);
      break;
    case "uint64":
      writeU64LE(buf, val.value);
      break;
    case "float32":
      writeF32LE(buf, val.value);
      break;
    case "string":
      writeGgufString(buf, val.value);
      break;
  }
}

function valueTypeCode(val: GgufScalarValue): number {
  switch (val.type) {
    case "uint32":  return ValueType.UINT32;
    case "uint64":  return ValueType.UINT64;
    case "float32": return ValueType.FLOAT32;
    case "string":  return ValueType.STRING;
  }
}

/**
 * Build a minimal valid GGUF v3 buffer with the given metadata key-value pairs.
 * tensor_count = 0, no tensor info section.
 */
function buildGgufBuffer(kvEntries: KvEntry[], version: number = 3): Buffer {
  const buf: number[] = [];

  // Magic
  writeU32LE(buf, GGUF_MAGIC);
  // Version
  writeU32LE(buf, version);
  // tensor_count (u64)
  writeU64LE(buf, 0);
  // kv_count (u64)
  writeU64LE(buf, kvEntries.length);

  // KV pairs
  for (const { key, value } of kvEntries) {
    writeGgufString(buf, key);
    writeU32LE(buf, valueTypeCode(value));
    writeScalarValue(buf, value);
  }

  return Buffer.from(buf);
}

/**
 * Write a buffer to a temp file, run the parser, then clean up.
 */
function parseBuffer(buf: Buffer): ReturnType<typeof parseGgufMeta> {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.gguf`);
  fs.writeFileSync(tmpFile, buf);
  try {
    return parseGgufMeta(tmpFile);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseGgufMeta — synthetic buffer", () => {
  it("parses a minimal v3 GGUF with llama architecture metadata", () => {
    const kv: KvEntry[] = [
      { key: "general.architecture", value: { type: "string", value: "llama" } },
      { key: "llama.context_length",   value: { type: "uint32", value: 4096 } },
      { key: "llama.block_count",      value: { type: "uint32", value: 32 } },
      { key: "llama.attention.head_count_kv", value: { type: "uint32", value: 8 } },
      { key: "llama.embedding_length", value: { type: "uint32", value: 4096 } },
      { key: "llama.attention.head_count",    value: { type: "uint32", value: 32 } },
    ];

    const result = parseBuffer(buildGgufBuffer(kv));
    expect(result).not.toBeNull();
    expect(result!.architecture).toBe("llama");
    expect(result!.contextLength).toBe(4096);
    expect(result!.blockCount).toBe(32);
    expect(result!.kvHeads).toBe(8);
    // headDim = embedding_length / head_count = 4096 / 32 = 128
    expect(result!.headDim).toBe(128);
  });

  it("uses attention.key_length for headDim when present", () => {
    const kv: KvEntry[] = [
      { key: "general.architecture", value: { type: "string", value: "phi2" } },
      { key: "phi2.context_length",   value: { type: "uint32", value: 2048 } },
      { key: "phi2.block_count",      value: { type: "uint32", value: 24 } },
      { key: "phi2.attention.head_count_kv", value: { type: "uint32", value: 16 } },
      { key: "phi2.attention.head_count",    value: { type: "uint32", value: 32 } },
      { key: "phi2.embedding_length",        value: { type: "uint32", value: 2560 } },
      { key: "phi2.attention.key_length",    value: { type: "uint32", value: 80 } },
    ];

    const result = parseBuffer(buildGgufBuffer(kv));
    expect(result).not.toBeNull();
    // key_length wins over embedding_length / head_count
    expect(result!.headDim).toBe(80);
  });

  it("falls back to head_count when head_count_kv is absent", () => {
    const kv: KvEntry[] = [
      { key: "general.architecture", value: { type: "string", value: "mistral" } },
      { key: "mistral.context_length",  value: { type: "uint32", value: 8192 } },
      { key: "mistral.block_count",     value: { type: "uint32", value: 40 } },
      { key: "mistral.attention.head_count", value: { type: "uint32", value: 32 } },
      { key: "mistral.embedding_length",     value: { type: "uint32", value: 4096 } },
    ];

    const result = parseBuffer(buildGgufBuffer(kv));
    expect(result).not.toBeNull();
    // No head_count_kv → falls back to head_count = 32
    expect(result!.kvHeads).toBe(32);
    expect(result!.headDim).toBe(128); // 4096 / 32
  });

  it("parses a GGUF v2 buffer", () => {
    const kv: KvEntry[] = [
      { key: "general.architecture", value: { type: "string", value: "qwen2" } },
      { key: "qwen2.context_length",   value: { type: "uint32", value: 32768 } },
      { key: "qwen2.block_count",      value: { type: "uint32", value: 28 } },
      { key: "qwen2.attention.head_count_kv", value: { type: "uint32", value: 4 } },
      { key: "qwen2.embedding_length", value: { type: "uint32", value: 1536 } },
      { key: "qwen2.attention.head_count",    value: { type: "uint32", value: 12 } },
    ];

    const result = parseBuffer(buildGgufBuffer(kv, 2));
    expect(result).not.toBeNull();
    expect(result!.contextLength).toBe(32768);
  });

  it("returns null for an invalid magic", () => {
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32LE(0xdeadbeef, 0); // wrong magic
    buf.writeUInt32LE(3, 4); // version
    const result = parseBuffer(buf);
    expect(result).toBeNull();
  });

  it("returns null for an unsupported version", () => {
    const kv: KvEntry[] = [
      { key: "general.architecture", value: { type: "string", value: "llama" } },
    ];
    const result = parseBuffer(buildGgufBuffer(kv, 99));
    expect(result).toBeNull();
  });

  it("returns null when required architecture keys are missing", () => {
    const kv: KvEntry[] = [
      { key: "general.architecture", value: { type: "string", value: "llama" } },
      // context_length missing
      { key: "llama.block_count",      value: { type: "uint32", value: 32 } },
      { key: "llama.attention.head_count_kv", value: { type: "uint32", value: 8 } },
      { key: "llama.embedding_length", value: { type: "uint32", value: 4096 } },
      { key: "llama.attention.head_count",    value: { type: "uint32", value: 32 } },
    ];

    const result = parseBuffer(buildGgufBuffer(kv));
    expect(result).toBeNull();
  });

  it("returns null for a completely empty file", () => {
    const buf = Buffer.alloc(0);
    const result = parseBuffer(buf);
    expect(result).toBeNull();
  });

  it("returns null for a non-existent file path", () => {
    const result = parseGgufMeta("/nonexistent/path/model.gguf");
    expect(result).toBeNull();
  });
});
