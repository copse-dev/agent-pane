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

FROM node:22-bookworm

# Pin the runner agent; bump deliberately. https://github.com/actions/runner/releases
ARG RUNNER_VERSION=2.330.0
# Supplied automatically by BuildKit (amd64 | arm64).
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false

# 1) System packages:
#    - build toolchain (build-essential, python3) for the repo's native deps
#      (node-pty, @anthropic-ai/sandbox-runtime) built during `npm install`
#    - xvfb: the virtual display WebdriverIO auto-spawns on Linux
#    - the full Chromium runtime lib set Electron dlopen()s at launch. Missing
#      any one of these surfaces as a cryptic "tab crashed" / launch failure,
#      so the list is deliberately complete rather than minimal.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq sudo \
      build-essential python3 \
      xvfb \
      fonts-liberation \
      libglib2.0-0 libdbus-1-3 \
      libnss3 libnspr4 \
      libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcups2 libdrm2 libgbm1 libgl1 \
      libgtk-3-0 libpango-1.0-0 libcairo2 libasound2 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxrandr2 libxkbcommon0 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# 2) Non-root user. The GitHub runner refuses to run as root unless you set
#    RUNNER_ALLOW_RUNASROOT; a normal user is the supported path.
RUN useradd -m -s /bin/bash runner \
    && mkdir -p /opt/runner \
    && chown runner:runner /opt/runner

WORKDIR /opt/runner

# 3) GitHub Actions runner agent. TARGETARCH -> the release asset suffix.
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

USER runner
ENTRYPOINT ["/opt/runner/entrypoint.sh"]
