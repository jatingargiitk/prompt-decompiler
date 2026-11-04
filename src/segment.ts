import type { Clause, Span } from "./types.ts";

const LIST_MARKER = /^([ \t]*)(?:(\d+)[.)]|[-*+•])[ \t]+/;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/;
const FENCE = /^[ \t]*(```|~~~)/;
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "approx", "no", "mr", "mrs", "dr", "st"]);

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function position(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - (starts[lo] ?? 0) + 1 };
}

export function makeSpan(text: string, starts: number[], start: number, end: number): Span {
  const a = position(starts, start);
  const b = position(starts, Math.max(start, end - 1));
  return { start, end, line: a.line, col: a.col, endLine: b.line, endCol: b.col + 1, text: text.slice(start, end) };
}

interface Block {
  start: number;
  end: number;
  listNumber?: number;
  isListItem: boolean;
  isHeading: boolean;
}

function blocks(text: string, starts: number[]): Block[] {
  const out: Block[] = [];
  let current: Block | null = null;
  let inFence = false;
  const close = () => {
    if (current) out.push(current);
    current = null;
  };
  for (let i = 0; i < starts.length; i++) {
    const lineStart = starts[i] ?? 0;
    let lineEnd = i + 1 < starts.length ? (starts[i + 1] ?? text.length) - 1 : text.length;
    if (text[lineEnd - 1] === "\r") lineEnd--;
    const line = text.slice(lineStart, lineEnd);
    if (FENCE.test(line)) {
      close();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") {
      close();
      continue;
    }
    if (HEADING.test(line)) {
      close();
      const m = HEADING.exec(line);
      out.push({ start: lineStart + (m?.[0].length ?? 0), end: lineEnd, isListItem: false, isHeading: true });
      continue;
    }
    const list = LIST_MARKER.exec(line);
    if (list) {
      close();
      current = {
        start: lineStart + list[0].length,
        end: lineEnd,
        isListItem: true,
        isHeading: false,
        ...(list[2] ? { listNumber: Number(list[2]) } : {}),
      };
      continue;
    }
    if (current) {
      current.end = lineEnd;
    } else {
      const lead = line.length - line.trimStart().length;
      current = { start: lineStart + lead, end: lineEnd, isListItem: false, isHeading: false };
    }
  }
  close();
  return out;
}

/** Where sentences end inside a block: after . ! ? followed by space and a capital, quote, backtick or digit. */
function sentenceBreaks(s: string): number[] {
  const breaks: number[] = [];
  const re = /[.!?](?=\s+["'`(A-Z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (s[m.index] === ".") {
      const before = s.slice(0, m.index);
      const word = /([A-Za-z.]+)$/.exec(before)?.[1]?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(word) || /^\d+$/.test(/(\S+)$/.exec(before)?.[1] ?? "")) continue;
    }
    breaks.push(m.index + 1);
  }
  return breaks;
}

export function normalizeClauseText(s: string): string {
  return s
    .replace(/\*\*|__/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a prompt into clauses (sentences and list items), keeping exact source spans. */
export function segment(text: string): Clause[] {
  const starts = lineStarts(text);
  const clauses: Clause[] = [];
  blocks(text, starts).forEach((block, blockIndex) => {
    const body = text.slice(block.start, block.end).replace(/[\r\n]/g, " ");
    const cuts = [0, ...sentenceBreaks(body), body.length];
    let first = true;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const raw = body.slice(cuts[i], cuts[i + 1]);
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const start = block.start + (cuts[i] ?? 0) + lead;
      const span = makeSpan(text, starts, start, start + trimmed.length);
      clauses.push({
        text: normalizeClauseText(trimmed),
        span,
        isListItem: block.isListItem,
        itemStart: block.isListItem && first,
        isHeading: block.isHeading,
        block: blockIndex,
        ...(block.listNumber !== undefined ? { listNumber: block.listNumber } : {}),
      });
      first = false;
    }
  });
  return clauses;
}
