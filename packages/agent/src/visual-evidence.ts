/** Maximum user-visible copy accepted by the first-party evidence tool. */
export const VISUAL_EVIDENCE_CAPTION_MAX_CHARS = 400
export const VISUAL_EVIDENCE_LABEL_MAX_CHARS = 80

/** Browser provenance retained with a published screenshot. */
export interface BrowserVisualEvidenceSource {
  kind: 'browser'
  viewId: string
  title: string
  /** Display-safe URL: credentials, query, and fragment are removed before publication. */
  url: string
}

export type VisualEvidenceSource = BrowserVisualEvidenceSource

export interface VisualEvidenceAssetMetadata {
  id: string
  label: string
  mimeType: 'image/png'
  width: number
  height: number
  capturedAt: number
  source: VisualEvidenceSource
}

/**
 * One immutable visual carried by an assistant evidence card.
 *
 * Live and folded messages carry a data URL; a missing or corrupt referenced
 * blob folds into the unavailable arm so one damaged asset never hides the
 * rest of the thread.
 */
export type VisualEvidenceAsset = VisualEvidenceAssetMetadata &
  ({ dataUrl: string; unavailableReason?: never } | { dataUrl?: never; unavailableReason: string })

export type VisualEvidenceKind = 'screenshot' | 'comparison'

/** Evidence metadata before the loop associates it with the publishing tool call. */
export interface VisualEvidenceDraft {
  id: string
  kind: VisualEvidenceKind
  caption: string
  createdAt: number
  assets: VisualEvidenceAsset[]
}

/** Durable assistant-message reference to explicitly published visual proof. */
export interface VisualEvidenceRef extends VisualEvidenceDraft {
  toolCallId: string
}
