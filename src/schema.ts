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
});

export const runSchema = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  pr: positiveInt,
  head: sha,
  base: sha,
  maxFindings: positiveInt,
  failOn: Schema.Literals(["high", "medium", "never"]),
});

export const contextSchema = Schema.Struct({
  ...runSchema.fields,
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
  const has = (severity: "high" | "medium") => report.findings.some((finding) => finding.severity === severity);
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
    const key = `${finding.path}:${finding.line}:${finding.title.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate finding: ${key}`);
    seen.add(key);
  }
  const priority = { high: 0, medium: 1, low: 2 };
  return { ...report, findings: report.findings.toSorted((a, b) => priority[a.severity] - priority[b.severity]) };
}
