<p align="center">
  <img src="brand/redline-carmine.svg" width="72" alt="Redline">
</p>

<h1 align="center">redline_</h1>

<p align="center">Pull request reviews that run in your own actions, with your model and your key.</p>

---

Redline reads the diff and the code around it, then posts one review on the pull request:

- A merge risk of low, medium or high, with the reason.
- Up to five findings, each as an inline comment on a changed line with a suggested fix.
- What changed, what it checked, and what it couldn't check.

It runs on your runner, with your key. Your code goes to the model provider you pick and nowhere else.

## Setup

1. Install the [Redline GitHub App](https://github.com/apps/redline) on the repos you want reviewed.
2. Add `OPENCODE_API_KEY` under Settings → Secrets and variables → Actions.
3. Add `.github/workflows/redline.yml`:

```yaml
name: redline

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, closed]

concurrency:
  group: redline-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  id-token: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: polimath-labs/redline@v1
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

Open a pull request. `redline[bot]` posts its review a few minutes later.

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

Redline reads this file from the base branch, so a pull request can't change the rules it's reviewed by. It also follows your `AGENTS.md` if you have one.

## Without the App

Set `use_github_token: true` and give the workflow `pull-requests: write`. Reviews then come from `github-actions[bot]`, and nothing calls our servers.

```yaml
permissions:
  contents: read
  pull-requests: write

# ...

      - uses: polimath-labs/redline@v1
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          use_github_token: true
```

## Inputs

| Input              | Default                     | Description                                           |
| ------------------ | --------------------------- | ----------------------------------------------------- |
| `model`            | `opencode-go/glm-5.3-flash` | Model in `provider/model` format.                     |
| `use_github_token` | `false`                     | Post with the workflow's `GITHUB_TOKEN`, not the App. |

## How it runs

- The review is an [opencode](https://opencode.ai) agent that can read and search files. It can't run commands, edit files or fetch URLs.
- A new push cancels the running review and starts a fresh one. Closing the pull request cancels it.
- Drafts are skipped until they're marked ready. Pull requests from forks are skipped, because GitHub doesn't pass secrets to them.
- With the App, the action trades the run's GitHub OIDC token for a token that can only comment on pull requests in that one repo. That exchange is the only part we host. It never sees your code or your key.

## License

[MIT](LICENSE)
