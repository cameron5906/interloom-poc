// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useOperatorBindFlow: vi.fn(),
}));

vi.mock("./useOperatorBindFlow.js", () => ({
  useOperatorBindFlow: mocks.useOperatorBindFlow,
}));

import { OperatorBindGate } from "./OperatorBindGate.js";

describe("OperatorBindGate shell awareness", () => {
  beforeEach(() => {
    mocks.useOperatorBindFlow.mockReset().mockReturnValue({
      phase: "idle",
      error: null,
      boundIdentity: null,
      start: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    delete window.interloomShell;
  });

  it("renders a passive embedded state without invoking the legacy popup hook", () => {
    window.interloomShell = {
      version: 1,
      notify: vi.fn(),
      onNotificationClick: vi.fn(() => () => {}),
    };

    render(<OperatorBindGate mode="unbound" onBound={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "Waiting for the app to connect this host…" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Connect identity")).toBeNull();
    expect(mocks.useOperatorBindFlow).not.toHaveBeenCalled();
  });

  it("preserves the standalone portal bind flow without a shell bridge", () => {
    render(<OperatorBindGate mode="unbound" onBound={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Connect identity" })).not.toBeNull();
    expect(mocks.useOperatorBindFlow).toHaveBeenCalledTimes(1);
  });
});
