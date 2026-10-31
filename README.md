# Redline Review

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![By Polimath Labs](https://img.shields.io/badge/by-Polimath%20Labs-D90036.svg)](https://polimath.dev/)

Redline runs an [opencode](https://opencode.ai) agent in **your** CI runners to review your pull requests. We don't collect any data, however your code goes to the model provider you pick and nowhere else.

Each review posts one comment on the pull request with:

- A merge risk of `low`, `medium`, or `high`, and what to do before merging.
- An inline comment on each finding, anchored to the changed line, with the smallest fix the evidence supports.
- A short list of what changed, what the agent traced, and anything it didn't get to.

A clean pull request gets "Good to merge" and no findings.

## Setup

1. Add your provider's key as a repository secret under Settings → Secrets and variables → Actions. The default model, `opencode-go/glm-5.3-flash`, uses `OPENCODE_API_KEY`. Other providers are in [Models and keys](#models-and-keys).
2. Add the workflow below in `.github/workflows/redline.yml`:

```yaml
name: redline

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, closed]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # Unrelated comments skip the job, so they never start a runner or join the concurrency group.
    if: >-
      github.event_name == 'pull_request_target' ||
      (github.event.issue.pull_request &&
       startsWith(github.event.comment.body, '/redline review') &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association))
    # Automatic and requested reviews share one group per PR. A push cancels a running review; a request waits its turn.
    concurrency:
      group: redline-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: ${{ github.event_name == 'pull_request_target' }}
    runs-on: ubuntu-latest
    steps:
      - uses: polimath-labs/redline@v1
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

3. Merge it into your default branch. `pull_request_target` and `issue_comment` only run workflows from there.

> We use `pull_request_target` and `issue_comment` so the workflow always comes from your default branch. A pull request or a comment shouldn't change how it gets reviewed.

You can now open a pull request, and `github-actions[bot]` posts the review a few minutes later. The workflow needs `pull-requests: write` to post reviews and react to commands, and `contents: read` to check out the code.

Redline runs on Linux x64 runners only, like `ubuntu-latest`.

### Team rules

Put the rules you want enforced in `.github/redline/instructions.md`:

```md
- Every database query must filter by organization.
- Money is stored in cents. Flag any float math on amounts.
- We don't log request bodies.
```

Redline reads this file from the base branch, so a pull request can't rewrite the rules it's reviewed against. For the same reason it ignores `AGENTS.md` and `CLAUDE.md` in the pull request. Put any rules you want enforced into `instructions.md`.

### Models and keys

The default model is `opencode-go/glm-5.3-flash`. To use another, set `model` and pass that provider's key:

```yaml
      - uses: polimath-labs/redline@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-opus-5-5
```

Keys work the way they do when you run opencode in your shell. Each provider reads its usual environment variable. Pick a model that supports tool calls, since the agent reads files and submits its review through tools.

| Provider   | `model` prefix              | Environment variable           |
| ---------- | --------------------------- | ------------------------------ |
| OpenCode   | `opencode/`, `opencode-go/` | `OPENCODE_API_KEY`             |
| Anthropic  | `anthropic/`                | `ANTHROPIC_API_KEY`            |
| OpenAI     | `openai/`                   | `OPENAI_API_KEY`               |
| Google     | `google/`                   | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenRouter | `openrouter/`               | `OPENROUTER_API_KEY`           |
| xAI        | `xai/`                      | `XAI_API_KEY`                  |
| Groq       | `groq/`                     | `GROQ_API_KEY`                 |
| DeepSeek   | `deepseek/`                 | `DEEPSEEK_API_KEY`             |

For anything else, take the model name and variable from opencode's [providers list](https://opencode.ai/docs/providers/).

To change models without touching the workflow, use [`templates/redline.yml`](templates/redline.yml). It reads the model from the `REDLINE_MODEL` repository variable, which you set under Settings → Secrets and variables → Actions → Variables. When it's empty, Redline uses the default.

We recommend using Redline with its own key and with a spending limit. Each review is one agent session, capped at 15 minutes.

## Review status

Every review gives the pull request a merge risk:

| Risk     | Headline                        | Means                                                                        |
| -------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `low`    | Good to merge                   | The review covered every change and found nothing high or medium.            |
| `medium` | Needs a decision before merging | A person should decide. A medium risk level finding or an incomplete review lands here. |
| `high`   | Don't merge yet                 | A high finding, new or still open, needs fixing first.                       |

A high risk fails the run after the review posts, so the pull request shows a failed check. Set `fail_on` to change that:

```yaml
        with:
          fail_on: medium
```

`medium` fails on medium or high, and `never` keeps reviews advisory. To block merging on a failed review, make the `review` check from the `redline` workflow required in branch protection.

## Inputs

| Input          | Default                     | Description                                                            |
| -------------- | --------------------------- | ---------------------------------------------------------------------- |
| `model`        | `opencode-go/glm-5.3-flash` | Model in `provider/model` format.                                      |
| `max_findings` | `10`                        | The most findings one review can post.                                 |
| `fail_on`      | `high`                      | Fail the run at this merge risk or above: `high`, `medium` or `never`. |

## Request a review

Anyone with write, maintain or admin access can ask for another review in a pull request comment:

```text
/redline review
/redline review Check the timeout handling again.
/redline review --full
/redline review --full Focus on the migration.
```

The command must start the comment. Text after it adds focus to the review on top of your team rules, and never replaces them. Redline reacts with 👀 when it accepts the command, and with 😕 when it declines one, such as on a draft. Comments from anyone else are ignored and cost nothing.

- With new commits, Redline reviews what changed since its last review.
- With no new commits, it looks at the pull request again with your instructions and its earlier findings.
- `--full` reviews the whole pull request, ignoring the last review.

Commands need the `issue_comment` trigger and the job's `if` from the [setup](#setup) workflow. Edited comments don't count. Run the workflow from your default branch. Fork, draft and closed pull requests are skipped, the same as for automatic reviews.

## When it runs

- The first review covers the whole pull request. After that, each push reviews only the commits since the last posted review. The agent can still read any file it needs.
- Redline falls back to a full review when the branch was rebased or force-pushed, merged the base branch in, or changed its base branch.
- Every push starts a review and cancels the one in progress. Closing the pull request cancels it too. A requested review waits for the running one to finish.
- A review only counts once it posts. A failed or cancelled run leaves its commits for the next one, and so do commits pushed while a review runs.
- Once a review posts, reopening the pull request or re-running the job with no new commits doesn't start another one. Use `/redline review` to get one.
- Each finding keeps its place across reviews. Later reviews mark it still open or fixed, and only new findings get inline comments.
- Findings that are still open count toward the merge risk, and so do pull request comments.
- Drafts wait until they're marked ready.
- Pull requests over 200 files or 300,000 characters of diff are too large to review. Split them up.
- Lockfiles are left out of the diff.

## Callouts 

- The agent can read and search files. It can't run commands, edit files or fetch URLs.
- Reviews post with the workflow's own `GITHUB_TOKEN`, and the agent never sees it. Nothing calls our servers.
- Redline checks a commenter's access with the GitHub API before it runs. Their instructions reach the agent as a file and never run as a command.
- Redline keeps its progress in a hidden note in its own review. It only trusts notes posted by `github-actions[bot]`.
- Pull requests from forks are skipped. A stranger's pull request could hide instructions that trick the model into leaking your key.
