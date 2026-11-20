#!/usr/bin/env bash
# Reap orphaned e2e session processes. Shared by the e2e shards (before every
# attempt and on exit) and the e2e burn-in job (before every run), so both use
# one definition. Always exits 0: nothing matching is the normal case.
#
# A failed deleteSession can orphan any of these; self-hosted runner
# containers are reused, so clean before the first attempt as well as retries.
# The runners are one job per PID-isolated container, so this cannot touch
# another job. Bracketed patterns avoid matching this shell's own command line.

# ASRT's Linux network bridge, matched by the socket path it owns.
#
# `@anthropic-ai/sandbox-runtime` spawns socat on both sides of the
# sandbox boundary, and both forms name the same generated socket
# (`linux-sandbox-utils.js`, initializeLinuxNetworkBridge):
#
#   host:    socat UNIX-LISTEN:$TMPDIR/claude-http-<hex>.sock,… TCP:localhost:<port>,…
#   sandbox: socat TCP-LISTEN:3128,… UNIX-CONNECT:$TMPDIR/claude-http-<hex>.sock
#
# Matching that socket name — rather than the bare word `socat` — is
# what makes this safe to run on a shared runner. A blanket
# `pkill -f socat` would also reap a socat the runner infrastructure
# itself depends on, which is why #1561 recorded the leak but left
# the fix alone. Nothing but ASRT creates `claude-{http,socks}-*.sock`.
E2E_SOCAT_PATTERN='[s]ocat.*claude-(http|socks)-[0-9a-f]+\.sock'

pkill -TERM -f '[e]lectron/dist/electron' 2>/dev/null || true
pkill -TERM -f '[e]lectron-chromedriver/bin/chromedriver' 2>/dev/null || true
pkill -TERM -f '[X]vfb' 2>/dev/null || true
pkill -TERM -f '[g]ortex' 2>/dev/null || true
# Added for #1442's socat bridges: the reaper predates them, so they
# survived into the next job on a reused container. Each leaked
# bridge holds its listening socket, and a shard that then cannot
# start a session fails every spec that calls `reloadSession`.
pkill -TERM -f "$E2E_SOCAT_PATTERN" 2>/dev/null || true
sleep 1
pkill -KILL -f '[e]lectron/dist/electron' 2>/dev/null || true
pkill -KILL -f '[e]lectron-chromedriver/bin/chromedriver' 2>/dev/null || true
pkill -KILL -f '[X]vfb' 2>/dev/null || true
pkill -KILL -f '[g]ortex' 2>/dev/null || true
pkill -KILL -f "$E2E_SOCAT_PATTERN" 2>/dev/null || true
# The sockets outlive the processes that listened on them. Leaving
# them behind fills $TMPDIR on a long-lived runner and makes the
# diagnostics harder to read.
find "${TMPDIR:-/tmp}" -maxdepth 1 \
  \( -name 'claude-http-*.sock' -o -name 'claude-socks-*.sock' \) \
  -delete 2>/dev/null || true
exit 0
