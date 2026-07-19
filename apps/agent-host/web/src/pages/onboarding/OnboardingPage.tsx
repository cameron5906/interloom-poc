import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoomGlyph } from "../../components/NavRail.js";
import { StepHardware } from "./StepHardware.js";
import { StepIdentity } from "./StepIdentity.js";
import "./onboarding.css";

const STEPS = ["Hardware", "Identity"] as const;

export function OnboardingPage({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  const finish = () => {
    onDone();
    navigate("/models", { replace: true });
  };

  const skip = () => {
    onDone();
    navigate("/", { replace: true });
  };

  return (
    <div className="il-onb">
      <div className="il-onb__frame">
        <header className="il-onb__brand">
          <span className="il-onb__mark" aria-hidden>
            <LoomGlyph size={26} />
          </span>
          <span className="il-onb__wordmark">Eris</span>
          <span className="il-onb__tag">Agent Host setup</span>
          <button className="il-onb__skip" onClick={skip}>
            Skip for now
          </button>
        </header>

        <ol className="il-onb__steps" aria-label="Setup progress">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`il-onb__step${i === step ? " il-onb__step--active" : ""}${
                i < step ? " il-onb__step--done" : ""
              }`}
            >
              <span className="il-onb__step-num">{i < step ? "✓" : i + 1}</span>
              <span className="il-onb__step-label">{label}</span>
            </li>
          ))}
        </ol>

        <div className="il-onb__panel">
          {step === 0 && <StepHardware onNext={() => setStep(1)} />}
          {step === 1 && <StepIdentity onNext={finish} onBack={() => setStep(0)} />}
        </div>
      </div>
    </div>
  );
}
