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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { declareExternalContainerBoundary } from '../security/runtime-containment.ts'
import {
  HARBOR_TUNING_APPLIED_FILE,
  HARBOR_TUNING_FILE,
  decodeHarborWorkerTuning,
  type HarborWorkerTuning,
} from './harbor-tuning.mts'
import { runContainerWorker } from './worker-main.ts'

const RUN_DIR_ENV = 'COPSE_HARBOR_RUN_DIR'

const HARBOR_BOUNDARY_LABEL =
  'terminal-bench/harbor task container: harness-provided boundary, not attested by a Copse host'

/**
 * The product allows one 4,096-token recovery stream after a reasoning circle is
 * cut, then gives up. On Terminal-Bench `regex-log` the model needs roughly 9,500
 * tokens of reasoning before it writes the file, so that cap ends the run
 * unattempted. Raised modestly (3x), for this benchmark entry only; the product
 * default is unchanged. Revisit when the product cap is reconsidered.
 */
const HARBOR_REASONING_RECOVERY_MAX_TOKENS = 12_288

function runDir(): string {
  const configured = process.env[RUN_DIR_ENV]
  return configured !== undefined && configured.length > 0 ? configured : '/run/copse'
}

/**
 * The benchmark tuning the host driver wrote beside `run.json`, if any (see
 * `harbor-tuning.mts`). An invalid file is fatal: a trial must never silently run
 * a configuration other than the one it was asked to measure.
 */
function readTuning(directory: string): HarborWorkerTuning {
  const path = join(directory, HARBOR_TUNING_FILE)
  if (!existsSync(path)) return {}
  const tuning = decodeHarborWorkerTuning(readFileSync(path, 'utf8'))
  if (tuning === null) throw new Error(`${path} is not a valid Harbor worker tuning`)
  return tuning
}

/** Whether `command --version` runs here: a task image may ship neither `rg` nor `git`. */
function present(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

const directory = runDir()
const tuning = readTuning(directory)
const recoveryMaxTokens = tuning.reasoningRecoveryMaxTokens ?? HARBOR_REASONING_RECOVERY_MAX_TOKENS
// What this worker was actually handed, for the host driver to collect next to
// `result.json`. `loopLimits: null` means the product loop's own limits apply.
writeFileSync(
  join(directory, HARBOR_TUNING_APPLIED_FILE),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      requested: tuning,
      effective: {
        loopLimits: tuning.loopLimits ?? null,
        reasoningRecoveryMaxTokens: recoveryMaxTokens,
      },
    },
    null,
    2,
  )}\n`,
)

runContainerWorker({
  runDir: directory,
  prepareContainment: () => (): Promise<void> => {
    declareExternalContainerBoundary(HARBOR_BOUNDARY_LABEL)
    return Promise.resolve()
  },
  workspace: 'in-place',
  reasoningRecoveryMaxTokens: recoveryMaxTokens,
  ...(tuning.loopLimits === undefined ? {} : { loopLimits: tuning.loopLimits }),
  toolAvailability: () => ({ rg: present('rg'), git: present('git'), gh: false }),
  environmentNote: () =>
    'Environment: a disposable Linux task container, and you run as root in it. The task container ' +
    'is the sandbox: act on its files directly. Shell commands may have network access; use it only ' +
    'when the task needs it. Nothing leaves the container except the files you leave in place, which ' +
    'are checked when you finish.',
})
