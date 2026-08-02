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
    'docker compose run --rm --no-deps --entrypoint bwrap runner --ro-bind / / --unshare-all true',
    `docker compose up -d --no-build --scale runner=${String(runnersPerInstance)}`,
    'docker compose ps',
  ]
}
