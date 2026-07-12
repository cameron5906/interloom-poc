import { canonicalJson } from "./canonicalJson.js";
import { publicKeyFromPrivate, sign, verify } from "./sign.js";

/**
 * A payload signed under a single Ed25519 key.
 * `sig` is the base64url signature over `canonicalJson(payload)`.
 * `key` is the base64url public key that produced the signature.
 */
export interface SignedEnvelope<T> {
  payload: T;
  key: string;
  sig: string;
}

/**
 * Wrap a payload in a signed envelope. The signature is over the canonical JSON
 * of the payload. `publicKey` is optional; when omitted it is derived from the
 * private key so the embedded `key` always matches the signer.
 */
export function signEnvelope<T>(
  payload: T,
  privateKey: string,
  publicKey?: string,
): SignedEnvelope<T> {
  const key = publicKey ?? publicKeyFromPrivate(privateKey);
  const sig = sign(canonicalJson(payload), privateKey);
  return { payload, key, sig };
}

/** Verify that the envelope's signature is valid for its payload under its embedded key. */
export function verifyEnvelope<T>(env: SignedEnvelope<T>): boolean {
  return verify(canonicalJson(env.payload), env.sig, env.key);
}
