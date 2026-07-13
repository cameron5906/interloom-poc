import { describe, expect, it } from "vitest";
import { findMentionSpans, mentionedNonMembers, parseMentions } from "./mentions.js";

const members = [
  { id: "ada", name: "Ada" },
  { id: "ada-lovelace", name: "Ada Lovelace" },
  { id: "bob", name: "Bob" },
];

describe("parseMentions", () => {
  it("prefers the longest matching name", () => {
    expect(parseMentions("hey @Ada Lovelace, ship it", members)).toEqual(["ada-lovelace"]);
  });

  it("falls back to the shorter name when the longer does not match", () => {
    expect(parseMentions("hey @Ada Smith", members)).toEqual(["ada"]);
  });

  it("matches case-insensitively", () => {
    expect(parseMentions("ping @ADA LOVELACE now", members)).toEqual(["ada-lovelace"]);
    expect(parseMentions("ping @bob", members)).toEqual(["bob"]);
  });

  it("accepts punctuation as a boundary after the name", () => {
    expect(parseMentions("thanks @Ada!", members)).toEqual(["ada"]);
    expect(parseMentions("(@Bob)", members)).toEqual(["bob"]);
    expect(parseMentions("@Ada, @Bob: hello", members)).toEqual(["ada", "bob"]);
  });

  it("requires a word boundary after the name", () => {
    expect(parseMentions("hi @Adam", members)).toEqual([]);
    expect(parseMentions("hi @Bobby", members)).toEqual([]);
  });

  it("matches at end of text", () => {
    expect(parseMentions("over to you @Bob", members)).toEqual(["bob"]);
  });

  it("finds multiple mentions and deduplicates", () => {
    expect(parseMentions("@Ada meet @Bob; @ada again", members)).toEqual(["ada", "bob"]);
  });

  it("ignores email-like @ sequences", () => {
    expect(parseMentions("mail bob@ada.dev please", members)).toEqual([]);
  });

  it("returns empty for no mentions or empty text", () => {
    expect(parseMentions("no mentions here", members)).toEqual([]);
    expect(parseMentions("", members)).toEqual([]);
  });
});

describe("mentionedNonMembers", () => {
  it("returns mentioned members that are absent from the channel roster", () => {
    expect(mentionedNonMembers("hey @Bob", members, ["ada"])).toEqual([{ id: "bob", name: "Bob" }]);
  });

  it("excludes mentioned members already in the roster", () => {
    expect(mentionedNonMembers("hey @Bob", members, ["bob"])).toEqual([]);
  });

  it("returns empty when nobody is mentioned", () => {
    expect(mentionedNonMembers("hello all", members, [])).toEqual([]);
  });

  it("returns multiple absent members", () => {
    expect(mentionedNonMembers("@Ada and @Bob", members, [])).toEqual([
      { id: "ada", name: "Ada" },
      { id: "bob", name: "Bob" },
    ]);
  });
});

describe("findMentionSpans (render parity with parseMentions)", () => {
  const members = [
    { id: "rm", name: "Rocket Man" },
    { id: "r", name: "Rocket" },
    { id: "ada", name: "Ada" },
  ];
  it("spans the full spaced name (longest match wins)", () => {
    const text = "hey @Rocket Man how are you";
    expect(findMentionSpans(text, members)).toEqual([{ start: 4, end: 15, memberId: "rm" }]);
  });
  it("word boundary + email guard match parseMentions", () => {
    expect(findMentionSpans("@Adam", members)).toEqual([]);
    expect(findMentionSpans("bob@ada.dev", members)).toEqual([]);
    expect(findMentionSpans("@Ada!", members)).toEqual([{ start: 0, end: 4, memberId: "ada" }]);
  });
  it("multiple + repeated mentions all get spans", () => {
    const text = "@Ada meet @Rocket Man; thanks @Ada";
    expect(findMentionSpans(text, members).map((s) => s.memberId)).toEqual(["ada", "rm", "ada"]);
  });
});
