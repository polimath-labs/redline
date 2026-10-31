import { join } from "node:path";
import { Schema } from "effect";
import { api, command, commentSchema, directory, log, main, pages, pullSchema } from "./github";
import { render } from "./report";
import { contextSchema, errorMessage, readJson, validateReview } from "./schema";

const rank = { low: 0, medium: 1, high: 2, never: 3 };

main(() => {
  const context = readJson(join(directory, "context.json"), contextSchema);
  const report = validateReview(readJson(join(directory, "review.json"), Schema.Unknown), context);
  const endpoint = `repos/${context.repository}/pulls/${context.pr}`;
  const pull = api([endpoint], pullSchema);
  // Commits pushed during the run stay pending: the review and its checkpoint only post for the pinned head.
  if (pull.state !== "open" || pull.draft || pull.head.sha !== context.head) {
    log("Review not posted: the PR changed while it was being reviewed.");
    return;
  }

  const posted = new Set(pages(`${endpoint}/comments?per_page=100`, commentSchema).map((item) => item.body));
  const rendered = render(context, report, pull.user, posted);
  const post = (review: { body: string; comments: typeof rendered.comments }) =>
    command("gh", ["api", `${endpoint}/reviews`, "--method", "POST", "--input", "-"], JSON.stringify({ commit_id: context.head, event: "COMMENT", ...review }));

  try {
    post({ body: rendered.body, comments: rendered.comments });
    log(`Posted ${report.mergeRisk.level}-risk ${context.mode} review on PR #${context.pr} with ${rendered.comments.length} inline comments.`);
  } catch (error) {
    log(`Inline comments rejected, posting findings in the summary: ${errorMessage(error)}`);
    post({ body: rendered.fallbackBody, comments: [] });
    log(`Posted ${report.mergeRisk.level}-risk ${context.mode} review on PR #${context.pr} with findings in the summary.`);
  }
  if (rank[report.mergeRisk.level] >= rank[context.failOn]) {
    console.log(`::error::Redline found ${report.mergeRisk.level} merge risk. See the review on PR #${context.pr}.`);
    process.exitCode = 1;
  }
});
