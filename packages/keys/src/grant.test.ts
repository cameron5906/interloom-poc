import { describe, expect, it } from "vitest";
import { generateKeypair, signEnvelope } from "./index.js";
import { verifyGrant, type GrantPayload } from "./grant.js";

function makeGrant(overrides: Partial<GrantPayload> = {}): GrantPayload {
  return {
    v: 1,
    identityKey: "identity-pub",
    subjectKey: "subject-pub",
    scope: "workspace-device",
    audience: "https://instance.example",
    issuedAt: 1_000,
    epoch: 0,
    nonce: "n1",
    ...overrides,
  };
}

describe("verifyGrant", () => {
  it("accepts a valid grant matching subject, scope, and audience", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: payload.subjectKey,
        scope: payload.scope,
        audience: payload.audience,
      }),
    ).toBe(true);
  });

  it("rejects when the verifier's subjectKey does not match the grant", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: "someone-else",
        scope: payload.scope,
        audience: payload.audience,
      }),
    ).toBe(false);
  });

  it("rejects when the verifier's scope does not match the grant", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: payload.subjectKey,
        scope: "host-operator",
        audience: payload.audience,
      }),
    ).toBe(false);
  });

  it("rejects when the verifier's audience does not match the grant's audience", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: payload.subjectKey,
        scope: payload.scope,
        audience: "https://different-instance.example",
      }),
    ).toBe(false);
  });

  it("accepts when the grant has no audience regardless of the verifier's audience", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey, audience: undefined });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: payload.subjectKey,
        scope: payload.scope,
        audience: "https://anything.example",
      }),
    ).toBe(true);
  });

  it("verifies after a JSON wire round-trip when audience is signed as an explicit undefined", () => {
    const identity = generateKeypair();
    // AuthorizePage builds `audience: request.audience`, so an unset audience is
    // a key present with the value `undefined` — not an absent key. The grant
    // then crosses the wire as JSON (postMessage → fetch POST body), which drops
    // undefined-valued keys. Signing preimage and verifying preimage must agree
    // across that boundary, so canonicalJson must omit undefined keys too.
    const payload = makeGrant({ identityKey: identity.publicKey, audience: undefined });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    const overWire = JSON.parse(JSON.stringify(env));
    expect(
      verifyGrant(overWire, {
        subjectKey: payload.subjectKey,
        scope: payload.scope,
        audience: "https://anything.example",
      }),
    ).toBe(true);
  });

  it("rejects an expired grant", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey, expiresAt: 1_000 });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: payload.subjectKey,
        scope: payload.scope,
        audience: payload.audience,
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("accepts a grant whose expiresAt is still in the future", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey, expiresAt: 5_000 });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: payload.subjectKey,
        scope: payload.scope,
        audience: payload.audience,
        now: 2_000,
      }),
    ).toBe(true);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const identity = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey });
    const env = signEnvelope(payload, identity.privateKey, identity.publicKey);
    const tampered = { ...env, payload: { ...payload, subjectKey: "attacker-pub" } };
    expect(
      verifyGrant(tampered, {
        subjectKey: "attacker-pub",
        scope: payload.scope,
        audience: payload.audience,
      }),
    ).toBe(false);
  });

  it("rejects when the envelope was signed by a key other than the declared identityKey", () => {
    const identity = generateKeypair();
    const impostor = generateKeypair();
    const payload = makeGrant({ identityKey: identity.publicKey });
    // Signed (validly) by the impostor's key, not the grantor's — envelope.key
    // no longer matches payload.identityKey even though the signature verifies.
    const env = signEnvelope(payload, impostor.privateKey, impostor.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: payload.subjectKey,
        scope: payload.scope,
        audience: payload.audience,
      }),
    ).toBe(false);
  });

  it("rejects a malformed payload missing required grant fields", () => {
    const identity = generateKeypair();
    const env = signEnvelope({ hello: "world" }, identity.privateKey, identity.publicKey);
    expect(
      verifyGrant(env, {
        subjectKey: "subject-pub",
        scope: "workspace-device",
      }),
    ).toBe(false);
  });
});
