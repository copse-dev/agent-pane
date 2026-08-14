/**
 * Build and validate the runner image before starting any service that can
 * register with GitHub. A broken bubblewrap host must fail provisioning rather
 * than join the pool and discover the problem inside an e2e job.
 */
export function runnerComposeStartupCommands(runnersPerInstance: number): string[] {
  if (!Number.isSafeInteger(runnersPerInstance) || runnersPerInstance <= 0) {
    throw new Error('runnersPerInstance must be a positive safe integer')
  }

  return [
    'docker compose build --pull',
    // Mirror the namespace and procfs operations ASRT's Linux backend uses.
    // A shallower `--unshare-all true` probe misses Docker's protected-system-
    // paths restriction and admits runners whose real plugin workers immediately exit.
    'docker compose run --rm --no-deps --entrypoint bwrap runner --new-session --die-with-parent --ro-bind / / --unshare-net --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /usr/bin/true',
    `docker compose up -d --no-build --scale runner=${String(runnersPerInstance)}`,
    'docker compose ps',
  ]
}
