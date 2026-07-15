import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssuer, createScanner, type LinkStage } from "../src/session.js";
import type { FakeSocket } from "./fakes.js";
import { FakeRelay, fakeRtcAdapter, nodeCrypto, waitFor, wsCtorFor } from "./fakes.js";

interface TestPayload {
  v: 1;
  secret: string;
}

function stageRecorder() {
  const stages: LinkStage[] = [];
  return { stages, onStage: (s: LinkStage) => stages.push(s) };
}

describe("LinkSession FSM — rtc: null (Node scanner path)", () => {
  it("runs approve -> confirm -> blob -> done end to end with no WebRTC involved", async () => {
    const relay = new FakeRelay();
    const linkId = "link-1";
    const secret = nodeCrypto.getRandomValues(new Uint8Array(32));
    const payload: TestPayload = { v: 1, secret: "top-secret" };

    const issuerRecorder = stageRecorder();
    let candidateIds: string[] = [];
    const issuer = createIssuer<TestPayload>(
      {
        linkId,
        secret,
        wsUrl: "ws://fake/issuer",
        ws: wsCtorFor(relay, "issuer"),
        crypto: nodeCrypto,
        rtc: null,
        payload,
      },
      {
        onStage: issuerRecorder.onStage,
        onCandidates: (list) => {
          candidateIds = list.map((c) => c.candidateId);
        },
      },
    );

    const scannerRecorder = stageRecorder();
    let receivedPayload: TestPayload | null = null;
    let approvedName: string | undefined;
    const scanner = createScanner<TestPayload>(
      {
        linkId,
        secret,
        wsUrl: "ws://fake/scanner",
        ws: wsCtorFor(relay, "scanner"),
        crypto: nodeCrypto,
        rtc: null,
      },
      {
        onStage: scannerRecorder.onStage,
        onPayload: (p) => {
          receivedPayload = p;
        },
        onApproved: (name) => {
          approvedName = name;
        },
      },
    );

    issuer.start();
    scanner.start();

    await waitFor(() => candidateIds.length > 0);
    expect(issuerRecorder.stages).toContain("review");

    issuer.approve(candidateIds[0]!);
    await waitFor(() => scannerRecorder.stages.includes("confirm"));
    expect(issuerRecorder.stages).toContain("awaiting-confirm");

    scanner.confirmLink();
    await waitFor(() => scannerRecorder.stages.includes("done"));

    expect(receivedPayload).toEqual(payload);
    expect(issuerRecorder.stages).toContain("transfer");
    expect(scannerRecorder.stages).toContain("transfer");
    expect(issuerRecorder.stages.at(-1)).not.toBe("error");
    // approved fires before confirm, name is undefined here (no display name plumbed in the fake relay)
    expect(approvedName).toBeUndefined();

    issuer.stop();
    scanner.stop();
  });

  it("rejects a candidate before approval and drives the scanner to the rejected stage", async () => {
    const relay = new FakeRelay();
    const linkId = "link-2";
    const secret = nodeCrypto.getRandomValues(new Uint8Array(32));

    let candidateIds: string[] = [];
    const issuer = createIssuer<TestPayload>(
      {
        linkId,
        secret,
        wsUrl: "ws://fake/issuer",
        ws: wsCtorFor(relay, "issuer"),
        crypto: nodeCrypto,
        rtc: null,
        payload: { v: 1, secret: "unused" },
      },
      {
        onStage: () => {},
        onCandidates: (list) => {
          candidateIds = list.map((c) => c.candidateId);
        },
      },
    );

    const scannerRecorder = stageRecorder();
    const scanner = createScanner<TestPayload>(
      {
        linkId,
        secret,
        wsUrl: "ws://fake/scanner",
        ws: wsCtorFor(relay, "scanner"),
        crypto: nodeCrypto,
        rtc: null,
      },
      { onStage: scannerRecorder.onStage },
    );

    issuer.start();
    scanner.start();

    await waitFor(() => candidateIds.length > 0);
    issuer.reject(candidateIds[0]!);

    await waitFor(() => scannerRecorder.stages.includes("rejected"));
    expect(scannerRecorder.stages.at(-1)).toBe("rejected");

    issuer.stop();
    scanner.stop();
  });

  it("surfaces a relay-driven TTL/expiry error as stage=error with the code", async () => {
    const relay = new FakeRelay();
    const errors: string[] = [];
    const recorder = stageRecorder();
    let socket: FakeSocket | null = null;
    const issuer = createIssuer<TestPayload>(
      {
        linkId: "link-3",
        secret: nodeCrypto.getRandomValues(new Uint8Array(32)),
        wsUrl: "ws://fake/issuer",
        ws: wsCtorFor(relay, "issuer", (s) => (socket = s)),
        crypto: nodeCrypto,
        rtc: null,
        payload: { v: 1, secret: "unused" },
      },
      { onStage: recorder.onStage, onError: (m) => errors.push(m) },
    );

    issuer.start();
    await waitFor(() => socket !== null);
    relay.deliverRaw(socket!, { t: "error", code: "E_LINK_EXPIRED" });

    await waitFor(() => recorder.stages.includes("error"));
    expect(errors).toContain("E_LINK_EXPIRED");
  });

  it("surfaces E_LINK_CONSUMED (single-use link already claimed) the same way", async () => {
    const relay = new FakeRelay();
    const errors: string[] = [];
    const recorder = stageRecorder();
    let socket: FakeSocket | null = null;
    const scanner = createScanner<TestPayload>(
      {
        linkId: "link-4",
        secret: nodeCrypto.getRandomValues(new Uint8Array(32)),
        wsUrl: "ws://fake/scanner",
        ws: wsCtorFor(relay, "scanner", (s) => (socket = s)),
        crypto: nodeCrypto,
        rtc: null,
      },
      { onStage: recorder.onStage, onError: (m) => errors.push(m) },
    );

    scanner.start();
    await waitFor(() => socket !== null);
    relay.deliverRaw(socket!, { t: "error", code: "E_LINK_CONSUMED" });

    await waitFor(() => recorder.stages.includes("error"));
    expect(errors).toContain("E_LINK_CONSUMED");
  });

  it("treats E_LINK_REJECTED as the rejected stage for a scanner and stops the session", async () => {
    const relay = new FakeRelay();
    const recorder = stageRecorder();
    let socket: FakeSocket | null = null;
    const scanner = createScanner<TestPayload>(
      {
        linkId: "link-5",
        secret: nodeCrypto.getRandomValues(new Uint8Array(32)),
        wsUrl: "ws://fake/scanner",
        ws: wsCtorFor(relay, "scanner", (s) => (socket = s)),
        crypto: nodeCrypto,
        rtc: null,
      },
      { onStage: recorder.onStage },
    );

    scanner.start();
    await waitFor(() => socket !== null);
    relay.deliverRaw(socket!, { t: "error", code: "E_LINK_REJECTED" });

    await waitFor(() => recorder.stages.includes("rejected"));
    await waitFor(() => socket!.readyState === 3);
  });
});

