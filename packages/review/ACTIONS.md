# Copse Reviewer on another repository

The reusable workflow runs entirely on the adopter's GitHub-hosted runners.
It calls two Actions on separate runners: credential-free grounding, then model
review and publishing. There is no Copse server. Mention commands and code edits
are not part of this initial release.

## Supported projects

The first portable shell targets public github.com TypeScript projects using npm,
with a root `package-lock.json` (v2 or v3). Every dependency must resolve to an
integrity-pinned HTTPS tarball on `registry.npmjs.org`; local/workspace links, git
dependencies and private registries are rejected. Private repositories, monorepo
workspace links and a general portable pnpm shell are follow-ups. Copse itself uses
this same workflow with the restricted `copse-pnpm` preparation profile.

The Action fetches only validated registry tarballs on the trusted host. It
does not execute a contributor manifest, `.npmrc`, install script or check there.
Installs, checks and model-requested verification execute in network-disabled
containers with a read-only root and scrubbed environment. Each checkout gets a
private writable copy of the read-only dependency cache. Lifecycle scripts are
disabled during installation; a project requiring native dependency builds needs
a separately reviewed preparation policy before adopting this shell.

## Installation

1. Add a repository secret `COPSE_REVIEW_API_KEY` containing an OpenRouter key.
2. Add both workflows below on the repository's default branch. Replace both occurrences
   of `REVIEWER_SHA` with the same reviewed full 40-character Copse commit SHA.
3. Enable workflow PR writes if the repository or organization restricts them.

The PR-side request workflow (`.github/workflows/copse-review-request.yml`) is
credential-free and executes no contributor code:

```yaml
name: Copse review request
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
permissions: {}
jobs:
  request:
    if: github.event.pull_request.head.repo.id == github.event.repository.id
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - run: echo 'Copse review requested'
```

The reviewer caller (`.github/workflows/copse-review.yml`) runs trusted code from
the default branch after that request, or through manual dispatch:

```yaml
name: Copse review

on:
  workflow_run:
    workflows: [Copse review request]
    types: [completed]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: number

permissions: {}

jobs:
  review:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_repository.id == github.event.repository.id)
    permissions:
      contents: read
      pull-requests: write
    uses: copse-dev/agent-pane/.github/workflows/reviewer.yml@REVIEWER_SHA
    with:
      reviewer-ref: REVIEWER_SHA
      pr: ${{ github.event.workflow_run.pull_requests[0].number || fromJSON(inputs.pr || '0') }}
    secrets:
      model-api-key: ${{ secrets.COPSE_REVIEW_API_KEY }}
```

The `fromJSON` conversion passes the dispatch value as a number to the reusable
workflow, rather than forwarding its string representation.

The caller grants the maximum permissions available to the reusable workflow;
its grounding job reduces that grant to `permissions: {}`. Only the findings
job receives the model key. `model-api-key` is optional in the reusable interface
because Copse obtains its key from a protected environment; npm callers must pass it
and authorization fails early when it is absent. Both the workflow and the reviewer
source are pinned,
so a change to Copse's main branch cannot change an installed reviewer's behavior.
The Actions currently install their trusted source dependencies from that pinned
checkout; no published npm package, release tag or prebuilt image is required.
The validation image is built on each runner from the trusted Dockerfile.

Same-repository PRs request automatic reviews when opened, reopened, updated or
marked ready. The credential-free request completes first; `workflow_run` then
loads the reviewer caller from the default branch with its repository secrets,
including for Dependabot. The reviewer validates the request's workflow path,
repository and unique PR, then checks that the current head still
matches the request. No request artifacts or PR-side code are imported into the
trusted runner. If GitHub omits the PR association (as it can for Dependabot),
the reviewer resolves a unique open PR by the exact branch, repository and commit.

