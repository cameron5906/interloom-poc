/** A member that can be @-mentioned. */
export interface Mentionable {
  id: string;
  name: string;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/** A raw, non-overlapping mention match: `@` through the end of the matched name. */
export interface MentionSpan {
  start: number;
  end: number;
  memberId: string;
}

/**
 * Shared scanning walk behind `parseMentions` and `findMentionSpans`.
 *
 * Rules: `@` + member display name, longest-match-first, case-insensitive,
 * word-boundary required after the name (so `@Ada!` matches but `@Adam` does
 * not match member "Ada"). A word character immediately before the `@`
 * (e.g. `bob@ada.dev`) is not treated as a mention. Returns spans in
 * ascending, non-overlapping order (document order, repeats included).
 */
function scanMentions(text: string, members: Mentionable[]): MentionSpan[] {
  const candidates = members
    .filter((m) => m.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const spans: MentionSpan[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    if (isWordChar(text[i - 1])) continue;
    for (const member of candidates) {
      const candidate = text.slice(i + 1, i + 1 + member.name.length);
      if (candidate.toLowerCase() !== member.name.toLowerCase()) continue;
      if (isWordChar(text[i + 1 + member.name.length])) continue;
      const end = i + 1 + member.name.length;
      spans.push({ start: i, end, memberId: member.id });
      i = end - 1;
      break;
    }
  }

  return spans;
}

/**
 * Parse `@` mentions out of a message (CONTRACTS §5).
 *
 * Same matching semantics as `scanMentions` (longest-match, case-insensitive,
 * word-boundary, email guard). Returns member ids in order of first
 * appearance, deduplicated.
 */
export function parseMentions(text: string, members: Mentionable[]): string[] {
  const found: string[] = [];
  for (const span of scanMentions(text, members)) {
    if (!found.includes(span.memberId)) found.push(span.memberId);
  }
  return found;
}

/**
 * Find `@` mention spans in a message, for rendering (CONTRACTS §5).
 *
 * Same matching semantics as `parseMentions` (longest-match, case-insensitive,
 * word-boundary, email guard). Spans cover `@` through the end of the matched
 * name, non-overlapping, in ascending order; repeated mentions each get their
 * own span.
 */
export function findMentionSpans(text: string, members: Mentionable[]): MentionSpan[] {
  return scanMentions(text, members);
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
