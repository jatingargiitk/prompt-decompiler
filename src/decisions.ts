import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { ConflictDecision } from "./analyze.ts";
import type { Model, RuleStatus } from "./types.ts";

/** What a human confirmed about one prompt: which rules are right, who wins each conflict, and a fallback label. */
export interface Decisions {
  promptSha256?: string;
  rules: Record<string, "accept" | "reject">;
  conflicts: ConflictDecision[];
  default?: string;
}

export function emptyDecisions(model?: Model): Decisions {
  return { ...(model ? { promptSha256: model.promptSha256 } : {}), rules: {}, conflicts: [] };
}

function fail(source: string, msg: string): never {
  throw new Error(`${source}: ${msg}`);
}

/** Parse a decisions file (YAML or JSON; JSON is valid YAML). */
export function parseDecisions(text: string, source = "decisions"): Decisions {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    fail(source, `not valid YAML or JSON (${(err as Error).message})`);
  }
  if (raw === null || raw === undefined) return emptyDecisions();
  if (typeof raw !== "object" || Array.isArray(raw)) fail(source, "expected a mapping at the top level");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["prompt_sha256", "rules", "conflicts", "default"].includes(key)) fail(source, `unknown key "${key}"`);
  }
  const out = emptyDecisions();
  if (obj.prompt_sha256 !== undefined) {
    if (typeof obj.prompt_sha256 !== "string") fail(source, "prompt_sha256 must be a string");
    out.promptSha256 = obj.prompt_sha256;
  }
  if (obj.rules !== undefined && obj.rules !== null) {
    if (typeof obj.rules !== "object" || Array.isArray(obj.rules)) fail(source, "rules must map rule ids to accept or reject");
    for (const [id, v] of Object.entries(obj.rules as Record<string, unknown>)) {
      if (v !== "accept" && v !== "reject") fail(source, `rules.${id} must be "accept" or "reject", got ${JSON.stringify(v)}`);
      out.rules[id] = v;
    }
  }
  if (obj.conflicts !== undefined && obj.conflicts !== null) {
    if (!Array.isArray(obj.conflicts)) fail(source, "conflicts must be a list");
    obj.conflicts.forEach((c: unknown, i: number) => {
      const entry = c as Record<string, unknown> | null;
      const between = entry?.between;
      const winner = entry?.winner;
      if (!Array.isArray(between) || between.length < 2 || !between.every((x) => typeof x === "string")) {
        fail(source, `conflicts[${i}].between must list at least two labels or rule ids`);
      }
      if (typeof winner !== "string") fail(source, `conflicts[${i}].winner must be a label or rule id`);
      out.conflicts.push({ between: between as string[], winner });
    });
  }
  if (obj.default !== undefined && obj.default !== null) {
    if (typeof obj.default !== "string") fail(source, "default must be a label");
    out.default = obj.default;
  }
  return out;
}

export function loadDecisions(path: string): Decisions {
  return parseDecisions(readFileSync(path, "utf8"), path);
}

/** Write decisions as YAML with the prompt hash first, so the file stays tied to the prompt it was made for. */
export function serializeDecisions(d: Decisions): string {
  const q = (v: string) => YAML.stringify(v).trimEnd();
  const lines = ["# prompt-decompiler decisions. Edit by hand or with `prompt-decompiler review`."];
  if (d.promptSha256) lines.push(`prompt_sha256: ${q(d.promptSha256)}`);
  const rules = Object.entries(d.rules);
  lines.push(rules.length ? "rules:" : "rules: {}");
  for (const [id, mark] of rules) lines.push(`  ${q(id)}: ${mark}`);
  lines.push(d.conflicts.length ? "conflicts:" : "conflicts: []");
  for (const c of d.conflicts) {
    lines.push(`  - between: [${c.between.map(q).join(", ")}]`, `    winner: ${q(c.winner)}`);
  }
  if (d.default) lines.push(`default: ${q(d.default)}`);
  return lines.join("\n") + "\n";
}

export interface Applied {
  model: Model;
  conflicts: ConflictDecision[];
  warnings: string[];
}

/** Apply rule accept/reject marks and the default; validate conflict decisions against the model. */
export function applyDecisions(model: Model, d: Decisions): Applied {
  const warnings: string[] = [];
  if (d.promptSha256 && d.promptSha256 !== model.promptSha256) {
    warnings.push("The decisions file was made for a different version of this prompt (prompt_sha256 differs). Rule ids may now point at other sentences; check them.");
  }
  const ids = new Set(model.rules.map((r) => r.id));
  for (const id of Object.keys(d.rules)) if (!ids.has(id)) warnings.push(`Decision for unknown rule ${id} ignored.`);
  const rules = model.rules.map((r) => {
    const mark = d.rules[r.id];
    const status: RuleStatus = mark === "accept" ? "accepted" : mark === "reject" ? "rejected" : r.status;
    return { ...r, status };
  });
  const known = (x: string) => ids.has(x) || model.labels.includes(x);
  const conflicts: ConflictDecision[] = [];
  for (const c of d.conflicts) {
    const bad = [...c.between, c.winner].filter((x) => !known(x));
    if (bad.length) {
      warnings.push(`Conflict decision between ${c.between.join(", ")} names unknown ${bad.join(", ")}; ignored.`);
      continue;
    }
    const labelOf = (x: string) => model.rules.find((r) => r.id === x)?.label ?? x;
    if (!c.between.map(labelOf).includes(labelOf(c.winner))) {
      warnings.push(`Conflict decision between ${c.between.join(", ")} picks ${c.winner}, which is not one of them; ignored.`);
      continue;
    }
    conflicts.push(c);
  }
  let def = model.default;
  if (d.default !== undefined) {
    if (!model.labels.includes(d.default)) warnings.push(`Default label "${d.default}" is not a label of this prompt; ignored.`);
    else if (model.default && model.default.label !== d.default) {
      warnings.push(`The prompt already sets the default to "${model.default.label}"; the decisions file's "${d.default}" is ignored.`);
    } else if (!model.default) {
      def = { label: d.default, from: "confirmed", span: { start: 0, end: 0, line: 0, col: 0, endLine: 0, endCol: 0, text: "" } };
    }
  }
  return { model: { ...model, rules, default: def }, conflicts, warnings };
}
