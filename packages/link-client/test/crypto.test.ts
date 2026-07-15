import { webcrypto } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { CryptoLike } from "../src/adapters.js";
import {
  generateLinkSecret,
  encodeSecret,
  decodeSecret,
  buildLinkUrl,
  parseLinkFragment,
  parseLinkUrl,
  generateEcdhKeyPair,
  deriveLinkKeyV2,
  encryptLinkPayload,
  decryptLinkPayload,
} from "../src/crypto.js";

const crypto = webcrypto as unknown as CryptoLike;

describe("link secret encode/decode", () => {
  it("round-trips a generated secret through base64url", () => {
    const secret = generateLinkSecret(crypto);
    expect(secret.length).toBe(32);
    const encoded = encodeSecret(secret);
    const decoded = decodeSecret(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(secret));
  });
});

describe("buildLinkUrl / parseLinkFragment", () => {
  it("builds a URL whose fragment parses back to the same secret", () => {
    const secret = generateLinkSecret(crypto);
    const url = buildLinkUrl("https://net.example.com", "link-123", secret);
    expect(url).toBe(`https://net.example.com/link/link-123#${encodeSecret(secret)}`);

    const hash = "#" + url.split("#")[1];
    const parsed = parseLinkFragment(hash);
    expect(parsed).not.toBeNull();
    expect(Array.from(parsed!)).toEqual(Array.from(secret));
  });

  it("strips a trailing slash on the origin", () => {
    const secret = generateLinkSecret(crypto);
    const url = buildLinkUrl("https://net.example.com/", "abc", secret);
    expect(url.startsWith("https://net.example.com/link/abc#")).toBe(true);
  });

  it("parses a fragment with or without the leading #", () => {
    const secret = generateLinkSecret(crypto);
    const encoded = encodeSecret(secret);
    expect(parseLinkFragment(`#${encoded}`)).not.toBeNull();
    expect(parseLinkFragment(encoded)).not.toBeNull();
  });

  it("returns null for an empty or malformed fragment", () => {
    expect(parseLinkFragment("")).toBeNull();
    expect(parseLinkFragment("#")).toBeNull();
    expect(parseLinkFragment("#not-valid-base64url-secret!!!")).toBeNull();
  });
});

describe("parseLinkUrl", () => {
  it("parses a full share URL from any origin", () => {
    const secret = generateLinkSecret(crypto);
    const url = buildLinkUrl("https://net.example.com", "link-abc", secret);
    const parsed = parseLinkUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.linkId).toBe("link-abc");
    expect(Array.from(parsed!.secret)).toEqual(Array.from(secret));
  });

  it("parses the raw linkId#secret form pasted directly (MCP interloom_link)", () => {
    const secret = generateLinkSecret(crypto);
    const raw = `link-xyz#${encodeSecret(secret)}`;
    const parsed = parseLinkUrl(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.linkId).toBe("link-xyz");
    expect(Array.from(parsed!.secret)).toEqual(Array.from(secret));
  });

  it("trims surrounding whitespace from a pasted code", () => {
    const secret = generateLinkSecret(crypto);
    const raw = `  link-xyz#${encodeSecret(secret)}  `;
    const parsed = parseLinkUrl(raw);
    expect(parsed?.linkId).toBe("link-xyz");
  });

  it("returns null for text with no fragment, a malformed URL, or a bad secret", () => {
    expect(parseLinkUrl("not-a-link-code")).toBeNull();
    expect(parseLinkUrl("https://[::not-a-host/link/abc#xyz")).toBeNull();
    expect(parseLinkUrl("link-abc#not-valid-base64url-secret!!!")).toBeNull();
  });
});

