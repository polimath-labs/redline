import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { errorMessage } from "./schema";

export const directory = join(process.cwd(), ".github", "redline");

const userSchema = Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.String }));

export const pullSchema = Schema.Struct({
  title: Schema.String,
  user: userSchema,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  draft: Schema.Boolean,
  head: Schema.Struct({ sha: Schema.String }),
});

export const commentSchema = Schema.Struct({
  body: Schema.NullOr(Schema.String),
  user: userSchema,
  created_at: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.String),
  line: Schema.optional(Schema.NullOr(Schema.Number)),
});

export function safeText(text: string) {
  return text.replaceAll(/<!--[\s\S]*?-->/g, "").replaceAll(/@(?=[\w-])/g, "@​");
}

export function log(message: string) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

export function command(program: string, args: string[], input?: string) {
  return execFileSync(program, args, { input, encoding: "utf8", stdio: "pipe", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 });
}

export function api<A>(args: string[], schema: Schema.ConstraintDecoder<A>) {
  const data: unknown = JSON.parse(command("gh", ["api", ...args]));
  return Schema.decodeUnknownSync(schema)(data);
}

export function pages<A>(path: string, schema: Schema.ConstraintDecoder<A>) {
  return api(["--paginate", "--slurp", path], Schema.Array(Schema.Array(schema))).flat();
}

export function main(run: () => void) {
  try {
    run();
  } catch (error) {
    log(`Redline failed: ${safeText(errorMessage(error))}`);
    process.exitCode = 1;
  }
}
