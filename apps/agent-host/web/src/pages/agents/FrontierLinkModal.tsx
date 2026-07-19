import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, Modal, Spinner } from "@interloom/ui";
import type { FrontierLinkPayload } from "@interloom/protocol";
import { agents as agentsApi } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";
import {
  FrontierLinkSession,
  decodeSecret,
  type LinkCandidate,
  type LinkStage,
} from "../../lib/frontierLink.js";
import { LinkStepper } from "./link/LinkStepper.js";
import { LinkCandidateCard } from "./link/LinkCandidateCard.js";
import "./link/frontierLink.css";

export interface FrontierLinkModalProps {
  open: boolean;
  onClose(): void;
  agentId: string;
}

const STAGE_LABEL: Record<LinkStage, string> = {
  connect: "Setting up a secure link…",
  waiting: "Waiting for your MCP server to connect…",
  review: "A device wants to link — review it below",
  "awaiting-confirm": "Waiting for it to confirm…",
  confirm: "Waiting for it to confirm…",
  transfer: "Sending your agent's credentials…",
  done: "Agent linked!",
  rejected: "Link declined",
  error: "Something went wrong",
};

const TRANSFER_MIN_VISIBLE_MS = 1400;

/** Per-CLI on-duty prompt (verbatim strings pinned in
 * .superpowers/sdd/pinned-interfaces.md §C/§D — `interloom_next_work` is the
 * long-polling MCP tool both loops resolve to). */
const ENGAGEMENT_SAMPLES = [
  {
    cli: "Claude Code",
    prompt: "Start working your Eris queue — keep looping until I say stop.",
  },
  {
    cli: "Codex",
    prompt: "Work your Eris queue with interloom_next_work and keep looping.",
  },
] as const;

/**
 * Issuer-side "Link a device" flow for a frontier agent (CONTRACTS §6/§14) —
 * mirrors `apps/network/web/src/components/account/DeviceLinkModal.tsx`'s QR +
 * candidate-approval UX, but issues its own link session against
 * `POST /api/agents/:id/frontier/link` and carries the daemon-minted
 * `issuerAuth` envelope on the WS join (no browser identity cookie here).
 * Reopenable per device — closing and reopening starts a brand new session,
 * so an operator can link several MCP processes one after another.
 */
