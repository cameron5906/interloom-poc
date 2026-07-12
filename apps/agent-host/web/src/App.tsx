import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { NavRail } from "./components/NavRail.js";
import { keys as keysApi, network as networkApi, agents as agentsApi } from "./api/endpoints.js";
import { useAsync } from "./hooks/useAsync.js";
import { useDaemonHealth } from "./hooks/useDaemonHealth.js";
import { ONBOARDING_DONE_KEY } from "./lib/constants.js";
import { OnboardingPage } from "./pages/onboarding/OnboardingPage.js";
import { OverviewPage } from "./pages/overview/OverviewPage.js";
import { ModelsPage } from "./pages/models/ModelsPage.js";
import { AgentsPage } from "./pages/agents/AgentsPage.js";
import { PlacementsPage } from "./pages/placements/PlacementsPage.js";

export function App() {
  const location = useLocation();
  const daemonOnline = useDaemonHealth();

  const hostKeys = useAsync((s) => keysApi.get(s), []);
  const session = useAsync((s) => networkApi.session(s), []);

  const isOnboarding = location.pathname === "/onboarding";

  if (isOnboarding) {
    return (
      <OnboardingPage
        onDone={() => {
          window.localStorage.setItem(ONBOARDING_DONE_KEY, "1");
        }}
      />
    );
  }

  return (
    <div className="il-app">
      <NavRail
        session={session.data}
        hostKeys={hostKeys.data}
        daemonOnline={daemonOnline}
      />
      <main className="il-content-outer">
        {!daemonOnline && (
          <div className="il-offline-banner" role="alert">
            <span className="il-offline-banner__dot" />
            The Agent Host daemon is unreachable on port 7420 — reconnecting…
          </div>
        )}
        <OnboardingGate>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/placements" element={<PlacementsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </OnboardingGate>
      </main>
    </div>
  );
}

/**
 * First-run redirect: send the owner to /onboarding unless they've dismissed it
 * (localStorage) OR the daemon already reports agents (a returning host). While
 * that determination is loading we render nothing to avoid a flash of the shell.
 */
function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [decision, setDecision] = useState<"loading" | "onboard" | "app">("loading");

  useEffect(() => {
    const dismissed = window.localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
    if (dismissed) {
      setDecision("app");
      return;
    }
    let active = true;
    const controller = new AbortController();
    agentsApi
      .list(controller.signal)
      .then((list) => {
        if (!active) return;
        // Returning host with agents already configured → skip onboarding.
        setDecision(list.length > 0 ? "app" : "onboard");
      })
      .catch(() => {
        // Daemon down or no agents endpoint yet — default to onboarding.
        if (active) setDecision("onboard");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  if (decision === "loading") return null;
  if (decision === "onboard") return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
