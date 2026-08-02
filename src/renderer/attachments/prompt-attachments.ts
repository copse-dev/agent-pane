/**
 * A video on its way into the composer. Either the raw bytes (dropped from
 * outside the app, so a copy has to be stored with the thread) or a path
 * already on disk in the workspace, which is referenced where it lies — there
 * is no reason to duplicate a recording the agent can already open.
 */
export type PromptVideoAttachment = { name: string; mimeType: string } & (
  { bytes: ArrayBuffer; path?: undefined } | { path: string; bytes?: undefined }
)

/**
 * An archive on its way into the composer. Same two shapes as a video: raw
 * bytes for a file dropped from outside the app, or a path already on disk in
 * the workspace, which is referenced where it lies.
 */
export type PromptArchiveAttachment = { name: string } & (
  { bytes: ArrayBuffer; path?: undefined } | { path: string; bytes?: undefined }
)

export interface PromptAttachmentHandlers {
  attachFile(file: { path: string; content: string }): void
  attachTextBlock(content: string, label?: string): void
  attachImage(dataUrl: string, mimeType: string): void
  /**
   * A video dropped or picked in the composer. Unlike an image it is stored to
   * disk and referenced by path — the media never becomes model content (see
   * `@shared/video/video-media.ts`), so this is async where the others are not.
   */
  attachVideo(video: PromptVideoAttachment): Promise<void>
  /**
   * An archive dropped or picked in the composer. Stored and referenced by
   * path like a video; the agent unpacks it with `read_archive` rather than
   * ever receiving the bytes.
   */
  attachArchive(archive: PromptArchiveAttachment): Promise<void>
  /** Move keyboard focus to the chat composer after a selection attachment. */
  focusComposer?: () => void
}

let handlers: PromptAttachmentHandlers | null = null

export function registerPromptAttachments(h: PromptAttachmentHandlers): () => void {
  handlers = h
  return () => {
    if (handlers === h) handlers = null
  }
}

export function getPromptAttachmentHandlers(): PromptAttachmentHandlers | null {
  return handlers
}