export function FrontierLinkModal({ open, onClose, agentId }: FrontierLinkModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<LinkStage>("connect");
  const [visibleStage, setVisibleStage] = useState<LinkStage>("connect");
  const [candidates, setCandidates] = useState<LinkCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [copiedSample, setCopiedSample] = useState<string | null>(null);
  const sessionRef = useRef<FrontierLinkSession | null>(null);
  const transferStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      sessionRef.current?.stop();
      sessionRef.current = null;
      setQrDataUrl(null);
      setShareUrl(null);
      setStage("connect");
      setVisibleStage("connect");
      setCandidates([]);
      setError(null);
      setCopied(false);
      setSnippetCopied(false);
      setCopiedSample(null);
      transferStartRef.current = null;
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const linkSession = await agentsApi.frontierLink(agentId);
        if (cancelled) return;

        const payload: FrontierLinkPayload = {
          v: 1,
          kind: "frontier-agent",
          ...linkSession.payload,
        };
        const secret = decodeSecret(linkSession.secret);
        const dataUrl = await QRCode.toDataURL(linkSession.url, { margin: 1, width: 240 });
        if (cancelled) return;

        setShareUrl(linkSession.url);
        setQrDataUrl(dataUrl);

        const frontierSession = new FrontierLinkSession(
          {
            linkId: linkSession.linkId,
            secret,
            wsUrl: linkSession.wsUrl,
            payload,
            issuerAuth: linkSession.issuerAuth,
          },
          {
            onStage: (s) => !cancelled && setStage(s),
            onError: (message) => !cancelled && setError(message),
            onCandidates: (list) => !cancelled && setCandidates(list),
          },
        );
        sessionRef.current = frontierSession;
        frontierSession.start();
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not start a link session for this agent.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId]);

  // Gate the visible stage so a fast transfer still holds for at least
  // TRANSFER_MIN_VISIBLE_MS before flipping to "done".
  useEffect(() => {
    if (stage === "transfer") {
      transferStartRef.current = Date.now();
      setVisibleStage("transfer");
      return;
    }
    if (stage === "done") {
      const start = transferStartRef.current;
      const elapsed = start ? Date.now() - start : Number.POSITIVE_INFINITY;
      const remaining = Math.max(0, TRANSFER_MIN_VISIBLE_MS - elapsed);
      const timer = setTimeout(() => setVisibleStage("done"), remaining);
      return () => clearTimeout(timer);
    }
    setVisibleStage(stage);
  }, [stage]);

  async function copyUrl() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function copySnippet() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(`Link me to Eris: ${shareUrl}`);
    setSnippetCopied(true);
    setTimeout(() => setSnippetCopied(false), 2000);
  }

  async function copySample(cli: string, prompt: string) {
    await navigator.clipboard.writeText(prompt);
    setCopiedSample(cli);
    setTimeout(() => setCopiedSample((cur) => (cur === cli ? null : cur)), 2000);
  }

  function handleApprove(candidateId: string) {
    sessionRef.current?.approve(candidateId);
  }

  function handleReject(candidateId: string) {
    sessionRef.current?.reject(candidateId);
  }

  const showQrView = visibleStage === "connect" || visibleStage === "waiting";
  const showReview = visibleStage === "review" && candidates.length > 0;
  const showAwaitingConfirm = visibleStage === "awaiting-confirm";
  const showTransfer = visibleStage === "transfer";

  return (
    <Modal open={open} onClose={onClose} title="Link a device">
      {visibleStage === "done" ? (
        <div className="link-done">
          <div className="link-done__check">✓</div>
          <p>Your agent is linked and ready to work.</p>

          <div className="link-done__samples">
            {ENGAGEMENT_SAMPLES.map(({ cli, prompt }) => (
              <div className="link-done__sample" key={cli}>
                <span className="link-done__sample-label">{cli}</span>
                <div className="link-done__sample-snippet">
                  <code>{prompt}</code>
                  <Button variant="secondary" size="sm" onClick={() => void copySample(cli, prompt)}>
                    {copiedSample === cli ? "Copied!" : "Copy"}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : error ? (
        <div className="link-error">
          <p>{error}</p>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className={"link-issuer" + (showTransfer ? " link-issuer--transfer" : "")}>
          {showQrView && (
            <>
              {qrDataUrl ? (
                <img className="link-qr" src={qrDataUrl} alt="Scan this code from your MCP client, or paste the link" />
              ) : (
                <div className="link-qr link-qr--loading">
                  <Spinner size="lg" />
                </div>
              )}
            </>
          )}

          {showReview && (
            <div className="link-candidate-list">
              {candidates.map((candidate) => (
                <LinkCandidateCard
                  key={candidate.candidateId}
                  candidate={candidate}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))}
            </div>
          )}

          {showAwaitingConfirm && (
            <div className="link-awaiting-confirm">
              <Spinner size="lg" />
              <p>Waiting for it to confirm…</p>
            </div>
          )}

          <LinkStepper stage={visibleStage} label={STAGE_LABEL[visibleStage]} />

          {!showReview && !showAwaitingConfirm && (
            <p className="link-stage-label">{STAGE_LABEL[visibleStage]}</p>
          )}

          {showQrView && shareUrl && (
            <>
              <div className="link-share-row">
                <code className="link-share-url">{shareUrl}</code>
                <Button variant="secondary" size="sm" onClick={() => void copyUrl()}>
                  {copied ? "Copied!" : "Copy link"}
                </Button>
              </div>

              <div className="link-paste-snippet">
                <p className="link-paste-snippet__label">
                  Paste this into your Claude Code or Codex chat:
                </p>
                <div className="link-paste-snippet__row">
                  <code className="link-paste-snippet__code">Link me to Eris: {shareUrl}</code>
                  <Button variant="secondary" size="sm" onClick={() => void copySnippet()}>
                    {snippetCopied ? "Copied!" : "Copy"}
                  </Button>
                </div>
              </div>

              <p className="link-hint">
                Run your MCP server's link command with this URL, or paste it into your agent's chat.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
