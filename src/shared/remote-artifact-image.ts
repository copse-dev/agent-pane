/**
 * Renderer ↔ main contract for automatic remote-artifact image hydration
 * (docs/plans/sandboxed-artifact-image-downloads.md). The renderer names the
 * thread it is showing; main derives the agent from that thread's durable
 * link. Failures cross as bounded codes, never raw messages.
 */

export interface RemoteArtifactImageRequest {
  projectId: string
  threadId: string
  path: string
  /** Selects among the thread's linked agents; never trusted on its own. */
  agentId?: string
}

export const REMOTE_ARTIFACT_IMAGE_ERROR_CODES = [
  'invalid-request',
  'invalid-path',
  'unlinked-agent',
  'unsupported-provider',
  'not-configured',
  'sandbox-unavailable',
  'metadata-failed',
  'origin-denied',
  'redirect-denied',
  'too-many-redirects',
  'http-status',
  'bad-encoding',
  'bad-type',
  'bad-image',
  'too-large',
  'timeout',
  'tls',
  'network',
  'protocol',
  'busy',
  'cancelled',
] as const
export type RemoteArtifactImageErrorCode = (typeof REMOTE_ARTIFACT_IMAGE_ERROR_CODES)[number]

export type RemoteArtifactImageResult =
  | { ok: true; dataUrl: string }
  | { ok: false; code: RemoteArtifactImageErrorCode; retryable: boolean }
