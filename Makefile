# Copse — developer Makefile
#
# Two jobs, both idempotent and safe to re-run:
#
#   1. Docker CI runners — provision / (re)build / restart the self-hosted
#      GitHub Actions runner fleet (`make runners`). Verifies the required
#      tooling is installed, that the tier's `.env` is present and its keys are
#      filled in, and scales to however many runners you ask for.
#
#   2. App dev loop — keep dependencies and the `dist/` build in sync, then run
#      the app (`make run`). Dependencies are only reinstalled when
#      `package-lock.json` changes; `dist/` is only rebuilt when source changes.
#
# Run `make` (or `make help`) for the full target list.

# One shell per recipe with strict flags, so multi-line blocks read naturally
# and any failing command aborts the target.
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.ONESHELL:
.DEFAULT_GOAL := help

# ----------------------------------------------------------------------------
# Configuration (override on the command line, e.g. `make runners RUNNERS=5`)
# ----------------------------------------------------------------------------

# Which runner fleet to act on: `e2e` (the Chromium/Xvfb suite) or `checks`
# (the lighter typecheck/lint/unit tier). Picks the compose stack + defaults.
TIER ?= e2e

ifeq ($(TIER),e2e)
  RUNNER_DIR := .github/runner
  # Chromium-under-Xvfb is memory hungry (~4-6 GB/runner) — 3 is a sane default.
  RUNNERS ?= 3
else ifeq ($(TIER),checks)
  RUNNER_DIR := .github/runner-checks
  # The static + unit tier is lighter; 2 is plenty.
  RUNNERS ?= 2
else
  $(error TIER must be 'e2e' or 'checks' (got '$(TIER)'))
endif

# `docker compose` (v2 plugin) is preferred; fall back to legacy `docker-compose`.
DOCKER ?= docker
COMPOSE ?= $(shell \
  if $(DOCKER) compose version >/dev/null 2>&1; then echo "$(DOCKER) compose"; \
  elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; \
  else echo "$(DOCKER) compose"; fi)

# Run compose from inside the tier directory so its `.env` and `build.context`
# resolve exactly as the READMEs document.
COMPOSE_IN_TIER := cd $(RUNNER_DIR) && $(COMPOSE)

# Minimum Node major.minor required by package.json `engines` (>=22.18).
NODE_MIN_MAJOR := 22
NODE_MIN_MINOR := 18

# Stamp files record the last successful install/build so we can skip no-op work.
STAMP_DIR   := .tmp
DEPS_STAMP  := $(STAMP_DIR)/deps.stamp
BUILD_STAMP := $(STAMP_DIR)/build.stamp

# Source that, when changed, should trigger a rebuild of `dist/`. Evaluated when
# the Makefile is parsed; new files are picked up on the next `make` invocation.
BUILD_SRC := $(shell find src packages scripts -type f 2>/dev/null) \
             package.json tsconfig.json tsconfig.node.json tsconfig.web.json

# ----------------------------------------------------------------------------
# Help
# ----------------------------------------------------------------------------

.PHONY: help
help:
	@echo "Copse Makefile"
	@echo
	@echo "Docker CI runners (TIER=e2e|checks, RUNNERS=N):"
	@echo "  make runners           Provision, build & (re)start the $(TIER) fleet ($(RUNNERS) runners)"
	@echo "  make runners-build     Build/refresh the runner image only (pulls latest base)"
	@echo "  make runners-restart   Restart the running $(TIER) containers"
	@echo "  make runners-down      Stop & remove the $(TIER) fleet"
	@echo "  make runners-logs      Follow the $(TIER) fleet logs"
	@echo "  make runners-ps        Show the $(TIER) fleet status"
	@echo "  make runner-env        Check/scaffold the $(TIER) .env file"
	@echo
	@echo "App dev loop:"
	@echo "  make deps              Install deps if package-lock.json changed"
	@echo "  make build             Rebuild dist/ if source changed (deps first)"
	@echo "  make run               deps -> build (if changed) -> start the app"
	@echo "  make clean             Remove dist/ and build/deps stamps"
	@echo
	@echo "Diagnostics:"
	@echo "  make check-tools       Verify docker/compose/git are installed & running"
	@echo "  make check-node        Verify Node satisfies engines (>=$(NODE_MIN_MAJOR).$(NODE_MIN_MINOR))"
	@echo
	@echo "Examples:"
	@echo "  make runners RUNNERS=5             # 5 e2e runners"
	@echo "  make runners TIER=checks RUNNERS=2 # the check-tier fleet"
	@echo "  make run                           # sync deps+build, then launch"

