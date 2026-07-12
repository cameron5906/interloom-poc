import { z } from "zod";

/**
 * zod factory for the signed-envelope shape shared with `@interloom/keys`.
 * `sig` is the base64url signature over `canonicalJson(payload)`; `key` is the
 * base64url public key. Registry writes, heartbeats, vouchers, and webhook
 * payloads all cross the wire as signed envelopes.
 */
export function signedEnvelope<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    payload: inner,
    key: z.string(),
    sig: z.string(),
  });
}

export type SignedEnvelope<T> = {
  payload: T;
  key: string;
  sig: string;
};
