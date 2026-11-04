import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAtom, parseCondition, parsePrompt, readConsequent } from "../src/parse.ts";
import { canonical } from "../src/text.ts";

const example = readFileSync(new URL("../examples/support-router.md", import.meta.url), "utf8");

describe("canonical phrase keys", () => {
  it("maps inflected and determiner variants to the same key", () => {
    expect(canonical("the ticket mentions a refund")).toBe(canonical("tickets mention refunds"));
    expect(canonical("the message reports crashes")).toBe(canonical("a message reports a crash"));
    expect(canonical("the customer's plan")).toBe("customer plan");
  });
});

describe("parseAtom", () => {
  it("reads negation in several spellings", () => {
    expect(parseAtom("the ticket does not mention a refund")).toEqual({ phrase: "the ticket mention a refund", negated: true });
    expect(parseAtom("the ticket doesn't mention a refund")).toMatchObject({ negated: true });
    expect(parseAtom("the ticket has no attachment")).toEqual({ phrase: "the ticket has attachment", negated: true });
  });

  it("reads 'X is true/false' as a boolean and 'X is v' as a possible choice", () => {
    expect(parseAtom("is_vip is false")).toEqual({ phrase: "is_vip", negated: true });
    expect(parseAtom("the plan is not enterprise")).toEqual({
      phrase: "the plan is not enterprise",
      negated: true,
      subject: "the plan",
      values: ["enterprise"],
    });
  });
});

describe("parseCondition", () => {
  it("splits conjunctions and disjunctions", () => {
    expect(parseCondition("A is true and B is true")).toHaveLength(1);
    expect(parseCondition("A is true or B is true")).toHaveLength(2);
  });

  it("keeps value lists together", () => {
    const c = parseCondition("the plan is one of free, pro or team and the ticket asks about pricing");
    expect(c).toEqual([[
      { phrase: "the plan is one of free|pro|team", negated: false, subject: "the plan", values: ["free", "pro", "team"] },
      { phrase: "the ticket asks about pricing", negated: false },
    ]]);
    const d = parseCondition("the plan is pro or enterprise");
    expect(d).toEqual([[{ phrase: "the plan is pro|enterprise", negated: false, subject: "the plan", values: ["pro", "enterprise"] }]]);
  });

  it("turns 'unless' into a negated atom on every branch", () => {
    expect(parseCondition("A is true unless B is true")).toEqual([[
      { phrase: "A", negated: false },
      { phrase: "B", negated: true },
    ]]);
  });

  it("refuses to guess ambiguous structure", () => {
    expect(parseCondition("A is true and B is true or C is true")).toEqual({ error: expect.stringContaining("mixes 'and' with 'or'") });
    expect(parseCondition("A is true and (B is true)")).toEqual({ error: "parenthesized or nested condition" });
    expect(parseCondition("A, B, C")).toEqual({ error: expect.stringContaining("comma-separated") });
  });
});

describe("readConsequent", () => {
  const labels = ["billing", "bugs"];
  it("finds one label and reads forbid/always wording", () => {
    expect(readConsequent("route it to `billing`", labels)).toEqual({ label: "billing", forbid: false, always: false });
    expect(readConsequent("always route it to bugs", labels)).toEqual({ label: "bugs", forbid: false, always: true });
    expect(readConsequent("never route it to `bugs`", labels)).toEqual({ label: "bugs", forbid: true, always: false });
  });

  it("reports unknown, missing or multiple labels", () => {
    expect(readConsequent("route it to `refunds`", labels)).toEqual({ error: "`refunds` is not one of the declared labels" });
    expect(readConsequent("use your best judgement", labels)).toEqual({ error: "no label in the action part" });
    expect(readConsequent("route it to billing or bugs", labels)).toEqual({ error: expect.stringContaining("more than one label") });
  });

  it("infers a label from the action when no label list exists", () => {
    expect(readConsequent("classify it as spam", null)).toMatchObject({ label: "spam" });
  });
});

