// src/resolve.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var repository = process.env.GITHUB_REPOSITORY ?? "";
var gh = (...args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: "pipe", timeout: 60000 }));
var output = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/null", `${name}=${value}
`);
function stop(reason) {
  console.log(`::notice::${reason}`);
  output("run", "false");
  process.exit(0);
}
function react(id, content) {
  try {
    gh(`repos/${repository}/issues/comments/${id}/reactions`, "--method", "POST", "-f", `content=${content}`);
  } catch {
    console.log(`::warning::Couldn't react to comment ${id}. The review continues.`);
  }
}
function parse(body) {
  const match = /^\/redline review(?=\s|$)([\s\S]*)$/.exec(body);
  if (!match)
    return;
  const rest = (match[1] ?? "").trim();
  const full = /^--full(?=\s|$)/.test(rest);
  const instructions = (full ? rest.slice(6) : rest).trim().replaceAll(`\r
`, `
`);
  return { full, instructions, valid: !instructions.startsWith("--") && instructions.length <= 4000 };
}
function check(pull) {
  if (pull.state !== "open")
    return "Redline skips closed pull requests.";
  if (pull.draft)
    return "Redline skips draft pull requests.";
  if (pull.head.repo?.full_name !== repository)
    return "Redline skips pull requests from forks.";
  return;
}
var name = process.env.GITHUB_EVENT_NAME;
var event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
var number;
var request = { manual: false, full: false, instructions: "" };
var commentId;
if (name === "pull_request_target" || name === "pull_request") {
  if (event.action === "closed")
    stop("Redline skips closed pull requests.");
  number = event.pull_request?.number;
} else if (name === "issue_comment") {
  const comment = event.comment;
  if (event.action !== "created" || !event.issue?.pull_request || !comment?.id || !comment.user?.login)
    stop("Not a new comment on a pull request.");
  const command = parse(comment.body ?? "");
  if (!command)
    stop("The comment isn't a Redline command.");
  if (comment.user.type !== "User")
    stop("Only people can request a review.");
  let permission = "none";
  try {
    permission = gh(`repos/${repository}/collaborators/${encodeURIComponent(comment.user.login)}/permission`).permission;
  } catch {
    permission = "none";
  }
  if (permission !== "write" && permission !== "admin")
    stop("Only people with write access can request a review.");
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
if (!number)
  stop("The event has no pull request.");
var pull = gh(`repos/${repository}/pulls/${number}`);
var problem = check(pull);
if (problem) {
  if (commentId)
    react(commentId, "confused");
  stop(problem);
}
if (!/^[a-f0-9]{40}$/.test(pull.head.sha) || !/^[a-f0-9]{40}$/.test(pull.base.sha))
  throw new Error("GitHub returned an unexpected pull request.");
if (commentId)
  react(commentId, "eyes");
var trigger = process.env.REDLINE_TRIGGER ?? "";
mkdirSync(dirname(trigger), { recursive: true });
writeFileSync(trigger, JSON.stringify({ pr: pull.number, head: pull.head.sha, base: pull.base.sha, baseRef: pull.base.ref, ...request }, null, 2));
output("run", "true");
output("pr", String(pull.number));
output("head", pull.head.sha);
console.log(`Reviewing PR #${pull.number} at ${pull.head.sha}${request.manual ? " on request" : ""}.`);
