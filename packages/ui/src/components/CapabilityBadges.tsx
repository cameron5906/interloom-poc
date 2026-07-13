export interface ModelCapabilityFlags {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
}

export interface CapabilityBadgesProps {
  capabilities?: ModelCapabilityFlags;
  /** Dashed styling for search-result estimates (spec: never present a guess as a fact). */
  estimated?: boolean;
  size?: "sm" | "md";
}

/** Capability chips. undefined = unknown → renders nothing (never guesses). */
export function CapabilityBadges({ capabilities, estimated, size = "md" }: CapabilityBadgesProps) {
  if (!capabilities) return null;
  const chips: Array<{ key: string; label: string }> = [];
  if (capabilities.tools) chips.push({ key: "tools", label: "TOOLS" });
  if (capabilities.vision) chips.push({ key: "vision", label: "VISION" });
  if (capabilities.thinking) chips.push({ key: "thinking", label: "THINKING" });
  if (chips.length === 0) chips.push({ key: "text", label: "TEXT" });

  return (
    <span className={`il-capbadges il-capbadges--${size}`}>
      {chips.map((c) => (
        <span
          key={c.key}
          className={`il-capbadge il-capbadge--${c.key}${estimated ? " il-capbadge--est" : ""}`}
          title={estimated ? "estimated — confirmed after download" : undefined}
        >
          {c.label}
        </span>
      ))}
    </span>
  );
}
