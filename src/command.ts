import type { Trigger } from "./schema";

export const maxInstructions = 4000;

export type Command = { full: boolean; instructions: string };

// "/redline review [--full] [instructions]" at the very start of a comment. Anything else isn't a command.
export function parseCommand(body: string): Command | "invalid" | undefined {
  const match = /^\/redline review(?=\s|$)([\s\S]*)$/.exec(body);
  if (!match) return undefined;
  let rest = (match[1] ?? "").trim();
  let full = false;
  const flag = /^--full(?=\s|$)/.exec(rest);
  if (flag) {
    full = true;
    rest = rest.slice(flag[0].length).trim();
  } else if (rest.startsWith("--")) {
    return "invalid";
  }
  if (rest.length > maxInstructions) return "invalid";
  return { full, instructions: rest.replaceAll("\r\n", "\n") };
}

export type Permission = { permission: string; user?: { permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } | undefined } | null | undefined };

// Write, maintain and admin all report "write" or "admin" in the legacy field. The permissions object is checked as a fallback.
export function canReview(result: Permission) {
  if (result.permission === "admin" || result.permission === "write") return true;
  const flags = result.user?.permissions;
  return Boolean(flags?.admin || flags?.maintain || flags?.push);
}

export type Pull = {
  number: number;
  state: string;
  draft: boolean;
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string };
};

export type Deps = {
  repository: string;
  pull(number: number): Pull;
  permission(login: string): Permission;
  react(commentId: number, content: "eyes" | "confused"): void;
  log(message: string): void;
};

type Event = {
  action?: string;
  pull_request?: { number?: number };
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string | null; user?: { login?: string; type?: string } | null };
};

export type Resolution = { run: false; reason: string } | { run: true; trigger: Trigger };

const skip = (reason: string): Resolution => ({ run: false, reason });

function pullProblem(pull: Pull, repository: string) {
  if (pull.state !== "open") return "Redline skips closed pull requests.";
  if (pull.draft) return "Redline skips draft pull requests.";
  // Fork PRs are skipped: their files could prompt-inject the model into leaking the user's API key.
  if (pull.head.repo?.full_name !== repository) return "Redline skips pull requests from forks.";
  return undefined;
}

// Turns a workflow event into a pinned review request, or a reason not to run. Nothing here calls the model.
export function resolve(eventName: string, event: Event, deps: Deps): Resolution {
  if (eventName === "pull_request_target" || eventName === "pull_request") {
    if (event.action === "closed") return skip("Redline skips closed pull requests.");
    const number = event.pull_request?.number;
    if (!number) return skip("The event has no pull request.");
    const pull = deps.pull(number);
    const problem = pullProblem(pull, deps.repository);
    if (problem) return skip(problem);
    return { run: true, trigger: toTrigger(pull, false, { full: false, instructions: "" }) };
  }

  if (eventName !== "issue_comment") return skip(`Redline doesn't handle ${eventName} events.`);
  if (event.action !== "created") return skip("Redline only reads new comments.");
  if (!event.issue?.pull_request || !event.issue.number) return skip("The comment isn't on a pull request.");
  const comment = event.comment;
  if (!comment?.id || !comment.user?.login) return skip("The event has no comment.");
  const parsed = parseCommand(comment.body ?? "");
  if (parsed === undefined) return skip("The comment isn't a Redline command.");
  if (comment.user.type !== "User") return skip("Only people can request a review.");

  let allowed = false;
  try {
    allowed = canReview(deps.permission(comment.user.login));
  } catch {
    allowed = false;
  }
  if (!allowed) return skip("Only people with write access can request a review.");

  const decline = (reason: string) => {
    tryReact(deps, comment.id!, "confused");
    return skip(reason);
  };
  if (parsed === "invalid") {
    return decline(`Unsupported command. Use /redline review, optionally with --full, then instructions under ${maxInstructions} characters.`);
  }
  const pull = deps.pull(event.issue.number);
  const problem = pullProblem(pull, deps.repository);
  if (problem) return decline(problem);
  tryReact(deps, comment.id, "eyes");
  return { run: true, trigger: toTrigger(pull, true, parsed) };
}

function toTrigger(pull: Pull, manual: boolean, command: Command): Trigger {
  return { pr: pull.number, head: pull.head.sha, base: pull.base.sha, baseRef: pull.base.ref, manual, ...command };
}

function tryReact(deps: Deps, commentId: number, content: "eyes" | "confused") {
  try {
    deps.react(commentId, content);
  } catch {
    deps.log(`Couldn't react to comment ${commentId}. The review continues.`);
  }
}
