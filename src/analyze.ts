import type { Atom, Input, Model, Rule } from "./types.ts";

/**
 * A human decision for one conflict. `between` and `winner` may name labels or rule ids; rule ids stand for
 * their labels. The decision applies wherever exactly these labels are still tied.
 */
export interface ConflictDecision {
  between: string[];
  winner: string;
}

export interface AnalyzeOptions {
  decisions?: ConflictDecision[];
  /** Refuse to enumerate more input combinations than this. Default 65536. */
  maxCombinations?: number;
}

/** One value per input, in model.inputs order. */
export type Assignment = string[];
/** Allowed values per input, in model.inputs order. */
export type Cube = string[][];

export type OutcomeKind = "single" | "resolved" | "default" | "unresolved" | "gap";

export interface Outcome {
  label: string | null;
  kind: OutcomeKind;
  /** Label rules whose condition holds and whose label is not forbidden here. */
  candidates: string[];
  /** Candidates still standing after priorities and human decisions. */
  remaining: string[];
  /** Forbid rules whose condition holds. */
  blockers: string[];
  by?: string;
  gapReason?: string;
}

export interface ConflictGroup {
  id: string;
  /** Every label rule that fires somewhere in this group. */
  rules: string[];
  /** Every label proposed somewhere in this group. */
  labels: string[];
  status: "unresolved" | "resolved";
  /** Unresolved: the labels still tied. Resolved: the winning label. */
  tied: string[];
  /** Rules that decide (resolved) or remain tied (unresolved) somewhere in this group. */
  remaining: string[];
  winner: string | null;
  by?: string;
  count: number;
  witness: Assignment;
  cubes: Cube[];
}

export interface GapGroup {
  id: string;
  reason: string;
  count: number;
  witness: Assignment;
  cubes: Cube[];
}

export interface RuleStats {
  id: string;
  /** Combinations where the rule's condition holds. */
  fires: number;
  /** Label rules: combinations where its label is the final answer and it is among the deciding rules. Forbid rules: combinations where it removed a candidate. */
  decides: number;
  /** Combinations where the rule is part of an unresolved tie. */
  ties: number;
}

export interface Analysis {
  combinations: number;
  conflicts: ConflictGroup[];
  gaps: GapGroup[];
  /** Combinations answered by the default label. */
  defaultCount: number;
  ruleStats: RuleStats[];
  /** Active rules that never decide or tie in any combination (label rules) or never block a label (forbid rules). */
  deadRules: string[];
  /** Decisions that matched no conflict. */
  unusedDecisions: ConflictDecision[];
}

export function atomHolds(atom: Atom, model: Model, a: Assignment): boolean {
  const idx = model.inputs.findIndex((i) => i.id === atom.input);
  const value = a[idx];
  return (value !== undefined && atom.values.includes(value)) !== atom.negated;
}

export function ruleFires(rule: Rule, model: Model, a: Assignment): boolean {
  return rule.conditions.some((conj) => conj.every((atom) => atomHolds(atom, model, a)));
}

