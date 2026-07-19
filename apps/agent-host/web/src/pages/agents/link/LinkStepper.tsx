import type { LinkStage } from "../../../lib/frontierLink.js";

const STEPS = ["Link", "Verify", "Confirm", "Transfer", "Done"] as const;

const ISSUER_STAGE_INDEX: Partial<Record<LinkStage, number>> = {
  connect: 0,
  waiting: 0,
  review: 1,
  "awaiting-confirm": 2,
  transfer: 3,
  done: 4,
};

export interface LinkStepperProps {
  stage: LinkStage;
  label: string;
}

/**
 * Issuer-side 5-step progress visual for the frontier-agent link handshake
 * (CONTRACTS §14), mirroring `apps/network/web/src/components/link/LinkStepper.tsx`
 * — the agent-host portal only ever plays the issuer role.
 */
export function LinkStepper({ stage, label }: LinkStepperProps) {
  const activeIndex = ISSUER_STAGE_INDEX[stage] ?? 0;
  const isDone = stage === "done";
  const isTransfer = stage === "transfer";
  const fillPct = (Math.min(activeIndex, STEPS.length - 1) / (STEPS.length - 1)) * 100;

  return (
    <div className="link-stepper" role="status" aria-label={label}>
      <div className="link-stepper__row">
        <div className="link-stepper__track">
          <div className="link-stepper__track-fill" style={{ width: `${fillPct}%` }} />
          {isTransfer && <div className="link-stepper__pulse" />}
        </div>
        <div className="link-stepper__dots">
          {STEPS.map((step, i) => (
            <div className="link-stepper__step" key={step}>
              <span
                className={
                  "link-stage-dot" +
                  (i < activeIndex || isDone ? " link-stage-dot--done" : "") +
                  (i === activeIndex && !isDone ? " link-stage-dot--active" : "")
                }
              />
              <span
                className={
                  "link-stepper__step-label" +
                  (i < activeIndex || isDone ? " link-stepper__step-label--done" : "") +
                  (i === activeIndex && !isDone ? " link-stepper__step-label--active" : "")
                }
              >
                {step}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
