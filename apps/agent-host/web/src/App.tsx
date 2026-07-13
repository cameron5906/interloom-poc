import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { MobileTabBar } from "@interloom/ui";
import { NavRail, NAV } from "./components/NavRail.js";
import { MobileTopBar } from "./components/MobileTopBar.js";
import { useToasts } from "./components/Toasts.js";
import { keys as keysApi, network as networkApi, agents as agentsApi } from "./api/endpoints.js";
import { useAsync } from "./hooks/useAsync.js";
import { useDaemonHealth } from "./hooks/useDaemonHealth.js";
import { useUpdateStatus } from "./hooks/useUpdateStatus.js";
import { ONBOARDING_DONE_KEY, UPDATE_NOTIFIED_KEY } from "./lib/constants.js";
import { OnboardingPage } from "./pages/onboarding/OnboardingPage.js";
import { OverviewPage } from "./pages/overview/OverviewPage.js";
import { ModelsPage } from "./pages/models/ModelsPage.js";
import { AgentsPage } from "./pages/agents/AgentsPage.js";
import { PlacementsPage } from "./pages/placements/PlacementsPage.js";
import { SettingsPage } from "./pages/settings/SettingsPage.js";

/** Which NAV entry the bottom tab bar should highlight for a given path. */
function activeNavKey(pathname: string): string {
  const match = NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)));
  return match?.to ?? "/";
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const daemonOnline = useDaemonHealth();

  const hostKeys = useAsync((s) => keysApi.get(s), []);
  const session = useAsync((s) => networkApi.session(s), []);

  const toasts = useToasts();
  const { status: updateStatus } = useUpdateStatus();

  const availableVersion = updateStatus?.updateAvailable
    ? updateStatus.latest?.version
    : undefined;
  useEffect(() => {
    if (!availableVersion) return;
    if (window.localStorage.getItem(UPDATE_NOTIFIED_KEY) === availableVersion) return;
    window.localStorage.setItem(UPDATE_NOTIFIED_KEY, availableVersion);
    toasts.push(`Host update ${availableVersion} is available — see Settings`, "accent");
  }, [availableVersion, toasts]);

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
        updateAvailable={updateStatus?.updateAvailable ?? false}
        version={updateStatus?.current.version}
      />
      <MobileTopBar session={session.data} daemonOnline={daemonOnline} />
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
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </OnboardingGate>
      </main>
      <MobileTabBar
        items={NAV.map(({ to, label, icon: Icon }) => ({
          key: to,
          label,
          icon: <Icon />,
        }))}
        activeKey={activeNavKey(location.pathname)}
        onSelect={(key) => navigate(key)}
      />
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
