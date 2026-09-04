# The Copse container worker image (docs/plans/thread-in-container.md).
#
# Built from a staging context that holds only the bundled worker, the pinned
# sandbox runtime, and the entrypoint — never the repository, node_modules, or
# any credential. The base image must provide Node 22; Debian/Ubuntu apt is
# used for the guest toolchain so the same file serves both families.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
ARG WORKER_UID=1001

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bubblewrap \
      ca-certificates \
      git \
      ripgrep \
      socat \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid "${WORKER_UID}" --shell /bin/bash copse

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root node_modules ./node_modules
COPY --chown=root:root worker.cjs entrypoint.sh ./
RUN chmod 0755 /app/entrypoint.sh && mkdir -p /workspace && chown "${WORKER_UID}" /workspace

USER ${WORKER_UID}:${WORKER_UID}
ENV NODE_PATH=/app/node_modules
WORKDIR /workspace
ENTRYPOINT ["/app/entrypoint.sh"]
