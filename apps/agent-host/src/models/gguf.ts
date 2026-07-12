/**
 * GGUF header metadata reader (CONTRACTS §6 context sizing).
 *
 * Parses the first few MB of a .gguf file (streamed, never fully loaded) to
 * extract architecture metadata needed for KV-cache sizing. Returns null on
 * any parse failure — never throws to callers.
 *
 * Supported: GGUF magic, versions 2 and 3, metadata KV section with all value
 * types (incl. arrays skipped, strings via u64 length prefix).
 */

import fs from "fs";

export interface GgufMeta {
  architecture: string;
  contextLength: number;
  blockCount: number;
  kvHeads: number;
  headDim: number;
}

// GGUF magic bytes: "GGUF" in little-endian u32 = 0x46554747
const GGUF_MAGIC = 0x46554747;

// GGUF metadata value types
const GgufValueType = {
  UINT8:   0,
  INT8:    1,
  UINT16:  2,
  INT16:   3,
  UINT32:  4,
  INT32:   5,
  FLOAT32: 6,
  BOOL:    7,
  STRING:  8,
  ARRAY:   9,
  UINT64:  10,
  INT64:   11,
  FLOAT64: 12,
} as const;

const READ_LIMIT_BYTES = 8 * 1024 * 1024; // 8 MB max

/**
 * Buffered sequential reader over a file chunk. Supports reading fixed-width
 * integers (LE) and strings. Throws `RangeError` when attempting to read
 * beyond the buffer.
 */
class BufReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  get offset(): number {
    return this.pos;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    if (this.pos + 1 > this.buf.length) throw new RangeError("buffer underflow");
    return this.buf.readUInt8(this.pos++);
  }

  u16(): number {
    if (this.pos + 2 > this.buf.length) throw new RangeError("buffer underflow");
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    if (this.pos + 2 > this.buf.length) throw new RangeError("buffer underflow");
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError("buffer underflow");
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError("buffer underflow");
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  f32(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError("buffer underflow");
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    if (this.pos + 8 > this.buf.length) throw new RangeError("buffer underflow");
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  /** Read a u64 as a JS number. Values > 2^53 lose precision but are fine for counts. */
  u64(): number {
    if (this.pos + 8 > this.buf.length) throw new RangeError("buffer underflow");
    const lo = this.buf.readUInt32LE(this.pos);
    const hi = this.buf.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return hi * 0x100000000 + lo;
  }

  i64(): number {
    // Treat as u64 for our purposes (all counts are positive)
    return this.u64();
  }

  /** Read a GGUF string: u64 length + UTF-8 bytes (no NUL terminator). */
  string(): string {
    const len = this.u64();
    if (len > this.remaining()) throw new RangeError("string length exceeds buffer");
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  skip(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError("skip beyond buffer");
    this.pos += n;
  }
}

/**
 * Skip a single GGUF metadata value of the given type.
 * For arrays, recursively skips all elements.
 */
function skipValue(r: BufReader, type: number): void {
  switch (type) {
    case GgufValueType.UINT8:
    case GgufValueType.INT8:
    case GgufValueType.BOOL:
      r.u8(); break;
    case GgufValueType.UINT16:
    case GgufValueType.INT16:
      r.u16(); break;
    case GgufValueType.UINT32:
    case GgufValueType.INT32:
    case GgufValueType.FLOAT32:
      r.u32(); break;
    case GgufValueType.UINT64:
    case GgufValueType.INT64:
    case GgufValueType.FLOAT64:
      r.u64(); break;
    case GgufValueType.STRING:
      r.string(); break;
    case GgufValueType.ARRAY: {
      const elemType = r.u32();
      const count = r.u64();
      for (let i = 0; i < count; i++) {
        skipValue(r, elemType);
      }
      break;
    }
    default:
      throw new Error(`unknown GGUF value type: ${type}`);
  }
}

/**
 * Read the scalar value of a GGUF metadata entry.
 * Returns undefined for array types (we don't need them).
 */
function readScalarValue(r: BufReader, type: number): string | number | boolean | undefined {
  switch (type) {
    case GgufValueType.UINT8:
    case GgufValueType.INT8:
    case GgufValueType.BOOL:
      return r.u8();
    case GgufValueType.UINT16:
    case GgufValueType.INT16:
      return r.u16();
    case GgufValueType.UINT32:
    case GgufValueType.INT32:
    case GgufValueType.FLOAT32:
      return r.u32();
    case GgufValueType.UINT64:
    case GgufValueType.INT64:
    case GgufValueType.FLOAT64:
      return r.u64();
    case GgufValueType.STRING:
      return r.string();
    case GgufValueType.ARRAY: {
      // Skip array elements — we don't extract array metadata
      const elemType = r.u32();
      const count = r.u64();
      for (let i = 0; i < count; i++) {
        skipValue(r, elemType);
      }
      return undefined;
    }
    default:
      throw new Error(`unknown GGUF value type: ${type}`);
  }
}

/**
 * Parse the GGUF header from a local file path and extract the architecture
 * metadata required for KV-cache sizing. Returns null on any parse error.
 */
export function parseGgufMeta(filePath: string): GgufMeta | null {
  try {
    return parseGgufMetaUnsafe(filePath);
  } catch {
    return null;
  }
}

function parseGgufMetaUnsafe(filePath: string): GgufMeta | null {
  const stat = fs.statSync(filePath);
  const readBytes = Math.min(stat.size, READ_LIMIT_BYTES);

  const fd = fs.openSync(filePath, "r");
  let buf: Buffer;
  try {
    buf = Buffer.allocUnsafe(readBytes);
    const bytesRead = fs.readSync(fd, buf, 0, readBytes, 0);
    if (bytesRead < readBytes) {
      buf = buf.subarray(0, bytesRead);
    }
  } finally {
    fs.closeSync(fd);
  }

  const r = new BufReader(buf);

  // Magic
  const magic = r.u32();
  if (magic !== GGUF_MAGIC) return null;

  // Version (2 or 3)
  const version = r.u32();
  if (version !== 2 && version !== 3) return null;

  // tensor_count (u64), kv_count (u64)
  r.u64(); // tensor_count — not needed
  const kvCount = r.u64();

  // Parse metadata KV pairs
  const kv = new Map<string, string | number | boolean>();

  for (let i = 0; i < kvCount; i++) {
    const key = r.string();
    const valueType = r.u32();
    const value = readScalarValue(r, valueType);
    if (value !== undefined) {
      kv.set(key, value);
    }
  }

  // Extract architecture
  const architecture = kv.get("general.architecture");
  if (typeof architecture !== "string" || !architecture) return null;

  const arch = architecture;

  // Context length
  const contextLength = kv.get(`${arch}.context_length`);
  if (typeof contextLength !== "number") return null;

  // Block count (= transformer layers)
  const blockCount = kv.get(`${arch}.block_count`);
  if (typeof blockCount !== "number") return null;

  // KV heads: prefer head_count_kv, fall back to head_count
  const kvHeadsRaw = kv.get(`${arch}.attention.head_count_kv`) ?? kv.get(`${arch}.attention.head_count`);
  if (typeof kvHeadsRaw !== "number") return null;
  const kvHeads = kvHeadsRaw;

  // Head dim: prefer attention.key_length; otherwise embedding_length / head_count
  let headDim: number;
  const keyLength = kv.get(`${arch}.attention.key_length`);
  if (typeof keyLength === "number" && keyLength > 0) {
    headDim = keyLength;
  } else {
    const embeddingLength = kv.get(`${arch}.embedding_length`);
    const headCount = kv.get(`${arch}.attention.head_count`);
    if (typeof embeddingLength !== "number" || typeof headCount !== "number" || headCount === 0) {
      return null;
    }
    headDim = Math.floor(embeddingLength / headCount);
  }

  if (headDim <= 0) return null;

  return {
    architecture: arch,
    contextLength: Math.floor(contextLength),
    blockCount: Math.floor(blockCount),
    kvHeads: Math.floor(kvHeads),
    headDim: Math.floor(headDim),
  };
}
