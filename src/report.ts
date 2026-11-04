import { activeRules, assignments, ruleFires, type Analysis, type Assignment, type ConflictGroup, type Cube } from "./analyze.ts";
import type { Atom, Input, Model, Rule, Span } from "./types.ts";

export const UNRESOLVED = "?? unresolved";

export type RowKind = "rule" | "forbid" | "conflict" | "gap" | "default";

/** One line of the decision table. */
export interface Row {
  id: string;
  kind: RowKind;
  /** One cell per input: T, F, -, a value, !value, or a|b. */
  cells: string[];
  /** The label, "never <label>", or "?? unresolved". */
  outcome: string;
  unresolved: boolean;
  /** Why: priority used, labels tied, rule status. */
  note: string;
  /** Rules whose source spans explain this row. */
  rules: string[];
  spans: Span[];
}

export interface Report {
  source: string;
  model: Model;
  analysis: Analysis;
  rows: Row[];
  warnings: string[];
}

/** Values allowed by every atom on each input of one conjunction. */
export function conjunctCube(model: Model, conj: Atom[]): Cube {
  return model.inputs.map((input) => {
    let allowed = input.values;
    for (const atom of conj.filter((a) => a.input === input.id)) {
      allowed = allowed.filter((v) => atom.values.includes(v) !== atom.negated);
    }
    return allowed;
  });
}

export function cell(input: Input, allowed: string[]): string {
  if (!allowed.length) return "(none)";
  if (allowed.length === input.values.length) return "-";
  if (input.kind === "bool") return allowed[0] === "true" ? "T" : "F";
  if (allowed.length === 1) return allowed[0] ?? "";
  const missing = input.values.filter((v) => !allowed.includes(v));
  if (missing.length === 1 && input.values.length > 2) return `!${missing[0]}`;
  return allowed.join("|");
}

export function cubeCells(model: Model, cube: Cube): string[] {
  return model.inputs.map((input, i) => cell(input, cube[i] ?? input.values));
}

/** A witness as { short_name: true | false | "value" }. */
export function witnessObject(model: Model, a: Assignment): Record<string, boolean | string> {
  return Object.fromEntries(
    model.inputs.map((input, i) => {
      const v = a[i] ?? "";
      return [input.short, input.kind === "bool" ? v === "true" : v];
    }),
  );
}

export function lineRef(span: Span): string {
  return span.line === span.endLine || span.endLine === 0 ? `L${span.line}` : `L${span.line}-${span.endLine}`;
}

function ruleNote(rule: Rule, model: Model, analysis: Analysis): string {
  const parts: string[] = [];
  if (rule.always) parts.push("always");
  if (rule.order !== undefined && model.ordered) parts.push(`order ${rule.order}`);
  for (const p of model.precedence) {
    if (p.kind === "rule" && p.winner === rule.id) parts.push(`beats ${p.loser}`);
    if (p.kind === "label" && p.winner === rule.label && rule.kind === "label") parts.push(`beats ${p.loser}`);
  }
  if (rule.status === "accepted") parts.push("confirmed");
  if (analysis.deadRules.includes(rule.id)) parts.push(rule.kind === "forbid" ? "never blocks anything" : "never decides");
  return parts.join(", ");
}

/** Label rules that fire on every combination in the cube: the rules this row is really about. */
function rulesThroughout(model: Model, cube: Cube): Rule[] {
  const points = [...assignments(model.inputs.map((input, k) => ({ ...input, values: cube[k] ?? input.values })))];
  return activeRules(model).filter((r) => points.every((a) => ruleFires(r, model, a)));
}

function conflictOutcome(c: ConflictGroup, labels: string[], tiedIds: string[]): { outcome: string; note: string } {
  if (c.status === "resolved") return { outcome: c.winner ?? "", note: `${labels.join(" vs ")}: ${c.by ?? ""}` };
  const note = `${c.tied.join(" vs ")} tied (${tiedIds.join(", ")})${c.by ? `, after ${c.by}` : ""}`;
  return { outcome: UNRESOLVED, note };
}

