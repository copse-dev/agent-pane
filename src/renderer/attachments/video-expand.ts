import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

/** Only `video.read` is used; keep the surface narrow for tests (cf. FileDropApi). */
export type VideoPlaybackApi = { video: Pick<ApiClient['video'], 'read'> }

/**
 * Playing an attached video without sending it anywhere.
 *
 * A video attachment is deliberately a path, not media — the whole point of
 * `video_frames` is that the recording never becomes model content. That leaves
 * the person who attached it unable to check what they attached, which is a
 * poor trade for a chip that already knows the file. This plays it locally, in
 * a modal, and nothing about it reaches a model.
 *
 * The media-specific loading and object-URL lifecycle stays here; the dialog
 * shell is shared with image and text previews through `attachment-preview.ts`.
 */

/** Open the shared video modal for an attached video, reading it over IPC. */
export async function openVideoExpand(
  api: VideoPlaybackApi,
  path: string,
  name: string,
): Promise<void> {
  const video = el('video', { class: 'video-expand-video' })
  video.controls = true
  video.preload = 'metadata'
  let objectUrl: string | null = null
  const session = openAttachmentPreview({
    kind: 'video',
    title: name,
    ariaLabel: `Video preview: ${name}`,
    status: `Loading ${name}…`,
    onClose: () => {
      video.pause()
      video.removeAttribute('src')
      video.load()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      objectUrl = null
    },
  })

  try {
    const { bytes, mimeType } = await api.video.read(path)
    // The user can close or open another video while a large file is read; a
    // late arrival must not hijack the dialog or leak the URL it just made.
    if (!session.isActive()) return
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    video.src = objectUrl
    session.setContent(video)
    await video.play().catch(() => undefined)
  } catch (err) {
    // The main-process message names the actual limit or reason, which is more
    // use than "could not play video".
    session.setStatus(err instanceof Error ? err.message : `Could not play ${name}.`)
  }
}

/**
 * Make an attachment chip open its video. Idempotent via `data-video-expand`,
 * so a re-render of the same chip does not stack handlers.
 */
export function attachVideoExpand(
  chip: HTMLElement,
  api: VideoPlaybackApi,
  path: string,
  name: string,
): void {
  if (chip.dataset['videoExpand'] === 'true') return
  chip.dataset['videoExpand'] = 'true'
  chip.classList.add('video-expandable')
  chip.setAttribute('role', 'button')
  chip.setAttribute('tabindex', '0')
  chip.setAttribute('aria-label', `Play ${name}`)

  const open = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    void openVideoExpand(api, path, name)
  }

  chip.addEventListener('click', open)
  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    open(event)
  })
}