export function activeRules(model: Model): Rule[] {
  return model.rules.filter((r) => r.status !== "rejected");
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Decide the label for one combination of inputs. */
export function evaluate(model: Model, a: Assignment, decisions: ConflictDecision[] = [], used?: Set<ConflictDecision>): Outcome {
  const rules = activeRules(model);
  const fired = rules.filter((r) => ruleFires(r, model, a));
  const blockers = fired.filter((r) => r.kind === "forbid");
  const blocked = new Set(blockers.map((r) => r.label));
  const labelRules = fired.filter((r) => r.kind === "label");
  const candidates = labelRules.filter((r) => !blocked.has(r.label));
  const base = { candidates: candidates.map((r) => r.id), blockers: blockers.map((r) => r.id) };
  if (!candidates.length) {
    const d = model.default;
    if (d && !blocked.has(d.label)) return { ...base, label: d.label, kind: "default", remaining: [] };
    const gapReason = labelRules.length
      ? "every matching rule's label is forbidden here"
      : d
        ? "no rule applies and the default label is forbidden here"
        : "no rule applies and the prompt has no default";
    return { ...base, label: null, kind: "gap", remaining: [], gapReason };
  }
  const labels = (rs: Rule[]) => [...new Set(rs.map((r) => r.label))];
  if (labels(candidates).length === 1) {
    return { ...base, label: candidates[0]?.label ?? null, kind: "single", remaining: candidates.map((r) => r.id) };
  }

  let remaining = candidates;
  const steps: string[] = [];
  const keep = (next: Rule[], why: string) => {
    if (next.length && next.length < remaining.length) {
      remaining = next;
      steps.push(why);
    }
  };
  // 1. Explicit "always" beats ordinary rules.
  const always = remaining.filter((r) => r.always);
  if (labels(remaining).length > 1) keep(always, `"always" in ${always.map((r) => r.id).join(", ")}`);
  // 2. Stated rule order, when every remaining rule is numbered.
  if (labels(remaining).length > 1 && model.ordered && remaining.every((r) => r.order !== undefined)) {
    const first = Math.min(...remaining.map((r) => r.order ?? Infinity));
    keep(remaining.filter((r) => r.order === first), "rule order");
  }
  // 3. Stated precedence between labels or numbered rules.
  if (labels(remaining).length > 1 && model.precedence.length) {
    const beaten = (r: Rule) =>
      remaining.some((o) =>
        o !== r &&
        model.precedence.some((p) =>
          (p.kind === "label" && p.winner === o.label && p.loser === r.label) ||
          (p.kind === "rule" && p.winner === o.id && p.loser === r.id),
        ),
      );
    const survivors = remaining.filter((r) => !beaten(r));
    const used = model.precedence.filter((p) =>
      remaining.some((r) => (p.kind === "label" ? r.label === p.loser : r.id === p.loser)) &&
      survivors.some((r) => (p.kind === "label" ? r.label === p.winner : r.id === p.winner)),
    );
    keep(survivors, `precedence (${used.map((p) => `${p.winner} over ${p.loser}`).join("; ")})`);
  }
  // 4. A human decision for exactly this tie.
  if (labels(remaining).length > 1) {
    const tied = labels(remaining);
    const asLabel = (x: string) => model.rules.find((r) => r.id === x)?.label ?? x;
    const decision = decisions.find((d) => sameSet([...new Set(d.between.map(asLabel))], tied));
    if (decision) {
      used?.add(decision);
      keep(remaining.filter((r) => r.label === asLabel(decision.winner)), "decisions file");
    }
  }
  const finalLabels = labels(remaining);
  if (finalLabels.length === 1) {
    return { ...base, label: finalLabels[0] ?? null, kind: "resolved", remaining: remaining.map((r) => r.id), by: steps.join(", then ") };
  }
  return { ...base, label: null, kind: "unresolved", remaining: remaining.map((r) => r.id), ...(steps.length ? { by: steps.join(", then ") } : {}) };
}

export function* assignments(inputs: Input[]): Generator<Assignment> {
  if (!inputs.length) {
    yield [];
    return;
  }
  const idx = inputs.map(() => 0);
  for (;;) {
    yield inputs.map((input, i) => input.values[idx[i] ?? 0] ?? "");
    let k = inputs.length - 1;
    while (k >= 0) {
      const input = inputs[k];
      idx[k] = (idx[k] ?? 0) + 1;
      if (input && (idx[k] ?? 0) < input.values.length) break;
      idx[k] = 0;
      k--;
    }
    if (k < 0) return;
  }
}

/** Lower is simpler: fewer true flags, earlier choice values. Used to pick readable witnesses. */
export function weight(inputs: Input[], a: Assignment): number {
  return inputs.reduce((w, input, i) => {
    const v = a[i] ?? "";
    if (input.kind === "bool") return w + (v === "true" ? 1 : 0);
    return w + Math.max(0, input.values.indexOf(v)) * 0.5;
  }, 0);
}

/** Merge combinations into cubes that differ only in one input at a time. Exact: never covers a combination outside the set. */
export function mergeCubes(inputs: Input[], points: Assignment[]): Cube[] {
  let cubes: Cube[] = points.map((p) => p.map((v) => [v]));
  let changed = true;
  while (changed) {
    changed = false;
    for (let d = 0; d < inputs.length; d++) {
      const groups = new Map<string, Cube[]>();
      for (const cube of cubes) {
        const key = cube.map((vals, i) => (i === d ? "*" : [...vals].sort().join("|"))).join("\u0000");
        const list = groups.get(key) ?? [];
        list.push(cube);
        groups.set(key, list);
      }
      const next: Cube[] = [];
      for (const list of groups.values()) {
        const first = list[0];
        if (!first) continue;
        if (list.length === 1) {
          next.push(first);
          continue;
        }
        const values = new Set<string>();
        for (const c of list) for (const v of c[d] ?? []) values.add(v);
        const order = inputs[d]?.values ?? [];
        next.push(first.map((vals, i) => (i === d ? order.filter((v) => values.has(v)) : vals)));
        changed = true;
      }
      cubes = next;
    }
  }
  return cubes;
}

interface Bucket {
  points: Assignment[];
  count: number;
  witness: Assignment;
  witnessWeight: number;
}


function addTo(map: Map<string, Bucket>, key: string, a: Assignment, w: number): void {
  const b = map.get(key);
  if (!b) {
    map.set(key, { points: [a], count: 1, witness: a, witnessWeight: w });
    return;
  }
  b.count++;
  b.points.push(a);
  if (w < b.witnessWeight) {
    b.witness = a;
    b.witnessWeight = w;
  }
}

export function combinationCount(model: Model): number {
  return model.inputs.reduce((n, i) => n * i.values.length, 1);
}

/** Enumerate every input combination and collect conflicts, gaps and per-rule statistics. */
export function analyze(model: Model, opts: AnalyzeOptions = {}): Analysis {
  const max = opts.maxCombinations ?? 65536;
  const total = combinationCount(model);
  if (total > max) {
    throw new Error(`${model.inputs.length} inputs give ${total} combinations, more than the limit of ${max}. Split the prompt or raise --max-combinations.`);
  }
  const decisions = opts.decisions ?? [];
  const used = new Set<ConflictDecision>();
  const stats = new Map(model.rules.map((r) => [r.id, { id: r.id, fires: 0, decides: 0, ties: 0 }]));
  const conflicts = new Map<string, Bucket & { outcome: Outcome; rules: Set<string>; labels: Set<string>; remaining: Set<string> }>();
  const gaps = new Map<string, Bucket>();
  let defaultCount = 0;
  const ruleById = new Map(model.rules.map((r) => [r.id, r]));

  const active = activeRules(model);
  for (const a of assignments(model.inputs)) {
    const o = evaluate(model, a, decisions, used);
    const w = weight(model.inputs, a);
    const firedLabels = new Set<string>();
    for (const r of active) {
      if (!ruleFires(r, model, a)) continue;
      (stats.get(r.id) as RuleStats).fires++;
      if (r.kind === "label") firedLabels.add(r.label);
    }
    if (o.label !== null && o.kind !== "default") for (const id of o.remaining) (stats.get(id) as RuleStats).decides++;
    for (const id of o.blockers) if (firedLabels.has(ruleById.get(id)?.label ?? "")) (stats.get(id) as RuleStats).decides++;
    if (o.kind === "default") defaultCount++;
    if (o.kind === "gap") addTo(gaps, o.gapReason ?? "", a, w);
    if (o.kind === "unresolved") for (const id of o.remaining) (stats.get(id) as RuleStats).ties++;
    if (o.kind === "resolved" || o.kind === "unresolved") {
      const labelOf = (id: string) => ruleById.get(id)?.label ?? "";
      const tied = [...new Set(o.remaining.map(labelOf))].sort();
      const key = o.kind === "unresolved" ? `unresolved:${tied.join(",")}` : `resolved:${o.label}:${o.by}`;
      let b = conflicts.get(key);
      if (!b) {
        b = { points: [], count: 0, witness: a, witnessWeight: Infinity, outcome: o, rules: new Set(), labels: new Set(), remaining: new Set() };
        conflicts.set(key, b);
      }
      for (const id of o.candidates) {
        b.rules.add(id);
        b.labels.add(labelOf(id));
      }
      for (const id of o.remaining) b.remaining.add(id);
      addTo(conflicts as Map<string, Bucket>, key, a, w);
    }
  }

  const ruleOrder = (ids: Set<string>) => model.rules.map((r) => r.id).filter((id) => ids.has(id));
  const labelOrder = (ls: Set<string>) => [...model.labels.filter((l) => ls.has(l)), ...[...ls].filter((l) => !model.labels.includes(l))];
  const conflictGroups = [...conflicts.values()]
    .sort((x, y) => Number(x.outcome.kind === "resolved") - Number(y.outcome.kind === "resolved") || y.count - x.count)
    .map((b, i): ConflictGroup => {
      const remaining = ruleOrder(b.remaining);
      const resolved = b.outcome.kind === "resolved";
      return {
        id: `C${i + 1}`,
        rules: ruleOrder(b.rules),
        labels: labelOrder(b.labels),
        status: resolved ? "resolved" : "unresolved",
        tied: resolved ? [b.outcome.label ?? ""] : labelOrder(new Set(remaining.map((id) => ruleById.get(id)?.label ?? ""))),
        remaining,
        winner: b.outcome.label,
        ...(b.outcome.by ? { by: b.outcome.by } : {}),
        count: b.count,
        witness: b.witness,
        cubes: mergeCubes(model.inputs, b.points),
      };
    });
  const gapGroups = [...gaps.entries()].map(([reason, b], i): GapGroup => ({
    id: `G${i + 1}`,
    reason,
    count: b.count,
    witness: b.witness,
    cubes: mergeCubes(model.inputs, b.points),
  }));
  const ruleStats = [...stats.values()];
  const deadRules = active
    .filter((r) => (stats.get(r.id)?.decides ?? 0) === 0 && (stats.get(r.id)?.ties ?? 0) === 0)
    .map((r) => r.id);
  return {
    combinations: total,
    conflicts: conflictGroups,
    gaps: gapGroups,
    defaultCount,
    ruleStats,
    deadRules,
    unusedDecisions: decisions.filter((d) => !used.has(d)),
  };
}
