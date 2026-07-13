import { useState } from "react";
import type { HTMLAttributes } from "react";
import { Button } from "./Button.js";
import { StatusPill } from "./StatusPill.js";
import { TextArea } from "./TextArea.js";

export interface FeedbackOption {
  id: string;
  label: string;
  description?: string;
}

export interface FeedbackAnswer {
  optionIds: string[];
  freeText?: string;
}

export interface FeedbackRequestProps extends Omit<HTMLAttributes<HTMLDivElement>, "onSubmit"> {
  /** The agent's question. */
  prompt: string;
  /** Choice rows; omit for a free-text-only ask. */
  options?: FeedbackOption[];
  /** Checkboxes instead of radios. */
  multiSelect?: boolean;
  /** Adds a "Something else…" fill-in row (always on when there are no options). */
  allowFreeText?: boolean;
  freeTextPlaceholder?: string;
  status?: "pending" | "answered";
  /** Rendered when answered. */
  answer?: FeedbackAnswer;
  answeredBy?: string;
  /** Preformatted time, e.g. "14:36". */
  answeredAt?: string;
  /** Submit in flight — everything disabled. */
  busy?: boolean;
  onSubmit?: (answer: FeedbackAnswer) => void;
}

export function FeedbackRequest({
  prompt,
  options = [],
  multiSelect = false,
  allowFreeText = false,
  freeTextPlaceholder = "Tell the agent what you have in mind…",
  status = "pending",
  answer,
  answeredBy,
  answeredAt,
  busy = false,
  onSubmit,
  className,
  ...rest
}: FeedbackRequestProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [otherActive, setOtherActive] = useState(false);
  const [text, setText] = useState("");

  const pending = status === "pending";
  // A card with no options is a free-text ask by definition.
  const freeTextOnly = options.length === 0;
  const showOtherRow = allowFreeText && !freeTextOnly;
  const textActive = otherActive || freeTextOnly;

  const toggle = (id: string) => {
    if (multiSelect) {
      setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
    } else {
      setSelected([id]);
      setOtherActive(false);
    }
  };

  const toggleOther = () => {
    if (multiSelect) {
      setOtherActive((prev) => !prev);
    } else {
      setSelected([]);
      setOtherActive(true);
    }
  };

  const canSubmit =
    selected.length > 0 || ((otherActive || freeTextOnly) && text.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    onSubmit?.({
      optionIds: selected,
      freeText: (otherActive || freeTextOnly) && text.trim() ? text.trim() : undefined,
    });
  };

  const classes = ["il-feedback", `il-feedback--${status}`, className].filter(Boolean).join(" ");

  const answeredOptions = answer ? options.filter((o) => answer.optionIds.includes(o.id)) : [];

  return (
    <div className={classes} {...rest}>
      <div className="il-feedback__kicker">
        <span className="il-feedback__chip" aria-hidden>
          <AskGlyph />
        </span>
        <span className="il-feedback__label">Input requested</span>
        {pending && multiSelect && options.length > 0 && (
          <span className="il-feedback__hint">choose all that apply</span>
        )}
      </div>

      <div className="il-feedback__prompt">{prompt}</div>

      {pending && (
        <>
          {options.length > 0 && (
            <div
              className="il-feedback__options"
              role={multiSelect ? "group" : "radiogroup"}
              aria-label={prompt}
            >
              {options.map((o) => {
                const on = selected.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    role={multiSelect ? "checkbox" : "radio"}
                    aria-checked={on}
                    disabled={busy}
                    className={`il-feedback__opt${on ? " il-feedback__opt--on" : ""}`}
                    onClick={() => toggle(o.id)}
                  >
                    <OptionControl multi={multiSelect} on={on} />
                    <span className="il-feedback__opt-text">
                      <span className="il-feedback__opt-label">{o.label}</span>
                      {o.description && (
                        <span className="il-feedback__opt-desc">{o.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
              {showOtherRow && (
                <button
                  type="button"
                  role={multiSelect ? "checkbox" : "radio"}
                  aria-checked={otherActive}
                  disabled={busy}
                  className={`il-feedback__opt${otherActive ? " il-feedback__opt--on" : ""}`}
                  onClick={toggleOther}
                >
                  <OptionControl multi={multiSelect} on={otherActive} />
                  <span className="il-feedback__opt-text">
                    <span className="il-feedback__opt-label">Something else…</span>
                  </span>
                </button>
              )}
            </div>
          )}

          {textActive && (
            <div className="il-feedback__free">
              <TextArea
                rows={2}
                autoFocus={!freeTextOnly}
                placeholder={freeTextPlaceholder}
                value={text}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          )}

          <div className="il-feedback__actions">
            <Button variant="primary" size="sm" disabled={busy || !canSubmit} onClick={submit}>
              Send answer
            </Button>
          </div>
        </>
      )}

      {!pending && (
        <>
          {answeredOptions.length > 0 && (
            <div className="il-feedback__options">
              {answeredOptions.map((o) => (
                <div key={o.id} className="il-feedback__opt il-feedback__opt--on il-feedback__opt--static">
                  <OptionControl multi={multiSelect} on />
                  <span className="il-feedback__opt-text">
                    <span className="il-feedback__opt-label">{o.label}</span>
                    {o.description && <span className="il-feedback__opt-desc">{o.description}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {answer?.freeText && <div className="il-feedback__quote">&ldquo;{answer.freeText}&rdquo;</div>}
          <div className="il-feedback__resolution">
            <StatusPill tone="success">answered</StatusPill>
            {(answeredBy || answeredAt) && (
              <span className="il-feedback__meta">
                {[answeredBy && `by ${answeredBy}`, answeredAt].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function OptionControl({ multi, on }: { multi: boolean; on: boolean }) {
  const base = multi ? "il-feedback__box" : "il-feedback__radio";
  return (
    <span className={`${base}${on ? ` ${base}--on` : ""}`} aria-hidden>
      {multi && on && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path
            d="M1.5 5.2 4 7.6 8.5 2.6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

function AskGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 3.4C2 2.6 2.6 2 3.4 2h7.2c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H7.2L4.4 12.4V10H3.4C2.6 10 2 9.4 2 8.6V3.4Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M5.7 4.9a1.3 1.3 0 1 1 1.87 1.17c-.35.17-.57.46-.57.82v.21"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <circle cx="7" cy="8.6" r="0.65" fill="currentColor" />
    </svg>
  );
}
