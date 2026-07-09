# Copse — developer Makefile
#
# Two jobs, both idempotent and safe to re-run:
#
#   1. Docker CI runners — provision / (re)build / reprovision the self-hosted
#      GitHub Actions runner fleet (`make runners`). One unified image
#      (ci-runners/) serves both the e2e and check tiers; verifies the required
#      tooling is installed, that the `.env` is present and filled in, and scales
#      to however many runners you ask for. The runner image bakes the dependency
#      tree at build time, so freshly (re)provisioned runners start warm instead
#      of downloading ~525 MB of node_modules on their first job.
#
#   2. App dev loop — keep dependencies and the `dist/` build in sync, then run
#      the app (`make run`). Dependencies are only reinstalled when
#      `package-lock.json` changes; `dist/` is only rebuilt when source changes.
#
# Run `make` (or `make help`) for the full target list.

# Strict bash flags — any failing command aborts the recipe line. Multi-line
# shell blocks use backslash continuations so they work on macOS /usr/bin/make
# (GNU Make 3.81), which predates .ONESHELL (3.82+).
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# ----------------------------------------------------------------------------
# Configuration (override on the command line, e.g. `make runners RUNNERS=5`)
# ----------------------------------------------------------------------------

# The unified runner fleet lives in ci-runners/ — one superset image that serves
# BOTH the e2e (Chromium/Xvfb) and check (typecheck/lint/unit) tiers via a single
# pool, so a box is eligible for whichever job is queued instead of one labelled
# fleet idling while the other saturates. Size for the heavy tier since e2e jobs
# land here too (~4-6 GB/runner), so 3 is a sane default.
RUNNER_DIR := ci-runners
RUNNERS ?= 3

# `docker compose` (v2 plugin) is preferred; fall back to legacy `docker-compose`.
DOCKER ?= docker
COMPOSE ?= $(shell \
  if $(DOCKER) compose version >/dev/null 2>&1; then echo "$(DOCKER) compose"; \
  elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; \
  else echo "$(DOCKER) compose"; fi)

# Run compose from inside the fleet directory so its `.env` resolves exactly as
# the README documents.
COMPOSE_IN_DIR := cd $(RUNNER_DIR) && $(COMPOSE)

# Minimum Node major.minor required by package.json `engines` (>=22.18).
NODE_MIN_MAJOR := 22
NODE_MIN_MINOR := 18

# nvm ships as a shell function loaded from nvm.sh, not a binary, so a recipe
# can't just call `nvm`. Source it (honouring $NVM_DIR, default ~/.nvm) and run
# `nvm use` to select the version pinned in .nvmrc before any node/npm command.
# Each recipe line is its own subshell, so this prefixes every node-touching
# recipe rather than running once. Sourced under `set +u` because nvm.sh trips
# the Makefile's `-u` flag; a no-op when nvm isn't installed, so PATH's node is
# used as a fallback (check-node then reports if that's too old).
NVM_DIR ?= $(HOME)/.nvm
USE_NVM := if [ -s "$(NVM_DIR)/nvm.sh" ]; then set +u; . "$(NVM_DIR)/nvm.sh"; nvm use >/dev/null || true; set -u; fi

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
	@echo "Docker CI runners (unified e2e+check fleet; RUNNERS=N):"
	@echo "  make runners             Provision, build & (re)start the fleet"
	@echo "  make runners-build       Build/refresh the runner image only (pulls latest base)"
	@echo "  make runners-reprovision Clean rebuild: down → build --no-cache → up (picks up new deps)"
	@echo "  make runners-restart     Restart the running containers"
	@echo "  make runners-down        Stop & remove the fleet"
	@echo "  make runners-logs        Follow the fleet's logs"
	@echo "  make runners-ps          Show fleet status"
	@echo "  make runner-env          Check/scaffold the ci-runners/.env file"
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
	@echo "  make runners                      # bring the fleet up on this machine"
	@echo "  make runners-reprovision          # clean-rebuild the fleet (after a repull)"
	@echo "  make runners RUNNERS=5             # 5 runners"
	@echo "  make run                           # sync deps+build, then launch"

# ============================================================================
# 1) Docker CI runners
# ============================================================================

$(STAMP_DIR):
	@mkdir -p $(STAMP_DIR)

