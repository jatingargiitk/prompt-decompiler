import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyze, assignments, evaluate, mergeCubes } from "../src/analyze.ts";
import { applyDecisions, parseDecisions, serializeDecisions } from "../src/decisions.ts";
import { parsePrompt } from "../src/parse.ts";
import type { Input } from "../src/types.ts";

const example = readFileSync(new URL("../examples/support-router.md", import.meta.url), "utf8");
const bool = (id: string): Input => ({
  id,
  name: id,
  short: id,
  kind: "bool",
  values: ["true", "false"],
  declared: true,
  span: { start: 0, end: 0, line: 1, col: 1, endLine: 1, endCol: 1, text: "" },
});
const valuesOf = (m: ReturnType<typeof parsePrompt>, a: Record<string, string>) =>
  m.inputs.map((i) => a[i.short] ?? (i.kind === "bool" ? "false" : (i.values[0] ?? "")));

describe("enumeration and cube merging", () => {
  it("enumerates the full cartesian product", () => {
    const inputs = [bool("x"), { ...bool("plan"), kind: "choice" as const, values: ["a", "b", "c"] }];
    expect([...assignments(inputs)]).toHaveLength(6);
  });

  it("merges combinations exactly, without covering anything outside the set", () => {
    const inputs = [bool("x"), bool("y")];
    expect(mergeCubes(inputs, [["true", "true"], ["true", "false"]])).toEqual([[["true"], ["true", "false"]]]);
    const xor = mergeCubes(inputs, [["true", "false"], ["false", "true"]]);
    expect(xor).toHaveLength(2);
  });
});

describe("analyze on the support-router example", () => {
  const m = parsePrompt(example);
  const a = analyze(m);

  it("enumerates every combination of the six inputs", () => {
    expect(a.combinations).toBe(3 * 2 ** 5);
  });

  it("finds the unresolved bugs/billing conflict with a minimal witness", () => {
    const c = a.conflicts.find((g) => g.status === "unresolved" && g.tied.join() === "billing,bugs");
    expect(c).toBeDefined();
    expect(c?.rules).toEqual(["R1", "R2", "R3", "R7"]);
    const w = Object.fromEntries(m.inputs.map((i, k) => [i.short, c?.witness[k]]));
    expect(w).toMatchObject({ reports_crash: "true", asks_to_delete: "false" });
    expect(c?.witness.filter((v) => v === "true")).toHaveLength(2);
  });

  it("finds sales vs billing for enterprise pricing questions", () => {
    const c = a.conflicts.find((g) => g.status === "unresolved" && g.tied.join() === "billing,sales");
    expect(c?.remaining).toEqual(["R2", "R5", "R7"]);
    expect(c?.cubes[0]?.[0]).toEqual(["enterprise"]);
  });

  it("resolves account over billing by stated precedence and crash+enterprise by 'always'", () => {
    const prec = a.conflicts.find((g) => g.status === "resolved" && g.winner === "account");
    expect(prec?.by).toBe("precedence (account over billing)");
    const always = a.conflicts.find((g) => g.status === "resolved" && g.winner === "bugs");
    expect(always?.by).toBe('"always" in R6');
    expect(always?.count).toBe(16 - 1);
  });

  it("applies the forbid rule: a refund never routes to sales", () => {
    const o = evaluate(m, valuesOf(m, { customer_plan: "enterprise", mentions_refund: "true", asks_about_pricing: "true" }));
    expect(o.blockers).toEqual(["R8"]);
    expect(o.candidates).toEqual(["R1", "R7"]);
    expect(o).toMatchObject({ kind: "single", label: "billing" });
  });

  it("reports a missing default as a gap", () => {
    expect(a.gaps).toHaveLength(1);
    expect(a.gaps[0]).toMatchObject({ reason: "no rule applies and the prompt has no default", count: 3 });
    expect(a.gaps[0]?.cubes).toEqual([[["free", "pro", "enterprise"], ["false"], ["false"], ["false"], ["false"], ["false"]]]);
  });
});

