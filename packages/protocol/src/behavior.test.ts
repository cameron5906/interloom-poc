import { describe, expect, it } from "vitest";
import {
  AmbientAttentionDecisionV2,
  ConversationMemoryV2,
  compileAgentBehaviorPolicy,
} from "./index.js";

describe("Agent Behavior v2", () => {
  it("keeps v1 prompt compilation byte-empty", () => {
    expect(
      compileAgentBehaviorPolicy({
        version: 1,
        mode: "direct",
        authority: "requested_actions",
      }),
    ).toBe("");
  });

  it("compiles explicit intent, ambiguity, memory, and one-answer invariants", () => {
    const policy = compileAgentBehaviorPolicy({
      version: 2,
      mode: "ambient_discovery",
      authority: "read_only",
    });
    expect(policy).toContain("materially change");
    expect(policy).toContain("Do not ask for details the human already gave you");
    expect(policy).toContain("source-linked memory");
    expect(policy).toContain("one coherent visible answer");
    expect(policy).toContain("must not cause side effects");
  });

  it("requires sources on every memory item and a reason on attention decisions", () => {
    expect(
      ConversationMemoryV2.safeParse({
        version: 2,
        items: [{ kind: "decision", text: "Use Postgres", sources: [] }],
      }).success,
    ).toBe(false);
    expect(AmbientAttentionDecisionV2.safeParse({ decision: "reply" }).success).toBe(false);
  });
});
