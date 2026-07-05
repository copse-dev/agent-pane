# Unified org-shared CI runners (PROTOTYPE)

A single self-hosted GitHub Actions runner image that **both** `agent-pane` and
`streaming-markdown` (and any future org repo) can share — replacing the two
per-repo, per-tier fleets that previously lived in `agent-pane/.github/runner`
(e2e) and `agent-pane/.github/runner-checks` (checks).

It folds three changes into one image:

1. **One superset image, one pool.** The check tier's image is a strict subset
   of the e2e image, so this image carries the full e2e stack and runs *both*
   tiers. A runner registers with both `copse-e2e` and `copse-checks` labels, so
   any box is eligible for whichever job is queued — the pool self-balances
   instead of one labelled fleet idling while the other is saturated. (This is
   the fix for "some are idle whilst the others are overworking.")

2. **Org-level registration.** `GITHUB_URL` can be an org URL. The entrypoint
   already picks the org vs repo registration endpoint automatically, so the
   same image registers an org-shared pool with no code change.

3. **Repo-agnostic dep baking ("thread in main").** The old images baked *their
   own* repo's `node_modules` by using the repo root as the Docker build
   context. That couples the image to one repo. This image instead **clones the
   target repo's branch at build time** and bakes its deps — so the image can
   live in its own repo and be pointed at any consumer.

> **Status: prototype — not yet live.** This directory replaces the two old
> runner dirs (`.github/runner`, `.github/runner-checks`), which are **removed in
> this branch**; `make runners*` now drives this unified fleet. But the pool has
> **not** been built or stood up yet, and CI routing is unchanged — so **do not
> merge until** the unified pool is registered and one green run (an e2e job and
> a check job) has landed on it. See [Cutover](#cutover-remaining).
>
> ⚠️ The runners currently serving CI were built from the now-deleted dirs. Once
> this merges you can no longer rebuild them from source — migrate by
> reprovisioning from THIS image (`make runners-reprovision`) before tearing the
> old containers down.

## Quick start

```bash
cd ci-runners
cp .env.example .env     # GITHUB_URL (org), ACCESS_TOKEN, BUILD_GH_TOKEN
DOCKER_BUILDKIT=1 docker compose up -d --build --scale runner=3
```

That builds the image (cloning + baking `TARGET_REPO`) and registers three
ephemeral runners labelled `self-hosted,linux,docker,copse-e2e,copse-checks`.

```bash
docker compose logs -f
docker compose ps
docker compose down      # tear down
```

## Do we need new PAT tokens?

There are **three distinct token roles**. You do **not** need three separate
tokens — one org-scoped fine-grained (or classic) PAT can cover all three — but
they are separate *permissions*, and one of them (the build-time clone) is
genuinely new versus today.

| Role | Used when | Needs | New? |
| ---- | --------- | ----- | ---- |
| **Registration** (`ACCESS_TOKEN`) | container start, to register the runner | **Org:** classic `admin:org` (manage_runners) or fine-grained org **Self-hosted runners: R/W**. (Repo-level today: repository Administration R/W.) | Existing token, but scope **widens repo→org** if you go org-level |
| **Build-time clone** (`BUILD_GH_TOKEN`) | `docker build`, to clone `TARGET_REPO` and let its `npm ci` fetch the **private** `@copse/streaming-markdown` git dep | **Contents: Read** on **both** `agent-pane` **and** `streaming-markdown` (classic `repo`, or a fine-grained token scoped to both) | **NEW** — the old images had the repo in the build context, so they never cloned |
| **`pick-runner` detection** (`RUNNERS_PAT`) | in CI, to list online runners for auto-routing | **Org:** `admin:org` read / fine-grained org **Self-hosted runners: Read** (repo Administration: Read today) | Existing token, but must query the **org** endpoint (scope widens repo→org) |

**Why the clone token is unavoidable:** baking `agent-pane` runs `npm ci`, which
pulls `@copse/streaming-markdown` — a **private** git dependency. So even the
build needs read access to *both* repos. That's the same cross-repo access the
`setup` action's `github-pat` input already handles at job time; here it moves
to build time. (This is also an argument *for* one org-scoped token: a single
fine-grained PAT with **Contents: Read on all repos** + **Self-hosted runners:
R/W** covers registration and baking in one credential.)

The clone token is passed as a **BuildKit secret** (`--secret`), mounted on
tmpfs and consumed only inside the bake `RUN` via `GIT_CONFIG_*` env vars — it is
**never written into an image layer**. Build with `DOCKER_BUILDKIT=1`.

If you point `TARGET_REPO` at a repo with a trivial, fully-public install, you
can leave `BUILD_GH_TOKEN` empty — the bake step no-ops and jobs fall back to
`npm ci`. But agent-pane's private git dep means its bake needs the token.

## How baking stays compatible

The bake writes exactly what `agent-pane/.github/actions/setup` already consumes:
`/opt/deps/tree/{node_modules,vendor/gortex,.lockhash,.ready}` with
`COPSE_BAKED_DEPS=/opt/deps/tree`. On a job, setup seeds the workspace from that
layer **iff** the checked-out `package-lock.json` hash matches `.lockhash`, else
falls back to the Actions cache / `npm ci`. So a lockfile bump is never served
stale — rebuild the image to re-bake.

**One-repo bake, shared pool:** the image bakes ONE repo's tree (default
`agent-pane`, the heavy consumer). `streaming-markdown` jobs land on the same
runners but get a cold `npm ci` — which is cheap there (small, pure-TS, no
native rebuild). If you later want warm starts for both, bake into
per-repo `/opt/deps/tree-<slug>` dirs and have the setup action pick by lockhash
— noted as a future enhancement, out of scope for this prototype.

