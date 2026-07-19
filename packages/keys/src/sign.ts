import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { b64urlToBytes, bytesToB64url, utf8ToBytes } from "./base64url.js";

// @noble/ed25519 v2 ships async-only by default. Wiring sha512Sync enables the
// synchronous sign/verify/getPublicKey paths we use throughout Eris.
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
  sha512(ed.etc.concatBytes(...messages));

export interface Keypair {
  publicKey: string;
  privateKey: string;
}

/** Generate a fresh Ed25519 keypair. Keys are base64url, 32 bytes each. */
export function generateKeypair(): Keypair {
  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = ed.getPublicKey(privateKeyBytes);
  return {
    publicKey: bytesToB64url(publicKeyBytes),
    privateKey: bytesToB64url(privateKeyBytes),
  };
}

/** Derive the base64url public key from a base64url private-key seed. */
export function publicKeyFromPrivate(privateKey: string): string {
  return bytesToB64url(ed.getPublicKey(b64urlToBytes(privateKey)));
}

/** Sign a UTF-8 message; returns a base64url signature. */
export function sign(messageUtf8: string, privateKey: string): string {
  const sig = ed.sign(utf8ToBytes(messageUtf8), b64urlToBytes(privateKey));
  return bytesToB64url(sig);
}

/** Verify a base64url signature over a UTF-8 message against a base64url public key. */
export function verify(messageUtf8: string, sig: string, publicKey: string): boolean {
  try {
    return ed.verify(b64urlToBytes(sig), utf8ToBytes(messageUtf8), b64urlToBytes(publicKey));
  } catch {
    return false;
  }
}
