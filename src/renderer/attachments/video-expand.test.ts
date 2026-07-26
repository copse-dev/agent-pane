import '../../../tests/setup-dom.ts'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { attachVideoExpand, openVideoExpand, type VideoPlaybackApi } from './video-expand.ts'
import { qsRequired } from '../dom/helpers.ts'

// happy-dom implements neither <dialog> modality nor media playback. Stubbing
// on HTMLDialogElement/HTMLMediaElement rather than HTMLElement keeps every
// assignment type-checked — the members exist on those interfaces.
function patchEnv(): void {
  const dialog = window.HTMLDialogElement.prototype
  if (typeof dialog.showModal !== 'function') {
    dialog.showModal = function (this: HTMLDialogElement): void {
      this.open = true
    }
    dialog.close = function (this: HTMLDialogElement): void {
      this.open = false
      this.dispatchEvent(new window.Event('close'))
    }
  }
  const media = window.HTMLMediaElement.prototype
  if (typeof media.play !== 'function') {
    media.play = (): Promise<void> => Promise.resolve()
    media.pause = (): void => undefined
    media.load = (): void => undefined
  }
  // The module under test calls the *global* URL, which happy-dom keeps
  // distinct from window.URL — patching the wrong one silently no-ops.
  globalThis.URL.createObjectURL = (): string => OBJECT_URL
  globalThis.URL.revokeObjectURL = (): void => undefined
}

const OBJECT_URL = 'blob:video-test'

function videoApi(read: VideoPlaybackApi['video']['read']): VideoPlaybackApi {
  return { video: { read } }
}

const BYTES = new Uint8Array([0, 1, 2, 3])

describe('video expand modal', () => {
  before(() => {
    patchEnv()
  })

  it('wires play affordances onto a chip once', () => {
    const chip = document.createElement('span')
    const api = videoApi(() => Promise.resolve({ bytes: BYTES, mimeType: 'video/mp4' }))
    attachVideoExpand(chip, api, '/store/a.mp4', 'a.mp4')
    attachVideoExpand(chip, api, '/store/a.mp4', 'a.mp4')

    assert.equal(chip.dataset['videoExpand'], 'true')
    assert.equal(chip.classList.contains('video-expandable'), true)
    // A chip that plays something is a button, and has to be reachable and
    // announced as one — it is not decoration.
    assert.equal(chip.getAttribute('role'), 'button')
    assert.equal(chip.getAttribute('tabindex'), '0')
    assert.equal(chip.getAttribute('aria-label'), 'Play a.mp4')
  })

  it('plays the bytes the main process returns', async () => {
    let requested: string | null = null
    const api = videoApi((path) => {
      requested = path
      return Promise.resolve({ bytes: BYTES, mimeType: 'video/webm' })
    })
    await openVideoExpand(api, '/store/clip.webm', 'clip.webm')

    assert.equal(requested, '/store/clip.webm')
    const dialog = qsRequired<HTMLDialogElement>(document.body, '.video-expand-dialog')
    assert.equal(dialog.open, true)
    const video = qsRequired<HTMLVideoElement>(dialog, '.video-expand-video')
    assert.equal(video.hidden, false)
    assert.equal(video.getAttribute('src'), OBJECT_URL)
    dialog.close()
  })

  it('shows the main-process message when the read is refused', async () => {
    // The refusal names the real reason — the preview size limit, or a path
    // outside the readable roots — which is more use than a generic failure.
    const api = videoApi(() => Promise.reject(new Error('over the 50 MB preview limit')))
    await openVideoExpand(api, '/elsewhere/huge.mp4', 'huge.mp4')

    const dialog = qsRequired<HTMLDialogElement>(document.body, '.video-expand-dialog')
    const status = qsRequired(dialog, '.video-expand-status')
    assert.match(status.textContent, /over the 50 MB preview limit/)
    assert.equal(status.hidden, false)
    assert.equal(qsRequired<HTMLVideoElement>(dialog, '.video-expand-video').hidden, true)
    dialog.close()
  })

  it('releases the object URL when the dialog closes', async () => {
    // An un-revoked blob URL pins the whole recording in renderer memory for the
    // rest of the session.
    let revoked: string | null = null
    globalThis.URL.revokeObjectURL = (url: string): void => {
      revoked = url
    }
    const api = videoApi(() => Promise.resolve({ bytes: BYTES, mimeType: 'video/mp4' }))
    await openVideoExpand(api, '/store/clip.mp4', 'clip.mp4')
    const dialog = qsRequired<HTMLDialogElement>(document.body, '.video-expand-dialog')
    dialog.close()

    assert.equal(revoked, OBJECT_URL, 'closing the modal must revoke the object URL')
    assert.equal(
      qsRequired<HTMLVideoElement>(dialog, '.video-expand-video').hasAttribute('src'),
      false,
    )
  })
})
