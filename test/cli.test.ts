import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDecisions } from "../src/decisions.ts";
import { main } from "../src/main.ts";
import type { ReviewIO } from "../src/review.ts";

const examplePath = new URL("../examples/support-router.md", import.meta.url).pathname;
const decisionsPath = new URL("../examples/support-router.decisions.yaml", import.meta.url).pathname;
const example = readFileSync(examplePath, "utf8");

async function run(argv: string[], opts: { stdin?: string; answers?: string[]; tty?: boolean } = {}) {
  let stdout = "";
  let stderr = "";
  const printed: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const reviewIO: ReviewIO = {
    print: (l) => printed.push(l),
    ask: async (q) => {
      printed.push(q);
      return answers.length ? (answers.shift() ?? null) : null;
    },
  };
  const code = await main(argv, {
    stdout: { write: (s: string) => (stdout += s), isTTY: opts.tty ?? false },
    stderr: { write: (s: string) => (stderr += s) },
    readStdin: () => opts.stdin ?? "",
    reviewIO,
    env: {},
  });
  return { code, stdout, stderr, printed: printed.join("\n") };
}

const tmp = () => mkdtempSync(join(tmpdir(), "pd-"));

describe("cli", () => {
  it("prints the decision table for the example", async () => {
    const r = await run([examplePath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("4 unresolved conflicts, 2 resolved by the prompt, 1 missing default, 2 uninterpretable clauses");
    expect(r.stdout).not.toContain("\x1b[");
  });

  it("colors only on a terminal", async () => {
    expect((await run([examplePath], { tty: true })).stdout).toContain("\x1b[");
    expect((await run([examplePath, "--no-color"], { tty: true })).stdout).not.toContain("\x1b[");
  });

  it("reads the prompt from stdin", async () => {
    const r = await run(["-", "--format", "json"], { stdin: example });
    expect(JSON.parse(r.stdout)).toMatchObject({ source: "stdin", summary: { rules: 8 } });
  });

  it("exits 1 with --check while anything is unresolved", async () => {
    expect((await run([examplePath, "--check"])).code).toBe(1);
    const clean = join(tmp(), "clean.md");
    writeFileSync(clean, "Labels: spam, inbox\nIf the sender is unknown, label it spam.\nOtherwise, label it inbox.\n");
    expect((await run([clean, "--check"])).code).toBe(0);
  });

  it("applies a decisions file and settles every conflict and gap", async () => {
    const r = await run([examplePath, "--confirm", decisionsPath, "--format", "markdown"]);
    expect(r.stdout).toContain("0 unresolved conflicts, 6 resolved by the prompt or decisions, 0 missing defaults");
    expect(r.stdout).toContain("| DEF | - | - | - | - | - | - | `general` |");
  });

  it("writes output and tests to files", async () => {
    const dir = tmp();
    const r = await run([examplePath, "-f", "html", "-o", join(dir, "t.html"), "--tests", join(dir, "t.yaml")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Wrote 15 test cases");
    expect(readFileSync(join(dir, "t.html"), "utf8")).toMatch(/^<!doctype html>/);
    expect(readFileSync(join(dir, "t.yaml"), "utf8")).toContain("type: equals");
    await run([examplePath, "--tests", join(dir, "t.jsonl")]);
    expect(readFileSync(join(dir, "t.jsonl"), "utf8").split("\n")[0]).toMatch(/^\{"id":"R1"/);
  });

  it("rejects bad usage with exit code 2", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run([examplePath, "--format", "pdf"])).stderr).toContain('unknown --format "pdf"');
    expect((await run(["/nonexistent.md"])).stderr).toContain("cannot read /nonexistent.md: ENOENT");
    expect((await run([examplePath, "--bogus"])).code).toBe(2);
    expect((await run(["review", examplePath])).stderr).toContain("review needs --confirm");
  });

  it("prints help and version", async () => {
    expect((await run(["--help"])).stdout).toContain("Usage:");
    expect((await run(["--version"])).stdout).toBe("0.1.0\n");
  });
});

describe("review", () => {
  it("records rule confirmations, conflict winners and the default", async () => {
    const file = join(tmp(), "d.yaml");
    const answers = ["y", "y", "y", "y", "y", "y", "n", "y", "2", "1", "1", "2", "3"];
    const r = await run(["review", examplePath, "--confirm", file], { answers });
    expect(r.code).toBe(0);
    expect(r.printed).toContain("Conflict: bugs vs account (16 combinations)");
    const d = parseDecisions(readFileSync(file, "utf8"));
    expect(d.rules).toMatchObject({ R1: "accept", R7: "reject" });
    expect(d.conflicts).toEqual([
      { between: ["bugs", "account"], winner: "account" },
      { between: ["billing", "bugs"], winner: "billing" },
      { between: ["account", "sales"], winner: "account" },
      { between: ["billing", "sales"], winner: "sales" },
    ]);
    expect(d.default).toBe("account");
    expect(r.printed).toContain("0 unresolved conflicts");
  });

  it("keeps partial answers when input ends and continues later", async () => {
    const file = join(tmp(), "d.yaml");
    await run(["review", examplePath, "--confirm", file], { answers: ["y", "y"] });
    expect(Object.keys(parseDecisions(readFileSync(file, "utf8")).rules)).toEqual(["R1", "R2"]);
    const again = await run(["review", examplePath, "--confirm", file], { answers: ["bad", "y"] });
    expect(again.printed).toContain("6 not yet confirmed");
    expect(again.printed).toContain("Please answer y, n, q.");
    expect(Object.keys(parseDecisions(readFileSync(file, "utf8")).rules)).toEqual(["R1", "R2", "R3"]);
  });

  it("lets you skip a conflict, which stays unresolved", async () => {
    const file = join(tmp(), "d.yaml");
    writeFileSync(file, "rules: {R1: accept, R2: accept, R3: accept, R4: accept, R5: accept, R6: accept, R7: accept, R8: accept}\n");
    const r = await run(["review", examplePath, "--confirm", file], { answers: ["s", "s", "s", "s", "s"] });
    expect(parseDecisions(readFileSync(file, "utf8")).conflicts).toEqual([]);
    expect(r.printed).toContain("4 unresolved conflicts");
  });
});
