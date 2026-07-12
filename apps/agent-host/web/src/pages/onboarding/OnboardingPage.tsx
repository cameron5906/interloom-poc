import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { StepHardware } from "./StepHardware.js";
import { StepIdentity } from "./StepIdentity.js";
import { StepNetwork } from "./StepNetwork.js";
import "./onboarding.css";

const STEPS = ["Hardware", "Identity", "Network"] as const;

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
            <BrandGlyph />
          </span>
          <span className="il-onb__wordmark">Interloom</span>
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
          {step === 1 && <StepIdentity onNext={() => setStep(2)} onBack={() => setStep(0)} />}
          {step === 2 && <StepNetwork onDone={finish} onBack={() => setStep(1)} />}
        </div>
      </div>
    </div>
  );
}

function BrandGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="1" y="1" width="16" height="16" rx="5" fill="url(#onb-loom)" />
      <path d="M5 6.2h8M5 9h8M5 11.8h8" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" opacity="0.92" />
      <path d="M6.6 4.4v9.2M11.4 4.4v9.2" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" opacity="0.5" />
      <defs>
        <linearGradient id="onb-loom" x1="1" y1="1" x2="17" y2="17" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b76ee" />
          <stop offset="1" stopColor="#6a5acd" />
        </linearGradient>
      </defs>
    </svg>
  );
}
