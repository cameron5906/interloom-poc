/**
 * Backstop `<think>…</think>` stripper (CONTRACTS §6.1). The engine already
 * separates reasoning via `--reasoning-format deepseek` (`reasoning_content` /
 * `delta.reasoning_content`) for template families it understands — this
 * stripper exists for the families it doesn't, where think content still
 * arrives inline in `content`. Streaming-safe: `push()` never emits text that
 * might still turn out to be part of a tag; `flush()` resolves whatever is
 * left at end-of-stream.
 *
 * Recognizes `<think>`/`<thinking>` open tags and `</think>`/`</thinking>`
 * close tags, case-insensitively. An unclosed tag at end-of-stream discards
 * everything from the open tag onward (never emits raw think text — CONTRACTS
 * §6.1). Whitespace immediately after a removed block is trimmed once, so a
 * stripped block doesn't leave a stray blank line/space behind.
 */

const OPEN_RE = /<think(?:ing)?>/i;
const CLOSE_RE = /<\/think(?:ing)?>/i;
/** Longest tag we watch for: "</thinking>" (12 chars). */
const MAX_TAG_LEN = "</thinking>".length;
const LEADING_WS_RE = /^[ \t\r\n]+/;

export class ThinkStripper {
  private buffer = "";
  private inThink = false;
  private trimLeadingPending = false;

  /** Feed one chunk of raw model output; returns the visible text to emit now (may be ""). */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";

    for (;;) {
      if (this.trimLeadingPending && !this.inThink) {
        const trimmed = this.buffer.replace(LEADING_WS_RE, "");
        if (trimmed.length !== this.buffer.length) this.buffer = trimmed;
        if (this.buffer.length > 0) this.trimLeadingPending = false;
      }

      if (!this.inThink) {
        const m = OPEN_RE.exec(this.buffer);
        if (m) {
          out += this.buffer.slice(0, m.index);
          this.buffer = this.buffer.slice(m.index + m[0].length);
          this.inThink = true;
          continue;
        }
        const safeLen = this.safeEmitLength(this.buffer);
        out += this.buffer.slice(0, safeLen);
        this.buffer = this.buffer.slice(safeLen);
        break;
      } else {
        const m = CLOSE_RE.exec(this.buffer);
        if (m) {
          // Discard the think content and the close tag itself — never emitted.
          this.buffer = this.buffer.slice(m.index + m[0].length);
          this.inThink = false;
          this.trimLeadingPending = true;
          continue;
        }
        // Still inside think: everything that can't possibly be a partial
        // close tag is confirmed think content — discard it, not emit it.
        const safeLen = this.safeEmitLength(this.buffer);
        this.buffer = this.buffer.slice(safeLen);
        break;
      }
    }

    return out;
  }

  /** End of stream. An unclosed think block discards its remainder; otherwise flushes held text. */
  flush(): string {
    if (this.inThink) {
      this.buffer = "";
      this.inThink = false;
      this.trimLeadingPending = false;
      return "";
    }
    let out = this.buffer;
    if (this.trimLeadingPending) {
      out = out.replace(LEADING_WS_RE, "");
    }
    this.buffer = "";
    this.trimLeadingPending = false;
    return out;
  }

  /**
   * Length of the prefix that's safe to release: everything up to (but not
   * including) a trailing `<` within the last MAX_TAG_LEN-1 chars, since that
   * `<` could still turn into a recognized tag once more chunks arrive.
   */
  private safeEmitLength(s: string): number {
    const holdFrom = Math.max(0, s.length - (MAX_TAG_LEN - 1));
    for (let i = holdFrom; i < s.length; i++) {
      if (s[i] === "<") return i;
    }
    return s.length;
  }
}

/** One-shot strip for a complete (non-streamed) response. Trims the final result. */
export function stripThinkTags(text: string): string {
  const stripper = new ThinkStripper();
  const out = stripper.push(text) + stripper.flush();
  return out.trim();
}
