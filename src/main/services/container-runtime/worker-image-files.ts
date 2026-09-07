/**
 * The two files the worker image is built from, kept as strings so the app can
 * assemble an image context from its own bundle without shipping loose files.
 * `buildWorkerImage` in `thread-container.ts` writes them next to the bundled
 * worker and the staged sandbox runtime.
 */

/**
 * Built from a staging context that holds only the bundled worker, the sandbox
 * runtime, and the entrypoint — never the repository, node_modules, or any
 * credential. The base image must provide Node 24 (what the projects a run
 * carries in expect; decision A9); Debian/Ubuntu apt is used for the guest
 * toolchain so the same file serves both families. No
 * `# syntax=` directive: it would pull a frontend image from Docker Hub, which
 * some sandboxes cannot reach.
 */
/**
 * The base the worker image builds on unless a build names another. Debian 13
 * (trixie) rather than 12: a project's own tooling can be built against a
 * newer C++ runtime than bookworm's GCC 12 provides (`GLIBCXX_3.4.32`, seen
 * on the first install that got as far as running one).
 */
export const WORKER_BASE_IMAGE = 'node:24-trixie-slim'

/**
 * The pnpm baked into the image for a carried-in project's install. A project
 * that pins another version through `packageManager` gets it from the
 * registry at install time, which the run admits for that step.
 */
export const WORKER_PNPM_VERSION = '10.34.5'

export const WORKER_DOCKERFILE = `# The Copse container worker image (docs/plans/thread-in-container.md).
#
# Built from a staging context that holds only the bundled worker, the pinned
# sandbox runtime, and the entrypoint — never the repository, node_modules, or
# any credential. The base image must provide Node 24; Debian/Ubuntu apt is
# used for the guest toolchain so the same file serves both families.
ARG BASE_IMAGE=${WORKER_BASE_IMAGE}
FROM \${BASE_IMAGE}
ARG WORKER_UID=1001
# The package manager a carried-in project's install runs under (decision A9),
# pinned so the image is reproducible. Empty means none is baked.
ARG PNPM_VERSION=""

# ACP agents the guest may run, as pinned \`package@version\` specs
# (src/shared/container-acp-agents.ts). Installed globally so they are on the
# worker user's PATH under their catalogue names; the run gives one of them a
# single API key by value, never a login. Empty means no agents are baked.
ARG ACP_AGENTS=""

ENV DEBIAN_FRONTEND=noninteractive \\
    npm_config_update_notifier=false

# python3, make, g++ and pkg-config are what node-gyp needs to build a native
# module (node-pty, say) during a carried-in project's install (decision A9).
# xvfb and Electron's shared libraries let a project's Electron e2e suite run
# under a virtual display (decision A11); the Electron binary itself comes
# from GitHub releases during the install, which an installing run admits.
# The t64 names are Debian 13's, after its time_t transition.
# No bubblewrap and no socat: the container is the sandbox (decision A7), so
# nothing inside it nests a second one, and the container keeps Docker's
# default seccomp and AppArmor profiles instead of the unconfined ones a
# nested bubblewrap needed.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
      ca-certificates \\
      git \\
      ripgrep \\
      python3 \\
      make \\
      g++ \\
      pkg-config \\
      xvfb \\
      xauth \\
      fonts-liberation \\
      libgtk-3-0t64 \\
      libnotify4 \\
      libnss3 \\
      libxss1 \\
      libxtst6 \\
      libatspi2.0-0t64 \\
      libdrm2 \\
      libgbm1 \\
      libxcb-dri3-0 \\
      libasound2t64 \\
      libx11-xcb1 \\
      libxkbcommon0 \\
      libsecret-1-0 \\
      libcups2t64 \\
      libgl1 \\
      xdg-utils \\
    && rm -rf /var/lib/apt/lists/*

RUN if [ -n "\${ACP_AGENTS}" ]; then npm install -g --no-fund --no-audit \${ACP_AGENTS} && npm cache clean --force; fi
RUN if [ -n "\${PNPM_VERSION}" ]; then npm install -g --no-fund --no-audit "pnpm@\${PNPM_VERSION}" && npm cache clean --force; fi

RUN useradd --create-home --uid "\${WORKER_UID}" --shell /bin/bash copse

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root node_modules ./node_modules
COPY --chown=root:root worker.cjs entrypoint.sh ./
RUN chmod 0755 /app/entrypoint.sh && mkdir -p /workspace/.pnpm-store && chown -R "\${WORKER_UID}" /workspace

USER \${WORKER_UID}:\${WORKER_UID}
ENV NODE_PATH=/app/node_modules
WORKDIR /workspace
ENTRYPOINT ["/app/entrypoint.sh"]
`

/**
 * Guest entrypoint. Runs as the unprivileged worker user with no network
 * interface. Egress is the worker's own loopback proxy over the link on the
 * container's stdio, so the entrypoint listens for nothing: the addresses the
 * worker and its children use are in the environment Docker was given.
 */
export const WORKER_ENTRYPOINT_SH = `#!/bin/sh
# Guest entrypoint for a Copse container run. Runs as the unprivileged worker
# user; the container has no network interface. Outbound traffic goes through
# the worker's own loopback proxy, which speaks to the host broker over this
# process's stdin and stdout; HTTPS_PROXY and friends already point every
# client here at it, so there is nothing to start first.
set -eu

exec node /app/worker.cjs
`
