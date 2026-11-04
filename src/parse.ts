import { createHash } from "node:crypto";
import { segment } from "./segment.ts";
import { canonical, contentWords, escapeRegExp, expandContractions, stripQuotes } from "./text.ts";
import type { Atom, Clause, Finding, Input, Model, Precedence, Rule, Span } from "./types.ts";

/* ---------------------------------------------------------------- conditions */

/** An atom before inputs are known. `subject` + `values` marks a possible fixed-choice test ("plan is pro"). */
export interface RawAtom {
  phrase: string;
  negated: boolean;
  subject?: string;
  values?: string[];
}

export type RawCondition = RawAtom[][];

interface Failure {
  error: string;
}

const BOOL_WORDS = new Set(["true", "false", "yes", "no"]);
const VALUE_SEP = /\s*(?:,\s*or\s+|,\s*and\s+|,|\||\s+or\s+|\/)\s*/i;

function isFailure(x: unknown): x is Failure {
  return typeof x === "object" && x !== null && "error" in x;
}

export function parseValueList(s: string): string[] | null {
  const parts = s
    .split(VALUE_SEP)
    .map((p) => stripQuotes(p.trim()))
    .filter(Boolean);
  if (!parts.length || !parts.every((p) => /^[\w-]+$/.test(p))) return null;
  return parts.map((p) => p.toLowerCase());
}

export function parseAtom(raw: string): RawAtom | Failure {
  const p = expandContractions(raw)
    .trim()
    .replace(/^(?:both|either)\s+/i, "")
    .replace(/[.;:,]+$/, "");
  if (!p) return { error: "empty condition" };
  const m = /^(.+?)\s+(?:is|are|equals)\s+(not\s+)?(?:one of\s*:?\s*|any of\s*:?\s*|either\s+)?(.+)$/i.exec(p);
  if (m) {
    const subject = (m[1] ?? "").trim();
    const negated = Boolean(m[2]);
    const values = parseValueList(m[3] ?? "");
    if (values) {
      const [only] = values;
      if (values.length === 1 && only !== undefined && BOOL_WORDS.has(only)) {
        const truthy = only === "true" || only === "yes";
        return { phrase: subject, negated: negated === truthy };
      }
      return { phrase: p, negated, subject, values };
    }
  }
  let negated = false;
  const kept: string[] = [];
  for (const token of p.split(/\s+/)) {
    const t = token.toLowerCase();
    if (t === "not" || t === "no" || t === "never") {
      negated = !negated;
      const prev = kept[kept.length - 1];
      if (prev && /^(does|do|did)$/i.test(prev)) kept.pop();
      continue;
    }
    kept.push(token);
  }
  if (!kept.length) return { error: `condition "${raw.trim()}" has no content` };
  return { phrase: kept.join(" "), negated };
}

/** Rewrite "one of a, b or c" so its separators cannot be mistaken for and/or between conditions. */
function protectValueLists(c: string): string {
  const item = "[`\"']?[\\w-]+[`\"']?";
  const re = new RegExp(`\\b(one of|any of)\\s*:?\\s*(${item}(?:\\s*(?:,\\s*or\\s+|,|\\s+or\\s+|\\/)\\s*${item})*)`, "gi");
  return c.replace(re, (_m, kw: string, list: string) => `${kw} ${list.split(VALUE_SEP).join("|")}`);
}

