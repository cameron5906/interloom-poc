export interface ThinkSegment {
  kind: "think" | "text";
  text: string;
  /** True while a <think> block is still streaming (no closing tag yet). */
  open?: boolean;
}

/** Split streamed reply text into think/text segments; tolerant of an unclosed tag. */
export function parseThinkSegments(raw: string): ThinkSegment[] {
  const segments: ThinkSegment[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const start = rest.indexOf("<think>");
    if (start === -1) {
      segments.push({ kind: "text", text: rest });
      break;
    }
    if (start > 0) segments.push({ kind: "text", text: rest.slice(0, start) });
    const end = rest.indexOf("</think>", start);
    if (end === -1) {
      segments.push({ kind: "think", text: rest.slice(start + 7), open: true });
      break;
    }
    segments.push({ kind: "think", text: rest.slice(start + 7, end) });
    rest = rest.slice(end + 8);
  }
  return segments.filter((s) => s.text.trim().length > 0 || s.open);
}
