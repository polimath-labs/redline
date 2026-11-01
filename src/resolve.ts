// Decides whether this event starts a review and pins it to the PR's current head.
// It imports nothing heavy so it runs before checkout and installs, and costs nothing when it declines.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Pull = { number: number; state: string; draft: boolean; head: { sha: string; repo: { full_name: string } | null }; base: { sha: string; ref: string } };
type Event = {
  action?: string;
  pull_request?: { number?: number };
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string | null; user?: { login?: string; type?: string } | null };
};

const repository = process.env.GITHUB_REPOSITORY ?? "";
const gh = (...args: string[]): unknown => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: "pipe", timeout: 60_000 }));
const output = (name: string, value: string) => appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/null", `${name}=${value}\n`);

function stop(reason: string): never {
  console.log(`::notice::${reason}`);
  output("run", "false");
  process.exit(0);
}

function react(id: number, content: "eyes" | "confused") {
  try {
    gh(`repos/${repository}/issues/comments/${id}/reactions`, "--method", "POST", "-f", `content=${content}`);
  } catch {
    console.log(`::warning::Couldn't react to comment ${id}. The review continues.`);
  }
}

// "/redline review [--full] [instructions]" at the very start of a comment.
function parse(body: string) {
  const match = /^\/redline review(?=\s|$)([\s\S]*)$/.exec(body);
  if (!match) return undefined;
  const rest = (match[1] ?? "").trim();
  const full = /^--full(?=\s|$)/.test(rest);
  const instructions = (full ? rest.slice(6) : rest).trim().replaceAll("\r\n", "\n");
  return { full, instructions, valid: !instructions.startsWith("--") && instructions.length <= 4000 };
}

function check(pull: Pull) {
  if (pull.state !== "open") return "Redline skips closed pull requests.";
  if (pull.draft) return "Redline skips draft pull requests.";
  // Fork PRs are skipped: their files could prompt-inject the model into leaking the user's API key.
  if (pull.head.repo?.full_name !== repository) return "Redline skips pull requests from forks.";
  return undefined;
}

const name = process.env.GITHUB_EVENT_NAME;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as Event;
let number: number | undefined;
let request = { manual: false, full: false, instructions: "" };
let commentId: number | undefined;

if (name === "pull_request_target" || name === "pull_request") {
  if (event.action === "closed") stop("Redline skips closed pull requests.");
  number = event.pull_request?.number;
} else if (name === "issue_comment") {
  const comment = event.comment;
  if (event.action !== "created" || !event.issue?.pull_request || !comment?.id || !comment.user?.login) stop("Not a new comment on a pull request.");
  const command = parse(comment.body ?? "");
  if (!command) stop("The comment isn't a Redline command.");
  if (comment.user.type !== "User") stop("Only people can request a review.");
  // Ask GitHub for the commenter's access. Write, maintain and admin all report write or admin here.
  let permission = "none";
  try {
    permission = (gh(`repos/${repository}/collaborators/${encodeURIComponent(comment.user.login)}/permission`) as { permission: string }).permission;
  } catch {
    permission = "none";
  }
  if (permission !== "write" && permission !== "admin") stop("Only people with write access can request a review.");
  commentId = comment.id;
  if (!command.valid) {
    react(commentId, "confused");
    stop("Unsupported command. Use /redline review, optionally --full, then instructions under 4,000 characters.");
  }
  number = event.issue.number;
  request = { manual: true, full: command.full, instructions: command.instructions };
} else {
  stop(`Redline doesn't handle ${name} events.`);
}

if (!number) stop("The event has no pull request.");
const pull = gh(`repos/${repository}/pulls/${number}`) as Pull;
const problem = check(pull);
if (problem) {
  if (commentId) react(commentId, "confused");
  stop(problem);
}
if (!/^[a-f0-9]{40}$/.test(pull.head.sha) || !/^[a-f0-9]{40}$/.test(pull.base.sha)) throw new Error("GitHub returned an unexpected pull request.");
if (commentId) react(commentId, "eyes");

// The request, with any instructions, goes to a file. Only the PR number and head SHA reach step outputs.
const trigger = process.env.REDLINE_TRIGGER ?? "";
mkdirSync(dirname(trigger), { recursive: true });
writeFileSync(trigger, JSON.stringify({ pr: pull.number, head: pull.head.sha, base: pull.base.sha, baseRef: pull.base.ref, ...request }, null, 2));
output("run", "true");
output("pr", String(pull.number));
output("head", pull.head.sha);
console.log(`Reviewing PR #${pull.number} at ${pull.head.sha}${request.manual ? " on request" : ""}.`);
