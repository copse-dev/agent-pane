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
workspace links and the portable pnpm shell are follow-ups. Existing Copse pnpm
review workflows continue to work.

The Action fetches only validated registry tarballs on the trusted host. It
does not execute a contributor manifest, `.npmrc`, install script or check there.
Installs, checks and model-requested verification execute in network-disabled
containers with a read-only root and scrubbed environment. Each checkout gets a
private writable copy of the read-only dependency cache. Lifecycle scripts are
disabled during installation; a project requiring native dependency builds needs
a separately reviewed preparation policy before adopting this shell.

## Installation

1. Add a repository secret `COPSE_REVIEW_API_KEY` containing an OpenRouter key.
2. Add this workflow on the repository's default branch. Replace both occurrences
   of `REVIEWER_SHA` with the same reviewed full 40-character Copse commit SHA.
3. Enable workflow PR writes if the repository or organization restricts them.

```yaml
name: Copse review

on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, labeled]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true
        type: number

permissions: {}

jobs:
  review:
    permissions:
      contents: read
      pull-requests: write
    uses: copse-dev/agent-pane/.github/workflows/reviewer.yml@REVIEWER_SHA
    with:
      reviewer-ref: REVIEWER_SHA
      pr: ${{ inputs.pr || 0 }}
    secrets:
      model-api-key: ${{ secrets.COPSE_REVIEW_API_KEY }}
```

The caller grants the maximum permissions available to the reusable workflow;
its grounding job reduces that grant to `permissions: {}`. Only the findings
job receives the model key. Both the workflow and the reviewer source are pinned,
so a change to Copse's main branch cannot change an installed reviewer's behavior.
The Actions currently install their trusted source dependencies from that pinned
checkout; no published npm package, release tag or prebuilt image is required.
The validation image is built on each runner from the trusted Dockerfile.

Reviews require the initiating actor and any rerunning actor to have repository
write permission. PRs must target the default branch. Fork authors cannot start
paid reviews themselves; a maintainer can add `copse-review` or use the manual
dispatch. Other labels do not start reviews. Drafts need `copse-review`, and
`copse-review-skip` opts out. Pushes alone do not start another review.

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
12, maximum 100) and `max-verify` (default 3, maximum 10). Other hosted providers
supported by the CLI can use `model-api-key`; custom base URLs are not exposed by
this first wrapper. Limits apply per reviewer; this is not a dollar spending cap.

Standard `build`, `typecheck`, `lint` and `test` npm scripts are detected.
`review.config.json` can override/disable commands and set per-check timeouts;
all configured commands still execute inside the cell. Missing checks and failed
preparation remain visible limitations. Normal review does not claim browser
coverage, fetch external conformance fixtures or replace project CI.

Findings post as advisory `COMMENT` reviews. The wrapper does not edit the PR
description, add feedback labels, make commits, or merge. An empty completed
review uses the existing resolution behavior and may post no new review.
Grounding is retained for seven days; the full findings JSON, SARIF and model
event stream are retained for thirty days.
