import { join } from "node:path";
import { Schema } from "effect";
import { api, command, commentSchema, directory, log, main, pages, pullSchema, safeText } from "./github";
import { contextSchema, errorMessage, marker, readJson, validateReview } from "./schema";
import type { reviewSchema } from "./schema";

type Finding = (typeof reviewSchema.Type)["findings"][number];

const label = { high: "High", medium: "Medium", low: "Low" };
const headline = { low: "Good to merge", medium: "Needs a decision before merging", high: "Don't merge yet" };
const rank = { low: 0, medium: 1, high: 2, never: 3 };
const logo = "https://raw.githubusercontent.com/polimath-labs/redline/main/brand/png/redline-carmine-32.png";
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

  const table = report.findings.length === 0 ? "No findings." : [
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
    `**What changed**\n\n${list(report.changes)}`,
    `<details>\n<summary>What I checked (${report.checked.length})</summary>\n\n${list(report.checked)}\n\n</details>`,
    incomplete,
    gaps,
    ...extra,
    `<sub><img src="${logo}" width="12" height="12" alt=""> Review of [\`${context.head.slice(0, 7)}\`](https://github.com/${context.repository}/commit/${context.head}) via [Redline](${readme})</sub>`,
  ].filter(Boolean).join("\n\n");
  const post = (review: { body: string; comments: typeof comments }) =>
    command("gh", ["api", `${endpoint}/reviews`, "--method", "POST", "--input", "-"], JSON.stringify({ commit_id: context.head, event: "COMMENT", ...review }));

  try {
    post({ body: body(), comments });
    log(`Posted ${report.mergeRisk.level}-risk review on PR #${context.pr} with ${comments.length} inline comments.`);
  } catch (error) {
    log(`Inline comments rejected, posting findings in the summary: ${errorMessage(error)}`);
    post({ body: body(...report.findings.map((finding) => `### ${label[finding.severity]} · ${safeText(finding.title)}\n\n${location(finding)}\n\n${explain(finding)}`)), comments: [] });
    log(`Posted ${report.mergeRisk.level}-risk review on PR #${context.pr} with findings in the summary.`);
  }
  if (rank[report.mergeRisk.level] >= rank[context.failOn]) {
    console.log(`::error::Redline found ${report.mergeRisk.level} merge risk. See the review on PR #${context.pr}.`);
    process.exitCode = 1;
  }
});
