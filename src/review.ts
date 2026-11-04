import { analyze, evaluate } from "./analyze.ts";
import { applyDecisions, type Decisions } from "./decisions.ts";
import { buildReport, conjunctCube, cubeCells, lineRef, witnessObject } from "./report.ts";
import type { Model, Rule } from "./types.ts";

export interface ReviewIO {
  /** Resolves to null when input has ended. */
  ask(question: string): Promise<string | null>;
  print(line: string): void;
}

function conditionText(model: Model, rule: Rule): string {
  return rule.conditions
    .map((conj) => {
      const cells = cubeCells(model, conjunctCube(model, conj));
      const parts = model.inputs.flatMap((input, i) => (cells[i] === "-" ? [] : [`${input.short}=${cells[i]}`]));
      return parts.join(" and ") || "always";
    })
    .join("  OR  ");
}

/** Ask until the answer is one of the choices. Ended input counts as "q". An empty answer picks `fallback` if given. */
async function choose(io: ReviewIO, question: string, choices: string[], fallback?: string): Promise<string> {
  for (;;) {
    const got = await io.ask(question);
    if (got === null) return "q";
    const raw = got.trim().toLowerCase();
    const answer = raw === "" && fallback ? fallback : raw;
    if (choices.includes(answer)) return answer;
    io.print(`  Please answer ${choices.join(", ")}.`);
  }
}

/**
 * Walk a human through the extracted rules, the conflicts the prompt leaves open, and the missing default.
 * Answers are recorded in the returned decisions; nothing is guessed. "q" stops and keeps what was answered.
 */
export async function review(model: Model, start: Decisions, io: ReviewIO): Promise<Decisions> {
  const d: Decisions = { ...start, promptSha256: model.promptSha256, rules: { ...start.rules }, conflicts: [...start.conflicts] };
  const pending = model.rules.filter((r) => d.rules[r.id] === undefined);
  io.print(`Reviewing ${model.rules.length} extracted rule${model.rules.length === 1 ? "" : "s"} (${pending.length} not yet confirmed).`);
  for (const rule of pending) {
    io.print("");
    io.print(`${rule.id}  ${lineRef(rule.span)}  "${rule.span.text.replace(/\s+/g, " ").trim()}"`);
    io.print(`    read as: ${rule.kind === "forbid" ? `never ${rule.label}` : rule.label} when ${conditionText(model, rule)}${rule.always ? " (always)" : ""}`);
    const a = await choose(io, "    Is this right? [y]es / [n]o, drop it / [q]uit: ", ["y", "n", "q"], "y");
    if (a === "q") return d;
    d.rules[rule.id] = a === "y" ? "accept" : "reject";
  }

  const skipped = new Set<string>();
  for (;;) {
    const applied = applyDecisions(model, d);
    const analysis = analyze(applied.model, { decisions: applied.conflicts });
    const report = buildReport(applied.model, analysis);
    const next = analysis.conflicts.find((c) => c.status === "unresolved" && !skipped.has(c.tied.join("|")));
    if (!next) break;
    io.print("");
    io.print(`Conflict: ${next.tied.join(" vs ")} (${next.count} combination${next.count === 1 ? "" : "s"}), e.g.`);
    const w = witnessObject(report.model, next.witness);
    io.print(`    ${Object.entries(w).map(([k, v]) => `${k}=${String(v)}`).join(" ")}`);
    const shown = evaluate(applied.model, next.witness, applied.conflicts).remaining;
    for (const id of shown) {
      const r = model.rules.find((x) => x.id === id);
      if (r) io.print(`    ${r.id} ${lineRef(r.span)}: "${r.span.text.replace(/\s+/g, " ").trim()}"`);
    }
    const options = next.tied.map((label, i) => `[${i + 1}] ${label}`).join(" / ");
    const a = await choose(io, `    Which label should win? ${options} / [s]kip / [q]uit: `, [...next.tied.map((_, i) => String(i + 1)), "s", "q"]);
    if (a === "q") return d;
    if (a === "s") {
      skipped.add(next.tied.join("|"));
      continue;
    }
    d.conflicts.push({ between: next.tied, winner: next.tied[Number(a) - 1] ?? "" });
  }

  const applied = applyDecisions(model, d);
  const analysis = analyze(applied.model, { decisions: applied.conflicts });
  if (analysis.gaps.length && !applied.model.default && model.labels.length) {
    const total = analysis.gaps.reduce((n, g) => n + g.count, 0);
    io.print("");
    io.print(`${total} combination${total === 1 ? "" : "s"} match no rule and the prompt has no default.`);
    const options = model.labels.map((l, i) => `[${i + 1}] ${l}`).join(" / ");
    const a = await choose(io, `    Default label? ${options} / [s]kip: `, [...model.labels.map((_, i) => String(i + 1)), "s"]);
    if (a !== "s" && a !== "q") d.default = model.labels[Number(a) - 1];
  }
  return d;
}
