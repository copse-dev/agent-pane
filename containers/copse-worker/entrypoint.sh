#!/bin/sh
# Guest entrypoint for a Copse container run. Runs as the unprivileged worker
# user; the container has no network interface. For each origin the host
# allowlisted, COPSE_EGRESS_ORIGINS names host:port pairs whose hostnames the
# host already pointed at loopback; a socat listener on that port forwards into
# the host broker's unix socket, which is the only route out of the guest.
set -eu

RUN_DIR=/run/copse
if [ -n "${COPSE_EGRESS_ORIGINS:-}" ]; then
  old_ifs=$IFS
  IFS=','
  for origin in $COPSE_EGRESS_ORIGINS; do
    host=${origin%:*}
    port=${origin##*:}
    sock="$RUN_DIR/egress/$(printf '%s' "$host" | tr -c 'a-zA-Z0-9.\n-' '_')_${port}.sock"
    socat "TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:${sock}" &
  done
  IFS=$old_ifs
fi

exec node /app/worker.cjs
