/**
 * The two files the worker image is built from, kept as strings so the app can
 * assemble an image context from its own bundle without shipping loose files.
 * `buildWorkerImage` in `thread-container.ts` writes them next to the bundled
 * worker and the staged sandbox runtime.
 */

/**
 * Built from a staging context that holds only the bundled worker, the sandbox
 * runtime, and the entrypoint — never the repository, node_modules, or any
 * credential. The base image must provide Node 22; Debian/Ubuntu apt is used
 * for the guest toolchain so the same file serves both families. No
 * `# syntax=` directive: it would pull a frontend image from Docker Hub, which
 * some sandboxes cannot reach.
 */
export const WORKER_DOCKERFILE = `# The Copse container worker image (docs/plans/thread-in-container.md).
#
# Built from a staging context that holds only the bundled worker, the pinned
# sandbox runtime, and the entrypoint — never the repository, node_modules, or
# any credential. The base image must provide Node 22; Debian/Ubuntu apt is
# used for the guest toolchain so the same file serves both families.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM \${BASE_IMAGE}
ARG WORKER_UID=1001

ENV DEBIAN_FRONTEND=noninteractive \\
    npm_config_update_notifier=false

RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
      bubblewrap \\
      ca-certificates \\
      git \\
      ripgrep \\
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid "\${WORKER_UID}" --shell /bin/bash copse

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root node_modules ./node_modules
COPY --chown=root:root worker.cjs entrypoint.sh ./
RUN chmod 0755 /app/entrypoint.sh && mkdir -p /workspace && chown "\${WORKER_UID}" /workspace

USER \${WORKER_UID}:\${WORKER_UID}
ENV NODE_PATH=/app/node_modules
WORKDIR /workspace
ENTRYPOINT ["/app/entrypoint.sh"]
`

/**
 * Guest entrypoint. Runs as the unprivileged worker user with no network
 * interface. Egress is the worker's own loopback proxy over the one broker
 * socket the host mounted, so the entrypoint no longer listens for anything:
 * the addresses the worker and its children use are in the environment Docker
 * was given.
 */
export const WORKER_ENTRYPOINT_SH = `#!/bin/sh
# Guest entrypoint for a Copse container run. Runs as the unprivileged worker
# user; the container has no network interface. Outbound traffic goes through
# the worker's own loopback proxy, which speaks to the host broker over the one
# unix socket named by COPSE_EGRESS_SOCKET; HTTPS_PROXY and friends already
# point every client here at it, so there is nothing to start first.
set -eu

exec node /app/worker.cjs
`