# ============================================================================
# 1) Docker CI runners
# ============================================================================

$(STAMP_DIR):
	@mkdir -p $(STAMP_DIR)

# --- tooling preflight ------------------------------------------------------
.PHONY: check-tools
check-tools:
	@fail=0
	if ! command -v $(DOCKER) >/dev/null 2>&1; then
	  echo "ERROR: docker is not installed. See https://docs.docker.com/get-docker/" >&2
	  fail=1
	elif ! $(DOCKER) info >/dev/null 2>&1; then
	  echo "ERROR: the Docker daemon isn't running (or you lack permission)." >&2
	  echo "       Start Docker Desktop / the docker service and retry." >&2
	  fail=1
	fi
	if ! $(COMPOSE) version >/dev/null 2>&1; then
	  echo "ERROR: '$(COMPOSE)' is unavailable. Install the Docker Compose v2 plugin" >&2
	  echo "       (bundled with Docker Desktop) or the legacy docker-compose binary." >&2
	  fail=1
	fi
	if ! command -v git >/dev/null 2>&1; then
	  echo "ERROR: git is not installed." >&2
	  fail=1
	fi
	if [ "$$fail" -ne 0 ]; then exit 1; fi
	echo "==> Tooling OK: $$($(DOCKER) --version), $$($(COMPOSE) version | head -n1)"

# --- .env preflight ---------------------------------------------------------
# Ensures the tier's .env exists (scaffolding it from .env.example on first run)
# and that the credentials the entrypoint requires are actually filled in. On
# any gap it prints exactly what to set and stops — no half-provisioned fleet.
.PHONY: runner-env
runner-env:
	@env_file="$(RUNNER_DIR)/.env"
	example="$(RUNNER_DIR)/.env.example"
	if [ ! -f "$$env_file" ]; then
	  echo "==> $$env_file not found — creating it from $$example"
	  cp "$$example" "$$env_file"
	  echo
	  echo "ACTION REQUIRED: edit $$env_file and set your credentials, then re-run make:"
	  echo "  GITHUB_URL    the repo/org URL the runners attach to"
	  echo "  ACCESS_TOKEN  a GitHub PAT that can register runners"
	  echo "                (classic PAT: 'repo' scope; fine-grained: Administration R/W)"
	  echo "                — or set RUNNER_TOKEN to a pre-fetched registration token."
	  exit 1
	fi
	# Read the values without leaking secrets into the environment/log.
	set -a; . "$$env_file"; set +a
	missing=0
	if [ -z "$${GITHUB_URL:-}" ]; then
	  echo "ERROR: GITHUB_URL is not set in $$env_file (e.g. https://github.com/owner/repo)." >&2
	  missing=1
	fi
	if [ -z "$${ACCESS_TOKEN:-}" ] && [ -z "$${RUNNER_TOKEN:-}" ]; then
	  echo "ERROR: set ACCESS_TOKEN (a PAT) or RUNNER_TOKEN (a registration token) in $$env_file." >&2
	  echo "       Classic PAT needs 'repo' scope; fine-grained needs Administration -> Read & write." >&2
	  missing=1
	fi
	if [ "$$missing" -ne 0 ]; then exit 1; fi
	echo "==> $(TIER) .env OK ($$env_file): GITHUB_URL set, credentials present."

