import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.ts";

describe("segment", () => {
  it("splits paragraphs into sentences with exact spans", () => {
    const text = "You are a router.  Reply with one word.\nIf the ticket mentions a refund, route it to `billing`.";
    const clauses = segment(text);
    expect(clauses.map((c) => c.text)).toEqual([
      "You are a router.",
      "Reply with one word.",
      "If the ticket mentions a refund, route it to `billing`.",
    ]);
    for (const c of clauses) expect(text.slice(c.span.start, c.span.end)).toBe(c.span.text);
    expect(clauses[2]?.span.line).toBe(2);
    expect(clauses[2]?.span.col).toBe(1);
  });

  it("keeps numbered list items and their numbers, with spans after the marker", () => {
    const text = "Rules:\n1. If A is true, route to `x`.\n2. If B is true, route to `y`.\n   Continued here.\n";
    const clauses = segment(text);
    const items = clauses.filter((c) => c.isListItem);
    expect(items.map((c) => c.listNumber)).toEqual([1, 2, 2]);
    expect(items[0]?.span.col).toBe(4);
    expect(items[1]?.itemStart).toBe(true);
    expect(items[2]?.itemStart).toBe(false);
    expect(items[2]?.text).toBe("Continued here.");
  });

  it("joins hard-wrapped lines into one sentence spanning two lines", () => {
    const text = "If the ticket mentions a refund,\nroute it to `billing`.";
    const [c] = segment(text);
    expect(c?.text).toBe("If the ticket mentions a refund, route it to `billing`.");
    expect(c?.span.line).toBe(1);
    expect(c?.span.endLine).toBe(2);
    expect(c?.span.text).toBe(text);
  });

  it("does not split on abbreviations and skips fenced code", () => {
    const text = "Use labels, e.g. Billing or Bugs.\n```\nIf x, route to `y`.\n```\nDone.";
    expect(segment(text).map((c) => c.text)).toEqual(["Use labels, e.g. Billing or Bugs.", "Done."]);
  });

  it("marks headings and strips bold markers from parser text only", () => {
    const text = "## Rules\n**Always** route to `x` if A is true.";
    const clauses = segment(text);
    expect(clauses[0]?.isHeading).toBe(true);
    expect(clauses[0]?.text).toBe("Rules");
    expect(clauses[1]?.text).toBe("Always route to `x` if A is true.");
    expect(clauses[1]?.span.text).toBe("**Always** route to `x` if A is true.");
  });

  it("handles CRLF line endings", () => {
    const text = "First line.\r\nIf A is true, route to `x`.\r\n";
    const clauses = segment(text);
    expect(clauses.map((c) => c.span.text)).toEqual(["First line.", "If A is true, route to `x`."]);
    expect(clauses[1]?.span.line).toBe(2);
  });

  it("ends a clause at a line break when the next line starts a new sentence", () => {
    const text = "Labels: spam, promo\nLabel it spam if the sender is unknown.\nIf the sender is new,\nlabel it promo.";
    expect(segment(text).map((c) => c.text)).toEqual([
      "Labels: spam, promo",
      "Label it spam if the sender is unknown.",
      "If the sender is new, label it promo.",
    ]);
  });
});
