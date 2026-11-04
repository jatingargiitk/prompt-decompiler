import { lineRef, summarize, summaryLine, type Report, type Row } from "./report.ts";
import type { Input } from "./types.ts";

const ANSI = { red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };

function inputDesc(input: Input): string {
  return input.kind === "bool" ? input.name : `${input.name}: ${input.values.join(" | ")}`;
}

function columnLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `X${i}`;
}

function sourceRef(row: Row): string {
  return row.spans.map(lineRef).join(" ");
}

function quote(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
}

/** Plain-text table for the terminal. Columns are lettered; the legend above names each input. */
export function renderTable(r: Report, opts: { color?: boolean } = {}): string {
  const c = (code: keyof typeof ANSI, s: string) => (opts.color ? `${ANSI[code]}${s}${ANSI.reset}` : s);
  const { model, analysis } = r;
  const out: string[] = [];
  out.push(c("bold", `${r.source}`) + c("dim", `  (sha256 ${model.promptSha256.slice(0, 12)})`), "");

  out.push(c("bold", "Inputs"));
  model.inputs.forEach((input, i) => out.push(`  ${columnLetter(i)}  ${input.short.padEnd(18)} ${inputDesc(input)}  ${c("dim", lineRef(input.span))}`));
  if (!model.inputs.length) out.push("  (none found)");
  out.push("");

  out.push(c("bold", "Decision table"));
  const header = ["ID", ...model.inputs.map((_, i) => columnLetter(i)), "→ label", "why", "source"];
  const body = r.rows.map((row) => [row.id, ...row.cells, row.outcome, row.note, sourceRef(row)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? "").length)));
  const fmt = (cells: string[]) => cells.map((x, i) => (i === cells.length - 1 ? x : x.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  out.push(`  ${c("dim", fmt(header))}`);
  let lastKind = "";
  r.rows.forEach((row, k) => {
    if (lastKind && row.kind !== lastKind && (row.kind === "conflict" || row.kind === "gap" || row.kind === "default") && lastKind !== row.kind) {
      if (!(lastKind === "conflict" && row.kind === "gap")) out.push(`  ${c("dim", "·")}`);
    }
    lastKind = row.kind === "forbid" ? "rule" : row.kind;
    const line = fmt(body[k] ?? []);
    out.push(`  ${row.unresolved ? c("red", line) : row.kind === "conflict" ? c("yellow", line) : line}`);
  });
  out.push("");

  if (model.uninterpretable.length) {
    out.push(c("bold", "Could not interpret"));
    for (const f of model.uninterpretable) out.push(`  ${lineRef(f.span).padEnd(6)} ${quote(f.span.text)}`, `         ${c("dim", f.reason)}`);
    out.push("");
  }
  const notes = [
    ...model.notes,
    ...analysis.unusedDecisions.map((d) => `Decision between ${d.between.join(", ")} matched no conflict.`),
  ];
  if (notes.length) {
    out.push(c("bold", "Notes"));
    for (const n of notes) out.push(`  - ${n}`);
    out.push("");
  }
  for (const w of r.warnings) out.push(c("yellow", `warning: ${w}`));
  out.push(summaryLine(r));
  return out.join("\n") + "\n";
}

function md(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderMarkdown(r: Report): string {
  const { model } = r;
  const out: string[] = [`# Decision table: ${md(r.source)}`, "", summaryLine(r), ""];
  out.push("## Inputs", "", "| Input | Meaning | Values | Source |", "|---|---|---|---|");
  for (const input of model.inputs) out.push(`| \`${input.short}\` | ${md(input.name)} | ${input.values.join(", ")} | ${lineRef(input.span)} |`);
  out.push("", "## Rules, conflicts and gaps", "");
  out.push(`| ID | ${model.inputs.map((i) => `\`${i.short}\``).join(" | ")} | Label | Why | Source |`);
  out.push(`|---|${model.inputs.map(() => "---").join("|")}|---|---|---|`);
  for (const row of r.rows) {
    const label = row.unresolved ? `**${row.outcome}**` : `\`${row.outcome}\``;
    out.push(`| ${row.id} | ${row.cells.map(md).join(" | ")} | ${md(label)} | ${md(row.note)} | ${sourceRef(row)} |`);
  }
  out.push("", "Cells: `T` true, `F` false, `-` any value, `!v` anything but v, `a|b` either.", "");
  const ruleRows = model.rules.filter((x) => x.status !== "rejected");
  if (ruleRows.length) {
    out.push("## Source of each rule", "");
    for (const rule of ruleRows) out.push(`- **${rule.id}** (${lineRef(rule.span)}): ${md(quote(rule.span.text, 200))}`);
    out.push("");
  }
  if (model.uninterpretable.length) {
    out.push("## Could not interpret", "");
    for (const f of model.uninterpretable) out.push(`- ${lineRef(f.span)}: ${md(quote(f.span.text, 200))} (${f.reason})`);
    out.push("");
  }
  if (model.notes.length || r.warnings.length) {
    out.push("## Notes", "");
    for (const n of [...model.notes, ...r.warnings]) out.push(`- ${n}`);
    out.push("");
  }
  return out.join("\n");
}

