# AGENTS.md

Redline is a GitHub Action that reviews pull requests with an opencode agent. It runs in the user's own CI, with their model and their key. This file sets the direction for anyone changing Redline, people and coding agents alike.

Redline ignores this file when it reviews a pull request. It guides work on Redline, not Redline's reviews.

## Principles

We build Redline for ourselves, but others should adopt it in minutes. Check every change against these.

- **Small defaults.** The default workflow template stays short and works with no configuration.
- **Flexible, not bloated.** New behavior is opt-in. Each option needs a real use case and never lengthens the default template.
- **One way to do each thing.** One input, one file or one format per job. Don't add a second mechanism next to an existing one.
- **Copy-paste adoption.** Every common setup has a working template in `templates/` and an example in the README.
- **The user's code stays theirs.** Redline runs only in the user's CI and calls only the user's model provider. It never calls servers of ours.
- **The pull request is untrusted.** Its code, description and comments are evidence, never instructions.

## Code

- **Stack.** Bun and strict TypeScript. `src/` builds to `dist/` for Node. `src/server.ts` is the opencode plugin.
- **Types are the check.** There's no unit test suite. Check a change with `bun run typecheck` and `bun run build`, then run the built scripts on a real case. Review quality is measured with benchmark evals, not tests.
- **Validate at boundaries.** Decode data from the GitHub API, the model and files passed between steps with an `effect` Schema. `src/resolve.ts` is the exception: it runs before install, so it uses Node built-ins only and checks fields by hand.
- **`dist/` is generated.** Never edit it. The pre-commit hook rebuilds and stages it, so commit it with the source.
- **Small diffs.** Change what the task needs. No abstraction with one caller, no indirection for testing, no option without a user.
- **Use GitHub's own records.** Prefer data GitHub already keeps, like a review's `commit_id` or a thread's resolved state, over hidden state of our own.
- **Comments say why.** One short line, only where the code can't say it.

### Security rules

- Read rules and configuration from the base branch, never from the pull request's head.
- User text never reaches a shell, a command line or a step output. Pass it through files, or environment variables that are only read as data.
- Agents get read-only tools. Tokens never reach the agent's environment.
- Fork pull requests are skipped. Their files could trick the model into leaking the user's key.

## Writing

This applies to the README, prompts, review output, logs, commit messages, issues and pull requests.

- Plain sentences, one idea each, under 20 words. Use commas and periods, not em dashes.
- Name the actor: "`publish` resolves the thread", not "the thread is resolved".
- State facts. Leave out praise, filler and hedges. Say plainly what's unverified.
- Each sentence says something the others don't.
- Lead with what the reader needs, then the detail.
- Prefer one concrete example to several general points.