describe("parsePrompt on the example router", () => {
  const model = parsePrompt(example);

  it("reads the declared labels and the declared choice input", () => {
    expect(model.labels).toEqual(["billing", "bugs", "account", "sales", "general"]);
    expect(model.labelsDeclared).toBe(true);
    const plan = model.inputs.find((i) => i.kind === "choice");
    expect(plan).toMatchObject({ short: "customer_plan", values: ["free", "pro", "enterprise"], declared: true });
  });

  it("extracts every numbered rule with its source span", () => {
    expect(model.rules.map((r) => `${r.id}:${r.kind}:${r.label}`)).toEqual([
      "R1:label:billing", "R2:label:billing", "R3:label:bugs", "R4:label:account",
      "R5:label:sales", "R6:label:bugs", "R7:label:billing", "R8:forbid:sales",
    ]);
    const r1 = model.rules[0];
    expect(r1?.span.line).toBe(9);
    expect(example.slice(r1?.span.start, r1?.span.end)).toBe("If the ticket mentions a refund, route it to `billing`.");
    expect(model.rules[5]?.always).toBe(true);
    expect(model.rules[4]?.conditions[0]).toHaveLength(2);
  });

  it("shares one input between rules that test the same thing", () => {
    const refund = model.inputs.find((i) => i.short === "mentions_refund");
    expect(model.rules[0]?.conditions[0]?.[0]?.input).toBe(refund?.id);
    expect(model.rules[7]?.conditions[0]?.[0]?.input).toBe(refund?.id);
  });

  it("reads label precedence and reports what it cannot interpret", () => {
    expect(model.precedence).toEqual([expect.objectContaining({ kind: "label", winner: "account", loser: "billing" })]);
    expect(model.uninterpretable.map((f) => [f.span.line, f.reason])).toEqual([
      [19, "no label in the action part"],
      [20, "no label in the action part"],
    ]);
    expect(model.default).toBeNull();
    expect(model.notes[0]).toMatch(/never says they apply in order/);
  });
});

describe("parsePrompt phrasings", () => {
  it("reads 'label X if Y', 'unless', relative clauses and defaults", () => {
    const m = parsePrompt([
      "Labels: spam, promo, inbox",
      "Label it spam if the sender is unknown.",
      "Use promo unless the message is from a colleague.",
      "Messages that contain an unsubscribe link should go to promo.",
      "Otherwise, label it inbox.",
    ].join("\n"));
    expect(m.rules.map((r) => r.label)).toEqual(["spam", "promo", "promo"]);
    expect(m.rules[1]?.conditions[0]?.[0]).toMatchObject({ negated: true });
    expect(m.inputs.map((i) => i.name)).toContain("Messages contain an unsubscribe link");
    expect(m.default?.label).toBe("inbox");
    expect(m.uninterpretable).toEqual([]);
  });

  it("reads a bulleted label list and flags label descriptions", () => {
    const m = parsePrompt("Categories:\n- `dessert`: sweet dishes\n- `main`\n- `side`\n\nIf the recipe has sugar, label it `dessert`.");
    expect(m.labels).toEqual(["dessert", "main", "side"]);
    expect(m.uninterpretable).toEqual([expect.objectContaining({ reason: expect.stringContaining("label description") })]);
    expect(m.rules).toHaveLength(1);
  });

  it("infers a fixed-choice input from two values of one subject", () => {
    const m = parsePrompt("If the cuisine is thai, label it `spicy`.\nIf the cuisine is french, label it `mild`.");
    const cuisine = m.inputs[0];
    expect(cuisine).toMatchObject({ kind: "choice", values: ["thai", "french", "(other)"], declared: false });
    expect(m.labelsDeclared).toBe(false);
    expect(m.labels).toEqual(["spicy", "mild"]);
  });

  it("uses list order only when the prompt says rules apply in order", () => {
    const text = "Labels: a, b\n1. If X is true, label it a.\n2. If Y is true, label it b.\n";
    expect(parsePrompt(text).rules.map((r) => r.order)).toEqual([undefined, undefined]);
    const ordered = parsePrompt(`${text}Apply the rules in order; the first match wins.`);
    expect(ordered.ordered).not.toBeNull();
    expect(ordered.rules.map((r) => r.order)).toEqual([1, 2]);
  });

  it("reads rule-number precedence and rejects precedence it cannot map", () => {
    const m = parsePrompt("Labels: a, b\n1. If X is true, label it a.\n2. If Y is true, label it b.\n\nRule 2 takes precedence over rule 1.\nUrgent things take precedence over everything.");
    expect(m.precedence).toEqual([expect.objectContaining({ kind: "rule", winner: "R2", loser: "R1" })]);
    expect(m.uninterpretable[0]?.reason).toMatch(/precedence between things/);
  });

  it("flags disagreeing defaults and ignores output-format instructions", () => {
    const m = parsePrompt("Labels: a, b\nRespond with only the label.\nOtherwise, label it a.\nBy default, label it b.");
    expect(m.default?.label).toBe("a");
    expect(m.uninterpretable[0]?.reason).toMatch(/second default/);
    expect(m.ignored.map((f) => f.reason)).toContain("output-format instruction");
  });
});