export function renderJson(r: Report): string {
  const { model, analysis } = r;
  const assignment = (a: string[]) => Object.fromEntries(model.inputs.map((i, k) => [i.short, i.kind === "bool" ? a[k] === "true" : a[k]]));
  const doc = {
    tool: "prompt-decompiler",
    format: 1,
    source: r.source,
    prompt_sha256: model.promptSha256,
    summary: summarize(r),
    labels: model.labels,
    inputs: model.inputs.map((i) => ({ id: i.short, name: i.name, kind: i.kind, values: i.values, declared: i.declared, span: i.span })),
    rules: model.rules.map((x) => ({
      id: x.id,
      kind: x.kind,
      label: x.label,
      conditions: x.conditions.map((conj) => conj.map((a) => ({ input: model.inputs.find((i) => i.id === a.input)?.short ?? a.input, values: a.values, negated: a.negated }))),
      always: x.always,
      ...(x.order !== undefined ? { order: x.order } : {}),
      status: x.status,
      span: x.span,
    })),
    default: model.default,
    precedence: model.precedence,
    ordered: model.ordered,
    conflicts: analysis.conflicts.map((c) => ({ ...c, witness: assignment(c.witness), cubes: undefined })),
    gaps: analysis.gaps.map((g) => ({ ...g, witness: assignment(g.witness), cubes: undefined })),
    dead_rules: analysis.deadRules,
    rule_stats: analysis.ruleStats,
    rows: r.rows.map((row) => ({ ...row, cells: Object.fromEntries(model.inputs.map((i, k) => [i.short, row.cells[k]])), spans: row.spans.map(({ start, end, line, endLine }) => ({ start, end, line, endLine })) })),
    uninterpretable: model.uninterpretable,
    ignored: model.ignored,
    notes: model.notes,
    warnings: r.warnings,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A self-contained HTML page: the decision table next to the prompt. Clicking a row highlights the
 * sentences it came from. No external scripts or styles.
 */
export function renderHtml(r: Report, prompt: string): string {
  const { model } = r;
  // Mark every rule, default and uninterpretable span in the prompt text.
  const marks: { start: number; end: number; id: string; cls: string }[] = [];
  for (const rule of model.rules) marks.push({ start: rule.span.start, end: rule.span.end, id: rule.id, cls: "rule" });
  if (model.default?.from === "prompt") marks.push({ start: model.default.span.start, end: model.default.span.end, id: "DEF", cls: "rule" });
  model.uninterpretable.forEach((f, i) => marks.push({ start: f.span.start, end: f.span.end, id: `U${i + 1}`, cls: "bad" }));
  marks.sort((a, b) => a.start - b.start);
  let html = "";
  let pos = 0;
  for (const m of marks) {
    if (m.start < pos) continue;
    html += esc(prompt.slice(pos, m.start));
    html += `<mark class="${m.cls}" data-span="${m.id}" title="${m.id}">${esc(prompt.slice(m.start, m.end))}</mark>`;
    pos = m.end;
  }
  html += esc(prompt.slice(pos));

  const head = `<tr><th>ID</th>${model.inputs.map((i) => `<th title="${esc(i.name)}">${esc(i.short)}</th>`).join("")}<th>label</th><th>why</th></tr>`;
  const rows = r.rows
    .map((row) => {
      const ids = row.kind === "default" ? ["DEF"] : row.rules;
      return `<tr class="${row.kind}${row.unresolved ? " unresolved" : ""}" data-spans="${esc(ids.join(" "))}"><td>${esc(row.id)}</td>${row.cells.map((x) => `<td>${esc(x)}</td>`).join("")}<td>${esc(row.outcome)}</td><td>${esc(row.note)}</td></tr>`;
    })
    .join("\n");
  const bad = model.uninterpretable
    .map((f, i) => `<li data-spans="U${i + 1}"><b>${lineRef(f.span)}</b> ${esc(f.span.text)} <i>(${esc(f.reason)})</i></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(r.source)} · prompt-decompiler</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;display:flex;gap:1rem;padding:1rem;color:#222}
#prompt{flex:1;min-width:20rem}#table{flex:2;overflow:auto}
pre{white-space:pre-wrap;background:#f7f7f7;padding:1rem;border-radius:6px}
mark{background:#eef;border-radius:3px}mark.bad{background:#fde2e2}mark.on{background:#ffd54f;outline:2px solid #f9a825}
table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.25rem .5rem;text-align:left;white-space:nowrap}
tr[data-spans]{cursor:pointer}tr.unresolved td{color:#b00020;font-weight:600}tr.conflict:not(.unresolved){background:#fff8e1}
tr.sel{outline:2px solid #f9a825}li[data-spans]{cursor:pointer}
</style></head><body>
<div id="prompt"><h2>Prompt</h2><pre>${html}</pre></div>
<div id="table"><h2>Decision table</h2><p>${esc(summaryLine(r))}</p>
<table>${head}
${rows}
</table>
<p>Cells: T true, F false, - any value, !v anything but v, a|b either. Click a row to highlight its source.</p>
${bad ? `<h3>Could not interpret</h3><ul>${bad}</ul>` : ""}
</div>
<script>
document.querySelectorAll("[data-spans]").forEach(function (el) {
  el.addEventListener("click", function () {
    document.querySelectorAll(".on,.sel").forEach(function (m) { m.classList.remove("on", "sel"); });
    el.classList.add("sel");
    var first = null;
    el.getAttribute("data-spans").split(" ").forEach(function (id) {
      document.querySelectorAll('mark[data-span="' + id + '"]').forEach(function (m) { m.classList.add("on"); first = first || m; });
    });
    if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
  });
});
</script>
</body></html>
`;
}
