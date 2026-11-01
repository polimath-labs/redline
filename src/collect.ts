import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { api, command, commentSchema, directory, log, main, output, pages, pullSchema } from "./github";
import { marker, readJson, runSchema, triggerSchema } from "./schema";

const lockfiles = [":(exclude)bun.lock", ":(exclude)package-lock.json", ":(exclude)yarn.lock", ":(exclude)pnpm-lock.yaml"];

function git(args: string[]) {
  return command("git", ["-c", "core.quotePath=false", ...args]);
}

// Redline's own inline comments, unresolved, are the findings still open from earlier reviews.
const threadSchema = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  comments: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ databaseId: Schema.Number, url: Schema.String, body: Schema.String, author: Schema.NullOr(Schema.Struct({ login: Schema.String })) })),
  }),
});
const threadsQuery = `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved path line comments(first: 1) { nodes { databaseId url body author { login } } } }
  } } }
}`;
const heading = /^\*\*(High|Medium|Low) · (.+)\*\*$/m;

function previousFindings(repository: string, pr: number) {
  const [owner, repo] = repository.split("/");
  const lines = command("gh", ["api", "graphql", "--paginate", "--jq", ".data.repository.pullRequest.reviewThreads.nodes[]",
    "-f", `query=${threadsQuery}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `pr=${pr}`]);
  return lines.split("\n").filter(Boolean).flatMap((line) => {
    const thread = Schema.decodeUnknownSync(threadSchema)(JSON.parse(line));
    const first = thread.comments.nodes[0];
    const bot = first?.author?.login === "github-actions" || first?.author?.login === "github-actions[bot]";
    const match = !thread.isResolved && bot && first?.body.startsWith(marker) ? heading.exec(first.body) : null;
    if (!first || !match?.[1] || !match[2]) return [];
    const severity = match[1].toLowerCase() as "high" | "medium" | "low";
    return [{ id: first.databaseId, thread: thread.id, severity, title: match[2], path: thread.path, line: thread.line, url: first.url }];
  });
}

function isAncestor(ancestor: string, head: string) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, head]);
    return true;
  } catch {
    return false;
  }
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
  const relevant = (item: typeof commentSchema.Type) => Boolean(item.body) && (item.user?.type === "User" || Boolean(item.body?.startsWith(marker)));
  const entry = (kind: string) => (item: typeof commentSchema.Type) =>
    ({ kind, author: item.user?.login, at: item.created_at ?? item.submitted_at, path: item.path, line: item.line, body: item.body });
  const conversation = [
    ...pages(`repos/${run.repository}/issues/${run.pr}/comments?per_page=100`, commentSchema).filter(relevant).map(entry("comment")),
    ...reviews.filter(relevant).map(entry("review")),
    ...pages(`${endpoint}/comments?per_page=100`, commentSchema).filter(relevant).map(entry("inline")),
  ].toSorted((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  // The checkpoint is the commit Redline's last posted review covered. Only the workflow's own reviews count.
  const last = reviews.findLast((review) => review.user?.login === "github-actions[bot]" && review.body?.startsWith(marker) && review.commit_id);
  const since = last?.commit_id ?? undefined;
  const lastBase = /<!-- redline:base (\S+) -->/.exec(last?.body ?? "")?.[1];
  const mergeBase = git(["merge-base", run.base, run.head]).trim();
  const plan = (): { mode: "full" | "incremental" | "revisit" | "skip"; reason: string } => {
    if (trigger.full) return { mode: "full", reason: "Full review requested." };
    if (!since) return { mode: "full", reason: "First review of this pull request." };
    if (lastBase !== encodeURIComponent(trigger.baseRef)) return { mode: "full", reason: "The base branch changed since the last review." };
    if (since === run.head) {
      return trigger.manual
        ? { mode: "revisit", reason: "Requested again with no new commits." }
        : { mode: "skip", reason: `No new commits since the review of ${since.slice(0, 7)}.` };
    }
    if (!isAncestor(since, run.head)) return { mode: "full", reason: `The last reviewed commit ${since.slice(0, 7)} is no longer in this branch.` };
    if (git(["merge-base", run.base, since]).trim() !== mergeBase) return { mode: "full", reason: "The branch merged in new commits from the base branch." };
    return { mode: "incremental", reason: `Changes since ${since.slice(0, 7)}.` };
  };
  const { mode, reason } = plan();
  if (mode === "skip") {
    log(`${reason} Comment \`/redline review\` to review it again.`);
    output("review", "false");
    return;
  }

  const from = mode === "incremental" && since ? since : mergeBase;
  const files = git(["diff", "--name-only", "-z", "--find-renames", from, run.head]).split("\0").filter(Boolean);
  const diffWith = (start: string, ...flags: string[]) =>
    git(["diff", "--no-ext-diff", "--no-textconv", "--find-renames", ...flags, start, run.head, "--", ".", ...lockfiles]);
  const diff = diffWith(from);
  if (files.length > 200 || diff.length > 300_000) {
    throw new Error("PR too large to review: split PRs over 200 files or 300,000 diff characters.");
  }
  const functions = diffWith(from, "--function-context");
  // New findings can anchor anywhere the PR adds lines, not only in the new commits.
  const prDiff = from === mergeBase ? diff : diffWith(mergeBase);
  const previous = previousFindings(run.repository, run.pr);

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "diff.patch"), diff);
  writeFileSync(join(directory, "functions.patch"), functions);
  writeFileSync(join(directory, "related.md"), related(functions));
  if (prDiff !== diff) writeFileSync(join(directory, "pr.patch"), prDiff);
  if (trigger.instructions) writeFileSync(join(directory, "request.md"), trigger.instructions);
  writeJson("context.json", { ...run, mode, since: mode === "incremental" ? since : null, baseRef: trigger.baseRef, previous, addedLines: addedLines(prDiff) });
  writeJson("pr.json", {
    title: pull.title,
    description: pull.body,
    review: { mode, reason, since: mode === "incremental" ? since : null },
    files,
    previousFindings: previous.map(({ thread, url, ...finding }) => finding),
    conversation,
  });
  const instructions = join(directory, "instructions.md");
  try {
    writeFileSync(instructions, git(["show", `${run.base}:.github/redline/instructions.md`]));
  } catch {
    rmSync(instructions, { force: true });
    log("No .github/redline/instructions.md on the base branch. Using the default review.");
  }
  output("review", "true");
  log(`Prepared ${mode} review of PR #${run.pr} at ${run.head}. ${reason} ${files.length} changed files, ${previous.length} open findings, ${conversation.length} discussion entries.`);
});
