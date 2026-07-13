import { useEffect, useState, type CSSProperties } from "react";

export type AvatarSize = "sm" | "md" | "lg";
export type Presence = "online" | "away" | "offline" | null;

export interface AvatarProps {
  name: string;
  isAgent: boolean;
  emoji?: string;
  bg?: string;
  /** Rendered avatar image (network/instance asset URL); falls back to emoji/initials on load error. */
  imageUrl?: string;
  size?: AvatarSize;
  presence?: Presence;
  className?: string;
}

const SIZE_PX: Record<AvatarSize, number> = { sm: 24, md: 32, lg: 44 };

// Deterministic pastel fill for human avatars derived from the name.
const HUMAN_PALETTE = ["#efeafc", "#e7f2ea", "#faf1dc", "#faeae8", "#e5f2f0", "#eceae3"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function pastelFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return HUMAN_PALETTE[hash % HUMAN_PALETTE.length]!;
}

export function Avatar({
  name,
  isAgent,
  emoji,
  bg,
  imageUrl,
  size = "md",
  presence = null,
  className,
}: AvatarProps) {
  const px = SIZE_PX[size];
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  const showImage = Boolean(imageUrl) && !imageFailed;

  const classes = ["il-avatar", isAgent ? "il-avatar--agent" : "il-avatar--human", className]
    .filter(Boolean)
    .join(" ");

  const style: CSSProperties = {
    width: px,
    height: px,
    fontSize: Math.round(px * (isAgent ? 0.5 : 0.38)),
    background: isAgent ? (bg ?? "var(--il-accent-gradient)") : (bg ?? pastelFor(name)),
  };

  return (
    <span className={classes} style={style} aria-label={name} title={name}>
      {showImage ? (
        <img
          className="il-avatar__img"
          src={imageUrl}
          alt=""
          draggable={false}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="il-avatar__inner">{isAgent ? (emoji ?? "🤖") : initials(name)}</span>
      )}
      {presence ? <span className={`il-avatar__dot il-avatar__dot--${presence}`} /> : null}
    </span>
  );
}
