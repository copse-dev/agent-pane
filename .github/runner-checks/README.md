# Self-hosted check runners (Docker)

One lightweight Linux container image that turns **any** machine with Docker into
a GitHub Actions runner for this repo's **non-e2e** check tier — the static
checks and unit tests, not the Electron e2e suite.

This is the lighter sibling of [`../runner`](../runner) (the e2e fleet). Same
registration mechanics, different payload:

| | `../runner` (e2e) | `runner-checks` (this) |
|---|---|---|
| Label | `copse-e2e` | `copse-checks` |
| Runs | seeded e2e suite (launches Electron) | typecheck, lint, format:check, check:dead-code, check:oracle, unit tests / coverage, normalizer-parity |
| Image | Ubuntu 24.04 + Chromium/Electron/Xvfb + emoji font | Ubuntu 24.04 + Node + build toolchain + ripgrep + python3 |
| Memory | ~4–6 GB/runner | ~2–4 GB/runner |

The check tier never starts Electron, so this image omits the entire
Chromium/Xvfb/font stack — it builds and boots much faster while still matching
GitHub-hosted `ubuntu-latest` (Ubuntu 24.04 / glibc 2.39) so the vendored
`codesearch` prebuilt and the native `npm ci` builds behave identically to CI.

## Prerequisites

- Docker with BuildKit (Docker Desktop, OrbStack, Colima, or Docker Engine).
  - **Windows:** Docker Desktop in **Linux containers** mode (default, WSL2).
  - **macOS:** any of Docker Desktop / OrbStack / Colima. Apple Silicon builds
    a native `linux/arm64` image automatically.
- A GitHub PAT with permission to register runners on the repo:
  - Classic PAT: `repo` scope.
  - Fine-grained PAT: repository **Administration → Read & write**.

## Quick start

```bash
cd .github/runner-checks
cp .env.example .env          # set GITHUB_URL + ACCESS_TOKEN
docker compose up -d --build --scale runner=2
```

That registers two ephemeral runners labelled
`self-hosted,linux,docker,copse-checks`. Each takes one job, then the container
exits and `restart: always` launches a fresh, clean replacement — so every job
gets an isolated environment.

Check them under **Settings → Actions → Runners** in the repo, or:

```bash
docker compose logs -f
docker compose ps
```

Tear down:

```bash
docker compose down
```

## How CI uses these runners

CI does **not** hard-pin the static jobs to self-hosted. A `pick-runner` job at
the top of [`ci.yml`](../workflows/ci.yml) queries the GitHub API for online
runners carrying the `copse-checks` label and emits a `runs-on` value the
`precheck`, `check`, and `build` jobs consume:

- **≥1 `copse-checks` runner online** → those jobs run here (free minutes, warm
  dependency cache).
- **none online, the API call fails, or the PAT is missing** → the jobs **defer
  to GitHub-hosted `ubuntu-latest`** automatically. Nothing queues waiting for a
  runner that isn't there.

So bringing this fleet up or down is transparent — start containers to offload
the check tier onto your own hardware, stop them and CI silently falls back to
hosted runners on the next run.

### PAT for detection (reuses the existing secret)

Detection needs a PAT because the GitHub API won't list self-hosted runners
with the default `GITHUB_TOKEN` (it has no `administration` scope). By default
`pick-runner` **reuses the repo's existing `SCREENSHOTS_PAT`** — a classic
`repo`-scoped PAT already carries repository **Administration: Read**, so the
same token that pushes screenshot commits can also list runners. No new secret
is required.

Optionally set a dedicated **`RUNNERS_PAT`** if you'd rather scope a separate
token (it takes precedence over `SCREENSHOTS_PAT`):

- Classic PAT: `repo` scope, **or**
- Fine-grained PAT: repository **Administration → Read**.

With neither secret — or a token that lacks admin read — `pick-runner` simply
can't enumerate the fleet and CI runs the check tier on GitHub-hosted runners
(the previous behaviour).

## Sizing

The static + unit tier is CPU-light and modest on memory — `tsc`, `eslint`, and
the Node unit suite. Budget **~2–4 GB and ~2 cores per concurrent runner** and
set `--scale` accordingly. `docker-compose.yml` caps each runner at
`mem_limit: 4g`; tune to taste.

## Running without a PAT in the container

If you'd rather not place a PAT in the container, fetch a registration token
yourself (Settings → Actions → Runners → New, or the API) and pass it as
`RUNNER_TOKEN` instead of `ACCESS_TOKEN`. Registration tokens expire in ~1 hour,
so this suits short-lived/manual bring-ups; `ACCESS_TOKEN` is better for
long-running hosts since the entrypoint mints a fresh token on each restart.

## One-off `docker run` (no compose)

```bash
docker build -t copse-ci-checks-runner .
docker run -d --restart always --init \
  -e GITHUB_URL=https://github.com/jonathankingston/agent-pane \
  -e ACCESS_TOKEN=ghp_xxx \
  copse-ci-checks-runner
```