# --- tooling preflight ------------------------------------------------------
.PHONY: check-tools
check-tools:
	@fail=0; \
	if ! command -v $(DOCKER) >/dev/null 2>&1; then \
	  echo "ERROR: docker is not installed. See https://docs.docker.com/get-docker/" >&2; \
	  fail=1; \
	elif ! $(DOCKER) info >/dev/null 2>&1; then \
	  echo "ERROR: the Docker daemon isn't running (or you lack permission)." >&2; \
	  echo "       Start Docker Desktop / the docker service and retry." >&2; \
	  fail=1; \
	fi; \
	if ! $(COMPOSE) version >/dev/null 2>&1; then \
	  echo "ERROR: '$(COMPOSE)' is unavailable. Install the Docker Compose v2 plugin" >&2; \
	  echo "       (bundled with Docker Desktop) or the legacy docker-compose binary." >&2; \
	  fail=1; \
	fi; \
	if ! command -v git >/dev/null 2>&1; then \
	  echo "ERROR: git is not installed." >&2; \
	  fail=1; \
	fi; \
	if [ "$$fail" -ne 0 ]; then exit 1; fi; \
	echo "==> Tooling OK: $$($(DOCKER) --version), $$($(COMPOSE) version | head -n1)"

# --- .env preflight ---------------------------------------------------------
# Ensures the tier's .env exists (scaffolding it from .env.example on first run)
# and that the credentials the entrypoint requires are actually filled in. On
# any gap it prints exactly what to set and stops — no half-provisioned fleet.
.PHONY: runner-env
runner-env:
	@env_file="$(RUNNER_DIR)/.env"; \
	example="$(RUNNER_DIR)/.env.example"; \
	if [ ! -f "$$env_file" ]; then \
	  echo "==> $$env_file not found — creating it from $$example"; \
	  cp "$$example" "$$env_file"; \
	  echo; \
	  echo "ACTION REQUIRED: edit $$env_file and set your credentials, then re-run make:"; \
	  echo "  GITHUB_URL    the repo/org URL the runners attach to"; \
	  echo "  ACCESS_TOKEN  a GitHub PAT that can register runners"; \
	  echo "                (classic PAT: 'repo' scope; fine-grained: Administration R/W)"; \
	  echo "                — or set RUNNER_TOKEN to a pre-fetched registration token."; \
	  exit 1; \
	fi; \
	set -a; . "$$env_file"; set +a; \
	missing=0; \
	if [ -z "$${GITHUB_URL:-}" ]; then \
	  echo "ERROR: GITHUB_URL is not set in $$env_file (e.g. https://github.com/owner/repo)." >&2; \
	  missing=1; \
	fi; \
	if [ -z "$${ACCESS_TOKEN:-}" ] && [ -z "$${RUNNER_TOKEN:-}" ]; then \
	  echo "ERROR: set ACCESS_TOKEN (a PAT) or RUNNER_TOKEN (a registration token) in $$env_file." >&2; \
	  echo "       Classic PAT needs 'repo' scope; fine-grained needs Administration -> Read & write." >&2; \
	  missing=1; \
	fi; \
	if [ "$$missing" -ne 0 ]; then exit 1; fi; \
	echo "==> .env OK ($$env_file): GITHUB_URL set, credentials present."

# --- provision / build / reprovision ---------------------------------------
# One unified fleet, so each target acts on ci-runners/ directly. A command-line
# `RUNNERS=N` overrides the default scale.

# Bring the fleet up. `up -d --build --pull always` (re)creates containers,
# rebuilds the image (pulling the latest base so the toolchain stays current),
# and scales to $(RUNNERS).
.PHONY: runners
runners: check-tools runner-env
	@echo "==> Provisioning $(RUNNERS) runner(s) from $(RUNNER_DIR)…"
	$(COMPOSE_IN_DIR) up -d --build --pull always --scale runner=$(RUNNERS)
	@echo "==> Fleet up. Follow logs with:  make runners-logs"

# Rebuild the image without touching running containers (pull latest base).
.PHONY: runners-build
runners-build: check-tools
	@echo "==> Building the runner image (pulling latest base)…"
	$(COMPOSE_IN_DIR) build --pull

