/**
 * BENCHMARK-ONLY guest entry: the product worker run inside a Terminal-Bench /
 * Harbor task container (`docs/plans/thread-in-container.md`, decision A20).
 *
 * It is the only caller of `declareExternalContainerBoundary`. It is built into
 * its own bundle (`dist-test/copse-thread-container-worker-harbor.cjs`, by
 * `scripts/lib/thread-container-worker-bundle.mts`) and is never part of
 * `dist/` or the packaged app. The product entry (`worker-entry.ts`) does not
 * import this file, and nothing in the product worker — no environment
 * variable, `run.json` field or setting — can select this behaviour;
 * `worker-entry-gating.test.ts` enforces both.
 *
 * What is the same as the product: the shared worker (`worker-main.ts`), the
 * unattended-run arming, the fail-closed approval handler, the contained-effect
 * classifier, the reviewed guest tool allowlist, and inference over the stdio
 * link (the container holds no credential and no model endpoint).
 *
 * What differs, and why:
 * - the container tier is declared on the harness's word, not from a host
 *   attestation (Harbor task containers run as root with a writable root
 *   filesystem and a network, so they cannot be attested);
 * - the workspace is the task's own directory, baselined with git where it
 *   stands, and nothing is carried out (the harness verifies the files);
 * - the run directory is configurable (`COPSE_HARBOR_RUN_DIR`), because
 *   `/run` may not be writable in every task image;
 * - the agent is told that the task container is its sandbox, not that it has
 *   no network;
 * - which tools exist is probed, not assumed: task images ship neither `rg` nor
 *   `git` in general, and the loop trusts the declaration.
 */
import { spawnSync } from 'node:child_process'
import { declareExternalContainerBoundary } from '../security/runtime-containment.ts'
import { runContainerWorker } from './worker-main.ts'

const RUN_DIR_ENV = 'COPSE_HARBOR_RUN_DIR'

const HARBOR_BOUNDARY_LABEL =
  'terminal-bench/harbor task container: harness-provided boundary, not attested by a Copse host'

function runDir(): string {
  const configured = process.env[RUN_DIR_ENV]
  return configured !== undefined && configured.length > 0 ? configured : '/run/copse'
}

/** Whether `command --version` runs here: a task image may ship neither `rg` nor `git`. */
function present(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

runContainerWorker({
  runDir: runDir(),
  prepareContainment: () => (): Promise<void> => {
    declareExternalContainerBoundary(HARBOR_BOUNDARY_LABEL)
    return Promise.resolve()
  },
  workspace: 'in-place',
  toolAvailability: () => ({ rg: present('rg'), git: present('git'), gh: false }),
  environmentNote: () =>
    'Environment: a disposable Linux task container, and you run as root in it. The task container ' +
    'is the sandbox: act on its files directly. Shell commands may have network access; use it only ' +
    'when the task needs it. Nothing leaves the container except the files you leave in place, which ' +
    'are checked when you finish.',
})
