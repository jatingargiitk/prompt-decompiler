import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { analyze } from "./analyze.ts";
import { applyDecisions, emptyDecisions, loadDecisions, serializeDecisions, type Decisions } from "./decisions.ts";
import { parsePrompt } from "./parse.ts";
import { buildReport, hasOpenIssues, summaryLine } from "./report.ts";
import { renderHtml, renderJson, renderMarkdown, renderTable } from "./render.ts";
import { review, type ReviewIO } from "./review.ts";
import { buildTestCases, toJsonl, toPromptfoo } from "./witness.ts";

export interface MainIO {
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  readStdin(): string;
  /** Interactive prompts for `review`. */
  reviewIO?: ReviewIO;
  env?: Record<string, string | undefined>;
}

const HELP = `prompt-decompiler: turn a classifier prompt into a decision table you can inspect and test.

Usage:
  prompt-decompiler <prompt-file | -> [options]
  prompt-decompiler review <prompt-file> --confirm <decisions.yaml>

Options:
  -f, --format <fmt>        table (default), markdown, json or html
  -o, --output <file>       write the table there instead of stdout
  -c, --confirm <file>      apply a decisions file (YAML or JSON): accepted/rejected rules, conflict winners, default
      --tests <file>        write one test case per rule, conflict and gap
      --tests-format <fmt>  jsonl or promptfoo (default: promptfoo for .yaml/.yml, else jsonl)
      --check               exit 1 if any conflict, missing default or clause is left unresolved
      --max-combinations <n>  enumeration limit (default 65536)
      --no-color            plain output (also NO_COLOR=1)
  -h, --help                show this help
  -v, --version             show the version

review asks you to confirm each extracted rule, pick winners for open conflicts and set a default,
then writes your answers to the --confirm file. Run it again to continue where you stopped.

Exit codes: 0 ok, 1 --check found open issues, 2 usage or input error.
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

class UsageError extends Error {}

export async function main(argv: string[], io: MainIO): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    io.stderr.write(`prompt-decompiler: ${(err as Error).message}\n`);
    if (err instanceof UsageError) io.stderr.write("Run prompt-decompiler --help for usage.\n");
    return 2;
  }
}

async function run(argv: string[], io: MainIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string", short: "f" },
        output: { type: "string", short: "o" },
        confirm: { type: "string", short: "c" },
        tests: { type: "string" },
        "tests-format": { type: "string" },
        check: { type: "boolean" },
        "max-combinations": { type: "string" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values: opts, positionals } = parsed;
  if (opts.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    io.stdout.write(`${version()}\n`);
    return 0;
  }
  const isReview = positionals[0] === "review";
  const files = isReview ? positionals.slice(1) : positionals;
  if (files.length !== 1) throw new UsageError(files.length ? "give exactly one prompt file" : "missing prompt file (use - for stdin)");
  const file = files[0] ?? "";
  const format = opts.format ?? "table";
  if (!["table", "markdown", "md", "json", "html"].includes(format)) throw new UsageError(`unknown --format "${format}"`);
  const max = opts["max-combinations"] === undefined ? undefined : Number(opts["max-combinations"]);
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) throw new UsageError("--max-combinations must be a positive integer");

  let prompt: string;
  try {
    prompt = file === "-" ? io.readStdin() : readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const source = file === "-" ? "stdin" : basename(file);
  const model = parsePrompt(prompt);

  if (isReview) {
    if (!opts.confirm) throw new UsageError("review needs --confirm <file> to save your answers");
    if (!io.reviewIO) throw new Error("review needs an interactive terminal or answers on stdin");
    const start: Decisions = existsSync(opts.confirm) ? loadDecisions(opts.confirm) : emptyDecisions(model);
    const decided = await review(model, start, io.reviewIO);
    writeFileSync(opts.confirm, serializeDecisions(decided));
    const applied = applyDecisions(model, decided);
    const report = buildReport(applied.model, analyze(applied.model, { decisions: applied.conflicts, ...(max ? { maxCombinations: max } : {}) }), { source, warnings: applied.warnings });
    io.reviewIO.print("");
    io.reviewIO.print(`Saved ${opts.confirm}. ${summaryLine(report)}`);
    return 0;
  }

  let decisions: Decisions | undefined;
  if (opts.confirm) decisions = loadDecisions(opts.confirm);
  const applied = decisions ? applyDecisions(model, decisions) : { model, conflicts: [], warnings: [] };
  const analysis = analyze(applied.model, { decisions: applied.conflicts, ...(max ? { maxCombinations: max } : {}) });
  const report = buildReport(applied.model, analysis, { source, warnings: applied.warnings });

  const env = io.env ?? {};
  const color = format === "table" && !opts.output && !opts["no-color"] && !env.NO_COLOR && Boolean(io.stdout.isTTY);
  const rendered =
    format === "json" ? renderJson(report)
    : format === "html" ? renderHtml(report, prompt)
    : format === "markdown" || format === "md" ? renderMarkdown(report)
    : renderTable(report, { color });
  if (opts.output) {
    writeFileSync(opts.output, rendered);
    io.stderr.write(`Wrote ${opts.output}. ${summaryLine(report)}\n`);
  } else {
    io.stdout.write(rendered);
  }

  if (opts.tests) {
    const ext = extname(opts.tests).toLowerCase();
    const testsFormat = opts["tests-format"] ?? (ext === ".yaml" || ext === ".yml" ? "promptfoo" : "jsonl");
    if (testsFormat !== "jsonl" && testsFormat !== "promptfoo") throw new UsageError(`unknown --tests-format "${testsFormat}"`);
    const cases = buildTestCases(report, applied.conflicts);
    writeFileSync(opts.tests, testsFormat === "promptfoo" ? toPromptfoo(report, cases) : toJsonl(cases));
    const open = cases.filter((c) => c.expected === null).length;
    io.stderr.write(`Wrote ${cases.length} test cases to ${opts.tests} (${open} without an expected label).\n`);
  }
  return opts.check && hasOpenIssues(report) ? 1 : 0;
}

/** Review prompts over a terminal, or over piped answers (one per line) when stdin is not a TTY. */
export function terminalReviewIO(): ReviewIO {
  const print = (line: string) => process.stdout.write(`${line}\n`);
  if (!process.stdin.isTTY) {
    let lines: string[] | undefined;
    return {
      print,
      ask: async (q) => {
        lines ??= readFileSync(0, "utf8").split(/\r?\n/);
        const answer = lines.shift();
        process.stdout.write(`${q}${answer ?? ""}\n`);
        return answer === undefined ? null : answer;
      },
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  return {
    print,
    ask: async (q) => {
      if (closed) return null;
      try {
        return await rl.question(q);
      } catch {
        return null;
      }
    },
  };
}
