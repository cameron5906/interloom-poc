import { useEffect, useRef, useState } from "react";
import { Button, Input, Spinner } from "@interloom/ui";
import { network as networkApi } from "../../api/endpoints.js";
import { ApiError } from "../../api/client.js";

type Phase = "email" | "sent" | "polling" | "done";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function StepNetwork({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the session while waiting for the magic-link click to complete.
  useEffect(() => {
    if (phase !== "polling") return;
    let active = true;
    const controller = new AbortController();

    const check = async () => {
      try {
        const session = await networkApi.session(controller.signal);
        if (active && session.signedIn) {
          setPhase("done");
        }
      } catch {
        /* keep polling; the daemon may be momentarily busy */
      }
    };

    check();
    pollRef.current = setInterval(check, 1500);
    return () => {
      active = false;
      controller.abort();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase]);

  const submit = async () => {
    if (!EMAIL_RE.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await networkApi.login(email.trim());
      setLoginUrl(result.loginUrl);
      setPhase("sent");
    } catch (err) {
      setError(
        err instanceof ApiError && err.isOffline
          ? "Can't reach the daemon to start sign-in."
          : "Sign-in request failed. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="il-onb__step-body">
      <h2 className="il-onb__title">Join the Interloom network</h2>
      <p className="il-onb__lede">
        Sign in with your email to publish agents and receive placement invites. This is a
        passwordless magic-link — we'll surface the link right here for the PoC.
      </p>

      {phase === "email" && (
        <div className="il-net-form">
          <label className="il-section-label" htmlFor="onb-email">
            Email address
          </label>
          <div className="il-net-form__row">
            <Input
              id="onb-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              invalid={!!error}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <Button variant="primary" onClick={submit} disabled={submitting}>
              {submitting ? "Sending…" : "Send link"}
            </Button>
          </div>
          {error ? <div className="il-net-form__error">{error}</div> : null}
        </div>
      )}

      {phase === "sent" && (
        <div className="il-net-sent">
          <p className="il-net-sent__lead">
            Magic link ready for <strong>{email}</strong>. Click below to complete sign-in — in
            production this arrives by email.
          </p>
          <a
            className="il-net-sent__link"
            href={loginUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => setPhase("polling")}
          >
            Complete sign-in ↗
          </a>
          <div className="il-meta il-net-sent__url">{loginUrl}</div>
          <button className="il-net-sent__waiting-link" onClick={() => setPhase("polling")}>
            I've clicked the link
          </button>
        </div>
      )}

      {phase === "polling" && (
        <div className="il-net-polling">
          <Spinner size="md" />
          <div>
            <div className="il-net-polling__title">Waiting for sign-in…</div>
            <div className="il-meta">
              Complete the link in the opened tab. This updates automatically.
            </div>
          </div>
          <a className="il-net-polling__reopen" href={loginUrl} target="_blank" rel="noreferrer">
            Reopen link
          </a>
        </div>
      )}

      {phase === "done" && (
        <div className="il-net-done">
          <div className="il-net-done__check" aria-hidden>
            ✓
          </div>
          <div className="il-net-done__title">You're signed in as {email}</div>
          <div className="il-meta">Your host is connected to the Interloom network.</div>
        </div>
      )}

      <div className="il-onb__actions">
        <Button variant="secondary" onClick={onBack} disabled={phase === "polling"}>
          Back
        </Button>
        {phase === "done" ? (
          <Button variant="primary" onClick={onDone}>
            Browse models →
          </Button>
        ) : (
          <button className="il-onb__later" onClick={onDone}>
            Set up later
          </button>
        )}
      </div>
    </div>
  );
}