# --- provision / build / restart -------------------------------------------
# The umbrella task: verify tooling + env, then bring the fleet up. `up -d
# --build --pull` creates missing containers, rebuilds the image (pulling the
# latest base so the toolchain stays current), and scales to $(RUNNERS).
.PHONY: runners
runners: check-tools runner-env
	@echo "==> Provisioning $(RUNNERS) '$(TIER)' runner(s) from $(RUNNER_DIR)…"
	$(COMPOSE_IN_TIER) up -d --build --pull always --scale runner=$(RUNNERS)
	echo "==> Done. Follow logs with:  make runners-logs TIER=$(TIER)"

# Rebuild the image without touching running containers (pull latest base).
.PHONY: runners-build
runners-build: check-tools
	@echo "==> Building the '$(TIER)' runner image (pulling latest base)…"
	$(COMPOSE_IN_TIER) build --pull

# Restart the current containers in place (no rebuild, no re-scale).
.PHONY: runners-restart
runners-restart: check-tools
	@echo "==> Restarting the '$(TIER)' fleet…"
	$(COMPOSE_IN_TIER) restart

.PHONY: runners-down
runners-down: check-tools
	@echo "==> Stopping & removing the '$(TIER)' fleet…"
	$(COMPOSE_IN_TIER) down

.PHONY: runners-logs
runners-logs:
	@$(COMPOSE_IN_TIER) logs -f

.PHONY: runners-ps
runners-ps:
	@$(COMPOSE_IN_TIER) ps

# ============================================================================
# 2) App dev loop: deps -> build -> run
# ============================================================================

# --- node preflight ---------------------------------------------------------
.PHONY: check-node
check-node:
	@if ! command -v node >/dev/null 2>&1; then
	  echo "ERROR: node is not installed (need >=$(NODE_MIN_MAJOR).$(NODE_MIN_MINOR); see .nvmrc)." >&2
	  exit 1
	fi
	ver="$$(node -p 'process.versions.node')"
	major="$${ver%%.*}"; rest="$${ver#*.}"; minor="$${rest%%.*}"
	if [ "$$major" -lt "$(NODE_MIN_MAJOR)" ] || { [ "$$major" -eq "$(NODE_MIN_MAJOR)" ] && [ "$$minor" -lt "$(NODE_MIN_MINOR)" ]; }; then
	  echo "ERROR: Node $$ver is too old — need >=$(NODE_MIN_MAJOR).$(NODE_MIN_MINOR) (see .nvmrc). Try 'nvm use'." >&2
	  exit 1
	fi
	echo "==> Node $$ver OK."

# --- dependencies -----------------------------------------------------------
# Reinstall only when the lockfile (or package.json) is newer than the last
# successful install. `npm ci` gives a clean, lockfile-exact tree.
.PHONY: deps
deps: $(DEPS_STAMP)

$(DEPS_STAMP): package-lock.json package.json | $(STAMP_DIR) check-node
	@echo "==> Dependencies out of date — running 'npm ci'…"
	npm ci
	touch $(DEPS_STAMP)

# --- build ------------------------------------------------------------------
# Rebuild dist/ only when source changed since the last build. A stale dist/ is
# wiped first so nothing from a prior layout lingers.
.PHONY: build
build: $(BUILD_STAMP)

$(BUILD_STAMP): $(DEPS_STAMP) $(BUILD_SRC) | $(STAMP_DIR)
	@echo "==> Source changed — clearing dist/ and rebuilding…"
	rm -rf dist
	npm run build
	touch $(BUILD_STAMP)

# --- run --------------------------------------------------------------------
# Sync deps, rebuild if needed (both via prerequisites), then launch the app.
.PHONY: run
run: build
	@echo "==> Starting the app…"
	npm start

# --- cleanup ----------------------------------------------------------------
.PHONY: clean
clean:
	@echo "==> Removing dist/ and build/deps stamps…"
	rm -rf dist $(DEPS_STAMP) $(BUILD_STAMP)