describe("LinkSession FSM — rtc adapter present (browser-shaped path)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the 8s WebRTC->WS-relay fallback timing when the datachannel never opens", async () => {
    const relay = new FakeRelay();
    const linkId = "link-6";
    const secret = nodeCrypto.getRandomValues(new Uint8Array(32));
    const payload: TestPayload = { v: 1, secret: "rtc-fallback" };

    let candidateIds: string[] = [];
    const issuerRtc = fakeRtcAdapter();
    const issuer = createIssuer<TestPayload>(
      {
        linkId,
        secret,
        wsUrl: "ws://fake/issuer",
        ws: wsCtorFor(relay, "issuer"),
        crypto: nodeCrypto,
        rtc: issuerRtc,
        payload,
      },
      { onStage: () => {}, onCandidates: (list) => (candidateIds = list.map((c) => c.candidateId)) },
    );

    const scannerRecorder = stageRecorder();
    let receivedPayload: TestPayload | null = null;
    const scanner = createScanner<TestPayload>(
      {
        linkId,
        secret,
        wsUrl: "ws://fake/scanner",
        ws: wsCtorFor(relay, "scanner"),
        crypto: nodeCrypto,
        rtc: fakeRtcAdapter(),
      },
      { onStage: scannerRecorder.onStage, onPayload: (p) => (receivedPayload = p) },
    );

    issuer.start();
    scanner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => expect(candidateIds.length).toBeGreaterThan(0), { timeout: 2000, interval: 5 });
    issuer.approve(candidateIds[0]!);
    await vi.waitFor(() => expect(scannerRecorder.stages).toContain("confirm"), { timeout: 2000, interval: 5 });

    scanner.confirmLink();
    // The datachannel/offer dance runs (fake PC resolves immediately) but the
    // channel never fires "open" — nothing should have transferred yet.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(7999);
    expect(receivedPayload).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(receivedPayload).toEqual(payload), { timeout: 2000, interval: 5 });
    expect(issuerRtc.peerConnections.length).toBeGreaterThan(0);

    issuer.stop();
    scanner.stop();
  });
});
