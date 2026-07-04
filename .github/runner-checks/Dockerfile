# syntax=docker/dockerfile:1

# A single Linux runner image for this repo's NON-e2e checks — everything the
# `check` script and CI's static tier run:
#   typecheck, lint, format:check, check:dead-code, check:oracle, unit tests
#   (npm test / coverage:ci), and check:normalizer-parity.
#
# It is the lightweight sibling of ../runner (the e2e image). The e2e image
# carries the full Chromium/Electron/Xvfb runtime so it can launch the app;
# these checks never start Electron, so this image drops that entire stack
# (~hundreds of MB of X11/GTK/Chromium libs + the emoji font). What stays is
# only what the static + unit tier touches:
#   - Node 22 + the native build toolchain (npm ci electron-rebuilds node-pty
#     and @anthropic-ai/sandbox-runtime — a COMPILE step, no display needed),
#   - ripgrep (the unit suite exercises the code-search services that shell out
#     to `rg`; on a self-hosted Linux runner the setup action assumes it's
#     already provisioned and installs nothing — see .github/actions/setup),
#   - python3 (check:normalizer-parity diffs the JS CommonMark normalizer
#     against the reference normalize.py via python3).
#
# Runs on ANY Docker host — Linux native, or the Linux VM under Docker Desktop /
# OrbStack / Colima on macOS and Windows (Linux-containers mode). Multi-arch:
# BuildKit builds the host's native arch (linux/amd64 or linux/arm64).
#
# Base is Ubuntu 24.04 to MATCH GitHub-hosted `ubuntu-latest` (glibc 2.39). The
# vendored `codesearch` binary fetched during postinstall is built against
# glibc >= 2.38/2.39; on older distros (e.g. Debian bookworm, glibc 2.36) the
# postinstall `codesearch --version` check fails with "GLIBC_2.39 not found".
# Mirroring CI's OS keeps every prebuilt behaving identically.
FROM ubuntu:24.04

# Pin the runner agent; bump deliberately. https://github.com/actions/runner/releases
ARG RUNNER_VERSION=2.330.0
# Node major to match CI's actions/setup-node `node-version: '22'` (>=22.18).
ARG NODE_MAJOR=22
# Supplied automatically by BuildKit (amd64 | arm64).
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false

# 1) System packages — only what the static + unit tier needs:
#    - build toolchain (build-essential, python3) for the repo's native deps
#      (node-pty, @anthropic-ai/sandbox-runtime) built during `npm ci`.
#      python3-setuptools restores the `distutils` module node-gyp's gyp imports
#      — Python 3.12 (Ubuntu 24.04) dropped it from the stdlib (PEP 632).
#    - python3 also runs the reference normalize.py for check:normalizer-parity.
#    - ripgrep (rg): the unit suite's code-search services spawn it; the setup
#      action does NOT install it on self-hosted Linux (assumes the host has it).
#    - curl + jq: the entrypoint exchanges a PAT for a registration token.
#    Deliberately NO xvfb / Chromium libs / fonts — those belong to ../runner.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq sudo gnupg \
      ripgrep \
      build-essential python3 python3-setuptools \
    && rm -rf /var/lib/apt/lists/*

# 2) Node.js (NodeSource). Ubuntu's archive Node is too old for this repo's
#    >=22.18 engine and its `.mts` install scripts, so install the 22.x line
#    that mirrors CI's setup-node.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# 3) Non-root user. The GitHub runner refuses to run as root unless you set
#    RUNNER_ALLOW_RUNASROOT; a normal user is the supported path.
RUN useradd -m -s /bin/bash runner \
    && mkdir -p /opt/runner \
    && chown runner:runner /opt/runner

WORKDIR /opt/runner

# 4) GitHub Actions runner agent. TARGETARCH -> the release asset suffix.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) RUNNER_ARCH=x64 ;; \
      arm64) RUNNER_ARCH=arm64 ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"; \
    tar xzf runner.tar.gz; \
    rm runner.tar.gz

# Pull any remaining libs the runner agent itself needs. Runs as root, then we
# drop back to the runner user.
RUN apt-get update \
    && /opt/runner/bin/installdependencies.sh \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=runner:runner .github/runner-checks/entrypoint.sh /opt/runner/entrypoint.sh
RUN chmod +x /opt/runner/entrypoint.sh && chown -R runner:runner /opt/runner

# 5) Bake the dependency tree so ephemeral runners start warm.
#    These runners are ephemeral (one job per pristine container, no volumes),
#    so every job would otherwise restore ~525 MB of node_modules from the
#    Actions cache service over the network before doing any work — the slow
#    step this image exists to remove. Run the repo's own install ONCE here and
#    stash node_modules + vendor/codesearch under /opt/deps/tree. The setup
#    action (.github/actions/setup) seeds a job's workspace from this layer when
#    the checked-out package-lock.json still matches what was baked (recorded in
#    .lockhash); on a lockfile bump it falls back to the cache / npm ci path, so
#    the layer is never used stale.
#
#    The build context is the repo root (see docker-compose.yml), so these COPYs
#    reach the manifests + scripts the install's pre/postinstall hooks need
#    (electron-rebuild of node-pty, the vendored codesearch fetch, esbuild's
#    platform binary). Kept as the LAST layers so a lockfile/scripts change only
#    re-runs the install, not the toolchain above it. Non-fatal: if the install
#    fails the image still builds (no .ready marker) and runners fall back.
WORKDIR /opt/deps/tree
COPY package.json package-lock.json ./
COPY tsconfig*.json ./
COPY scripts ./scripts
RUN set -eux; \
    if npm_config_ignore_scripts=false npm ci --include=optional --no-audit --no-fund; then \
      sha256sum package-lock.json | awk '{ print $1 }' > .lockhash; \
      npm cache clean --force >/dev/null 2>&1 || true; \
      chmod -R a+rX /opt/deps/tree; \
      touch .ready; \
      echo "==> baked deps ready ($(du -sh node_modules 2>/dev/null | cut -f1) node_modules)"; \
    else \
      echo "==> WARNING: dependency baking failed — runners fall back to the CI cache / npm ci path"; \
    fi
ENV COPSE_BAKED_DEPS=/opt/deps/tree
WORKDIR /opt/runner

USER runner
ENTRYPOINT ["/opt/runner/entrypoint.sh"]
