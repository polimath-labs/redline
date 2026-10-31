import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { latestState, plan, stripState } from "./checkpoint";
import { addedLines } from "./diff";
import { api, commentSchema, directory, git, log, main, output, pages, pullSchema } from "./github";
import { marker, readJson, runSchema, triggerSchema } from "./schema";
import type { Context } from "./schema";

const lockfiles = [":(exclude)bun.lock", ":(exclude)package-lock.json", ":(exclude)yarn.lock", ":(exclude)pnpm-lock.yaml"];

function writeJson(name: string, value: unknown) {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
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
  const trigger = readJson(process.env.REDLINE_TRIGGER ?? "", triggerSchema);
  const run = Schema.decodeUnknownSync(runSchema)({
    repository: process.env.GITHUB_REPOSITORY,
    pr: trigger.pr,
    head: trigger.head,
    base: trigger.base,
    maxFindings: Number(process.env.MAX_FINDINGS),
    failOn: process.env.FAIL_ON,
  });
  const endpoint = `repos/${run.repository}/pulls/${run.pr}`;
  const pull = api([endpoint], pullSchema);
  const reviews = pages(`${endpoint}/reviews?per_page=100`, commentSchema);
  const state = latestState(reviews);
  const selected = plan({ ...trigger, state }, {
    mergeBase: (a, b) => git(["merge-base", a, b]).trim(),
    isAncestor: (a, b) => {
      try {
        git(["merge-base", "--is-ancestor", a, b]);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (selected.mode === "skip") {
    log(`${selected.reason} Comment \`/redline review\` to review it again.`);
    output("review", "false");
    return;
  }

  const relevant = (item: typeof commentSchema.Type) => Boolean(item.body) && (item.user?.type === "User" || Boolean(item.body?.startsWith(marker)));
  const entry = (kind: string) => (item: typeof commentSchema.Type) =>
    ({ kind, author: item.user?.login, at: item.created_at ?? item.submitted_at, path: item.path, line: item.line, body: stripState(item.body ?? "") });
  const conversation = [
    ...pages(`repos/${run.repository}/issues/${run.pr}/comments?per_page=100`, commentSchema).filter(relevant).map(entry("comment")),
    ...reviews.filter(relevant).map(entry("review")),
    ...pages(`${endpoint}/comments?per_page=100`, commentSchema).filter(relevant).map(entry("inline")),
  ].toSorted((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  const from = selected.since ?? selected.mergeBase;
  const changedFiles = (start: string) => git(["diff", "--name-only", "-z", "--find-renames", start, run.head]).split("\0").filter(Boolean);
  const diffWith = (start: string, ...flags: string[]) =>
    git(["diff", "--no-ext-diff", "--no-textconv", "--find-renames", ...flags, start, run.head, "--", ".", ...lockfiles]);
  const files = changedFiles(from);
  const diff = diffWith(from);
  if (files.length > 200 || diff.length > 300_000) {
    throw new Error("PR too large to review: split PRs over 200 files or 300,000 diff characters.");
  }
  const functions = diffWith(from, "--function-context");
  // Findings can anchor anywhere the PR adds lines, so a still-relevant line from an earlier commit stays reachable.
  const prDiff = selected.mode === "incremental" ? diffWith(selected.mergeBase) : diff;

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "diff.patch"), diff);
  writeFileSync(join(directory, "functions.patch"), functions);
  writeFileSync(join(directory, "related.md"), related(functions));
  if (selected.mode === "incremental") writeFileSync(join(directory, "pr.patch"), prDiff);
  const context: Context = {
    ...run,
    mode: selected.mode,
    reason: selected.reason,
    since: selected.since,
    baseRef: trigger.baseRef,
    mergeBase: selected.mergeBase,
    nextId: state?.nextId ?? 1,
    previous: state?.findings ?? [],
    addedLines: addedLines(prDiff),
  };
  writeJson("context.json", context);
  writeJson("pr.json", {
    title: pull.title,
    description: pull.body,
    review: { mode: selected.mode, reason: selected.reason, since: selected.since, requested: trigger.manual },
    files,
    ...(selected.mode === "incremental" ? { prFiles: changedFiles(selected.mergeBase) } : {}),
    previousFindings: context.previous,
    conversation,
  });
  if (trigger.instructions) writeFileSync(join(directory, "request.md"), trigger.instructions);
  const instructions = join(directory, "instructions.md");
  try {
    writeFileSync(instructions, git(["show", `${run.base}:.github/redline/instructions.md`]));
  } catch {
    rmSync(instructions, { force: true });
    log("No .github/redline/instructions.md on the base branch. Using the default review.");
  }
  output("review", "true");
  log(`Prepared ${selected.mode} review of PR #${run.pr} at ${run.head}: ${selected.reason} ${files.length} changed files, ${context.previous.length} earlier findings, ${conversation.length} discussion entries.`);
});
