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
      socat \\
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
 * Guest entrypoint. Runs as the unprivileged worker user; the container has no
 * network interface. For each origin the host allowlisted, `COPSE_EGRESS_ORIGINS`
 * names `host:port=socket` triples: the hostname the host already pointed at
 * loopback, the port to listen on, and the broker socket to forward into. The
 * host names the socket because a unix path is capped near 104 bytes and a
 * hostname is not — see `egressSocketName`. A socat listener on that port
 * forwards into the socket, which is the only route out of the guest.
 */
export const WORKER_ENTRYPOINT_SH = `#!/bin/sh
# Guest entrypoint for a Copse container run. Runs as the unprivileged worker
# user; the container has no network interface. For each origin the host
# allowlisted, COPSE_EGRESS_ORIGINS names host:port=socket triples whose
# hostnames the host already pointed at loopback; a socat listener on that port
# forwards into the named broker socket, the only route out of the guest. The
# host picks the socket file name: a unix socket path is capped near 104 bytes
# and a hostname is not, so deriving it here from the host would break on a long
# origin or a long temp root.
set -eu

RUN_DIR=/run/copse
if [ -n "\${COPSE_EGRESS_ORIGINS:-}" ]; then
  old_ifs=$IFS
  IFS=','
  for origin in $COPSE_EGRESS_ORIGINS; do
    hostport=\${origin%%=*}
    name=\${origin#*=}
    port=\${hostport##*:}
    case "$name" in
      */*|''|..) echo "[entrypoint] refusing egress socket name: $name" >&2; exit 1 ;;
    esac
    socat "TCP-LISTEN:\${port},bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$RUN_DIR/egress/\${name}" &
  done
  IFS=$old_ifs
fi

exec node /app/worker.cjs
`