Manual reviews remain available: open Actions → Copse review → Run workflow,
select the default branch and enter the PR number, or use
`gh workflow run copse-review.yml --ref main -f pr=123` (replace `main` with your
default branch). Human initiating/rerunning actors must have write permission;
Dependabot can automatically request reviews only for its own same-repository PRs.
Both the PR head and base must belong to the caller repository and target its
default branch. Fork PRs are rejected even when dispatched by a maintainer.
Drafts need `copse-review`; adding that label alone does not start a run, so push,
mark ready or dispatch manually. `copse-review-skip` opts out. Description edits
and feedback labels do not request another review, preventing publication loops.

The two jobs share a grounding artifact from the same run and attempt, not an
arbitrary earlier run. The CLI validates its shape, head and merge-base before
using it. Publishing rechecks the head/base, open state and opt-out labels before
each mutation, so a stale run cannot supersede current findings. GitHub does not
offer an atomic conditional review API, so a push can still race the final API
call; every posted review is anchored to its exact reviewed commit.

## Optional App identity

Default publishing uses the caller's `GITHUB_TOKEN`. To use a GitHub App, install
it on the repository and pass two additional secrets:

```yaml
app-id: ${{ secrets.RELEASE_APP_ID }}
app-private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

Copse-owned repos can use our existing installation and restricted organization
secrets. The findings Action mints a repository-scoped installation token with
only pull-request write permission, after setup completes. PR context is read
using the separate workflow token. No App/model credentials enter validation
containers.

An external organization can install our App, but installation does not provide
its workflows with our signing key. Offering that identity externally requires
a token/publishing path we control; adopters do not need it to run the OSS Actions
and publish with their own workflow token.

## Configuration and results

Optional workflow inputs: `provider` (default `openrouter`), `model` (default
`openai/gpt-6-luna`), `lenses` (default `correctness,visual`), `max-steps` (default
12, maximum 100), `max-verify` (default 3, maximum 10) and `post-summary` (default
`false`). Set `post-summary: true` in the caller's `with` block to update the PR
description with an evidence-based summary, including reviews with no findings.
Other hosted providers supported by the CLI can use `model-api-key`; custom base
URLs are not exposed by this first wrapper. Limits apply per reviewer; this is
not a dollar spending cap.

Standard `build`, `typecheck`, `lint` and `test` npm scripts are detected.
`review.config.json` can override/disable commands and set per-check timeouts;
all configured commands still execute inside the cell. Missing checks and failed
preparation remain visible limitations. Normal review does not claim browser
coverage, fetch external conformance fixtures or replace project CI.

Findings post as advisory `COMMENT` reviews. With `post-summary: true`, the reviewer
adds or replaces its managed summary block in the PR description, preserving the
author's text. Description updates use the same current-head/base and opt-out checks
as review publishing. Summaries are disabled by default. The portable wrapper does
not add feedback labels, make commits, or merge. An empty completed review uses the
existing resolution behavior and may post no new review; an enabled description
summary still provides a visible result.
Grounding is retained for seven days; the full findings JSON, SARIF and model
event stream are retained for thirty days.

## Copse dogfooding

Copse's `review-trigger.yml` calls the reusable workflow locally and passes
`reviewer-ref: ${{ github.sha }}` and `preparation: copse-pnpm`. Both select the
trusted caller revision, so a reviewer update is exercised without a self-referential
commit pin. This profile is restricted to owner-authored, same-repository Copse PRs
and the trusted default-branch caller; it is not an alternate external installation.

The protected model job repeats the owner/caller/rerun guard before entering
`copse-review-models`. It uses the existing dedicated OpenRouter key, retained
configured Scaleway route, App identity, feedback label and evidence-based description
summary. Its workflow token remains read-only. No new secret configuration is needed
for existing Copse credentials. Full-review summaries are produced by automatic and manual
reviews; the separate summary-only workflow can also be dispatched manually.
Nightly sampling remains separate.

Copse's pnpm lockfiles and patch paths are validated before host-side fetch;
workspace/local contents and native builds run only inside validation cells.
The reviewed preparation script copies the immutable seed into a checkout-private
writable store, disables lifecycle scripts and explicitly builds node-pty. Grounding
is now always fresh and bound to this run/attempt, replacing the
old 24-hour lookup and dispatch/handoff workflows.
