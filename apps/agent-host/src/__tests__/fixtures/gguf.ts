/**
 * Minimal GGUF v3 writer for tests — string/u32/u64 KVs only, no tensors.
 * Mirrors the reader in models/gguf.ts (magic, version, counts, KV section).
 */

type KvValue = { t: "u32"; v: number } | { t: "u64"; v: number } | { t: "str"; v: string };

function strBytes(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(8);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

export function buildGguf(kvs: Record<string, KvValue>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(24);
  head.writeUInt32LE(0x46554747, 0); // "GGUF"
  head.writeUInt32LE(3, 4); // version
  head.writeUInt32LE(0, 8); // tensor_count lo
  head.writeUInt32LE(0, 12); // tensor_count hi
  head.writeUInt32LE(Object.keys(kvs).length, 16); // kv_count lo
  head.writeUInt32LE(0, 20); // kv_count hi
  parts.push(head);

  for (const [key, val] of Object.entries(kvs)) {
    parts.push(strBytes(key));
    const type = Buffer.alloc(4);
    if (val.t === "u32") {
      type.writeUInt32LE(4, 0);
      const b = Buffer.alloc(4);
      b.writeUInt32LE(val.v, 0);
      parts.push(type, b);
    } else if (val.t === "u64") {
      type.writeUInt32LE(10, 0);
      const b = Buffer.alloc(8);
      b.writeUInt32LE(val.v, 0);
      b.writeUInt32LE(0, 4);
      parts.push(type, b);
    } else {
      type.writeUInt32LE(8, 0);
      parts.push(type, strBytes(val.v));
    }
  }
  return Buffer.concat(parts);
}

/** A parseable text-model header: arch qwen3 with everything gguf.ts requires. */
export function textModelKvs(chatTemplate?: string): Record<string, KvValue> {
  const kvs: Record<string, KvValue> = {
    "general.architecture": { t: "str", v: "qwen3" },
    "qwen3.context_length": { t: "u32", v: 32768 },
    "qwen3.block_count": { t: "u32", v: 36 },
    "qwen3.attention.head_count": { t: "u32", v: 32 },
    "qwen3.attention.head_count_kv": { t: "u32", v: 8 },
    "qwen3.embedding_length": { t: "u32", v: 4096 },
  };
  if (chatTemplate !== undefined) {
    kvs["tokenizer.chat_template"] = { t: "str", v: chatTemplate };
  }
  return kvs;
}
