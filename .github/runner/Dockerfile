# syntax=docker/dockerfile:1

# A single Linux runner image that works on ANY Docker host:
#   - Linux        -> native containers
#   - macOS        -> Docker Desktop / OrbStack / Colima Linux VM
#   - Windows      -> Docker Desktop (WSL2 "Linux containers" mode)
#
# Because the e2e suite runs on Linux + Xvfb (WebdriverIO's `autoXvfb`), one
# image covers every machine you own — you no longer need macOS as a primary
# CI device. Multi-arch: builds for the host's native arch (linux/amd64 on
# Intel, linux/arm64 on Apple Silicon); both Electron and the runner agent
# ship both.
#
# Base is Ubuntu 24.04 to MATCH the GitHub-hosted `ubuntu-latest` CI runner
# (glibc 2.39). The vendored `codesearch` binary (and other prebuilts) are
# built against glibc >= 2.38/2.39; on the older Debian bookworm (glibc 2.36)
# the postinstall `codesearch --version` check fails with "GLIBC_2.39 not
# found". Mirroring CI's OS guarantees every prebuilt behaves identically.
FROM ubuntu:24.04

# Pin the runner agent; bump deliberately. https://github.com/actions/runner/releases
ARG RUNNER_VERSION=2.330.0
# Node major to match CI's actions/setup-node `node-version: '22'` (>=22.18).
ARG NODE_MAJOR=22
# Supplied automatically by BuildKit (amd64 | arm64).
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false

# 1) System packages:
#    - build toolchain (build-essential, python3) for the repo's native deps
#      (node-pty, @anthropic-ai/sandbox-runtime) built during `npm install`.
#      python3-setuptools restores the `distutils` module that node-gyp's gyp
#      imports — Python 3.12 (Ubuntu 24.04) dropped it from the stdlib (PEP 632).
#    - ripgrep (rg): the e2e app assumes it's provisioned (see
#      tool-availability.ts — under COPSE_E2E it reports rg present WITHOUT
#      probing). workspace:set awaits buildIndex(), which spawns `rg --files`;
#      if rg is missing the workspace never finishes loading and every
#      workspace-opening spec hangs to a 60s timeout. (Present on the
#      GitHub-hosted ubuntu runner; must be added explicitly here.)
#    - xvfb: the virtual display WebdriverIO auto-spawns on Linux
#    - the full Chromium runtime lib set Electron dlopen()s at launch. Missing
#      any one of these surfaces as a cryptic "tab crashed" / launch failure,
#      so the list is deliberately complete rather than minimal.
#
#    NOTE: Ubuntu 24.04 completed the 64-bit time_t transition, so several libs
#    carry a `t64` suffix (libasound2t64, libatk1.0-0t64, libcups2t64, …) — the
#    pre-24.04 names no longer resolve.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq sudo gnupg \
      ripgrep \
      build-essential python3 python3-setuptools \
      xvfb \
      fonts-liberation \
      libglib2.0-0t64 libdbus-1-3 \
      libnss3 libnspr4 \
      libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
      libcups2t64 libdrm2 libgbm1 libgl1 \
      libgtk-3-0t64 libpango-1.0-0 libcairo2 libasound2t64 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxrandr2 libxkbcommon0 libxshmfence1 \
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

# Pull any remaining libs the runner agent itself needs (separate from the
# Chromium set above). Runs as root, then we drop back to the runner user.
RUN apt-get update \
    && /opt/runner/bin/installdependencies.sh \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=runner:runner entrypoint.sh /opt/runner/entrypoint.sh
RUN chmod +x /opt/runner/entrypoint.sh && chown -R runner:runner /opt/runner

# 5) Color-emoji font. Without it Chromium/Electron has no glyphs for emoji, so
#    they render as blank "tofu" boxes in the e2e reference screenshots. Kept as
#    the LAST root layer on purpose: rebuilding to pick this up re-runs only this
#    small step while every layer above (Chromium deps, Node, the runner agent)
#    stays cached. The package's postinstall refreshes the fontconfig cache, so no
#    explicit `fc-cache` is needed. Still root here (USER runner is set below).
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

USER runner
ENTRYPOINT ["/opt/runner/entrypoint.sh"]