## Sizing

The superset image runs Chromium-under-Xvfb for e2e, so size for the heavy tier
even though light jobs share the box: **~4-6 GB + ~2 cores per concurrent
runner**. `docker-compose.yml` caps each at `mem_limit: 6g` with a 2 GB
`/dev/shm`. Light check jobs simply under-use that budget — the cost of pooling.

## Cutover (remaining)

Already done in this branch: the two old runner dirs are removed and the
`Makefile` (`make runners*`) is repointed at this unified fleet. Still to do
before/after merging:

1. **Bring the pool up** at org scope (org `GITHUB_URL`, org `ACCESS_TOKEN`) and
   put both repos in the runner group. Reprovision from this image
   (`make runners-reprovision`) to replace the containers built from the old
   dirs.
2. **`pick-runner`**: change its runner query from the repo endpoint
   (`/repos/{repo}/actions/runners`) to the org endpoint
   (`/orgs/copse-dev/actions/runners`), and give `RUNNERS_PAT` org
   **Self-hosted runners: Read**. (Org runners are not listed on the repo
   endpoint, so without this the check tier silently stays on hosted.)
3. **e2e job**: unchanged — it already targets `["self-hosted","copse-e2e"]`,
   which these runners carry. Fork-PR fail-closed guard stays as-is.
4. **`streaming-markdown/.github/workflows/ci.yml`**: optionally add a
   `pick-runner`-style route so its `build` job can land on `copse-checks`
   (it has no e2e/Electron, so it only ever needs the check tier).
5. Confirm one green run lands on the unified pool (an e2e job and a check job),
   then merge.

## Extracting to its own repo

This directory is self-contained (Dockerfile + entrypoint + compose reference
only THIS dir, not the repo root). To split it into `copse-dev/ci-runners`
preserving history:

```bash
git subtree split --prefix=ci-runners -b ci-runners-export
# push ci-runners-export to the new repo's main
```

Nothing here imports from the agent-pane tree, so the split is clean — the only
coupling to a consumer repo is the runtime `TARGET_REPO` build arg.
