import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { api, command, commentSchema, directory, log, main, pages, pullSchema } from "./github";
import { marker, runSchema } from "./schema";

const lockfiles = [":(exclude)bun.lock", ":(exclude)package-lock.json", ":(exclude)yarn.lock", ":(exclude)pnpm-lock.yaml"];

function git(args: string[]) {
  return command("git", ["-c", "core.quotePath=false", ...args]);
}

function writeJson(name: string, value: unknown) {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
}

function addedLines(diff: string) {
  const added: Record<string, number[]> = {};
  let lines: number[] = [];
  let line = 0;
  let header = false;
  for (const entry of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(entry);
    if (entry.startsWith("diff --git ")) header = true;
    else if (header && entry.startsWith("+++ ")) {
      lines = [];
      if (entry.startsWith("+++ b/")) added[entry.slice(6).replace(/\t$/, "")] = lines;
    } else if (hunk) {
      header = false;
      line = Number(hunk[1]);
    } else if (header) continue;
    else if (entry.startsWith("+")) lines.push(line++);
    else if (entry.startsWith(" ")) line++;
  }
  return added;
}

function related(functions: string) {
  const declaration = /^[ +-](?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|def|func|fn)\s+([A-Za-z_$][\w$]{2,})/gm;
  const names = [...new Set([...functions.matchAll(declaration)].flatMap((match) => match[1] ?? []))];
  const grep = (name: string) => {
    try {
      return git(["grep", "-n", "-w", "-I", "-e", name, "--", ".", ...lockfiles]).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return names
    .map((name) => `## ${name}\n\n${grep(name).map((hit) => `- ${hit}`).join("\n")}`)
    .join("\n\n");
}

main(() => {
  const run = Schema.decodeUnknownSync(runSchema)({
    repository: process.env.GITHUB_REPOSITORY,
    pr: Number(process.env.PR_NUMBER),
    head: process.env.HEAD_SHA,
    base: process.env.BASE_SHA,
    maxFindings: Number(process.env.MAX_FINDINGS),
    failOn: process.env.FAIL_ON,
  });
  const endpoint = `repos/${run.repository}/pulls/${run.pr}`;
  const pull = api([endpoint], pullSchema);
  const relevant = (item: typeof commentSchema.Type) => Boolean(item.body) && (item.user?.type === "User" || Boolean(item.body?.startsWith(marker)));
  const entry = (kind: string) => (item: typeof commentSchema.Type) =>
    ({ kind, author: item.user?.login, at: item.created_at ?? item.submitted_at, path: item.path, line: item.line, body: item.body });
  const conversation = [
    ...pages(`repos/${run.repository}/issues/${run.pr}/comments?per_page=100`, commentSchema).filter(relevant).map(entry("comment")),
    ...pages(`${endpoint}/reviews?per_page=100`, commentSchema).filter(relevant).map(entry("review")),
    ...pages(`${endpoint}/comments?per_page=100`, commentSchema).filter(relevant).map(entry("inline")),
  ].toSorted((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  const mergeBase = git(["merge-base", run.base, run.head]).trim();
  const files = git(["diff", "--name-only", "-z", "--find-renames", mergeBase, run.head]).split("\0").filter(Boolean);
  const diffWith = (...flags: string[]) =>
    git(["diff", "--no-ext-diff", "--no-textconv", "--find-renames", ...flags, mergeBase, run.head, "--", ".", ...lockfiles]);
  const diff = diffWith();
  if (files.length > 200 || diff.length > 300_000) {
    throw new Error("PR too large to review: split PRs over 200 files or 300,000 diff characters.");
  }
  const functions = diffWith("--function-context");

  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "diff.patch"), diff);
  writeFileSync(join(directory, "functions.patch"), functions);
  writeFileSync(join(directory, "related.md"), related(functions));
  writeJson("context.json", { ...run, addedLines: addedLines(diff) });
  writeJson("pr.json", { title: pull.title, description: pull.body, files, conversation });
  const instructions = join(directory, "instructions.md");
  try {
    writeFileSync(instructions, git(["show", `${run.base}:.github/redline/instructions.md`]));
  } catch {
    rmSync(instructions, { force: true });
    log("No .github/redline/instructions.md on the base branch. Using the default review.");
  }
  log(`Prepared PR #${run.pr} at ${run.head}: ${files.length} changed files, ${conversation.length} discussion entries.`);
});
