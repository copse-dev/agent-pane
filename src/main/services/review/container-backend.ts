// The container isolation backend for Copse Reviewer in the app
// (docs/plans/copse-reviewer.md, §Execution isolation, "Backend per shell —
// App"; binding decision B3): `@copse/review`'s container backend over the
// thread-in-container runtime's own image and naming, so the reviewer is a
// consumer of that runtime rather than a second one.
//
// What is reused: the worker image (`copse-worker:local`, built and
// fingerprinted by the runtime — a stale image is never run), the daemon
// probe, and the container name and labels, so a review cell a crash left
// behind is swept by the same orphan sweep as an abandoned run. What is not:
// the runtime's egress broker. A review cell has no network at all; the
// package's backend is the one that says so.
//
// Where it stands in the app's choice of backend: the OS sandbox first for
// the author's own tree (lighter, and enough per B3), this backend where no
// OS sandbox is active but Docker is, and read-only review where neither is.
import { createContainerBackend } from '@copse/review/container-backend.ts'
import type { IsolationBackend } from '@copse/review/isolation.ts'
import {
  containerName,
  dockerAvailable,
  MANAGED_LABEL,
  RUNTIME_LABEL,
  WORKER_IMAGE,
  workerBuildFingerprint,
  workerImageFingerprint,
} from '../container-runtime/thread-container.ts'

/** What the detection asks the host; injected by the tests. */
export interface ReviewContainerProbe {
  readonly platform: NodeJS.Platform
  readonly dockerAvailable: () => Promise<boolean>
  /** The fingerprint of the worker build this app would make; throws when the bundle is not built. */
  readonly wantedFingerprint: () => string
  /** The fingerprint an existing image carries, or `null`. */
  readonly imageFingerprint: (image: string) => Promise<string | null>
}

const appProbe: ReviewContainerProbe = {
  platform: process.platform,
  dockerAvailable,
  wantedFingerprint: () => workerBuildFingerprint(),
  imageFingerprint: workerImageFingerprint,
}

export interface ReviewContainerDetection {
  readonly backend: IsolationBackend | null
  /** Why there is no backend; `null` when there is one. */
  readonly reason: string | null
}

/**
 * The app's container backend, or the reason there is none right now: not a
 * POSIX host (the cell mounts host paths at their own names, which Windows
 * paths cannot be), no daemon, or a worker image that is missing or was built
 * by another version of Copse. The image is never built here — a review is
 * not the moment for a multi-minute image build — the runtime builds it the
 * first time a container run is started.
 */
export async function createReviewContainerBackend(
  probe: ReviewContainerProbe = appProbe,
): Promise<ReviewContainerDetection> {
  if (probe.platform === 'win32') {
    return { backend: null, reason: 'the container backend needs a POSIX host' }
  }
  if (!(await probe.dockerAvailable())) {
    return { backend: null, reason: 'Docker is not running' }
  }
  let wanted: string
  try {
    wanted = probe.wantedFingerprint()
  } catch {
    return { backend: null, reason: 'the container worker bundle is not built' }
  }
  const actual = await probe.imageFingerprint(WORKER_IMAGE)
  if (actual === null) {
    return {
      backend: null,
      reason: `the worker image ${WORKER_IMAGE} is not built; start a container run once to build it`,
    }
  }
  if (actual !== wanted) {
    return {
      backend: null,
      reason: `the worker image ${WORKER_IMAGE} was built by another version of Copse; start a container run once to rebuild it`,
    }
  }
  return {
    backend: createContainerBackend({
      image: WORKER_IMAGE,
      containerName: (commandId) => containerName(commandId),
      labels: (commandId) => ({ [MANAGED_LABEL]: '1', [RUNTIME_LABEL]: commandId }),
    }),
    reason: null,
  }
}
