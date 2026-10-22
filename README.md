# Redline

Pull request reviews that run in your own actions, with your model and your key.

Redline reads the diff and the code around it, then posts one review on the pull request:

- A merge risk of low, medium or high, with the reason.
- Up to five findings, each as an inline comment on a changed line with a suggested fix.
- What changed, what it checked, and what it couldn't check.

It runs on your runner, with your key. Your code goes to the model provider you pick and nowhere else.

## Setup

1. Add `OPENCODE_API_KEY` under Settings → Secrets and variables → Actions.
2. Add `.github/workflows/redline.yml`:

```yaml
name: redline

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, closed]

concurrency:
  group: redline-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: polimath-labs/redline@v1
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

Open a pull request. Redline posts its review as `github-actions[bot]` a few minutes later.

## Use another model

The default is `opencode-go/glm-5.3-flash`. To change it, change `model` and pass that provider's key:

```yaml
      - uses: polimath-labs/redline@v1
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
        with:
          model: openrouter/anthropic/claude-sonnet-5-5
```

Model names use opencode's `provider/model` format. See the [providers list](https://opencode.ai/docs/providers/).

## Tell it what your team cares about

Add `.github/redline/instructions.md`:

```md
- Every database query must filter by organization.
- Money is stored in cents. Flag any float math on amounts.
- We don't log request bodies.
```

Redline reads this file from the base branch, so a pull request can't change the rules it's reviewed by.

## Inputs

| Input   | Default                     | Description                       |
| ------- | --------------------------- | --------------------------------- |
| `model` | `opencode-go/glm-5.3-flash` | Model in `provider/model` format. |

## How it runs

- The review is an [opencode](https://opencode.ai) agent that can read and search files. It can't run commands, edit files or fetch URLs.
- A new push cancels the running review and starts a fresh one. Closing the pull request cancels it.
- Drafts are skipped until they're marked ready. Pull requests from forks are skipped, so strangers can't hide instructions in a PR that trick the model into leaking your key.
- Reviews are posted with the workflow's own `GITHUB_TOKEN`. Nothing calls our servers.

## License

[MIT](LICENSE)