describe("priorities and dead rules", () => {
  it("lets the first rule win only when the prompt says rules apply in order", () => {
    const text = "Labels: a, b\n1. If X is true, label it a.\n2. If Y is true, label it b.\n";
    const unordered = analyze(parsePrompt(text));
    expect(unordered.conflicts).toEqual([expect.objectContaining({ status: "unresolved", tied: ["a", "b"] })]);
    const ordered = analyze(parsePrompt(`${text}Apply the rules in order; the first match wins.`));
    expect(ordered.conflicts).toEqual([expect.objectContaining({ status: "resolved", winner: "a", by: "rule order" })]);
  });

  it("flags a rule that can never decide anything", () => {
    const m = parsePrompt("Labels: a, b\n1. If X is true, label it a.\n2. If X is true and Y is true, label it b.\nApply the rules in order; the first match wins.");
    expect(analyze(m).deadRules).toEqual(["R2"]);
  });

  it("uses the default and reports when a forbid blocks every option", () => {
    const m = parsePrompt("Labels: a, b\nIf X is true, label it a.\nNever label it a if Y is true.\nOtherwise, label it b.");
    const r = analyze(m);
    expect(r.gaps).toEqual([]);
    expect(r.defaultCount).toBe(4 - 1);
    const strict = parsePrompt("Labels: a\nIf X is true, label it a.\nNever label it a if Y is true.");
    expect(analyze(strict).gaps.map((g) => g.reason)).toContain("every matching rule's label is forbidden here");
  });

  it("refuses to enumerate past the combination limit", () => {
    expect(() => analyze(parsePrompt(example), { maxCombinations: 10 })).toThrow(/96 combinations/);
  });
});

describe("decisions", () => {
  const m = parsePrompt(example);

  it("round-trips through YAML and accepts JSON", () => {
    const d = { promptSha256: m.promptSha256, rules: { R1: "accept" as const, R7: "reject" as const }, conflicts: [{ between: ["billing", "bugs"], winner: "bugs" }], default: "general" };
    expect(parseDecisions(serializeDecisions(d))).toEqual(d);
    expect(parseDecisions(JSON.stringify({ rules: { R2: "reject" } })).rules).toEqual({ R2: "reject" });
  });

  it("rejects malformed files with a clear message", () => {
    expect(() => parseDecisions("rules: {R1: maybe}", "d.yaml")).toThrow(/d.yaml: rules.R1 must be "accept" or "reject"/);
    expect(() => parseDecisions("conflicts: [{between: [a], winner: a}]")).toThrow(/at least two/);
    expect(() => parseDecisions("winners: []")).toThrow(/unknown key "winners"/);
  });

  it("settles conflicts, rejects rules and fills the missing default", () => {
    const d = parseDecisions([
      "rules:",
      "  R7: reject",
      "conflicts:",
      "  - between: [R1, R3]",
      "    winner: R3",
      "  - between: [account, bugs]",
      "    winner: bugs",
      "  - between: [account, sales]",
      "    winner: account",
      "  - between: [billing, sales]",
      "    winner: sales",
      "default: general",
    ].join("\n"));
    const applied = applyDecisions(m, d);
    expect(applied.warnings).toEqual([]);
    const r = analyze(applied.model, { decisions: applied.conflicts });
    expect(r.conflicts.filter((c) => c.status === "unresolved")).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.defaultCount).toBeGreaterThan(0);
    expect(r.unusedDecisions).toEqual([]);
    const crash = r.conflicts.find((c) => c.by?.includes("decisions file") && c.winner === "bugs");
    expect(crash).toBeDefined();
  });

  it("warns about a changed prompt, unknown ids and invalid winners", () => {
    const d = parseDecisions("prompt_sha256: abc\nrules: {R99: accept}\nconflicts:\n  - between: [billing, bugs]\n    winner: sales\ndefault: nope");
    const { warnings, conflicts } = applyDecisions(m, d);
    expect(conflicts).toEqual([]);
    expect(warnings.join("\n")).toMatch(/different version/);
    expect(warnings.join("\n")).toMatch(/unknown rule R99/);
    expect(warnings.join("\n")).toMatch(/not one of them/);
    expect(warnings.join("\n")).toMatch(/"nope" is not a label/);
  });
});
