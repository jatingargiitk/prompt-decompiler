import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.ts";
import { parsePrompt } from "../src/parse.ts";
import { buildReport, cell, hasOpenIssues, summarize, UNRESOLVED } from "../src/report.ts";
import { renderHtml, renderJson, renderMarkdown, renderTable } from "../src/render.ts";
import { buildTestCases, toJsonl, toPromptfoo } from "../src/witness.ts";
import type { Input } from "../src/types.ts";

const example = readFileSync(new URL("../examples/support-router.md", import.meta.url), "utf8");
const model = parsePrompt(example);
const report = buildReport(model, analyze(model), { source: "support-router.md" });

describe("cells", () => {
  const plan = { kind: "choice", values: ["free", "pro", "enterprise"] } as Input;
  it("prints any, single values, complements and alternatives", () => {
    expect(cell(plan, ["free", "pro", "enterprise"])).toBe("-");
    expect(cell(plan, ["pro"])).toBe("pro");
    expect(cell(plan, ["free", "pro"])).toBe("!enterprise");
    expect(cell({ ...plan, values: ["a", "b", "c", "d"] }, ["a", "b"])).toBe("a|b");
    expect(cell({ kind: "bool", values: ["true", "false"] } as Input, ["false"])).toBe("F");
  });
});

describe("report rows", () => {
  it("has a row per rule, conflict cube and gap, each tied to its source", () => {
    const ids = report.rows.map((r) => r.id);
    expect(ids.slice(0, 8)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
    expect(report.rows.find((r) => r.id === "R8")).toMatchObject({ kind: "forbid", outcome: "never sales" });
    const r6 = report.rows.find((r) => r.id === "R6");
    expect(r6?.note).toBe("always");
    expect(r6?.spans[0]?.line).toBe(14);
    expect(example.slice(r6?.spans[0]?.start, r6?.spans[0]?.end)).toMatch(/^If the ticket reports a crash and .*always route it to `bugs`\.$/);
  });

  it("shows unresolved cells visibly and never guesses a label", () => {
    const open = report.rows.filter((r) => r.unresolved);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((r) => r.outcome === UNRESOLVED)).toBe(true);
    const gap = report.rows.find((r) => r.kind === "gap");
    expect(gap?.cells).toEqual(["-", "F", "F", "F", "F", "F"]);
    expect(hasOpenIssues(report)).toBe(true);
  });

  it("cites the precedence sentence on rows it resolves", () => {
    const row = report.rows.find((r) => r.kind === "conflict" && r.outcome === "account");
    expect(row?.spans.map((s) => s.line)).toContain(17);
  });

  it("summarizes the counts", () => {
    expect(summarize(report)).toEqual({ rules: 8, inputs: 6, combinations: 96, unresolvedConflicts: 4, resolvedConflicts: 2, gaps: 1, uninterpretable: 2, deadRules: 0 });
  });
});

describe("renderers", () => {
  it("prints a terminal table with a legend, uninterpretable clauses and no color by default", () => {
    const text = renderTable(report);
    expect(text).toContain("A  customer_plan");
    expect(text).toMatch(/G1\s+-\s+F\s+F\s+F\s+F\s+F\s+\?\? unresolved/);
    expect(text).toContain('L19    "Tickets that sound angry should be handled with extra care."');
    expect(text).not.toContain("\x1b[");
    expect(renderTable(report, { color: true })).toContain("\x1b[31m");
  });

  it("writes Markdown with escaped cells", () => {
    const text = renderMarkdown(report);
    expect(text).toContain("| ID | `customer_plan` |");
    expect(text).toContain("**?? unresolved**");
    expect(text).toContain("- **R8** (L18): \"Never route to `sales` if the ticket mentions a refund.\"");
  });

  it("writes JSON with spans and witnesses keyed by input name", () => {
    const doc = JSON.parse(renderJson(report));
    expect(doc.prompt_sha256).toBe(model.promptSha256);
    expect(doc.rules[0]).toMatchObject({ id: "R1", label: "billing", span: { line: 9 } });
    expect(doc.conflicts[0].witness).toMatchObject({ reports_crash: true, asks_to_delete: true });
    expect(doc.rows[0].cells).toMatchObject({ mentions_refund: "T" });
  });

  it("writes a self-contained HTML page that links rows to source spans", () => {
    const html = renderHtml(report, example);
    expect(html).toContain('<mark class="rule" data-span="R1" title="R1">If the ticket mentions a refund, route it to `billing`.</mark>');
    expect(html).toContain('data-spans="R3 R4"');
    expect(html).toContain('<mark class="bad" data-span="U1"');
    expect(html).not.toMatch(/<script src=|<link /);
    expect(renderHtml(report, "<b>x</b>")).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("test export", () => {
  const cases = buildTestCases(report);

  it("exports one witness per rule, conflict and gap", () => {
    expect(cases.map((c) => c.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "C1", "C2", "C3", "C4", "C5", "C6", "G1"]);
    expect(cases.find((c) => c.id === "R1")).toMatchObject({ expected: "billing", status: "decided", inputs: { mentions_refund: true, reports_crash: false } });
    expect(cases.find((c) => c.id === "R8")).toMatchObject({ expected: "billing", inputs: { mentions_refund: true, asks_about_pricing: true, customer_plan: "enterprise" } });
  });

  it("includes conflict inputs with a null expectation when unresolved", () => {
    const c2 = cases.find((c) => c.id === "C2");
    expect(c2).toMatchObject({ kind: "conflict", expected: null, status: "unresolved" });
    expect(c2?.source.map((s) => s.line)).toEqual(["L9", "L11"]);
    expect(cases.find((c) => c.id === "C6")).toMatchObject({ expected: "bugs", status: "resolved" });
  });

  it("writes JSONL, one parseable case per line", () => {
    const lines = toJsonl(cases).trimEnd().split("\n");
    expect(lines).toHaveLength(cases.length);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: "R1" });
  });

  it("writes promptfoo tests with equals asserts only where the label is known", () => {
    const tests = YAML.parse(toPromptfoo(report, cases)) as { description: string; vars: Record<string, unknown>; assert?: unknown[] }[];
    expect(tests).toHaveLength(cases.length);
    expect(tests[0]).toMatchObject({ vars: { mentions_refund: true }, assert: [{ type: "equals", value: "billing" }] });
    const open = tests.find((t) => t.description.startsWith("UNRESOLVED C1"));
    expect(open?.assert).toBeUndefined();
    expect(String(tests[0]?.vars.scenario)).toContain("the ticket mentions a refund: yes");
  });

  it("adds a default case when the default is used", () => {
    const m = parsePrompt("Labels: a, b\nIf X is true, label it a.\nOtherwise, label it b.");
    const r = buildReport(m, analyze(m));
    expect(buildTestCases(r).find((c) => c.id === "DEF")).toMatchObject({ expected: "b", status: "default", inputs: { x: false } });
  });
});
