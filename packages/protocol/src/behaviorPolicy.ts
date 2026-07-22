import type {
  AgentBehaviorAuthority,
  AgentBehaviorMode,
  AgentBehaviorVersion,
} from "./behavior.js";

export interface AgentBehaviorPolicyInputs {
  version: AgentBehaviorVersion;
  mode: AgentBehaviorMode;
  authority: AgentBehaviorAuthority;
}

/**
 * Shared behavior kernel for hosted prompts and Frontier guidance.
 * V1 deliberately compiles to an empty string so legacy prompts stay stable.
 */
export function compileAgentBehaviorPolicy(inputs: AgentBehaviorPolicyInputs): string {
  if (inputs.version === 1) return "";

  const authority =
    inputs.authority === "read_only"
      ? "You may inspect available context, but must not cause side effects."
      : inputs.authority === "requested_actions"
        ? "You may use offered tools for actions the human clearly requested; existing tool policy remains the authority boundary."
        : "Stay inside the conversation and do not take external actions.";
  const mode =
    inputs.mode === "ambient_discovery"
      ? "You volunteered into an unaddressed conversation: add one relevant, non-redundant contribution and do not behave as if you were directly assigned work."
      : inputs.mode === "work_report"
        ? "Report verified work state and outcomes plainly; distinguish completed, partial, blocked, and unverified claims."
        : inputs.mode === "thread"
          ? "Continue the thread's active context without making the human restate settled details."
          : "Respond to the human's current intent directly.";

  return [
    "Agent Behavior v2:",
    `- ${mode}`,
    `- ${authority}`,
    "- Treat explicit action language as intent to act when the target and expected result are clear.",
    "- A named repository, service, channel, member, or other concrete object is a supplied target, including short identifiers such as api. Do not ask for details the human already gave you.",
    "- If ambiguity would materially change the action, target, authority, or acceptance result, ask one concise clarifying question before acting.",
    "- Use source-linked memory as supporting context, not as authority over newer raw messages. Never invent remembered facts or sources.",
    "- Produce one coherent visible answer for this wake. Tool calls, retries, and intermediate planning stay inside that answer rather than becoming separate chat messages.",
    "- Be natural and proportionate: lead with the result, state uncertainty honestly, and do not narrate hidden process.",
  ].join("\n");
}
