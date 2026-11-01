import { readFileSync } from "node:fs";
import { Schema } from "effect";

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

export const reviewSchema = Schema.Struct({
  status: Schema.Literals(["complete", "incomplete"]),
  changes: Schema.Array(text(160)).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  checked: Schema.Array(text(160)).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  gaps: Schema.Array(text(250)).check(Schema.isMaxLength(6)),
  mergeRisk: Schema.Struct({
    level: Schema.Literals(["low", "medium", "high"]),
    reason: text(300),
  }),
  findings: Schema.Array(Schema.Struct({
    severity: Schema.Literals(["high", "medium", "low"]),
    path: text(500),
    line: positiveInt,
    title: text(100),
    problem: text(500),
    fix: text(350),
  })),
  previous: Schema.Array(Schema.Struct({
    id: positiveInt,
    status: Schema.Literals(["open", "fixed"]),
  })),
});

// Written by the resolve step. Instructions are data and never reach a shell.
export const triggerSchema = Schema.Struct({
  pr: positiveInt,
  head: sha,
  base: sha,
  baseRef: Schema.String,
  manual: Schema.Boolean,
  full: Schema.Boolean,
  instructions: Schema.String,
});

export const runSchema = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  pr: positiveInt,
  head: sha,
  base: sha,
  maxFindings: positiveInt,
  failOn: Schema.Literals(["high", "medium", "never"]),
});

// An unresolved finding from an earlier review. The id is its inline comment's id.
export const previousSchema = Schema.Struct({
  id: positiveInt,
  thread: Schema.String,
  severity: Schema.Literals(["high", "medium", "low"]),
  title: Schema.String,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  url: Schema.String,
});

export const contextSchema = Schema.Struct({
  ...runSchema.fields,
  mode: Schema.Literals(["full", "incremental", "revisit"]),
  since: Schema.NullOr(sha),
  baseRef: Schema.String,
  previous: Schema.Array(previousSchema),
  addedLines: Schema.Record(Schema.String, Schema.Array(positiveInt)),
});

export const marker = "<!-- redline -->";

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function readJson<A>(path: string, schema: Schema.ConstraintDecoder<A>) {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Schema.decodeUnknownSync(schema)(data);
}

export function validateReview(input: unknown, context: typeof contextSchema.Type) {
  const report = Schema.decodeUnknownSync(reviewSchema, { onExcessProperty: "error" })(input);
  if (report.findings.length > context.maxFindings) throw new Error(`At most ${context.maxFindings} findings. Keep the strongest.`);
  const unknown = report.previous.find((entry) => !context.previous.some((finding) => finding.id === entry.id));
  if (unknown) throw new Error(`Unknown previous finding ${unknown.id}. Use the ids in previousFindings.`);
  // An earlier finding without a status stays open. Absence from the diff is not a fix.
  const fixed = new Set(report.previous.filter((entry) => entry.status === "fixed").map((entry) => entry.id));
  const open = [...report.findings, ...context.previous.filter((finding) => !fixed.has(finding.id))];
  const has = (severity: "high" | "medium") => open.some((finding) => finding.severity === severity);
  if (report.status === "incomplete" && report.gaps.length === 0) throw new Error("An incomplete review must list the changed code it didn't read in gaps.");
  if (has("high") && report.mergeRisk.level !== "high") throw new Error("A high-severity finding requires high merge risk.");
  if (report.mergeRisk.level === "low" && (report.status === "incomplete" || has("medium"))) {
    throw new Error("Incomplete coverage or medium-severity findings require at least medium merge risk.");
  }
  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (!context.addedLines[finding.path]?.includes(finding.line)) {
      throw new Error(`Finding must target an added line: ${finding.path}:${finding.line}`);
    }
    const earlier = context.previous.find((item) => item.path === finding.path && item.title.toLowerCase() === finding.title.toLowerCase());
    if (earlier) throw new Error(`Finding ${earlier.id} already reports this. Give its status in previous instead.`);
    const key = `${finding.path}:${finding.line}:${finding.title.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate finding: ${key}`);
    seen.add(key);
  }
  const priority = { high: 0, medium: 1, low: 2 };
  return { ...report, findings: report.findings.toSorted((a, b) => priority[a.severity] - priority[b.severity]) };
}
