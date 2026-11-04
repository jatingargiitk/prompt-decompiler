/** A slice of the original prompt. Offsets are UTF-16 indexes into the prompt string, end exclusive. */
export interface Span {
  start: number;
  end: number;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column of the first character. */
  col: number;
  endLine: number;
  /** 1-based column just after the last character. */
  endCol: number;
  text: string;
}

/** One sentence or list item of the prompt, the unit the parser reads. */
export interface Clause {
  /** Parser-friendly text: whitespace collapsed, markdown emphasis removed. */
  text: string;
  span: Span;
  /** Number of the numbered-list item this clause belongs to, if any. */
  listNumber?: number;
  isListItem: boolean;
  /** True for the first sentence of a list item. */
  itemStart: boolean;
  isHeading: boolean;
  block: number;
}

export type InputKind = "bool" | "choice";

export interface Input {
  id: string;
  /** Human-readable phrase, e.g. "the ticket mentions a refund" or "the customer's plan". */
  name: string;
  /** Short column header, e.g. "mentions_refund". */
  short: string;
  kind: InputKind;
  /** "true"/"false" for booleans; the choice values otherwise. */
  values: string[];
  /** For choices: whether the prompt listed every value ("X is one of a, b, c"). */
  declared: boolean;
  /** Where the input was first mentioned. */
  span: Span;
}

/** One test on one input. A boolean atom uses values ["true"]. */
export interface Atom {
  input: string;
  values: string[];
  negated: boolean;
}

export type RuleStatus = "unconfirmed" | "accepted" | "rejected";

export interface Rule {
  id: string;
  /** "label": assign the label when the condition holds. "forbid": never assign it. */
  kind: "label" | "forbid";
  label: string;
  /** Disjunctive normal form: the rule fires when every atom of any one conjunction holds. */
  conditions: Atom[][];
  /** Explicit "always" / "regardless" wording. */
  always: boolean;
  /** Position among numbered rules (1-based), used only when the prompt says rules apply in order. */
  order?: number;
  /** The number printed in the prompt's numbered list, if any. */
  listNumber?: number;
  span: Span;
  status: RuleStatus;
}

export interface DefaultRule {
  label: string;
  span: Span;
  /** "prompt" when the prompt states it, "confirmed" when it came from a decisions file. */
  from: "prompt" | "confirmed";
}

export interface Precedence {
  kind: "label" | "rule";
  winner: string;
  loser: string;
  span: Span;
}

export interface Finding {
  span: Span;
  reason: string;
}

export interface Model {
  promptSha256: string;
  labels: string[];
  labelsDeclared: boolean;
  inputs: Input[];
  rules: Rule[];
  default: DefaultRule | null;
  precedence: Precedence[];
  /** Span of the sentence saying numbered rules apply in order, if any. */
  ordered: Span | null;
  uninterpretable: Finding[];
  /** Clauses read but skipped because they carry no rule wording (role text, format instructions). */
  ignored: Finding[];
  notes: string[];
}