describe("deriveLinkKeyV2", () => {
  it("derives the same AES key on both sides from mirrored ECDH inputs", async () => {
    const secret = generateLinkSecret(crypto);
    const linkId = "link-abc";
    const issuer = await generateEcdhKeyPair(crypto);
    const scanner = await generateEcdhKeyPair(crypto);

    // Issuer derives from its own priv + the candidate's (scanner's) pub.
    const issuerKey = await deriveLinkKeyV2(crypto, secret, issuer.privateKey, scanner.publicKeyB64, linkId);
    // Scanner derives from its own priv + the issuer's ephemeral pub.
    const scannerKey = await deriveLinkKeyV2(crypto, secret, scanner.privateKey, issuer.publicKeyB64, linkId);

    const payload = { hello: "world" };
    const blob = await encryptLinkPayload(crypto, issuerKey, payload);
    const decrypted = await decryptLinkPayload<typeof payload>(crypto, scannerKey, blob);
    expect(decrypted).toEqual(payload);
  });

  it("derives a different key under a different linkId (HKDF salt binds to linkId)", async () => {
    const secret = generateLinkSecret(crypto);
    const issuer = await generateEcdhKeyPair(crypto);
    const scanner = await generateEcdhKeyPair(crypto);

    const keyA = await deriveLinkKeyV2(crypto, secret, issuer.privateKey, scanner.publicKeyB64, "link-a");
    const blob = await encryptLinkPayload(crypto, keyA, { hello: "world" });

    const keyAOnOtherLink = await deriveLinkKeyV2(crypto, secret, scanner.privateKey, issuer.publicKeyB64, "link-b");
    await expect(decryptLinkPayload(crypto, keyAOnOtherLink, blob)).rejects.toThrow();
  });

  it("fails to decrypt with a third party's ECDH key, even holding the same secret and linkId", async () => {
    const secret = generateLinkSecret(crypto);
    const linkId = "link-abc";
    const issuer = await generateEcdhKeyPair(crypto);
    const scanner = await generateEcdhKeyPair(crypto);
    const attacker = await generateEcdhKeyPair(crypto);

    const issuerKey = await deriveLinkKeyV2(crypto, secret, issuer.privateKey, scanner.publicKeyB64, linkId);
    const blob = await encryptLinkPayload(crypto, issuerKey, { hello: "world" });

    // The attacker knows the QR secret and the linkId (e.g. photographed the QR
    // and observed the relay) but was never the approved candidate, so its
    // ECDH agreement with the issuer's pubkey yields a different shared secret.
    const attackerKey = await deriveLinkKeyV2(crypto, secret, attacker.privateKey, issuer.publicKeyB64, linkId);
    await expect(decryptLinkPayload(crypto, attackerKey, blob)).rejects.toThrow();
  });
});

describe("encryptLinkPayload / decryptLinkPayload", () => {
  it("round-trips a JSON payload under a v2-derived key", async () => {
    const secret = generateLinkSecret(crypto);
    const linkId = "link-abc";
    const a = await generateEcdhKeyPair(crypto);
    const b = await generateEcdhKeyPair(crypto);
    const key = await deriveLinkKeyV2(crypto, secret, a.privateKey, b.publicKeyB64, linkId);

    const payload = { v: 1, privKey: "priv", pubKey: "pub", displayName: "Ava" };
    const blob = await encryptLinkPayload(crypto, key, payload);
    expect(typeof blob.ciphertextB64).toBe("string");
    expect(typeof blob.ivB64).toBe("string");

    const decrypted = await decryptLinkPayload<typeof payload>(crypto, key, blob);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt a tampered ciphertext (AES-GCM auth failure)", async () => {
    const secret = generateLinkSecret(crypto);
    const linkId = "link-abc";
    const a = await generateEcdhKeyPair(crypto);
    const b = await generateEcdhKeyPair(crypto);
    const key = await deriveLinkKeyV2(crypto, secret, a.privateKey, b.publicKeyB64, linkId);

    const blob = await encryptLinkPayload(crypto, key, { hello: "world" });
    const tampered = { ...blob, ciphertextB64: blob.ciphertextB64.slice(0, -2) + "aa" };
    await expect(decryptLinkPayload(crypto, key, tampered)).rejects.toThrow();
  });
});
