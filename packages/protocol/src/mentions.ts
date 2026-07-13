/** A member that can be @-mentioned. */
export interface Mentionable {
  id: string;
  name: string;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * Parse `@` mentions out of a message (CONTRACTS §5).
 *
 * Rules: `@` + member display name, longest-match-first, case-insensitive,
 * word-boundary required after the name (so `@Ada!` matches but `@Adam` does
 * not match member "Ada"). A word character immediately before the `@`
 * (e.g. `bob@ada.dev`) is not treated as a mention. Returns member ids in
 * order of first appearance, deduplicated.
 */
export function parseMentions(text: string, members: Mentionable[]): string[] {
  const candidates = members
    .filter((m) => m.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    if (isWordChar(text[i - 1])) continue;
    for (const member of candidates) {
      const candidate = text.slice(i + 1, i + 1 + member.name.length);
      if (candidate.toLowerCase() !== member.name.toLowerCase()) continue;
      if (isWordChar(text[i + 1 + member.name.length])) continue;
      if (!found.includes(member.id)) found.push(member.id);
      i += member.name.length;
      break;
    }
  }

  return found;
}

/** Mentionables that are mentioned in `text` AND not already in `memberIds`. */
export function mentionedNonMembers(
  text: string,
  members: Mentionable[],
  memberIds: string[],
): Mentionable[] {
  const inChannel = new Set(memberIds);
  const mentioned = new Set(parseMentions(text, members));
  return members.filter((m) => mentioned.has(m.id) && !inChannel.has(m.id));
}
