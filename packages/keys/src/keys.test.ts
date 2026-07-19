import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  generateKeypair,
  publicKeyFromPrivate,
  sign,
  signEnvelope,
  verify,
  verifyEnvelope,
} from "./index.js";

describe("generateKeypair", () => {
  it("produces distinct base64url keys of the expected byte length", () => {
    const { publicKey, privateKey } = generateKeypair();
    expect(publicKey).not.toBe(privateKey);
    // 32 bytes base64url without padding => 43 chars.
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("derives a public key from the private key that matches generation", () => {
    const { publicKey, privateKey } = generateKeypair();
    expect(publicKeyFromPrivate(privateKey)).toBe(publicKey);
  });
});

describe("sign/verify round-trip", () => {
  it("verifies a signature over the same message", () => {
    const { publicKey, privateKey } = generateKeypair();
    const message = "the quick brown fox";
    const sig = sign(message, privateKey);
    expect(verify(message, sig, publicKey)).toBe(true);
  });

  it("rejects a signature over a different message", () => {
    const { publicKey, privateKey } = generateKeypair();
    const sig = sign("original message", privateKey);
    expect(verify("tampered message", sig, publicKey)).toBe(false);
  });

  it("rejects a signature under a different public key", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const sig = sign("hello", a.privateKey);
    expect(verify("hello", sig, b.publicKey)).toBe(false);
  });

  it("returns false rather than throwing on malformed input", () => {
    const { publicKey } = generateKeypair();
    expect(verify("hello", "not-a-signature", publicKey)).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("is invariant to object key ordering", () => {
    const a = { a: 1, b: { d: 2, c: 3 } };
    const b = { b: { c: 3, d: 2 }, a: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("produces the expected canonical form", () => {
    const value = { a: 1, b: { d: 2, c: 3 } };
    expect(canonicalJson(value)).toBe('{"a":1,"b":{"c":3,"d":2}}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ z: [{ b: 2, a: 1 }] })).toBe('{"z":[{"a":1,"b":2}]}');
  });

  it("handles primitives and null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("s")).toBe('"s"');
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("signed envelopes", () => {
  it("round-trips signEnvelope/verifyEnvelope", () => {
    const { publicKey, privateKey } = generateKeypair();
    const env = signEnvelope({ hello: "world", n: 7 }, privateKey, publicKey);
    expect(env.key).toBe(publicKey);
    expect(verifyEnvelope(env)).toBe(true);
  });

  it("derives the embedded key when publicKey is omitted", () => {
    const { publicKey, privateKey } = generateKeypair();
    const env = signEnvelope({ a: 1 }, privateKey);
    expect(env.key).toBe(publicKey);
    expect(verifyEnvelope(env)).toBe(true);
  });

  it("is invariant to payload key ordering (canonical signing)", () => {
    const { privateKey } = generateKeypair();
    const env = signEnvelope({ a: 1, b: { d: 2, c: 3 } }, privateKey);
    // Re-order the payload keys post-signing; verification must still pass.
    const reordered = { payload: { b: { c: 3, d: 2 }, a: 1 }, key: env.key, sig: env.sig };
    expect(verifyEnvelope(reordered)).toBe(true);
  });

  it("fails verification when the payload is tampered with", () => {
    const { privateKey } = generateKeypair();
    const env = signEnvelope({ amount: 100 }, privateKey);
    const tampered = { ...env, payload: { amount: 999 } };
    expect(verifyEnvelope(tampered)).toBe(false);
  });

  it("fails verification when the signature is tampered with", () => {
    const { privateKey } = generateKeypair();
    const env = signEnvelope({ x: 1 }, privateKey);
    const tampered = {
      ...env,
      sig: `${env.sig[0] === "A" ? "B" : "A"}${env.sig.slice(1)}`,
    };
    expect(verifyEnvelope(tampered)).toBe(false);
  });
});
