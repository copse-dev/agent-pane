# Unified org-shared CI runners (PROTOTYPE)

A single self-hosted GitHub Actions runner image that **both** `agent-pane` and
`streaming-markdown` (and any future org repo) can share — replacing the two
per-repo, per-tier fleets that previously lived in `agent-pane/.github/runner`
(e2e) and `agent-pane/.github/runner-checks` (checks).

It folds three changes into one image:

1. **One superset image, one pool.** The check tier's image is a strict subset
   of the e2e image, so this image carries the full e2e stack and runs _both_
   tiers. A runner registers with both `copse-e2e` and `copse-checks` labels, so
   any box is eligible for whichever job is queued — the pool self-balances
   instead of one labelled fleet idling while the other is saturated. (This is
   the fix for "some are idle whilst the others are overworking.")

2. **Org-level registration.** `GITHUB_URL` can be an org URL. The entrypoint
   already picks the org vs repo registration endpoint automatically, so the
   same image registers an org-shared pool with no code change.

3. **Repo-agnostic dep baking ("thread in main").** The old images baked _their
   own_ repo's `node_modules` by using the repo root as the Docker build
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

## Scaleway burst hosts

Scaleway is the cheapest/easiest burst path when AWS billing or capacity is in
the way. It uses the same runner image as the local/AWS flows. **Default burst
registers e2e-only labels** (`copse-e2e`, not `copse-checks`) so check jobs
routed via `CHECKS_RUNNER` do not compete with the e2e shard matrix; spin up a
separate checks-only burst when the check tier also queues (below).

Prerequisites:

- Scaleway CLI installed and configured (`scw init`) with permission to create,
  list, wait for, and terminate Instances in your project.
- Your Scaleway project has an SSH public key installed for the default `root`
  user (Scaleway propagates console SSH keys to new Linux Instances). Pass
  `--key-path` if SSH should use a specific private key — the wait loop fails
  fast on `Permission denied`.
- The default (or selected) security group must allow inbound TCP/22 from the
  machine running the CLI. A long `Waiting for SSH` with connection timeouts
  almost always means port 22 is dropped. Outbound traffic must also reach
  GitHub and apt repositories.
- `GITHUB_RUNNER_PAT` with GitHub self-hosted runner registration permission for
  `GITHUB_URL` (org or repo), and `BUILD_GH_TOKEN` with read access to
  `agent-pane` plus the private `@copse/streaming-markdown` dependency.

Default (`POP2-HC-8C-16G`, one e2e runner per host — omit `--zone` to auto-pick an
AZ with quota):

```bash
GITHUB_RUNNER_PAT=ghp_... BUILD_GH_TOKEN=ghp_... \
  npm run runners:burst:scw -- up \
    --instances 3 \
    --ttl-minutes 240
```

Cheaper, granular alternative — one runner on the half-size HC box:

```bash
GITHUB_RUNNER_PAT=ghp_... BUILD_GH_TOKEN=ghp_... \
  npm run runners:burst:scw -- up \
    --instances 6 \
    --scw-type POP2-HC-4C-8G \
    --runners-per-instance 1 \
    --ttl-minutes 240
```

Useful follow-ups (`status`/`down` scan all AZs unless `--zone` is set):

```bash
npm run runners:burst:scw -- status
npm run runners:burst:scw -- drain --instances 1 --yes # gracefully remove newest host
npm run runners:burst:scw -- down --yes --wait
```

Use `down --instances N --yes` to terminate only the newest N hosts immediately,
or Scaleway's `drain --instances N --yes` to stop those hosts accepting new jobs,
wait for in-flight jobs, and then terminate them. The partial form must leave at
least one host; omit `--instances` for the existing explicit whole-fleet teardown.

Scaleway sizing guidance:

- Omit `--zone` on `up` to fill `--instances` across Paris → Amsterdam →
  Warsaw → Milan AZs (Scaleway quotas are per-AZ). Partial creates are kept
  when an AZ hits quota; the remainder is requested in the next AZ. Pass
  `--zone` to pin. `status`/`down` without `--zone` scan all.
- The e2e tier is CPU-bound (Chromium-under-Xvfb) and wants ~4 vCPU + ~6 GiB per
  runner, i.e. ~1.5 GiB/vCPU. The High-CPU `POP2-HC` line (2 GiB/vCPU) matches
  that profile at ~half the €/vCPU of the general `PRO2` line (4 GiB/vCPU), whose
  extra RAM the runner never uses.
- **Default: `POP2-HC-8C-16G` (8 vCPU / 16 GiB) with two runners** — 4 vCPU + a
  6 GiB `mem_limit` each, with one shared image build amortized across both. The
  Scaleway analogue of the AWS `c7i.2xlarge`/2-runner balanced default.
