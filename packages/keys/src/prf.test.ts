import { describe, expect, it } from "vitest";
import { generateKeypair } from "./sign.js";
import { bytesToB64url } from "./base64url.js";
import { derivePrfWrapKeyBytes, unwrapPrivateKey, wrapPrivateKey } from "./prf.js";

function randomPrf(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe("PRF wrap/unwrap round-trip", () => {
  it("round-trips many random keys/PRF outputs byte-exactly", async () => {
    for (let i = 0; i < 25; i++) {
      const { publicKey, privateKey } = generateKeypair();
      const prfOutput = randomPrf();
      const wrapped = await wrapPrivateKey(privateKey, prfOutput, publicKey);
      const unwrapped = await unwrapPrivateKey(wrapped, prfOutput, publicKey);
      expect(unwrapped).toBe(privateKey);
    }
  });
});

describe("IV freshness", () => {
  it("produces a different IV and ciphertext each wrap, but both unwrap to the same key", async () => {
    const { publicKey, privateKey } = generateKeypair();
    const prfOutput = randomPrf();

    const first = await wrapPrivateKey(privateKey, prfOutput, publicKey);
    const second = await wrapPrivateKey(privateKey, prfOutput, publicKey);

    expect(first.ivB64).not.toBe(second.ivB64);
    expect(first.ciphertextB64).not.toBe(second.ciphertextB64);

    await expect(unwrapPrivateKey(first, prfOutput, publicKey)).resolves.toBe(privateKey);
    await expect(unwrapPrivateKey(second, prfOutput, publicKey)).resolves.toBe(privateKey);
  });
});

describe("authentication failures reject rather than return garbage", () => {
  it("rejects when the PRF output doesn't match", async () => {
    const { publicKey, privateKey } = generateKeypair();
    const prfOutput = randomPrf();
    const wrongPrf = randomPrf();
    const wrapped = await wrapPrivateKey(privateKey, prfOutput, publicKey);
    await expect(unwrapPrivateKey(wrapped, wrongPrf, publicKey)).rejects.toThrow();
  });

  it("rejects when the pubKey (salt) doesn't match", async () => {
    const { publicKey, privateKey } = generateKeypair();
    const other = generateKeypair();
    const prfOutput = randomPrf();
    const wrapped = await wrapPrivateKey(privateKey, prfOutput, publicKey);
    await expect(unwrapPrivateKey(wrapped, prfOutput, other.publicKey)).rejects.toThrow();
  });

  it("rejects when the ciphertext has been tampered with", async () => {
    const { publicKey, privateKey } = generateKeypair();
    const prfOutput = randomPrf();
    const wrapped = await wrapPrivateKey(privateKey, prfOutput, publicKey);

    const ciphertextBytes = Buffer.from(
      wrapped.ciphertextB64.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    ciphertextBytes[0] ^= 0xff;
    const tampered = { ...wrapped, ciphertextB64: bytesToB64url(new Uint8Array(ciphertextBytes)) };

    await expect(unwrapPrivateKey(tampered, prfOutput, publicKey)).rejects.toThrow();
  });

  it("rejects when the IV has been tampered with", async () => {
    const { publicKey, privateKey } = generateKeypair();
    const prfOutput = randomPrf();
    const wrapped = await wrapPrivateKey(privateKey, prfOutput, publicKey);

    const ivBytes = Buffer.from(wrapped.ivB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    ivBytes[0] ^= 0xff;
    const tampered = { ...wrapped, ivB64: bytesToB64url(new Uint8Array(ivBytes)) };

    await expect(unwrapPrivateKey(tampered, prfOutput, publicKey)).rejects.toThrow();
  });
});

// Known-answer vector: fixed prfOutput, fixed pubKey (used only as the raw
// 32-byte HKDF salt here — decoded from base64url, not a "real" derived Ed25519
// public key), fixed info string. The expected derived AES key bytes below
// were computed independently via Node's native `crypto.hkdfSync("sha256", ...)`
// (NOT via this package's own code), so a match here proves this package's
// WebCrypto HKDF path is byte-compatible with a from-scratch reimplementation
// (e.g. a Rust or mobile client using a standard HKDF-SHA256 library).
//
// Recompute with:
//   node -e '
//     const crypto = require("crypto");
//     const prfOutput = Uint8Array.from({length:32}, (_,i) => i);
//     const pubKeyBytes = Uint8Array.from({length:32}, (_,i) => i + 32);
//     const info = Buffer.from("il-passkey-wrap-v1", "utf8");
//     const derived = crypto.hkdfSync("sha256", Buffer.from(prfOutput), Buffer.from(pubKeyBytes), info, 32);
//     console.log(Buffer.from(derived).toString("hex"));
//   '
describe("known-answer vector (cross-implementation compatibility)", () => {
  it("derives the exact HKDF-SHA256 wrap key bytes for a fixed input set", async () => {
    const prfOutput = Uint8Array.from({ length: 32 }, (_, i) => i);
    const pubKeyBytes = Uint8Array.from({ length: 32 }, (_, i) => i + 32);
    const pubKey = bytesToB64url(pubKeyBytes);
    expect(pubKey).toBe("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8");

    const derived = await derivePrfWrapKeyBytes(prfOutput, pubKey);
    const derivedHex = Buffer.from(derived).toString("hex");

    expect(derivedHex).toBe("d7e9a7a2e63eaa27eb0cfc21f0ec59b4275b88e97e33d0813f6ff2e4d28a463e");
    expect(derived.length).toBe(32);
  });
});
