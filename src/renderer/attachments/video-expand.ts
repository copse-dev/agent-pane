import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'

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
 * Kept separate from `image-expand.ts` rather than generalised: the two share a
 * dialog shape and nothing else. An image is already in the DOM as a data URL,
 * while a video has to be fetched over IPC, can fail with a message worth
 * showing, and needs its object URL revoked on close.
 */

let expandDialog: HTMLDialogElement | null = null
let videoEl: HTMLVideoElement | null = null
let statusEl: HTMLElement | null = null
/** Revoked on close: an un-revoked object URL pins the whole file in memory. */
let objectUrl: string | null = null
/** Guards against a slow read landing after the dialog was closed or reopened. */
let openToken = 0

function releaseSource(): void {
  if (videoEl) {
    videoEl.pause()
    videoEl.removeAttribute('src')
    videoEl.load()
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
}

function ensureExpandDialog(): HTMLDialogElement {
  if (expandDialog) return expandDialog

  expandDialog = document.createElement('dialog')
  expandDialog.className = 'video-expand-dialog'
  expandDialog.setAttribute('aria-label', 'Video preview')

  const body = el('div', { class: 'video-expand-dialog-body' })
  videoEl = el('video', { class: 'video-expand-video' })
  videoEl.controls = true
  videoEl.preload = 'metadata'
  statusEl = el('p', { class: 'video-expand-status' })
  body.append(videoEl, statusEl)

  const closeBtn = el('button', { type: 'button', class: 'video-expand-close' }, 'Close')
  expandDialog.append(body, closeBtn)
  document.body.append(expandDialog)

  closeBtn.addEventListener('click', () => expandDialog?.close())
  expandDialog.addEventListener('click', (event) => {
    if (event.target === expandDialog) expandDialog?.close()
  })
  // Covers Escape too — a <dialog> closes itself, and this is the one hook that
  // fires for every route out, so playback can never keep running unseen.
  expandDialog.addEventListener('close', releaseSource)

  return expandDialog
}

/** Open the shared video modal for an attached video, reading it over IPC. */
export async function openVideoExpand(
  api: VideoPlaybackApi,
  path: string,
  name: string,
): Promise<void> {
  const dialog = ensureExpandDialog()
  const video = videoEl
  const status = statusEl
  if (!video || !status) return

  const token = ++openToken
  releaseSource()
  dialog.setAttribute('aria-label', `Video preview: ${name}`)
  video.hidden = true
  status.hidden = false
  status.textContent = `Loading ${name}…`
  if (!dialog.open) dialog.showModal()

  try {
    const { bytes, mimeType } = await api.video.read(path)
    // The user can close or open another video while a large file is read; a
    // late arrival must not hijack the dialog or leak the URL it just made.
    if (token !== openToken || !dialog.open) return
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    video.src = objectUrl
    video.hidden = false
    status.hidden = true
    await video.play().catch(() => undefined)
  } catch (err) {
    if (token !== openToken) return
    // The main-process message names the actual limit or reason, which is more
    // use than "could not play video".
    status.textContent = err instanceof Error ? err.message : `Could not play ${name}.`
    status.hidden = false
    video.hidden = true
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