- Granular/cheaper: `POP2-HC-4C-8G` (4 vCPU / 8 GiB) with **one** runner (all
  4 vCPU to it) — finer scale-down, half the blast radius, at the cost of an
  extra per-host image build. Do **not** put two runners on this box: 2 × 6 GiB
  caps oversubscribe an 8 GiB, swapless host, so the host OOM-killer (not the
  container cap) becomes the arbiter — the failure that reads as clustered spec
  timeouts. Two runners need a 16 GiB box.
- `PRO2-XS` / `BASIC3-X4C-16G` (4 vCPU / 16 GiB) remain fine fallbacks when
  `POP2-HC` AZ quota is exhausted; they just pay for RAM the runner won't use.
  Avoid the shared-vCPU `PLAY2` line for the e2e tier — CPU steal reintroduces
  the timeout variance this fleet exists to avoid; it's fine for check-only.
- Default burst is already e2e-only. For **check-only** bursts, run a separate
  `up` on a smaller box with checks-only labels, e.g.
  `--runner-labels self-hosted,linux,x64,docker,copse-checks,burst`.
- `--ttl-minutes` defaults to 240. On Scaleway the host **self-terminates** via
  the Instance API after that TTL (server + SBS volume + flexible IP), matching
  AWS terminate-on-shutdown — a guest `shutdown` alone would only enter billed
  standby. Requires `SCW_SECRET_KEY` or a configured `scw` secret-key at `up`
  time. Prefer `down --yes` when the queue drains; the TTL is a backstop, not
  the primary cleanup path.
- `--volume-size-gb` defaults to 80 (Scaleway SBS root). The default PLAY2 image
  disk is too small for `docker compose build` + dep bake; omit the flag to get
  80 GB, or raise it if builds still hit `no space left on device`.
- Scaleway root SBS volumes receive the same fleet ownership tags as their
  server. Normal teardown deletes and verifies those volumes; the daily
  `Prune Scaleway Volumes` workflow is a backstop that deletes only tagged,
  unattached Copse volumes after 24 hours. Run the same guard manually with
  `npm run scaleway:prune-volumes -- --yes --older-than-hours 24`.
- Zonal flexible IPs are the costliest thing to leak: Scaleway bills them from
  reservation until deletion whether or not a server is attached, so an orphan
  never stops charging on its own. `up` reserves each IP with the fleet's
  ownership tags _before_ creating its server, so a failed create can hand it
  straight back and the reaper can tell fleet garbage from an address someone
  reserved deliberately. The daily `Prune Scaleway IPs` workflow deletes only
  tagged IPs seen unattached in two passes 120s apart —
  `npm run scaleway:prune-ips -- --yes --settle-seconds 120`. Untagged IPs are
  never touched, so any predating this tagging must be removed by hand.
- With `--instances N` (N>1), hosts are provisioned **in parallel** after create
  (SSH wait + Docker build). Pass `--serial` for one-at-a-time logs.

## AWS burst hosts

For short queue-draining bursts, run the same Docker runner fleet on temporary
x64 EC2 hosts:

Prerequisites:

- AWS CLI installed and authenticated with permission to call EC2 `RunInstances`,
  `DescribeInstances`, `TerminateInstances`, `CreateTags`/tag-on-create, and SSM
  `GetParameter` for the Ubuntu AMI lookup.
- An EC2 key pair and local private key (`--key-name`, `--key-path`).
- A subnet that can reach GitHub and apt repositories. If you use `--ssh-host
public` (the default), instances must receive public IPv4 addresses; otherwise
  run from a host with private VPC access and pass `--ssh-host private`.
- A security group allowing SSH from the machine running the CLI.
- `GITHUB_RUNNER_PAT` with GitHub self-hosted runner registration permission
  for `GITHUB_URL` (org or repo), and `BUILD_GH_TOKEN` with read access to
  `agent-pane` plus the private `@copse/streaming-markdown` dependency.

```bash
GITHUB_RUNNER_PAT=ghp_... BUILD_GH_TOKEN=ghp_... \
  npm run runners:burst -- up \
    --region us-east-1 \
    --instances 3 \
    --instance-type c7i.2xlarge \
    --runners-per-instance 2 \
    --ttl-minutes 240 \
    --key-name copse-ci \
    --key-path ~/.ssh/copse-ci.pem \
    --subnet-id subnet-123 \
    --security-group-id sg-123
```

