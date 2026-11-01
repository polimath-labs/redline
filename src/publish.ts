import { join } from "node:path";
import { Schema } from "effect";
import { api, command, commentSchema, directory, log, main, pages, pullSchema, safeText } from "./github";
import { contextSchema, errorMessage, marker, readJson, validateReview } from "./schema";
import type { reviewSchema } from "./schema";

type Finding = (typeof reviewSchema.Type)["findings"][number];

const label = { high: "High", medium: "Medium", low: "Low" };
const headline = { low: "Good to merge", medium: "Needs a decision before merging", high: "Don't merge yet" };
const rank = { low: 0, medium: 1, high: 2, never: 3 };
const readme = "https://github.com/polimath-labs/redline#readme";

const list = (items: readonly string[]) => items.map((item) => `- ${safeText(item)}`).join("\n");
const cell = (text: string) => safeText(text).replaceAll("|", "\\|");
const explain = (finding: Finding) => `${safeText(finding.problem)}\n\n**Fix.** ${safeText(finding.fix)}`;

main(() => {
  const context = readJson(join(directory, "context.json"), contextSchema);
  const report = validateReview(readJson(join(directory, "review.json"), Schema.Unknown), context);
  const endpoint = `repos/${context.repository}/pulls/${context.pr}`;
  const pull = api([endpoint], pullSchema);
  if (pull.state !== "open" || pull.draft || pull.head.sha !== context.head) {
    log("Review not posted: the PR changed while it was being reviewed.");
    return;
  }

  const posted = new Set(pages(`${endpoint}/comments?per_page=100`, commentSchema).map((item) => item.body));
  const location = (finding: Finding) => {
    const path = finding.path.split("/").map(encodeURIComponent).join("/").replaceAll("(", "%28").replaceAll(")", "%29");
    return `[\`${cell(finding.path.split("/").at(-1) ?? finding.path)}:${finding.line}\`](https://github.com/${context.repository}/blob/${context.head}/${path}#L${finding.line})`;
  };
  const comments = report.findings
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: `${marker}\n**${label[finding.severity]} · ${safeText(finding.title)}**\n\n${explain(finding)}`,
    }))
    .filter((comment) => !posted.has(comment.body));

  const fixed = new Set(report.previous.filter((entry) => entry.status === "fixed").map((entry) => entry.id));
  const earlier = (status: boolean) => context.previous.filter((finding) => fixed.has(finding.id) === status);
  const link = (finding: (typeof context.previous)[number]) => `- [${safeText(finding.title)}](${finding.url})`;
  const stillOpen = earlier(false).length === 0 ? "" : `**Still open from earlier reviews**\n\n${earlier(false).map(link).join("\n")}`;
  const resolved = earlier(true).length === 0 ? "" : `**Fixed since the last review**\n\n${earlier(true).map(link).join("\n")}`;
  const scope = context.mode === "incremental" && context.since
    ? `changes from [\`${context.since.slice(0, 7)}\`](https://github.com/${context.repository}/commit/${context.since}) to `
    : "";
  const table = report.findings.length === 0 ? (context.previous.length > 0 ? "No new findings." : "No findings.") : [
    "| Severity | Finding | Location |",
    "|---|---|---|",
    ...report.findings.map((finding) => `| ${label[finding.severity]} | ${cell(finding.title)} | ${location(finding)} |`),
  ].join("\n");
  const incomplete = report.status === "incomplete" ? "This review didn't cover every change. The list below says what's left." : "";
  const gaps = report.gaps.length === 0 ? "" :
    `<details${incomplete ? " open" : ""}>\n<summary>Still to check (${report.gaps.length})</summary>\n\n${list(report.gaps)}\n\n</details>`;
  const mention = report.mergeRisk.level !== "low" && pull.user?.type === "User" ? `@${pull.user.login}` : "";
  const body = (...extra: string[]) => [
    marker,
    `## ${headline[report.mergeRisk.level]}`,
    mention,
    `**${label[report.mergeRisk.level]} merge risk.** ${safeText(report.mergeRisk.reason)}`,
    table,
    stillOpen,
    resolved,
    `**What changed**\n\n${list(report.changes)}`,
    `<details>\n<summary>What I checked (${report.checked.length})</summary>\n\n${list(report.checked)}\n\n</details>`,
    incomplete,
    gaps,
    ...extra,
    `<sub>Review of ${scope}[\`${context.head.slice(0, 7)}\`](https://github.com/${context.repository}/commit/${context.head}) via [Redline](${readme})</sub>`,
    // The next run checks this to catch a pull request moved to another base branch.
    `<!-- redline:base ${encodeURIComponent(context.baseRef)} -->`,
  ].filter(Boolean).join("\n\n");
  const post = (review: { body: string; comments: typeof comments }) =>
    command("gh", ["api", `${endpoint}/reviews`, "--method", "POST", "--input", "-"], JSON.stringify({ commit_id: context.head, event: "COMMENT", ...review }));

  try {
    post({ body: body(), comments });
    log(`Posted ${report.mergeRisk.level}-risk ${context.mode} review on PR #${context.pr} with ${comments.length} inline comments.`);
  } catch (error) {
    log(`Inline comments rejected, posting findings in the summary: ${errorMessage(error)}`);
    post({ body: body(...report.findings.map((finding) => `### ${label[finding.severity]} · ${safeText(finding.title)}\n\n${location(finding)}\n\n${explain(finding)}`)), comments: [] });
    log(`Posted ${report.mergeRisk.level}-risk ${context.mode} review on PR #${context.pr} with findings in the summary.`);
  }
  // Resolve threads only after the review posted, so a failed run leaves every finding open.
  for (const finding of earlier(true)) {
    try {
      command("gh", ["api", "graphql", "-f", "query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }", "-f", `id=${finding.thread}`]);
    } catch (error) {
      log(`Couldn't resolve the thread for "${safeText(finding.title)}": ${errorMessage(error)}`);
    }
  }
  if (earlier(true).length > 0) log(`Resolved ${earlier(true).length} fixed findings.`);
  if (rank[report.mergeRisk.level] >= rank[context.failOn]) {
    console.log(`::error::Redline found ${report.mergeRisk.level} merge risk. See the review on PR #${context.pr}.`);
    process.exitCode = 1;
  }
});
