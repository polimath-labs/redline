import { encodeState } from "./checkpoint";
import { safeText } from "./github";
import { marker } from "./schema";
import type { Context, Review, State, StoredFinding } from "./schema";

type Finding = Review["findings"][number];

const label = { high: "High", medium: "Medium", low: "Low" };
const headline = { low: "Good to merge", medium: "Needs a decision before merging", high: "Don't merge yet" };
const priority = { high: 0, medium: 1, low: 2 };
const readme = "https://github.com/polimath-labs/redline#readme";

const list = (items: readonly string[]) => items.map((item) => `- ${safeText(item)}`).join("\n");
const cell = (text: string) => safeText(text).replaceAll("|", "\\|");
const explain = (finding: Finding) => `${safeText(finding.problem)}\n\n**Fix.** ${safeText(finding.fix)}`;
const short = (sha: string) => sha.slice(0, 7);

// The state this review records. It points at the head the run was pinned to, never a later one.
export function nextState(context: Context, review: Review): { state: State; added: StoredFinding[]; open: StoredFinding[]; fixed: StoredFinding[] } {
  const status = new Map(review.previous.map((entry) => [entry.id, entry.status]));
  const kept = context.previous.filter((finding) => status.get(finding.id) !== "fixed");
  const fixed = context.previous.filter((finding) => status.get(finding.id) === "fixed");
  const added = review.findings.map((finding, index) => ({ id: `F${context.nextId + index}`, ...finding, commit: context.head }));
  const open = [...added, ...kept].toSorted((a, b) => priority[a.severity] - priority[b.severity]);
  return {
    state: {
      version: 1,
      head: context.head,
      baseRef: context.baseRef,
      mergeBase: context.mergeBase,
      nextId: context.nextId + added.length,
      findings: open,
    },
    added,
    open,
    fixed,
  };
}

export type Rendered = {
  body: string;
  fallbackBody: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
};

export function render(context: Context, review: Review, author: { login: string; type: string } | null, posted: ReadonlySet<string | null>): Rendered {
  const { state, added, open, fixed } = nextState(context, review);
  const isNew = new Set(added.map((finding) => finding.id));
  const tracked = context.previous.length > 0;
  const location = (finding: StoredFinding) => {
    const path = finding.path.split("/").map(encodeURIComponent).join("/").replaceAll("(", "%28").replaceAll(")", "%29");
    return `[\`${cell(finding.path.split("/").at(-1) ?? finding.path)}:${finding.line}\`](https://github.com/${context.repository}/blob/${finding.commit}/${path}#L${finding.line})`;
  };
  const comments = added
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT" as const,
      body: `${marker}\n**${label[finding.severity]} · ${safeText(finding.title)}**\n\n${explain(finding)}`,
    }))
    .filter((comment) => !posted.has(comment.body));

  const table = open.length === 0 ? "No open findings." : [
    tracked ? "| Severity | Finding | Location | Status |" : "| Severity | Finding | Location |",
    tracked ? "|---|---|---|---|" : "|---|---|---|",
    ...open.map((finding) => {
      const row = `| ${label[finding.severity]} | ${cell(finding.title)} | ${location(finding)} |`;
      return tracked ? `${row} ${isNew.has(finding.id) ? "New" : "Still open"} |` : row;
    }),
  ].join("\n");
  const resolved = fixed.length === 0 ? "" :
    `<details>\n<summary>Fixed since the last review (${fixed.length})</summary>\n\n${list(fixed.map((finding) => finding.title))}\n\n</details>`;
  const incomplete = review.status === "incomplete" ? "This review didn't cover every change. The list below says what's left." : "";
  const gaps = review.gaps.length === 0 ? "" :
    `<details${incomplete ? " open" : ""}>\n<summary>Still to check (${review.gaps.length})</summary>\n\n${list(review.gaps)}\n\n</details>`;
  const mention = review.mergeRisk.level !== "low" && author?.type === "User" ? `@${author.login}` : "";
  const commit = (sha: string) => `[\`${short(sha)}\`](https://github.com/${context.repository}/commit/${sha})`;
  const scope = context.mode === "incremental" && context.since
    ? `Review of changes from ${commit(context.since)} to ${commit(context.head)}`
    : context.mode === "revisit" ? `Review of ${commit(context.head)} on request` : `Review of ${commit(context.head)}`;
  const body = (...extra: string[]) => [
    marker,
    `## ${headline[review.mergeRisk.level]}`,
    mention,
    `**${label[review.mergeRisk.level]} merge risk.** ${safeText(review.mergeRisk.reason)}`,
    table,
    resolved,
    `**What changed**\n\n${list(review.changes)}`,
    `<details>\n<summary>What I checked (${review.checked.length})</summary>\n\n${list(review.checked)}\n\n</details>`,
    incomplete,
    gaps,
    ...extra,
    `<sub>${scope} via [Redline](${readme})</sub>`,
    encodeState(state),
  ].filter(Boolean).join("\n\n");

  return {
    body: body(),
    fallbackBody: body(...added.map((finding) => `### ${label[finding.severity]} · ${safeText(finding.title)}\n\n${location(finding)}\n\n${explain(finding)}`)),
    comments,
  };
}