The CLI launches Ubuntu 24.04 amd64 hosts, waits for EC2 status checks, SSHes in,
uploads this `ci-runners/` directory, writes the remote `.env`, and runs
`docker compose up -d --build --scale runner=N`. It deliberately requires an
existing subnet, security group, and key pair instead of creating networking; the
security group must allow SSH from the machine running the command.

Cost/packing guidance:

- EC2 c7i pricing is close to linear by size, so savings come mostly from high
  utilization and avoiding idle capacity, not from a large-instance discount.
- Each runner should be budgeted at roughly 2 vCPU and 4-6 GiB RAM. A
  `c7i.xlarge` (4 vCPU / 8 GiB) with one runner is the smallest safe general
  e2e/check shape; `c7i.2xlarge` with 2 runners is the balanced default because
  it halves duplicated Docker builds and setup while keeping the same per-runner
  CPU/RAM budget. `c7i.4xlarge` with 4 runners is a denser option.
- Default burst is e2e-only (`copse-e2e,burst`). For **check-only** bursts, use
  a separate `up` on a smaller box with checks-only labels — do not add
  `copse-e2e`; the current e2e failures look exactly like memory pressure.
- Many `c7i.xlarge` hosts cost about the same per vCPU as fewer larger c7i
  hosts, but duplicate Docker builds, EBS volumes, and setup. One very large
  host has coarser scale-down and larger single-host blast radius. Prefer a few
  medium hosts that each pack whole runners safely.
- With `--instances N` (N>1), hosts are provisioned **in parallel** after create.
  Pass `--serial` for one-at-a-time logs.
- `--ttl-minutes` defaults to 240. Instances launch with
  `instance-initiated-shutdown-behavior=terminate`, so the scheduled shutdown
  auto-terminates forgotten burst capacity. Pass `--ttl-minutes 0` only when you
  have another cleanup mechanism.

Useful follow-ups:

```bash
npm run runners:burst -- status --region us-east-1
npm run runners:burst -- down --region us-east-1 --instances 1 --yes --wait
npm run runners:burst -- down --region us-east-1 --yes --wait
```

`down --instances N` removes only the newest N hosts and refuses to remove the
entire remaining fleet. Omit `--instances` when a whole-fleet teardown is
intentional. AWS does not yet support graceful `drain`, so check the Actions
queue before using partial or full `down` there.

Secrets are read from environment variables (`GITHUB_RUNNER_PAT` and
`BUILD_GH_TOKEN` by default) rather than command-line flags so they do not appear
in shell history. `down` terminates instances tagged with the burst fleet name
(default `copse-burst`).

## Remote e2e dev hosts (`npm run e2e:remote`)

The same image doubles as the **remote e2e dev loop** (see
[`docs/plans/remote-e2e-dev-loop.md`](../docs/plans/remote-e2e-dev-loop.md)):
run the e2e suite from your **working tree** on an on-demand cloud host, so
your machine stays free while it runs. These hosts are _not_ GitHub runners —
no registration, no runner PAT; the only secret is `BUILD_GH_TOKEN` at image
build time, exactly like a burst host.

```bash
# Preferred: publish the baked image once to Scaleway Container Registry, then
# provision hosts that only pull (no on-host bake, no BUILD_GH_TOKEN on the host).
BUILD_GH_TOKEN=ghp_... SCW_SECRET_KEY=... \
  COPSE_CI_REGISTRY=rg.fr-par.scw.cloud/<namespace> \
  npm run e2e:remote -- publish

SCW_SECRET_KEY=... COPSE_CI_REGISTRY=rg.fr-par.scw.cloud/<namespace> \
  npm run e2e:remote -- up                           # pull + ready in minutes
# Registry pull defaults to a 40 GB root (no on-host bake scratch). On-host bake
# / --rebuild still defaults to 80 GB. Override with --volume-size-gb (SBS cannot
# shrink after create).

npm run e2e:remote -- run                            # oracle subset of your diff
npm run e2e:remote -- run --all --shard 2 --detach   # full CI suite, 2 containers
npm run e2e:remote -- wait <run-id>
npm run e2e:remote -- down --yes
```

