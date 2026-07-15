import { bytesToB64url, b64urlToBytes } from "@interloom/keys";
import type { CryptoLike } from "./adapters.js";

/**
 * Device-link E2E crypto (CONTRACTS §4 Device link) — pure WebCrypto helpers
 * over an injected `CryptoLike`, no ambient global/DOM dependency, so they're
 * unit-testable in isolation and usable from Node or the browser alike. The
 * relay (network server) never sees the fragment secret, the ECDH private
 * keys, or the plaintext payload.
 */
const LINK_INFO_V2 = "il-device-link-v2";
const SECRET_BYTES = 32;
const IV_BYTES = 12;
const ECDH_CURVE = "P-256";
const ECDH_SHARED_BITS = 256;

/** A fresh 32-byte link secret — lives ONLY in the URL fragment, never sent to the server. */
export function generateLinkSecret(crypto: CryptoLike): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

export function encodeSecret(secret: Uint8Array): string {
  return bytesToB64url(secret);
}

export function decodeSecret(encoded: string): Uint8Array {
  return b64urlToBytes(encoded);
}

/** Builds the QR / share URL: `${origin}/link/<linkId>#<secretB64>`. */
export function buildLinkUrl(origin: string, linkId: string, secret: Uint8Array): string {
  return `${origin.replace(/\/+$/, "")}/link/${linkId}#${encodeSecret(secret)}`;
}

/**
 * Parses the secret out of a `location.hash`-shaped fragment (with or
 * without the leading `#`). Returns null when there's nothing to parse —
 * callers should treat that as "no secret", never throw a user-facing error.
 */
export function parseLinkFragment(hash: string): Uint8Array | null {
  const clean = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!clean) return null;
  try {
    const bytes = decodeSecret(clean);
    return bytes.length === SECRET_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

export interface ParsedLinkUrl {
  linkId: string;
  secret: Uint8Array;
}

/**
 * Parses a scanner-supplied link code in either shape it may arrive in: a
 * full share URL (`<scheme>://<host>/link/<linkId>#<secretB64>`, any origin —
 * the caller decides whether the origin itself is trusted) or the raw
 * `<linkId>#<secretB64>` pasted directly (e.g. an MCP `interloom_link` call).
 * Returns null for anything that doesn't parse to a linkId plus a valid
 * 32-byte secret.
 */
export function parseLinkUrl(text: string): ParsedLinkUrl | null {
  const trimmed = text.trim();
  let pathAndHash = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      pathAndHash = `${url.pathname}${url.hash}`;
    } catch {
      return null;
    }
  }

  const hashIndex = pathAndHash.indexOf("#");
  if (hashIndex === -1) return null;
  const path = pathAndHash.slice(0, hashIndex);
  const hash = pathAndHash.slice(hashIndex);

  const match = /\/link\/([^/]+)$/.exec(path) ?? /^([^/]+)$/.exec(path);
  const linkId = match?.[1];
  if (!linkId) return null;

  const secret = parseLinkFragment(hash);
  if (!secret) return null;
  return { linkId, secret };
}

/** A fresh ephemeral ECDH P-256 keypair used for one device-link pairing session (CONTRACTS §4 key-derivation-v2). */
export async function generateEcdhKeyPair(
  crypto: CryptoLike,
): Promise<{ publicKeyB64: string; privateKey: unknown }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: ECDH_CURVE }, true, [
    "deriveBits",
  ]);
  const rawPublic = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    publicKeyB64: bytesToB64url(new Uint8Array(rawPublic)),
    privateKey: pair.privateKey,
  };
}

async function importPeerPublicKey(crypto: CryptoLike, peerPublicKeyB64: string): Promise<unknown> {
  const raw = b64urlToBytes(peerPublicKeyB64);
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: ECDH_CURVE }, false, []);
}

/**
 * Key derivation v2 (CONTRACTS §4 key-derivation-v2): binds the blob key to
 * the ECDH agreement between the two approved devices, not just the QR
 * secret, so a QR observer or queued rival candidate can't decrypt a blob
 * addressed to the approved candidate.
 *
 * `shared = ECDH-P256(ownEcdhPrivate, peerPublicKey)` — mirrored on both
 * sides (issuer: own priv + candidate's pub; scanner: own priv + issuer's
 * pub) so both derive the same AES key. `ikm = secret(32B) || shared(raw
 * bits)`, `key = HKDF-SHA256(ikm, salt=utf8(linkId), info=utf8(v2 info))`.
 */
export async function deriveLinkKeyV2(
  crypto: CryptoLike,
  secret: Uint8Array,
  ownEcdhPrivate: unknown,
  peerPublicKeyB64: string,
  linkId: string,
): Promise<unknown> {
  const peerPublicKey = await importPeerPublicKey(crypto, peerPublicKeyB64);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    ownEcdhPrivate,
    ECDH_SHARED_BITS,
  );
  const shared = new Uint8Array(sharedBits);
  const ikm = new Uint8Array(secret.length + shared.length);
  ikm.set(secret, 0);
  ikm.set(shared, secret.length);

  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(linkId),
      info: new TextEncoder().encode(LINK_INFO_V2),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface EncryptedBlob {
  ciphertextB64: string;
  ivB64: string;
}

/** Encrypts an arbitrary JSON-serializable payload under a key derived by `deriveLinkKeyV2`. */
export async function encryptLinkPayload(
  crypto: CryptoLike,
  key: unknown,
  payload: unknown,
): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertextB64: bytesToB64url(new Uint8Array(ciphertext)),
    ivB64: bytesToB64url(iv),
  };
}

/** Decrypts a blob produced by `encryptLinkPayload`. Throws on a forged/tampered blob or a mismatched key (AES-GCM auth failure). */
export async function decryptLinkPayload<T>(
  crypto: CryptoLike,
  key: unknown,
  blob: EncryptedBlob,
): Promise<T> {
  const iv = b64urlToBytes(blob.ivB64);
  const ciphertext = b64urlToBytes(blob.ciphertextB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
