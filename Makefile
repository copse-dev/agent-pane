# Copse — developer Makefile
#
# Two jobs, both idempotent and safe to re-run:
#
#   1. Docker CI runners — provision / (re)build / reprovision the self-hosted
#      GitHub Actions runner fleets (`make runners`). With no TIER it brings up
#      BOTH fleets (checks + e2e) in one shot; verifies the required tooling is
#      installed, that each tier's `.env` is present and filled in, and scales
#      to however many runners you ask for. The runner images bake the
#      dependency tree at build time, so freshly (re)provisioned runners start
#      warm instead of downloading ~525 MB of node_modules on their first job.
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

# Which fleets the umbrella targets act on. When TIER is NOT pinned on the
# command line, `runners`, `runners-build`, `runners-reprovision`,
# `runners-restart` and `runners-down` fan out over BOTH fleets — so
# `make runners` on a fresh machine brings up checks + e2e in one shot. Pin
# TIER=e2e or TIER=checks to scope any of them to a single fleet. (`origin`
# is `command line` only when the caller passed TIER=…; the `?=` default above
# leaves it `file`.)
ifeq ($(filter command line,$(origin TIER)),command line)
  TIERS := $(TIER)
else
  TIERS := checks e2e
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
	@echo "Docker CI runners (no TIER = BOTH fleets; TIER=e2e|checks, RUNNERS=N):"
	@echo "  make runners             Provision, build & (re)start the fleet(s) [$(TIERS)]"
	@echo "  make runners-build       Build/refresh the runner image(s) only (pulls latest base)"
	@echo "  make runners-reprovision Clean rebuild: down → build --no-cache → up (picks up new deps)"
	@echo "  make runners-restart     Restart the running containers"
	@echo "  make runners-down        Stop & remove the fleet(s)"
	@echo "  make runners-logs        Follow ONE fleet's logs (TIER=e2e|checks, default $(TIER))"
	@echo "  make runners-ps          Show fleet status"
	@echo "  make runner-env          Check/scaffold the $(TIER) .env file"
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
	@echo "  make runners                      # BOTH fleets (checks + e2e) on this machine"
	@echo "  make runners-reprovision          # clean-rebuild BOTH fleets (after a repull)"
	@echo "  make runners RUNNERS=5             # both fleets, 5 runners each"
	@echo "  make runners TIER=checks RUNNERS=2 # just the check-tier fleet"
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
	echo "==> $(TIER) .env OK ($$env_file): GITHUB_URL set, credentials present."

# --- provision / build / reprovision ---------------------------------------
# The umbrella targets verify tooling once, then loop over $(TIERS), re-invoking
# make once per fleet with TIER pinned. Each per-fleet sub-make re-parses this
# file with its own TIER, so RUNNER_DIR, the tier `.env` and the RUNNERS default
# all resolve correctly. A command-line `RUNNERS=N` propagates to the sub-makes
# automatically (make forwards command-line variables), overriding both fleets.

# Bring the fleet(s) up. `up -d --build --pull always` (re)creates containers,
# rebuilds the image (pulling the latest base so the toolchain stays current),
# and scales to $(RUNNERS). With no TIER this does checks + e2e.
.PHONY: runners
runners: check-tools
	@for t in $(TIERS); do \
	  $(MAKE) --no-print-directory _fleet-up TIER=$$t || exit $$?; \
	done

.PHONY: _fleet-up
_fleet-up: runner-env
	@echo "==> Provisioning $(RUNNERS) '$(TIER)' runner(s) from $(RUNNER_DIR)…"
	$(COMPOSE_IN_TIER) up -d --build --pull always --scale runner=$(RUNNERS)
	@echo "==> '$(TIER)' fleet up. Follow logs with:  make runners-logs TIER=$(TIER)"

# Rebuild the image(s) without touching running containers (pull latest base).
.PHONY: runners-build
runners-build: check-tools
	@for t in $(TIERS); do \
	  $(MAKE) --no-print-directory _fleet-build TIER=$$t || exit $$?; \
	done

.PHONY: _fleet-build
_fleet-build:
	@echo "==> Building the '$(TIER)' runner image (pulling latest base)…"
	$(COMPOSE_IN_TIER) build --pull

# Clean reprovision: tear the fleet down, rebuild the image from scratch (no
# layer cache, fresh base) so a new baked dependency layer is picked up, then
# bring it back up. This is the "I just repulled / my runners are stale" button.
.PHONY: runners-reprovision
runners-reprovision: check-tools
	@for t in $(TIERS); do \
	  $(MAKE) --no-print-directory _fleet-reprovision TIER=$$t || exit $$?; \
	done

.PHONY: _fleet-reprovision
_fleet-reprovision: runner-env
	@echo "==> Reprovisioning the '$(TIER)' fleet (down → build --no-cache → up)…"
	$(COMPOSE_IN_TIER) down --remove-orphans
	$(COMPOSE_IN_TIER) build --no-cache --pull
	$(COMPOSE_IN_TIER) up -d --scale runner=$(RUNNERS)
	@echo "==> '$(TIER)' fleet reprovisioned ($(RUNNERS) runner(s))."

# Restart the current containers in place (no rebuild, no re-scale).
.PHONY: runners-restart
runners-restart: check-tools
	@for t in $(TIERS); do \
	  $(MAKE) --no-print-directory _fleet-restart TIER=$$t || exit $$?; \
	done

.PHONY: _fleet-restart
_fleet-restart:
	@echo "==> Restarting the '$(TIER)' fleet…"
	$(COMPOSE_IN_TIER) restart

.PHONY: runners-down
runners-down: check-tools
	@for t in $(TIERS); do \
	  $(MAKE) --no-print-directory _fleet-down TIER=$$t || exit $$?; \
	done

.PHONY: _fleet-down
_fleet-down:
	@echo "==> Stopping & removing the '$(TIER)' fleet…"
	$(COMPOSE_IN_TIER) down

# logs follows a SINGLE fleet (tailing both at once is unreadable): TIER selects
# it (default $(TIER)). ps shows every fleet in $(TIERS).
.PHONY: runners-logs
runners-logs:
	@$(COMPOSE_IN_TIER) logs -f

.PHONY: runners-ps
runners-ps:
	@for t in $(TIERS); do \
	  echo "== $$t =="; \
	  $(MAKE) --no-print-directory _fleet-ps TIER=$$t || exit $$?; \
	done

.PHONY: _fleet-ps
_fleet-ps:
	@$(COMPOSE_IN_TIER) ps

# ============================================================================
# 2) App dev loop: deps -> build -> run
# ============================================================================

# --- node preflight ---------------------------------------------------------
.PHONY: check-node
check-node:
	@if ! command -v node >/dev/null 2>&1; then \
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
