import { readFileSync } from "node:fs";
import { Schema } from "effect";

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const severity = Schema.Literals(["high", "medium", "low"]);
const findingId = Schema.String.check(Schema.isPattern(/^F[1-9]\d{0,4}$/));

const findingFields = {
  severity,
  path: text(500),
  line: positiveInt,
  title: text(100),
  problem: text(500),
  fix: text(350),
};

export const reviewSchema = Schema.Struct({
  status: Schema.Literals(["complete", "incomplete"]),
  changes: Schema.Array(text(160)).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  checked: Schema.Array(text(160)).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  gaps: Schema.Array(text(250)).check(Schema.isMaxLength(6)),
  mergeRisk: Schema.Struct({
    level: Schema.Literals(["low", "medium", "high"]),
    reason: text(300),
  }),
  findings: Schema.Array(Schema.Struct(findingFields)),
  previous: Schema.Array(Schema.Struct({
    id: findingId,
    status: Schema.Literals(["open", "fixed"]),
  })),
});

// A finding Redline posted earlier, carried between runs in the review's state marker.
export const storedFindingSchema = Schema.Struct({ id: findingId, ...findingFields, commit: sha });

// What a posted review records so the next run can pick up where it stopped.
export const stateSchema = Schema.Struct({
  version: Schema.Literal(1),
  head: sha,
  baseRef: Schema.String,
  mergeBase: sha,
  nextId: positiveInt,
  findings: Schema.Array(storedFindingSchema),
});

// What the resolve step pinned for this run. Instructions are data and never reach a shell.
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

export const contextSchema = Schema.Struct({
  ...runSchema.fields,
  mode: Schema.Literals(["full", "incremental", "revisit"]),
  reason: Schema.String,
  since: Schema.NullOr(sha),
  baseRef: Schema.String,
  mergeBase: sha,
  nextId: positiveInt,
  previous: Schema.Array(storedFindingSchema),
  addedLines: Schema.Record(Schema.String, Schema.Array(positiveInt)),
});

export type Context = typeof contextSchema.Type;
export type Review = typeof reviewSchema.Type;
export type StoredFinding = typeof storedFindingSchema.Type;
export type State = typeof stateSchema.Type;
export type Trigger = typeof triggerSchema.Type;

export const marker = "<!-- redline -->";

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function readJson<A>(path: string, schema: Schema.ConstraintDecoder<A>) {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Schema.decodeUnknownSync(schema)(data);
}

const sameFinding = (a: { path: string; title: string }, b: { path: string; title: string }) =>
  a.path === b.path && a.title.trim().toLowerCase() === b.title.trim().toLowerCase();

export function validateReview(input: unknown, context: Context) {
  const report = Schema.decodeUnknownSync(reviewSchema, { onExcessProperty: "error" })(input);
  if (report.findings.length > context.maxFindings) throw new Error(`At most ${context.maxFindings} new findings. Keep the strongest.`);

  const known = new Map(context.previous.map((finding) => [finding.id, finding]));
  const statuses = new Map<string, "open" | "fixed">();
  for (const entry of report.previous) {
    if (!known.has(entry.id)) throw new Error(`Unknown previous finding: ${entry.id}. Use only ids from previousFindings in pr.json.`);
    if (statuses.has(entry.id)) throw new Error(`Previous finding listed twice: ${entry.id}`);
    statuses.set(entry.id, entry.status);
  }
  const missing = context.previous.filter((finding) => !statuses.has(finding.id)).map((finding) => finding.id);
  if (missing.length > 0) throw new Error(`Give a status for every previous finding. Missing: ${missing.join(", ")}`);

  const stillOpen = context.previous.filter((finding) => statuses.get(finding.id) === "open");
  const open = [...report.findings, ...stillOpen];
  const has = (level: "high" | "medium") => open.some((finding) => finding.severity === level);
  if (report.status === "incomplete" && report.gaps.length === 0) throw new Error("An incomplete review must list the changed code it didn't read in gaps.");
  if (has("high") && report.mergeRisk.level !== "high") throw new Error("A high-severity finding, new or still open, requires high merge risk.");
  if (report.mergeRisk.level === "low" && (report.status === "incomplete" || has("medium"))) {
    throw new Error("Incomplete coverage or medium-severity findings, new or still open, require at least medium merge risk.");
  }

  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (!context.addedLines[finding.path]?.includes(finding.line)) {
      throw new Error(`Finding must target an added line: ${finding.path}:${finding.line}`);
    }
    const earlier = context.previous.find((item) => sameFinding(item, finding));
    if (earlier) throw new Error(`${earlier.id} already reports "${earlier.title}". Give its status in previous instead of reporting it again.`);
    const key = `${finding.path}:${finding.line}:${finding.title.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate finding: ${key}`);
    seen.add(key);
  }
  const priority = { high: 0, medium: 1, low: 2 };
  return { ...report, findings: report.findings.toSorted((a, b) => priority[a.severity] - priority[b.severity]) };
}