export function buildReport(model: Model, analysis: Analysis, opts: { source?: string; warnings?: string[] } = {}): Report {
  const rows: Row[] = [];
  const spanOf = (id: string) => model.rules.find((r) => r.id === id)?.span;
  const spans = (ids: string[]) => ids.map(spanOf).filter((s): s is Span => s !== undefined);
  const suffix = (n: number, k: number) => (n > 1 ? String.fromCharCode(97 + k) : "");

  for (const rule of model.rules) {
    if (rule.status === "rejected") continue;
    rule.conditions.forEach((conj, k) => {
      rows.push({
        id: rule.id + suffix(rule.conditions.length, k),
        kind: rule.kind === "forbid" ? "forbid" : "rule",
        cells: cubeCells(model, conjunctCube(model, conj)),
        outcome: rule.kind === "forbid" ? `never ${rule.label}` : rule.label,
        unresolved: false,
        note: ruleNote(rule, model, analysis),
        rules: [rule.id],
        spans: [rule.span],
      });
    });
  }
  for (const c of analysis.conflicts) {
    c.cubes.forEach((cube, k) => {
      const throughout = rulesThroughout(model, cube);
      const labelRules = throughout.filter((x) => x.kind === "label");
      const proposed = new Set(labelRules.map((x) => x.label));
      const involved = throughout.filter((x) => x.kind === "label" || proposed.has(x.label));
      const labels = model.labels.filter((l) => proposed.has(l));
      const tiedIds = c.remaining.filter((id) => labelRules.some((x) => x.id === id));
      const { outcome, note } = conflictOutcome(c, labels.length > 1 ? labels : c.labels, tiedIds.length ? tiedIds : c.remaining);
      const extra: Span[] = [];
      if (c.by?.includes("precedence")) extra.push(...model.precedence.filter((p) => c.by?.includes(`${p.winner} over ${p.loser}`)).map((p) => p.span));
      if (c.by?.includes("rule order") && model.ordered) extra.push(model.ordered);
      const ids = involved.map((x) => x.id);
      rows.push({
        id: c.id + suffix(c.cubes.length, k),
        kind: "conflict",
        cells: cubeCells(model, cube),
        outcome,
        unresolved: c.status === "unresolved",
        note,
        rules: ids,
        spans: [...spans(ids), ...extra].sort((a, b) => a.start - b.start),
      });
    });
  }
  for (const g of analysis.gaps) {
    g.cubes.forEach((cube, k) => {
      rows.push({
        id: g.id + suffix(g.cubes.length, k),
        kind: "gap",
        cells: cubeCells(model, cube),
        outcome: UNRESOLVED,
        unresolved: true,
        note: g.reason,
        rules: [],
        spans: [],
      });
    });
  }
  if (model.default) {
    rows.push({
      id: "DEF",
      kind: "default",
      cells: model.inputs.map(() => "-"),
      outcome: model.default.label,
      unresolved: false,
      note: model.default.from === "confirmed" ? "default, confirmed in decisions file" : "when no rule applies",
      rules: [],
      spans: model.default.from === "prompt" ? [model.default.span] : [],
    });
  }
  return { source: opts.source ?? "prompt", model, analysis, rows, warnings: opts.warnings ?? [] };
}

export interface Summary {
  rules: number;
  inputs: number;
  combinations: number;
  unresolvedConflicts: number;
  resolvedConflicts: number;
  gaps: number;
  uninterpretable: number;
  deadRules: number;
}

export function summarize(r: Report): Summary {
  return {
    rules: r.model.rules.filter((x) => x.status !== "rejected").length,
    inputs: r.model.inputs.length,
    combinations: r.analysis.combinations,
    unresolvedConflicts: r.analysis.conflicts.filter((c) => c.status === "unresolved").length,
    resolvedConflicts: r.analysis.conflicts.filter((c) => c.status === "resolved").length,
    gaps: r.analysis.gaps.length,
    uninterpretable: r.model.uninterpretable.length,
    deadRules: r.analysis.deadRules.length,
  };
}

export function summaryLine(r: Report): string {
  const s = summarize(r);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [
    `${plural(s.rules, "rule")}, ${plural(s.inputs, "input")}, ${plural(s.combinations, "combination")} checked`,
    `${s.unresolvedConflicts} unresolved conflict${s.unresolvedConflicts === 1 ? "" : "s"}`,
    `${s.resolvedConflicts} resolved by the prompt${r.analysis.conflicts.some((c) => c.by?.includes("decisions file")) ? " or decisions" : ""}`,
    plural(s.gaps, "missing default"),
    `${s.uninterpretable} uninterpretable clause${s.uninterpretable === 1 ? "" : "s"}`,
    ...(s.deadRules ? [plural(s.deadRules, "dead rule")] : []),
  ].join(", ");
}

/** True when a human still has work to do: unresolved conflicts, gaps or uninterpretable clauses. */
export function hasOpenIssues(r: Report): boolean {
  const s = summarize(r);
  return s.unresolvedConflicts + s.gaps + s.uninterpretable > 0;
}