# Clean reprovision: tear the fleet down, rebuild the image from scratch (no
# layer cache, fresh base) so a new baked dependency layer is picked up, then
# bring it back up. This is the "I just repulled / my runners are stale" button.
.PHONY: runners-reprovision
runners-reprovision: check-tools runner-env
	@echo "==> Reprovisioning the fleet (down → build --no-cache → up)…"
	$(COMPOSE_IN_DIR) down --remove-orphans
	$(COMPOSE_IN_DIR) build --no-cache --pull
	$(COMPOSE_IN_DIR) up -d --scale runner=$(RUNNERS)
	@echo "==> Fleet reprovisioned ($(RUNNERS) runner(s))."

# Restart the current containers in place (no rebuild, no re-scale).
.PHONY: runners-restart
runners-restart: check-tools
	@echo "==> Restarting the fleet…"
	$(COMPOSE_IN_DIR) restart

.PHONY: runners-down
runners-down: check-tools
	@echo "==> Stopping & removing the fleet…"
	$(COMPOSE_IN_DIR) down

.PHONY: runners-logs
runners-logs:
	@$(COMPOSE_IN_DIR) logs -f

.PHONY: runners-ps
runners-ps:
	@$(COMPOSE_IN_DIR) ps

# ============================================================================
# 2) App dev loop: deps -> build -> run
# ============================================================================

# --- node preflight ---------------------------------------------------------
.PHONY: check-node
check-node:
	@$(USE_NVM); \
	if ! command -v node >/dev/null 2>&1; then \
	  echo "ERROR: node is not installed (need >=$(NODE_MIN_MAJOR).$(NODE_MIN_MINOR); see .nvmrc)." >&2; \
	  exit 1; \
	fi; \
	ver="$$(node -p 'process.versions.node')"; \
	major="$${ver%%.*}"; rest="$${ver#*.}"; minor="$${rest%%.*}"; \
	if [ "$$major" -lt "$(NODE_MIN_MAJOR)" ] || { [ "$$major" -eq "$(NODE_MIN_MAJOR)" ] && [ "$$minor" -lt "$(NODE_MIN_MINOR)" ]; }; then \
	  echo "ERROR: Node $$ver is too old — need >=$(NODE_MIN_MAJOR).$(NODE_MIN_MINOR) (see .nvmrc). Try 'nvm use'." >&2; \
	  exit 1; \
	fi; \
	echo "==> Node $$ver OK."

# --- dependencies -----------------------------------------------------------
# Reinstall only when the lockfile (or package.json) is newer than the last
# successful install. `npm ci` gives a clean, lockfile-exact tree.
#
# `--ignore-scripts=false` forces this project's `postinstall` to run even when
# npm is hardened with `ignore-scripts=true` in ~/.npmrc — without it that
# supply-chain setting silently skips the native postinstall (chmod on
# node-pty's spawn-helper, electron-rebuild, gortex fetch) and the integrated
# terminal fails to launch. The flag is scoped to this one invocation, so it
# doesn't touch your global config. See the "Hardened npm profiles" section of
# the README.
.PHONY: deps
deps: $(DEPS_STAMP)

$(DEPS_STAMP): package-lock.json package.json | $(STAMP_DIR) check-node
	@echo "==> Dependencies out of date — running 'npm ci' (scripts forced on)…"
	@$(USE_NVM); npm ci --ignore-scripts=false
	touch $(DEPS_STAMP)

# --- build ------------------------------------------------------------------
# Rebuild dist/ only when source changed since the last build. A stale dist/ is
# wiped first so nothing from a prior layout lingers.
.PHONY: build
build: $(BUILD_STAMP)

$(BUILD_STAMP): $(DEPS_STAMP) $(BUILD_SRC) | $(STAMP_DIR)
	@echo "==> Source changed — clearing dist/ and rebuilding…"
	rm -rf dist
	@$(USE_NVM); npm run build
	touch $(BUILD_STAMP)

# --- run --------------------------------------------------------------------
# Sync deps, rebuild if needed (both via prerequisites), then launch the app.
.PHONY: run
run: build
	@echo "==> Starting the app…"
	@$(USE_NVM); npm start

# --- cleanup ----------------------------------------------------------------
.PHONY: clean
clean:
	@echo "==> Removing dist/ and build/deps stamps…"
	rm -rf dist $(DEPS_STAMP) $(BUILD_STAMP)
