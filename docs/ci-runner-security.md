# CI runner trust boundary

The self-hosted runner must never execute untrusted code from external
contributors. Only the `e2e` job in [`ci.yml`](../.github/workflows/ci.yml)
uses it; every other job runs on GitHub-hosted `ubuntu-latest`.

Two layers keep fork code off the self-hosted box — keep **both**:

1. **Fork guard (`if`)** — the `e2e` job is skipped unless the event is a push
   or a same-repo (non-fork) PR, so fork PRs never schedule it.
2. **Trust-based `runs-on`** — `self-hosted` is selected only for pushes and
   same-repo PRs. The nightly schedule and any fork PR resolve to
   `ubuntu-latest`, so even if layer 1 were removed, fork code still could not
   reach our hardware.

A same-repo (non-fork) PR is trusted because only collaborators can push
branches to this repo.

## Required repo / runner settings

The workflow guards are necessary but not sufficient on their own:

- **Settings → Actions → General → Fork pull request workflows:** require
  approval for **all external contributors** (not just first-time ones).
- **Runner:** keep the self-hosted runner in a runner group scoped to this repo
  only, ideally ephemeral and isolated. GitHub advises against self-hosted
  runners on public repos; these settings plus the guards above are what make
  it safe.
