# Remote e2e for the local dev loop

**Status: Resolved** (M0–M4 implemented). M0 landed as the `scripts/lib/cloud-hosts.mts`
extraction; the CLI (`scripts/remote-e2e.mts`, `npm run e2e:remote`) and the
one-shot container runner (`ci-runners/exec-run.sh`) landed together — usage in
[`ci-runners/README.md`](../../ci-runners/README.md#remote-e2e-dev-hosts-npm-run-e2eremote).
This is stage one of a two-stage direction; stage two (Copse provisioning
cloud containers for any workspace) is
[`copse-cloud-workspaces.md`](copse-cloud-workspaces.md).

> **Decision amendments from implementation** (supersede the matching items
> below):
>
> - **One-shot containers instead of idle exec-mode containers.** Decision 1
>   originally added a `RUNNER_MODE=exec` idle mode to the entrypoint. The
>   implementation instead starts a **fresh container per run**
>   (`docker run --rm --init --entrypoint bash … exec-run.sh`), which needs no
>   entrypoint change at all, gives every run a pristine container (the same
>   isolation ephemeral CI runners get per job), and makes shard parallelism
>   trivial. Everything else in Decision 1 stands: no GitHub registration, no
>   runner PAT, `BUILD_GH_TOKEN` only at image-bake time.
> - **`adopt` and `rebake` subcommands.** BYO hosts (M1's "spare machine on
>   the LAN") are `e2e:remote adopt --host user@box`; lockfile drift is fixed
>   with `e2e:remote rebake` (rebuilds the image on the saved host).
> - **Defaults:** Scaleway `PLAY2-MICRO` is the default provider/shape (AWS
>   via `up aws`, default `c7i.xlarge` for the single-host dev case). Runs
>   always use `wdio.ci.conf.ts` for CI parity; `--all` means "no oracle
>   filtering", not the local `wdio.conf.ts` spec set.
> - **Scaleway Container Registry for host images (follow-up).** When
>   `COPSE_CI_REGISTRY=rg.fr-par.scw.cloud/<namespace>` (or `--registry`) is
>   set, `up`/`adopt`/`rebake` **pull** a pre-baked `copse-ci-runner:<lockhash>`
>   instead of `docker compose build` on the host. `publish` (or
>   `rebake --push`) bakes once locally with `BUILD_GH_TOKEN` as a BuildKit
>   secret and pushes; subsequent `up` needs **no GitHub token**. Registry
>   auth uses `SCW_SECRET_KEY` for an ephemeral host `docker login` (stdin →
>   pull → logout + config wipe) — credentials are never stored in Docker
>   layers or Scaleway instance snapshots. `--transfer-image` is the stricter
>   path (pull locally, `docker save|load` over SSH; host never sees registry
>   creds). On-host bake remains the fallback when no registry is configured
>   or `--rebuild` is passed.

## Problem

The e2e tier (`npm run test:e2e`, WebdriverIO driving real Electron,
~100 specs under `tests/e2e/`) is the one part of the dev loop that fights the
developer for the machine: it spawns Electron repeatedly, grabs the display and
CPU, and runs `maxInstances: 1`, so a full local run monopolises the box for a
long stretch. That is worst exactly when it matters most — an AI agent
iterating on code locally wants to check e2e _while continuing to work_, and
today the choices are "block the machine" or "push and wait for CI".

Meanwhile we now have a working way to spin up containers on cloud machines:

- **`ci-runners/`** — a single superset Docker image that runs the full e2e
  stack (Chromium-under-Xvfb, baked `node_modules` at `/opt/deps/tree` gated by
  `.lockhash`), currently used only as a GitHub Actions self-hosted runner.
- **`scripts/burst-runners.mts`** — a provisioning CLI (AWS + Scaleway) that
  launches Ubuntu hosts, waits for SSH, uploads `ci-runners/`, writes a remote
  `.env`, and runs `docker compose up --scale runner=N`, with a TTL shutdown
  backstop and tag-based `status`/`down`.

This plan reuses those two pieces to run e2e on a cloud container **on
demand, from the working tree, without going through GitHub Actions** — so the
local machine stays free while the suite runs.

## Decisions

1. **One image, new mode — not a second image.** The `ci-runners` image
   already carries everything e2e needs (Electron deps, Xvfb, baked
   node_modules). Add a non-registering **exec mode** to
   `ci-runners/entrypoint.sh` (`RUNNER_MODE=exec`, or an alternate compose
   service): instead of registering with GitHub and taking jobs, the container
   starts `sshd`-less and idles, and work arrives via `docker exec` over the
   host's SSH connection. No GitHub runner registration means the dev flow
   needs **no runner-admin PAT** at all — only the existing build-time
   `BUILD_GH_TOKEN` when (re)baking the image, exactly as burst hosts do today.
2. **Sync the working tree with git, not rsync.** The whole point is testing
   _uncommitted_ iteration state. The CLI snapshots the working tree (temp
   index → commit object, the same trick `createWorktreeBackup()` uses in-app:
   staged + unstaged + untracked, without touching the user's index) and pushes
   that single commit over SSH to a bare repo on the host; the container checks
   it out into a scratch worktree. Incremental after the first push (object
   transfer only), respects `.gitignore`, and never requires the host to reach
   GitHub at run time.
3. **Remote runs use the CI config semantics but are oracle-driven by
   default.** Default invocation runs the subset the test oracle
   (`scripts/test-oracle.mts`) selects for the current diff — the same
   `full`/`subset`/`skip` plan CI uses — with `--all` and `--spec` overrides.
   This keeps the common iteration case to a handful of specs, which matters
   for both wall-clock and cloud cost.
4. **Results come back as files plus an exit code, and runs can detach.**
   Artifacts (spec output, junit, failure screenshots, and any regenerated
   reference screenshots from `tests/e2e/screenshots/`) are pulled back to
   `.tmp/remote-e2e/<run-id>/` locally. `run --detach` returns immediately
   with a run id; `wait <run-id>` / `status` poll it. That is the shape an
   agent needs to keep working: kick off, keep editing, check results when
   notified — no interactive terminal held open.
5. **Provisioning is a shared library, not a fork of `burst-runners.mts`.**
   Extract the provider-agnostic core of `burst-runners.mts` (launch, SSH
   wait, upload, remote exec, TTL tagging, `status`/`down` scanning) into
   `scripts/lib/cloud-hosts.mts`, consumed by both the burst CLI and this one.
   This is also the prerequisite the stage-two plan builds on — do it once,
   here.
6. **Linux-only remote runs are a feature, not a caveat.** The CI gate runs on
   Linux containers; reference screenshots are Linux-rendered. A remote run on
   the same image _predicts CI_ far better than a local macOS run does. Local
   `test:e2e` remains available for macOS-specific behaviour.

### Alternatives considered

- **Push a branch and let GitHub Actions run it** — rejected for iteration:
  queue latency, requires committing/pushing every probe, burns the shared
  runner pool, and can't return artifacts into the working tree cheaply.
- **rsync the tree** — rejected: re-scans the whole tree each run, needs
  ignore-rule duplication, and loses the "exact snapshot commit" audit trail.
- **Register dev hosts as GitHub runners and trigger via
  `workflow_dispatch`** — rejected: couples the dev loop to CI plumbing and
  needs the widest-scope PAT we have.

## Design

### CLI surface

```bash
npm run e2e:remote -- up            # provision (or reuse) a dev e2e host
npm run e2e:remote -- run           # oracle subset from current diff
npm run e2e:remote -- run --all     # full suite
npm run e2e:remote -- run --spec tests/e2e/foo.e2e.ts --detach
npm run e2e:remote -- wait <run-id>
npm run e2e:remote -- status        # hosts + active/recent runs
npm run e2e:remote -- down --yes
```

`scripts/remote-e2e.mts`, sharing `scripts/lib/cloud-hosts.mts` with the burst
CLI. `up` accepts the same provider flags as the burst CLI (`--scw-type
PLAY2-MICRO` default — the cheapest shape that runs e2e; AWS via
`e2e:remote -- up aws ...`), plus `--ttl-minutes` (default 240, same backstop
semantics: TTL is the safety net, `down` is the real cleanup).

### On the host

- One `exec`-mode container per concurrent run (compose `--scale`), each with
  the CI resource shape (`mem_limit: 6g`, 2 GB `/dev/shm`).
- A bare repo at `/srv/agent-pane.git` receives snapshot pushes. A run =
  `git worktree add` at the snapshot sha → seed `node_modules` from
  `/opt/deps/tree` iff `.lockhash` matches (fall back to `npm ci`, which needs
  the baked-in token _only_ when the lockfile changed — surfacing that as a
  warning beats hiding it) → `node scripts/build.mts` → `wdio run
wdio.ci.conf.ts` (or `wdio.conf.ts` under `--all`) with the requested specs
  under Xvfb → tar artifacts back over the same SSH channel.
- Runs are serialized per container, parallel across containers. `--shard N`
  can split a spec list across containers exactly as CI shards do.

### Local side

- Snapshot: temp `GIT_INDEX_FILE` → `git add -A` → `git write-tree` /
  `commit-tree` (never touches the real index or HEAD), push
  `<sha>:refs/runs/<run-id>`.
- Run state lives in `.tmp/remote-e2e/` (gitignored): per-run dir with
  `meta.json`, streamed log, pulled artifacts. Exit code of `run`/`wait`
  mirrors wdio's, so `npm run e2e:remote -- run && ...` composes in scripts
  and agent workflows.
- No LLM keys ever leave the machine: e2e drives the built-in mock LLM
  (`tests/e2e/electron-shell`), so the remote env needs no provider secrets.

### Agent integration (the actual point)

Nothing in the app changes in this stage. The local agent (Copse itself, or
Claude Code working on this repo) uses the CLI as a tool:

- kick off `run --detach` after an edit burst, keep working;
- `wait`/`status` when it wants the verdict;
- artifacts land in the tree where the agent can already read them.

`AGENTS.md` gets a short section pointing agents at this flow instead of
running `test:e2e` locally mid-iteration.

## Milestones

- **M0 — extract `cloud-hosts.mts`.** Pure refactor of `burst-runners.mts`
  into lib + thin CLI; burst behaviour unchanged. Independently landable.
- **M1 — exec mode + BYO host.** Entrypoint exec mode; `remote-e2e run`
  against any host reachable over SSH that already has the image (including a
  spare machine on the LAN — provisioning not required to be useful).
- **M2 — tree sync + run + artifact pullback.** Snapshot push, worktree
  checkout, baked-deps seed, build, run, artifacts, exit codes. `--detach` /
  `wait`.
- **M3 — oracle default + sharding.** Diff → oracle plan → spec list;
  `--shard` across containers.
- **M4 — provisioning UX.** `up`/`status`/`down` via M0 lib, TTL, cost notes
  in `ci-runners/README.md`, AGENTS.md guidance.

## Risks / open questions

- **Idle cost.** A kept-warm host costs money while idle; the TTL backstop
  bounds forgetfulness but the default posture should be "up in the morning,
  down when the queue drains". An idle-N-minutes auto-`down` on the host is a
  cheap M4 add.
- **Lockfile drift.** When `package-lock.json` changes, remote runs fall back
  to `npm ci` (slow, needs the private-dep token baked at image build). Answer:
  warn loudly and offer `e2e:remote -- rebake`.
- **Screenshot churn.** Remote Linux runs can regenerate reference screenshots
  that differ from macOS-local expectations. Pulled screenshots go to the run
  dir, not directly into `tests/e2e/screenshots/` — applying them stays an
  explicit `--apply-screenshots` step.
- **Secrets hygiene.** The only secret on the host is the image-bake token,
  already handled as a BuildKit secret (never in a layer). The dev flow adds
  no new secret classes; keep it that way (no runner PATs, no LLM keys).
