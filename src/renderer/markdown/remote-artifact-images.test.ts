import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  RemoteArtifactImageRequest,
  RemoteArtifactImageResult,
} from '@shared/remote-artifact-image.ts'
import { hydrateRemoteArtifactImages, type ArtifactImageScope } from './remote-artifact-images.ts'
import { qsRequired } from '../dom/helpers.ts'

const SCOPE: ArtifactImageScope = { projectId: 'project-1', threadId: 'thread-1' }

function fakeApi(results: RemoteArtifactImageResult[] = []): {
  api: Parameters<typeof hydrateRemoteArtifactImages>[1]
  requests: RemoteArtifactImageRequest[]
} {
  const requests: RemoteArtifactImageRequest[] = []
  return {
    requests,
    api: {
      remoteAgent: {
        artifactImageDataUrl: (request): Promise<RemoteArtifactImageResult> => {
          requests.push(request)
          return Promise.resolve(
            results.shift() ?? { ok: true, dataUrl: 'data:image/png;base64,AA==' },
          )
        },
      },
    },
  }
}

function message(html: string): HTMLElement {
  const list = document.createElement('div')
  list.className = 'messages-list'
  list.innerHTML = html
  document.body.append(list)
  return list
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('hydrateRemoteArtifactImages', () => {
  it('asks main for the image by thread, not by a transcript agent link', async () => {
    const list = message(
      '<a href="https://cursor.com/agents/bc-spoofed">agent</a><img alt="Shot" data-remote-artifact-path="artifacts/shot.png">',
    )
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(list, api, SCOPE)
    await settle()

    assert.deepEqual(requests, [
      { projectId: 'project-1', threadId: 'thread-1', path: 'artifacts/shot.png' },
    ])
    const img = qsRequired<HTMLImageElement>(list, 'img')
    assert.equal(img.dataset['remoteArtifactState'], 'loaded')
    assert.equal(img.src, 'data:image/png;base64,AA==')
    list.remove()
  })

  it("passes the image's own agent id as a selector for main to check", () => {
    const list = message(
      '<img data-remote-artifact-path="artifacts/a.png" data-remote-artifact-agent-id="bc-own">',
    )
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(list, api, SCOPE)

    assert.deepEqual(requests, [{ ...SCOPE, path: 'artifacts/a.png', agentId: 'bc-own' }])
    list.remove()
  })

  it('makes no request without a thread scope', () => {
    const list = message('<img data-remote-artifact-path="artifacts/a.png">')
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(list, api, null)

    assert.deepEqual(requests, [])
    assert.equal(
      qsRequired<HTMLImageElement>(list, 'img').dataset['remoteArtifactState'],
      'missing-scope',
    )
    list.remove()
  })

  it('does not re-request an image that is loading or loaded', async () => {
    const list = message('<img data-remote-artifact-path="artifacts/a.png">')
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(list, api, SCOPE)
    hydrateRemoteArtifactImages(list, api, SCOPE)
    await settle()
    hydrateRemoteArtifactImages(list, api, SCOPE)

    assert.equal(requests.length, 1)
    list.remove()
  })

  it('shows a policy denial with its alt text and no retry', async () => {
    const list = message('<img alt="Login page" data-remote-artifact-path="artifacts/a.png">')
    const { api } = fakeApi([{ ok: false, code: 'sandbox-unavailable', retryable: false }])

    hydrateRemoteArtifactImages(list, api, SCOPE)
    await settle()

    const img = qsRequired<HTMLImageElement>(list, 'img')
    assert.equal(img.hidden, true)
    assert.equal(img.dataset['remoteArtifactState'], 'unavailable')
    assert.equal(img.dataset['remoteArtifactError'], 'sandbox-unavailable')
    const notice = qsRequired(list, '.remote-artifact-unavailable')
    assert.match(notice.textContent, /sandbox/u)
    assert.equal(qsRequired(notice, '.remote-artifact-unavailable-alt').textContent, 'Login page')
    assert.equal(notice.querySelector('.remote-artifact-retry'), null)
    list.remove()
  })

  it('offers Retry for a transient failure, and retrying replaces the notice', async () => {
    const list = message('<img alt="Shot" data-remote-artifact-path="artifacts/a.png">')
    const { api, requests } = fakeApi([{ ok: false, code: 'timeout', retryable: true }])

    hydrateRemoteArtifactImages(list, api, SCOPE)
    await settle()
    qsRequired<HTMLButtonElement>(list, '.remote-artifact-retry').click()
    await settle()

    assert.equal(requests.length, 2)
    const img = qsRequired<HTMLImageElement>(list, 'img')
    assert.equal(img.dataset['remoteArtifactState'], 'loaded')
    assert.equal(img.hidden, false)
    assert.equal(list.querySelector('.remote-artifact-unavailable'), null)
    list.remove()
  })

  it('treats a rejected IPC call as unavailable without retry', async () => {
    const list = message('<img data-remote-artifact-path="artifacts/a.png">')
    const api: Parameters<typeof hydrateRemoteArtifactImages>[1] = {
      remoteAgent: { artifactImageDataUrl: () => Promise.reject(new Error('invalid')) },
    }

    hydrateRemoteArtifactImages(list, api, SCOPE)
    await settle()

    assert.equal(
      qsRequired<HTMLImageElement>(list, 'img').dataset['remoteArtifactError'],
      'invalid-request',
    )
    assert.equal(list.querySelector('.remote-artifact-retry'), null)
    list.remove()
  })
})
