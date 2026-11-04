import YAML from "yaml";
import { activeRules, assignments, evaluate, ruleFires, weight, type Assignment, type ConflictDecision } from "./analyze.ts";
import { lineRef, witnessObject, type Report } from "./report.ts";
import type { Model, Span } from "./types.ts";

export type CaseKind = "rule" | "forbid" | "conflict" | "gap" | "default";
export type CaseStatus = "decided" | "resolved" | "unresolved" | "default";

/** One concrete input combination with the label the decision table expects for it. */
export interface TestCase {
  id: string;
  kind: CaseKind;
  inputs: Record<string, boolean | string>;
  /** null when the table cannot say: unresolved conflict or missing default. */
  expected: string | null;
  status: CaseStatus;
  why: string;
  source: { line: string; text: string }[];
}

function src(spans: Span[]): TestCase["source"] {
  return spans.filter((s) => s.text).map((s) => ({ line: lineRef(s), text: s.text.replace(/\s+/g, " ").trim() }));
}

function statusOf(kind: string): CaseStatus {
  if (kind === "resolved") return "resolved";
  if (kind === "default") return "default";
  if (kind === "unresolved" || kind === "gap") return "unresolved";
  return "decided";
}

/** Pick the simplest combination (fewest true flags) that satisfies a predicate. */
function simplest(model: Model, pred: (a: Assignment) => boolean): Assignment | undefined {
  let best: Assignment | undefined;
  let bestW = Infinity;
  for (const a of assignments(model.inputs)) {
    if (!pred(a)) continue;
    const w = weight(model.inputs, a);
    if (w < bestW) {
      best = a;
      bestW = w;
    }
  }
  return best;
}

/**
 * Build one witness per rule, conflict, gap and default. A rule's witness is the simplest combination where
 * that rule decides the label on its own; when it never does, the simplest one where it fires.
 */
export function buildTestCases(r: Report, decisions: ConflictDecision[] = []): TestCase[] {
  const { model, analysis } = r;
  const cases: TestCase[] = [];
  const out = (id: string, kind: CaseKind, a: Assignment, why: string, spans: Span[]) => {
    const o = evaluate(model, a, decisions);
    cases.push({ id, kind, inputs: witnessObject(model, a), expected: o.label, status: statusOf(o.kind), why, source: src(spans) });
  };
  for (const rule of activeRules(model)) {
    if (rule.kind === "label") {
      const alone = simplest(model, (a) => {
        const o = evaluate(model, a, decisions);
        return o.kind === "single" && o.candidates.length === 1 && o.candidates[0] === rule.id;
      });
      const decides = alone ?? simplest(model, (a) => evaluate(model, a, decisions).remaining.includes(rule.id));
      const fires = decides ?? simplest(model, (a) => ruleFires(rule, model, a));
      if (!fires) continue;
      const why = alone ? `${rule.id} applies on its own` : decides ? `${rule.id} applies together with other rules` : `${rule.id} applies but never decides the label`;
      out(rule.id, "rule", fires, why, [rule.span]);
    } else {
      const blocks = simplest(model, (a) => evaluate(model, a, decisions).blockers.includes(rule.id) && activeRules(model).some((x) => x.kind === "label" && x.label === rule.label && ruleFires(x, model, a)));
      const fires = blocks ?? simplest(model, (a) => ruleFires(rule, model, a));
      if (!fires) continue;
      out(rule.id, "forbid", fires, blocks ? `${rule.id} removes ${rule.label} here` : `${rule.id} applies (nothing to block)`, [rule.span]);
    }
  }
  const spanOf = (id: string) => model.rules.find((x) => x.id === id)?.span;
  for (const c of analysis.conflicts) {
    const o = evaluate(model, c.witness, decisions);
    const ruleOf = (id: string) => model.rules.find((x) => x.id === id);
    const labels = model.labels.filter((l) => o.candidates.some((id) => ruleOf(id)?.label === l));
    const why = c.status === "resolved"
      ? `${labels.join(" vs ")}; ${c.winner} wins by ${c.by ?? ""}`
      : `${c.tied.join(" vs ")} tied${c.by ? ` after ${c.by}` : ""}; the prompt does not say which wins`;
    const relevant = o.blockers.filter((id) => activeRules(model).some((x) => x.kind === "label" && x.label === ruleOf(id)?.label && ruleFires(x, model, c.witness)));
    const spans = [...o.candidates, ...relevant].map(spanOf).filter((s): s is Span => s !== undefined).sort((x, y) => x.start - y.start);
    out(c.id, "conflict", c.witness, why, spans);
  }
  for (const g of analysis.gaps) out(g.id, "gap", g.witness, g.reason, []);
  if (model.default && analysis.defaultCount > 0) {
    const a = simplest(model, (x) => evaluate(model, x, decisions).kind === "default");
    if (a) out("DEF", "default", a, "no rule applies, so the default label is used", model.default.from === "prompt" ? [model.default.span] : []);
  }
  return cases;
}

export function toJsonl(cases: TestCase[]): string {
  return cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : "");
}

/** Plain-language description of a combination, usable as a var when generating test inputs. */
export function scenario(model: Model, inputs: Record<string, boolean | string>): string {
  return model.inputs
    .map((i) => {
      const v = inputs[i.short];
      return i.kind === "bool" ? `${i.name}: ${v ? "yes" : "no"}` : `${i.name}: ${String(v)}`;
    })
    .join("; ");
}

/**
 * promptfoo-style test list. vars hold the input values (and a plain-language scenario); cases with a
 * known label get an `equals` assertion, unresolved ones get none and are marked in metadata.
 */
export function toPromptfoo(r: Report, cases: TestCase[]): string {
  const tests = cases.map((c) => {
    const first = c.source[0]?.text;
    const description = `${c.status === "unresolved" ? "UNRESOLVED " : ""}${c.id}: ${first && c.kind !== "conflict" ? first : c.why}`;
    return {
      description,
      vars: { ...c.inputs, scenario: scenario(r.model, c.inputs) },
      ...(c.expected !== null ? { assert: [{ type: "equals", value: c.expected }] } : {}),
      metadata: { kind: c.kind, status: c.status, why: c.why },
    };
  });
  const header = [
    `# Generated by prompt-decompiler from ${r.source} (prompt sha256 ${r.model.promptSha256.slice(0, 12)}).`,
    "# vars are the decision-table inputs, not raw text: write your test inputs (or a template) from them.",
    "# Cases marked UNRESOLVED have no assertion because the prompt does not decide them.",
  ].join("\n");
  return `${header}\n${YAML.stringify(tests, { lineWidth: 0 })}`;
}
