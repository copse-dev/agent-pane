/**
 * The product's guest entry for a container run
 * (`docs/plans/thread-in-container.md`). Bundled by `scripts/main-bundles.mts`
 * into `dist/main/thread-container-worker.cjs` and started by the worker image.
 *
 * It declares the container tier only from the host's attestation, checked
 * against what this process sees of its own confinement. A benchmark-only entry
 * exists as a different file and a different bundle, and this one must never
 * import it or anything that declares containment without an attestation
 * (`worker-entry-gating.test.ts` enforces that).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  declareContainerRuntime,
  observeGuestContainment,
  parseContainerRuntimeAttestation,
} from '../security/runtime-containment.ts'
import { guestEnvironmentNote } from './guest-install.ts'
import { runContainerWorker } from './worker-main.ts'

runContainerWorker({
  runDir: '/run/copse',
  prepareContainment: (runDir) => {
    const attestation = parseContainerRuntimeAttestation(
      readFileSync(join(runDir, 'attestation.json'), 'utf8'),
    )
    if (attestation === null) throw new Error('attestation.json is not a valid attestation')
    // The host's record, checked against what this process can see of its
    // own confinement: an engine that dropped a flag is caught here.
    return async (): Promise<void> => {
      declareContainerRuntime(attestation, await observeGuestContainment())
    }
  },
  workspace: 'carry-in',
  environmentNote: guestEnvironmentNote,
  // The worker image ships both (and the product never offers `gh` in a guest).
  toolAvailability: () => ({ rg: true, git: true, gh: false }),
})
