# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Unified, repo-agnostic self-hosted GitHub Actions runner (PROTOTYPE)
# ---------------------------------------------------------------------------
# This is the consolidation of agent-pane's two runner images
# (.github/runner = copse-e2e, .github/runner-checks = copse-checks) into ONE
# superset image that any repo in the org can share:
#
#   * It carries the FULL e2e stack (Chromium/Electron/Xvfb + emoji font), so
#     it can run the heavy e2e tier. The check tier (typecheck/lint/unit) is a
#     strict subset of what's installed here, so the SAME container also serves
#     the light jobs — no second image, no static label partition. One pool
#     load-balances across both tiers instead of one fleet idling while the
#     other is saturated.
#
#   * It is repo-agnostic. The old images baked THIS repo's dependency tree by
#     using the repo root as the build context (COPY package*.json + npm ci).
#     That couples the image to one repo. Here we instead CLONE the target
#     repo's branch at build time ("thread in main") and bake its deps — so the
#     image lives in its own repo (future copse-dev/ci-runners) and is pointed
#     at whichever consumer repo you want via build args.
#
# Build (BuildKit required — for the --mount=type=secret clone token):
#   DOCKER_BUILDKIT=1 docker build -t copse-ci-runner \
#     --build-arg TARGET_REPO=copse-dev/agent-pane \
#     --build-arg TARGET_REF=main \
#     --secret id=gh_token,env=BUILD_GH_TOKEN \
#     -f Dockerfile .
#
# See docker-compose.yml for the same wiring driven from .env.
#
# Base is Ubuntu 24.04 to MATCH GitHub-hosted `ubuntu-latest` (glibc 2.39).
# Prebuilt native modules (Electron, node-pty) are built against the CI
# toolchain; on an older distro they can fail with "GLIBC_2.39 not found".
FROM ubuntu:24.04

# Pin the runner agent; bump deliberately. https://github.com/actions/runner/releases
ARG RUNNER_VERSION=2.330.0
# Node major to match CI's actions/setup-node `node-version: '22'` (>=22.18).
ARG NODE_MAJOR=22
# Supplied automatically by BuildKit (amd64 | arm64).
ARG TARGETARCH
# Which consumer repo's dependency tree to bake, and at which ref. Override per
# consumer; defaults to the heavy consumer (agent-pane) whose warm start matters
# most. A repo with a trivial install (e.g. streaming-markdown) can be left to
# fall back to `npm ci` at job time — see the bake step below.
ARG TARGET_REPO=copse-dev/agent-pane
ARG TARGET_REF=main

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false

# 1) System packages: the static+unit toolchain PLUS the full Chromium runtime
#    Electron dlopen()s at launch. The check tier ignores the Chromium libs; the
#    e2e tier needs every one (a missing lib surfaces as a cryptic "tab crashed"),
#    so the list is deliberately complete. Ubuntu 24.04 uses the t64 (64-bit
#    time_t) library names.
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

# 2) Node.js (NodeSource) — the 22.x line that mirrors CI's setup-node; Ubuntu's
#    archive Node is too old for this repo's >=22.18 engine + .mts scripts.
#    Install via the signed NodeSource apt repo (GPG keyring + apt source) rather
#    than piping `setup_${NODE_MAJOR}.x` to bash as root: apt then verifies every
#    package against the pinned key, and no remote script executes as root.
RUN set -eux; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*; \
    node --version; npm --version

# 3) Non-root user. The runner agent refuses to run as root without
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

# Remaining libs the runner agent itself needs. Root here; drop to runner below.
RUN apt-get update \
    && /opt/runner/bin/installdependencies.sh \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=runner:runner entrypoint.sh /opt/runner/entrypoint.sh
RUN chmod +x /opt/runner/entrypoint.sh && chown -R runner:runner /opt/runner

# 5) Color-emoji font — without it Chromium renders emoji as blank "tofu" boxes
#    in the e2e reference screenshots.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# 6) Bake the TARGET repo's dependency tree so ephemeral runners start warm.
#    Unlike the old per-repo images (which COPYed from a repo-root build
#    context), this CLONES ${TARGET_REPO}@${TARGET_REF} at build time and runs
#    its install once, stashing node_modules (+ vendor/gortex if present) under
#    /opt/deps/tree with the package-lock.json hash in .lockhash. The consumer
#    repo's setup action seeds a job's workspace from this layer when the
#    checked-out lockfile still matches (COPSE_BAKED_DEPS), else falls back to
#    the Actions cache / npm ci — so the layer is never used stale.
#
#    The clone AND agent-pane's `npm ci` (which pulls the PRIVATE git dependency
#    @copse/streaming-markdown) both need a read token. It is provided as a
#    BuildKit secret (tmpfs, never written to an image layer) and consumed only
#    inside this RUN via GIT_CONFIG_* env vars (no token ever touches disk).
#    Mirrors .github/actions/setup: rewrite npm's ssh-normalized git dep to
#    https and attach the token as an http extraheader.
#
#    Non-fatal: if the clone or install fails the image still builds (no .ready
#    marker) and runners fall back to npm ci at job time. A repo with a trivial
#    install can be built with no token at all — the bake just no-ops.
WORKDIR /opt/deps
RUN --mount=type=secret,id=gh_token \
    set -eux; \
    TOKEN="$(cat /run/secrets/gh_token 2>/dev/null || true)"; \
    if [ -n "${TOKEN}" ]; then \
      auth="$(printf 'x-access-token:%s' "${TOKEN}" | base64 | tr -d '\n')"; \
      export GIT_CONFIG_COUNT=3 \
        GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" \
        GIT_CONFIG_VALUE_0="Authorization: Basic ${auth}" \
        GIT_CONFIG_KEY_1="url.https://github.com/.insteadOf" \
        GIT_CONFIG_VALUE_1="ssh://git@github.com/" \
        GIT_CONFIG_KEY_2="url.https://github.com/.insteadOf" \
        GIT_CONFIG_VALUE_2="git@github.com:"; \
    fi; \
    if git clone --depth=1 --branch "${TARGET_REF}" \
         "https://github.com/${TARGET_REPO}.git" tree 2>/dev/null; then \
      cd tree; \
      if npm_config_ignore_scripts=false npm ci --include=optional --no-audit --no-fund; then \
        sha256sum package-lock.json | awk '{ print $1 }' > .lockhash; \
        npm cache clean --force >/dev/null 2>&1 || true; \
        find . -maxdepth 1 -mindepth 1 \
          ! -name node_modules ! -name vendor \
          ! -name .lockhash -exec rm -rf {} + ; \
        chmod -R a+rX /opt/deps/tree; \
        touch .ready; \
        echo "==> baked ${TARGET_REPO}@${TARGET_REF} ($(du -sh node_modules 2>/dev/null | cut -f1) node_modules)"; \
      else \
        echo "==> WARNING: npm ci failed for ${TARGET_REPO} — runners fall back to cache / npm ci"; \
      fi; \
    else \
      echo "==> WARNING: could not clone ${TARGET_REPO}@${TARGET_REF} (no/insufficient token?) — skipping bake"; \
    fi
ENV COPSE_BAKED_DEPS=/opt/deps/tree
WORKDIR /opt/runner

USER runner
ENTRYPOINT ["/opt/runner/entrypoint.sh"]
