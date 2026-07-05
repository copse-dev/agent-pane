# Self-hosted e2e runners (Docker)

One Linux container image that turns **any** machine with Docker into a GitHub
Actions runner for this repo's e2e suite — Linux, macOS, or Windows hardware,
same image, no per-OS setup.

## Why a single Linux image works everywhere

The e2e suite runs on **Linux + Xvfb** (WebdriverIO's `autoXvfb` in
`wdio.conf.ts`), and a Docker container is always Linux — on macOS and Windows
it runs inside Docker Desktop's lightweight Linux VM. So one image covers every
host you own, and you no longer depend on macOS as a primary CI device. The
`wdio.conf.ts` capabilities already pass the container-critical Chromium flags
(`--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`), so nothing in the
app needs to change.

> The only genuinely macOS-specific spec —
> `tests/e2e/explorer-reload-spaced-path.e2e.ts` — already self-skips off
> macOS. Keep a single native Mac runner for that (and a smoke check) if you
> want; everything else belongs on these Linux runners.

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
cd .github/runner
cp .env.example .env          # set GITHUB_URL + ACCESS_TOKEN
docker compose up -d --build --scale runner=3
```

That registers three ephemeral runners labelled
`self-hosted,linux,docker,copse-e2e`. Each takes one job, then the container
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

## Baked dependencies (warm start)

The image runs the repo's `npm ci` **at build time** and stashes the resulting
`node_modules` + `vendor/gortex` under `/opt/deps/tree` (recording the
`package-lock.json` hash alongside). These runners are ephemeral — one job per
pristine container, no volumes — so a job would otherwise restore ~525 MB of
`node_modules` from the GitHub Actions cache service on its first step; on freshly
reprovisioned runners that transfer has crawled at ~1 MB/s (~8 min). The repo's
[`setup` action](../actions/setup) seeds the workspace straight from
`/opt/deps/tree` when the checked-out `package-lock.json` still matches the baked
hash, turning that download into a few-second local copy. On a lockfile bump the
baked layer is stale and setup falls back to the cache / `npm ci` path — rebuild
to re-bake with `make runners-reprovision` (or `docker compose build --no-cache`).
This is why the build context is the repo root (see `docker-compose.yml`).

## Sizing

Chromium-under-Xvfb is memory-hungry; the historical OOM quarantines in
`wdio.ci.conf.ts` came from a 2-core/7 GB box. Budget **~4–6 GB and ~2 cores
per concurrent runner** and set `--scale` accordingly. `docker-compose.yml`
caps each runner at `mem_limit: 6g` with a 2 GB `/dev/shm`; tune to taste.

## Wiring CI to these runners

The runners advertise the `copse-e2e` label. Point the e2e job at it so jobs
land on these Linux containers instead of the macOS runners — for example in
`.github/workflows/ci.yml`:

```yaml
# before: runs-on: ${{ github.event_name == 'schedule' && 'ubuntu-latest' || 'self-hosted' }}
# after:
runs-on: ${{ github.event_name == 'schedule' && 'ubuntu-latest' || ['self-hosted', 'copse-e2e'] }}
```

Requiring both `self-hosted` and `copse-e2e` keeps these jobs off any macOS
`self-hosted` runner still in the pool.

## Running without a PAT

If you'd rather not place a PAT in the container, fetch a registration token
yourself (Settings → Actions → Runners → New, or the API) and pass it as
`RUNNER_TOKEN` instead of `ACCESS_TOKEN`. Registration tokens expire in ~1 hour,
so this suits short-lived/manual brings-up; `ACCESS_TOKEN` is better for
long-running hosts since the entrypoint mints a fresh token on each restart.

## One-off `docker run` (no compose)

The build context is the repo root, so build with `-f` from there (not from this
directory):

```bash
# from the repo root:
docker build -t copse-ci-runner -f .github/runner/Dockerfile .
docker run -d --restart always --init --shm-size 2g \
  -e GITHUB_URL=https://github.com/copse-dev/agent-pane \
  -e ACCESS_TOKEN=ghp_xxx \
  copse-ci-runner
```