Without `COPSE_CI_REGISTRY`, `up` still works but bakes on the host
(`BUILD_GH_TOKEN` required; slow). Create a private namespace in the Scaleway
console (Storage → Container Registry), then
[`docker login`](https://www.scaleway.com/en/docs/container-registry/how-to/connect-docker-cli/)
uses `SCW_SECRET_KEY` with user `nologin`. Image tags are
`copse-ci-runner:<sha256(package-lock.json)>` and `:latest`.

**Secrets never land in Scaleway images.** `BUILD_GH_TOKEN` is a BuildKit
secret at bake/publish time only. Registry auth on `up` is an ephemeral host
`docker login` (password on stdin → pull → logout + wipe `~/.docker/config.json`);
it is not written into Docker layers or instance snapshots. For the stricter
path (host never sees registry credentials), pass `--transfer-image` (local
pull + `docker save|load` over SSH).

Each run pushes a snapshot commit (staged + unstaged + untracked) to a bare
repo on the host and starts a fresh one-shot container from this image with
[`exec-run.sh`](exec-run.sh) as the entrypoint override: checkout → seed the
baked deps (same `.lockhash` contract as the setup action) → build → wdio
under Xvfb → collect logs + changed reference screenshots. Results land in
`.tmp/remote-e2e/runs/<run-id>/` locally; the exit code mirrors wdio's.

Dev hosts carry their own tag namespace (`copse-remote-e2e` /
`copse-remote-e2e-hosts`), so `e2e:remote down` can never terminate burst CI
capacity and `runners:burst down` can never take a dev host. The same
TTL backstop applies (`--ttl-minutes`, default 240; Scaleway self-terminates
via API, AWS uses terminate-on-shutdown) — `down --yes` remains the real
cleanup. After a `package-lock.json` change, runs warn and fall back to
`npm ci`; refresh with `npm run e2e:remote -- rebake --push` (publish + pull
onto the saved host) or `rebake --rebuild` (on-host bake).
A spare machine with Docker + passwordless sudo works too:
`npm run e2e:remote -- adopt --host user@box`.

## Do we need new PAT tokens?

There are **three distinct token roles**. You do **not** need three separate
tokens — one org-scoped fine-grained (or classic) PAT can cover all three — but
they are separate _permissions_, and one of them (the build-time clone) is
genuinely new versus today.

| Role                                        | Used when                                                                                                             | Needs                                                                                                                                                                           | New?                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Registration** (`ACCESS_TOKEN`)           | container start, to register the runner                                                                               | **Org:** classic `admin:org` or fine-grained org **Self-hosted runners: Read & write**. (Repo-level: repository Administration R/W — repos have no separate runner permission.) | Existing token, but scope **widens repo→org** if you go org-level                |
| **Build-time clone** (`BUILD_GH_TOKEN`)     | `docker build`, to clone `TARGET_REPO` and let its `npm ci` fetch the **private** `@copse/streaming-markdown` git dep | **Contents: Read** on **both** `agent-pane` **and** `streaming-markdown` (classic `repo`, or a fine-grained token scoped to both)                                               | **NEW** — the old images had the repo in the build context, so they never cloned |
| **`pick-runner` detection** (`RUNNERS_PAT`) | in CI, to list online runners for auto-routing                                                                        | **Org:** classic `admin:org` / fine-grained org **Self-hosted runners: Read**                                                                                                   | Existing token, but must query the **org** endpoint (scope widens repo→org)      |

**Why the clone token is unavoidable:** baking `agent-pane` runs `npm ci`, which
pulls `@copse/streaming-markdown` — a **private** git dependency. So even the
build needs read access to _both_ repos. That's the same cross-repo access the
`setup` action's `github-pat` input already handles at job time; here it moves
to build time. (This is also an argument _for_ one org-scoped token: a single
fine-grained PAT with **Contents: Read on all repos** + org **Self-hosted
runners: Read & write** covers registration, detection, and baking in one
credential.)

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

## Cutover

**Done in this branch (code):**

- Removed the two old runner dirs; repointed the `Makefile` (`make runners*`) at
  this unified fleet.
- `agent-pane` `pick-runner` now queries the **org** endpoint
  (`/orgs/{owner}/actions/runners`) instead of the repo endpoint. The e2e job is
  unchanged — it already targets `["self-hosted","copse-e2e"]`, which these
  runners carry.
- `streaming-markdown/.github/workflows/ci.yml` gained a `pick-runner` route so
  its check job lands on the shared `copse-checks` pool when available (fork PRs
  stay on hosted).

**Remaining (infra — do before/at merge):**

1. **Bring the pool up** at org scope: set `.env` `GITHUB_URL` to the org, give
   `ACCESS_TOKEN` org runner admin, and put both repos in the runner group (the
   org default group grants all repos). Build + register with
   `make runners` — or `make runners-reprovision` to **replace the containers
   built from the now-deleted dirs**.
2. **Add `RUNNERS_PAT`** (org or repo secret, org **Self-hosted runners: Read**)
   to both repos so `pick-runner` can enumerate the org fleet. Without it,
   routing fails open to hosted — CI still works, it just never uses self-hosted.
3. **Confirm one green run** lands on the pool (an e2e job and a check job in
   agent-pane, a check job in streaming-markdown), then **merge**.

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