function splitDisjuncts(c: string): string[] {
  const merged: string[] = [];
  for (const chunk of c.split(/\s+or\s+/i)) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && /^[`"']?[\w-]+[`"']?$/.test(chunk.trim()) && /\b(?:is|are)\s+(?:not\s+)?[\w|`"'-]+$/i.test(prev)) {
      merged[merged.length - 1] = `${prev}|${stripQuotes(chunk.trim())}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

export interface ConditionOptions {
  /** Extra condition that must NOT hold ("... unless X"). */
  unless?: string;
  /** Noun to put in front of each atom ("tickets that A and B" -> "tickets A", "tickets B"). */
  subject?: string;
}

export function parseCondition(text: string, opts: ConditionOptions = {}): RawCondition | Failure {
  let c = protectValueLists(text.trim().replace(/[.;:]+$/, ""));
  if (/[()]/.test(c)) return { error: "parenthesized or nested condition" };
  let unless = opts.unless;
  const parts = c.split(/\s+unless\s+/i);
  if (parts.length > 2) return { error: "more than one 'unless' in one condition" };
  if (parts.length === 2) {
    if (unless !== undefined) return { error: "more than one 'unless' in one condition" };
    c = parts[0] ?? "";
    unless = parts[1];
  }
  c = c.replace(/,\s*(and|or)\s+/gi, " $1 ");
  if (c.includes(",")) return { error: "comma-separated condition list; write it with 'and' or 'or'" };
  const conj = c.trim() ? splitDisjuncts(c).map((d) => d.split(/\s+and\s+/i)) : [[]];
  if (conj.length > 1 && conj.some((x) => x.length > 1)) {
    return { error: "condition mixes 'and' with 'or', so the grouping is ambiguous and is not guessed" };
  }
  const withSubject = (s: string) => (opts.subject ? `${opts.subject} ${s.trim()}` : s);
  const out: RawCondition = [];
  for (const conjunct of conj) {
    const atoms: RawAtom[] = [];
    for (const piece of conjunct) {
      const atom = parseAtom(withSubject(piece));
      if (isFailure(atom)) return atom;
      atoms.push(atom);
    }
    out.push(atoms);
  }
  if (unless !== undefined) {
    const u = protectValueLists(unless.trim().replace(/[.;:]+$/, ""));
    if (/\s+and\s+/i.test(u) || u.includes(",")) return { error: "'unless A and B' is not supported; split it into separate rules" };
    for (const piece of splitDisjuncts(u)) {
      const atom = parseAtom(withSubject(piece));
      if (isFailure(atom)) return atom;
      for (const atoms of out) atoms.push({ ...atom, negated: !atom.negated });
    }
  }
  if (out.every((a) => a.length === 0)) return { error: "no condition found" };
  return out;
}

/* ---------------------------------------------------------------- consequents */

export interface Consequent {
  label: string;
  forbid: boolean;
  always: boolean;
}

const ACTION = /\b(route|routed|label|labeled|labelled|classify|classified|categorize|categorise|tag|tagged|mark|marked|send|sent|assign|assigned|return|respond|reply|answer|output|choose|pick|use|set|go|goes|belong|belongs|is|be)\b/i;
const FORBID = /\b(never|not|don't|do not|must not|should not|shouldn't|cannot|can't|avoid)\b/i;
const ALWAYS = /\b(always|regardless|no matter what|in every case|in all cases)\b/i;

function findLabels(q: string, labels: string[] | null): { found: string[]; unknown: string[] } {
  const found: string[] = [];
  const unknown: string[] = [];
  const add = (l: string) => {
    if (!found.includes(l)) found.push(l);
  };
  const ticks = [...q.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").trim());
  if (labels) {
    const byLower = new Map(labels.map((l) => [l.toLowerCase(), l]));
    for (const t of ticks) {
      const hit = byLower.get(t.toLowerCase());
      if (hit) add(hit);
      else unknown.push(t);
    }
    const plain = q.replace(/`[^`]*`/g, " ");
    for (const l of labels) {
      if (new RegExp(`(^|[^\\w-])${escapeRegExp(l)}([^\\w-]|$)`, "i").test(plain)) add(l);
    }
  } else {
    for (const t of ticks) if (/^[\w-]+$/.test(t)) add(t);
    if (!found.length) {
      const m = /\b(?:route|label|classify|categorize|tag|mark|send|assign|return|output|answer)\b(?:\s+(?:it|this|them|the\s+\w+))?\s+(?:as|to|into|with)\s+["']?([\w-]+)/i.exec(q);
      if (m?.[1] && !/^(the|a|an)$/i.test(m[1])) add(m[1]);
    }
  }
  return { found, unknown };
}

export function readConsequent(q: string, labels: string[] | null): Consequent | Failure {
  const text = expandContractions(q.trim());
  const { found, unknown } = findLabels(text, labels);
  if (!found.length) {
    if (unknown.length) return { error: `\`${unknown[0]}\` is not one of the declared labels` };
    return { error: "no label in the action part" };
  }
  if (found.length > 1) return { error: `more than one label in one action (${found.join(", ")})` };
  const label = found[0] ?? "";
  if (!ACTION.test(text) && !/^[`"']?[\w-]+[`"']?$/.test(text)) return { error: "no action wording around the label" };
  return { label, forbid: FORBID.test(text), always: ALWAYS.test(text) };
}

/* ---------------------------------------------------------------- clauses */

export type ParsedClause =
  | { kind: "rule"; condition: RawCondition; consequent: Consequent }
  | { kind: "default"; label: string }
  | { kind: "precedence"; winner: string; loser: string }
  | { kind: "order" }
  | { kind: "uninterpretable"; reason: string }
  | { kind: "ignored"; reason: string };

const ORDER = /\b(?:apply|check|evaluate|follow|read)\s+(?:the\s+|these\s+)?rules\s+(?:in\s+order|from\s+top\s+to\s+bottom|in\s+the\s+order\s+(?:given|listed|shown))|\bfirst\s+(?:matching\s+rule|rule\s+that\s+matches|match)\s+wins\b|\bearlier\s+rules\s+(?:win|take\s+precedence|override)/i;
const PRECEDENCE = [
  /^(.+?)\s+(?:takes?|has|have|gets?)\s+(?:precedence|priority)\s+over\s+(.+)$/i,
  /^(.+?)\s+(?:overrides?|wins?\s+over|beats?|outranks?|trumps?)\s+(.+)$/i,
  /^prefer\s+(.+?)\s+over\s+(.+)$/i,
];
const DEFAULTS = [
  /^(?:otherwise|else|in all other cases|in any other case|for (?:anything|everything|all) else|if (?:none|nothing) (?:of the above |of these |else )?(?:applies|apply|matches|match)|if no (?:other )?rules? (?:applies|apply|matches|match)|by default)\s*[,:]?\s*(.+)$/i,
  /^(?:default to|fall ?back to)\s+(.+)$/i,
  /^(?:the\s+)?default\s*(?:label|category|class|queue|tag|answer|route)?\s+(?:is|should be)\s+(.+)$/i,
  /^(?:everything|anything) else\s+(.+)$/i,
];
const TRIGGER = /\b(if|when|whenever|unless|always|never|should|must|otherwise|route|routed|label|labeled|labelled|classify|classified|categorize|categorise|tag|tagged|precedence|priority|default|escalate)\b/i;
const FORMAT_ONLY = /^(?:reply|respond|answer|output|return|print|write)\b.*\b(?:only|exactly|just|single)\b/i;
const VERB_BOUNDARY = /\s+(?=(?:always\s+|never\s+|then\s+|do not\s+|don't\s+)?(?:route|label|classify|categorize|tag|mark|send|assign|return|respond|reply|answer|output|choose|pick|use)\b)/i;

function tryConditional(rest: string, labels: string[] | null, condOpts: ConditionOptions = {}): ParsedClause | null {
  const splits: Array<[string, string]> = [];
  const then = /\s+then\s+/i.exec(rest);
  if (then) splits.push([rest.slice(0, then.index), rest.slice(then.index + then[0].length)]);
  for (let i = rest.indexOf(","); i !== -1; i = rest.indexOf(",", i + 1)) splits.push([rest.slice(0, i), rest.slice(i + 1)]);
  const verb = VERB_BOUNDARY.exec(rest);
  if (verb) splits.push([rest.slice(0, verb.index), rest.slice(verb.index)]);
  let firstError: string | null = null;
  for (const [c, q] of splits) {
    const consequent = readConsequent(q.replace(/^\s*then\s+/i, ""), labels);
    if (isFailure(consequent)) {
      firstError ??= consequent.error;
      continue;
    }
    const condition = parseCondition(c, condOpts);
    if (isFailure(condition)) return { kind: "uninterpretable", reason: condition.error };
    return { kind: "rule", condition, consequent };
  }
  return firstError ? { kind: "uninterpretable", reason: firstError } : null;
}

export function parseClause(clause: Pick<Clause, "text" | "isHeading">, labels: string[] | null): ParsedClause {
  if (clause.isHeading) return { kind: "ignored", reason: "heading" };
  const t = clause.text.replace(/[.;!]+$/, "").trim();
  if (ORDER.test(t)) return { kind: "order" };
  for (const re of PRECEDENCE) {
    const m = re.exec(t);
    if (m) return { kind: "precedence", winner: (m[1] ?? "").trim(), loser: (m[2] ?? "").trim() };
  }
  for (const re of DEFAULTS) {
    const m = re.exec(t);
    if (!m) continue;
    const q = readConsequent(m[1] ?? "", labels);
    if (isFailure(q)) return { kind: "uninterpretable", reason: `default: ${q.error}` };
    if (q.forbid) return { kind: "uninterpretable", reason: "a default that forbids a label is not supported" };
    return { kind: "default", label: q.label };
  }
  const a = /^(?:if|when|whenever|in case)\s+(.+)$/i.exec(t);
  if (a) {
    return tryConditional(a[1] ?? "", labels) ?? { kind: "uninterpretable", reason: "could not find where the condition ends and the action starts" };
  }
  const b = /^(.+?)\s+(if|when|whenever|unless)\s+(.+)$/i.exec(t);
  if (b) {
    const consequent = readConsequent(b[1] ?? "", labels);
    if (!isFailure(consequent)) {
      const isUnless = (b[2] ?? "").toLowerCase() === "unless";
      const condition = isUnless ? parseCondition("", { unless: b[3] ?? "" }) : parseCondition(b[3] ?? "");
      if (isFailure(condition)) return { kind: "uninterpretable", reason: condition.error };
      return { kind: "rule", condition, consequent };
    }
  }
  const c = /^(?:any|all|every|each)?\s*([\w'-]+(?:\s+[\w'-]+)?)\s+(that|which|who|where|with)\s+(.+?)\s+(should|must|always|never|go|goes|get|gets|belong|belongs|need|needs|will)\b(.*)$/i.exec(t);
  if (c) {
    const subject = c[1] ?? "";
    const rel = (c[2] ?? "").toLowerCase();
    const consequent = readConsequent(`${c[4] ?? ""}${c[5] ?? ""}`, labels);
    if (isFailure(consequent)) return { kind: "uninterpretable", reason: consequent.error };
    const condition = parseCondition(c[3] ?? "", { subject: rel === "with" ? `${subject} with` : subject });
    if (isFailure(condition)) return { kind: "uninterpretable", reason: condition.error };
    return { kind: "rule", condition, consequent };
  }
  if (FORMAT_ONLY.test(t) && !/\b(if|when|unless)\b/i.test(t)) return { kind: "ignored", reason: "output-format instruction" };
  const trigger = TRIGGER.exec(t);
  if (trigger) return { kind: "uninterpretable", reason: `uses rule wording ("${trigger[0]}") but matches no supported rule pattern` };
  return { kind: "ignored", reason: "no rule wording" };
}

/* ---------------------------------------------------------------- declarations */

const LABEL_DECL = [
  /^(?:the\s+)?(?:possible\s+|valid\s+|allowed\s+|available\s+|output\s+)?(?:labels?|categories|category|classes|queues|tags|intents|buckets|routes|destinations)\s*(?:are|is)?\s*:\s*(.*)$/i,
  /^(?:the\s+)?(?:possible\s+|valid\s+|allowed\s+|available\s+|output\s+)?(?:labels|categories|classes|queues|tags|intents|buckets|routes|destinations)\s+are\s+(.+)$/i,
  /\b(?:reply|respond|answer|output|return|classify|label|categorize|categorise|route|choose|pick|assign|tag)\b.*?\b(?:exactly\s+)?(?:one|any) of(?:\s+(?:the following|these|the))?(?:\s+\w+)?\s*:\s*(.*)$/i,
  /\b(?:reply|respond|answer|output|return|classify|label|categorize|categorise|route|choose|pick|assign|tag)\b.*?\b(?:exactly\s+)?one of\s+((?:`[^`]+`[\s,]*(?:or\s+|and\s+)?)+)$/i,
];
const CHOICE_DECL = /^(?:the\s+)?(.+?)\s+(?:is|will be|can be|must be)\s+(?:always\s+)?(?:exactly\s+)?one of\s*:?\s*(.+)$/i;

function readLabelList(s: string): string[] | null {
  const ticks = [...s.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
  if (ticks.length) return ticks;
  const parts = s
    .replace(/[.;]+$/, "")
    .split(/\s*(?:,\s*or\s+|,\s*and\s+|,|\||\s+or\s+|\s+and\s+|\/)\s*/i)
    .map((p) => stripQuotes(p.trim()))
    .filter(Boolean);
  if (!parts.length || !parts.every((p) => /^[\w-]+$/.test(p))) return null;
  return parts;
}

function itemLabel(text: string): { label: string; description: string } | null {
  const tick = /^`([^`]+)`\s*[:\-–—]?\s*(.*)$/.exec(text);
  if (tick) return { label: (tick[1] ?? "").trim(), description: (tick[2] ?? "").trim() };
  const plain = /^["']?([\w-]+)["']?\s*(?:[:\-–—]\s*(.*))?$/.exec(text.replace(/[.;]+$/, ""));
  if (plain) return { label: plain[1] ?? "", description: (plain[2] ?? "").trim() };
  return null;
}

/* ---------------------------------------------------------------- model building */

const ACTION_VERBS = /\b(reply|respond|answer|output|return|classify|label|categorize|route|choose|pick|assign|tag)\b/i;

function finding(span: Span, reason: string): Finding {
  return { span, reason };
}

function shortNames(inputs: Input[], subjects: Map<string, string>): void {
  const boolWords = inputs.filter((i) => i.kind === "bool").map((i) => contentWords(i.name));
  const leadCounts = new Map<string, number>();
  for (const w of boolWords) if (w[0]) leadCounts.set(w[0], (leadCounts.get(w[0]) ?? 0) + 1);
  const used = new Set<string>();
  for (const input of inputs) {
    let ws = input.kind === "choice" ? contentWords(subjects.get(input.id) ?? input.name) : contentWords(input.name);
    if (input.kind === "bool" && ws.length > 1 && (leadCounts.get(ws[0] ?? "") ?? 0) >= 2) ws = ws.slice(1);
    // Up to three words, cut at a word boundary so names stay readable.
    let base = "";
    for (const w of ws.slice(0, 3)) {
      const next = base ? `${base}_${w}` : w;
      if (base && next.length > 22) break;
      base = next;
    }
    base ||= input.id;
    if (used.has(base)) {
      let n = 2;
      while (used.has(`${base}_${n}`)) n++;
      base = `${base}_${n}`;
    }
    used.add(base);
    input.short = base;
  }
}

/** Parse a classifier prompt into a model of labels, inputs and rules. Pure and deterministic. */
export function parsePrompt(text: string): Model {
  const clauses = segment(text);
  const consumed = new Set<number>();
  const uninterpretable: Finding[] = [];
  const ignored: Finding[] = [];
  const notes: string[] = [];

  // Pass 1: label lists and fixed-choice declarations.
  let labels: string[] | null = null;
  const declaredChoices: Array<{ subject: string; values: string[]; span: Span }> = [];
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (!clause || clause.isHeading) continue;
    const t = clause.text.replace(/[.;]+$/, "");
    if (!labels && !/^(?:if|when)\b/i.test(t)) {
      for (const re of LABEL_DECL) {
        const m = re.exec(t);
        if (!m) continue;
        const rest = (m[1] ?? "").trim();
        if (rest) {
          const list = readLabelList(rest);
          if (!list) continue;
          labels = list;
          consumed.add(i);
        } else {
          // "Labels:" followed by a bulleted list.
          const found: string[] = [];
          let j = i + 1;
          for (; j < clauses.length; j++) {
            const item = clauses[j];
            if (!item?.isListItem) break;
            consumed.add(j);
            if (!item.itemStart) continue;
            const parsed = itemLabel(item.text);
            if (!parsed) {
              uninterpretable.push(finding(item.span, "label list item without a readable label name"));
              continue;
            }
            found.push(parsed.label);
            if (parsed.description) {
              uninterpretable.push(finding(item.span, "label description, not an if/then rule, so it is not in the table"));
            }
          }
          if (found.length) {
            labels = found;
            consumed.add(i);
          }
        }
        break;
      }
      if (consumed.has(i)) continue;
    }
    const choice = CHOICE_DECL.exec(t);
    if (choice && !/^(?:if|when|unless)\b/i.test(t) && !ACTION_VERBS.test(choice[1] ?? "")) {
      const values = parseValueList(choice[2] ?? "");
      if (values && values.length >= 2) {
        declaredChoices.push({ subject: (choice[1] ?? "").trim(), values, span: clause.span });
        consumed.add(i);
      }
    }
  }
  const labelsDeclared = labels !== null;

  // Pass 2: read every remaining clause.
  interface RawRule {
    clause: Clause;
    condition: RawCondition;
    consequent: Consequent;
  }
  const rawRules: RawRule[] = [];
  const rawPrecedence: Array<{ clause: Clause; winner: string; loser: string }> = [];
  let defaultRule: Model["default"] = null;
  let ordered: Span | null = null;
  clauses.forEach((clause, i) => {
    if (consumed.has(i)) return;
    const parsed = parseClause(clause, labels);
    switch (parsed.kind) {
      case "rule":
        rawRules.push({ clause, condition: parsed.condition, consequent: parsed.consequent });
        break;
      case "default":
        if (!defaultRule) defaultRule = { label: parsed.label, span: clause.span, from: "prompt" };
        else if (defaultRule.label !== parsed.label) {
          uninterpretable.push(finding(clause.span, `second default (\`${parsed.label}\`) disagrees with the first (\`${defaultRule.label}\`, line ${defaultRule.span.line})`));
        }
        break;
      case "precedence":
        rawPrecedence.push({ clause, winner: parsed.winner, loser: parsed.loser });
        break;
      case "order":
        ordered ??= clause.span;
        break;
      case "uninterpretable":
        uninterpretable.push(finding(clause.span, parsed.reason));
        break;
      case "ignored":
        ignored.push(finding(clause.span, parsed.reason));
        break;
    }
  });

  if (!labels) {
    labels = [];
    for (const r of rawRules) if (!labels.includes(r.consequent.label)) labels.push(r.consequent.label);
    const d = defaultRule as Model["default"];
    if (d && !labels.includes(d.label)) labels.push(d.label);
    if (labels.length) notes.push("No label list found in the prompt; labels were taken from the rules.");
  }

  // Pass 3: inputs. A subject tested against two or more values (or declared with "one of") is a fixed choice.
  const inputs: Input[] = [];
  const subjects = new Map<string, string>();
  const choiceByKey = new Map<string, Input>();
  const boolByKey = new Map<string, Input>();
  const newId = () => `i${inputs.length + 1}`;
  const subjectValues = new Map<string, Set<string>>();
  for (const r of rawRules) {
    for (const atoms of r.condition) {
      for (const a of atoms) {
        if (!a.subject || !a.values) continue;
        const key = canonical(a.subject);
        const set = subjectValues.get(key) ?? new Set<string>();
        a.values.forEach((v) => set.add(v));
        subjectValues.set(key, set);
      }
    }
  }
  for (const d of declaredChoices) {
    const key = canonical(d.subject);
    const input: Input = { id: newId(), name: d.subject, short: "", kind: "choice", values: [...d.values], declared: true, span: d.span };
    subjects.set(input.id, d.subject);
    inputs.push(input);
    choiceByKey.set(key, input);
  }
  const resolveAtom = (a: RawAtom, span: Span): Atom[] | Failure => {
    if (a.subject && a.values) {
      const key = canonical(a.subject);
      const isChoice = choiceByKey.has(key) || (subjectValues.get(key)?.size ?? 0) >= 2;
      if (isChoice) {
        let input = choiceByKey.get(key);
        if (!input) {
          input = { id: newId(), name: a.subject, short: "", kind: "choice", values: [...(subjectValues.get(key) ?? [])], declared: false, span };
          subjects.set(input.id, a.subject);
          inputs.push(input);
          choiceByKey.set(key, input);
        }
        for (const v of a.values) {
          if (!input.values.includes(v)) {
            input.values.push(v);
            if (input.declared) notes.push(`"${v}" is used for ${input.name} (line ${span.line}) but is not in its declared list; added it.`);
          }
        }
        return [{ input: input.id, values: [...a.values], negated: a.negated }];
      }
      const value = a.values[0] ?? "";
      return resolveAtom({ phrase: `${a.subject} is ${value}`, negated: a.negated }, span);
    }
    const key = canonical(a.phrase);
    let input = boolByKey.get(key);
    if (!input) {
      input = { id: newId(), name: a.phrase.replace(/^the\s+/i, "the ").replace(/^[A-Z](?=[a-z])/, (ch) => ch.toLowerCase()), short: "", kind: "bool", values: ["true", "false"], declared: false, span };
      inputs.push(input);
      boolByKey.set(key, input);
    } else if (!a.negated && input.span.start > span.start) {
      input.name = a.phrase;
    }
    return [{ input: input.id, values: ["true"], negated: a.negated }];
  };

  // Pass 4: rules, precedence, order.
  const rules: Rule[] = [];
  for (const r of rawRules) {
    const conditions: Atom[][] = [];
    let failed: string | null = null;
    for (const atoms of r.condition) {
      const resolved: Atom[] = [];
      for (const a of atoms) {
        const out = resolveAtom(a, r.clause.span);
        if (isFailure(out)) {
          failed = out.error;
          break;
        }
        resolved.push(...out);
      }
      if (failed) break;
      conditions.push(resolved);
    }
    if (failed) {
      uninterpretable.push(finding(r.clause.span, failed));
      continue;
    }
    rules.push({
      id: `R${rules.length + 1}`,
      kind: r.consequent.forbid ? "forbid" : "label",
      label: r.consequent.label,
      conditions,
      always: r.consequent.always,
      span: r.clause.span,
      status: "unconfirmed",
      ...(r.clause.listNumber !== undefined ? { listNumber: r.clause.listNumber } : {}),
    });
  }
  for (const input of inputs) if (input.kind === "choice" && !input.declared) input.values.push("(other)");
  shortNames(inputs, subjects);

  if (ordered) {
    let n = 0;
    for (const r of rules) if (r.listNumber !== undefined && r.kind === "label") r.order = ++n;
    if (!n) notes.push("The prompt says rules apply in order, but no numbered rules were found.");
  } else if (rules.some((r) => r.listNumber !== undefined)) {
    notes.push("Rules are numbered, but the prompt never says they apply in order, so numbering is not used as priority.");
  }

  const precedence: Precedence[] = [];
  const side = (s: string): { kind: "rule" | "label"; value: string } | null => {
    const ref = /\brule\s*#?(\d+)\b/i.exec(s);
    if (ref) {
      const rule = rules.find((r) => r.listNumber === Number(ref[1]));
      return rule ? { kind: "rule", value: rule.id } : null;
    }
    const { found } = findLabels(s, labels);
    return found.length === 1 && found[0] ? { kind: "label", value: found[0] } : null;
  };
  for (const p of rawPrecedence) {
    const w = side(p.winner);
    const l = side(p.loser);
    if (!w || !l || w.kind !== l.kind) {
      uninterpretable.push(finding(p.clause.span, "precedence between things that are not both labels or both numbered rules"));
      continue;
    }
    precedence.push({ kind: w.kind, winner: w.value, loser: l.value, span: p.clause.span });
  }

  return {
    promptSha256: createHash("sha256").update(text).digest("hex"),
    labels,
    labelsDeclared,
    inputs,
    rules,
    default: defaultRule,
    precedence,
    ordered,
    uninterpretable: uninterpretable.sort((x, y) => x.span.start - y.span.start),
    ignored,
    notes,
  };
}
