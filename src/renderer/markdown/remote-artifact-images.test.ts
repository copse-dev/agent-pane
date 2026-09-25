import '../../../tests/setup-dom.ts'
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { hydrateRemoteArtifactImages } from './remote-artifact-images.ts'
import { qsRequired } from '../dom/helpers.ts'

function fakeApi(): {
  api: Parameters<typeof hydrateRemoteArtifactImages>[1]
  requests: Array<[string, string]>
} {
  const requests: Array<[string, string]> = []
  return {
    requests,
    api: {
      remoteAgent: {
        artifactImageDataUrl: (agentId: string, path: string): Promise<string> => {
          requests.push([agentId, path])
          return Promise.resolve('data:image/png;base64,AA==')
        },
      },
    },
  }
}

/** A conversation list holding an earlier message that links the Cursor agent. */
function listWithAgentLink(agentHref: string | null): HTMLElement {
  const list = document.createElement('div')
  list.className = 'messages-list'
  const earlier = document.createElement('div')
  earlier.className = 'msg'
  earlier.innerHTML = agentHref === null ? '<p>no agent</p>' : `<a href="${agentHref}">agent</a>`
  list.append(earlier)
  document.body.append(list)
  return list
}

function appendMessage(list: HTMLElement, html: string): HTMLElement {
  const msg = document.createElement('div')
  msg.className = 'msg'
  msg.innerHTML = html
  list.append(msg)
  return msg
}

function linkScans(list: HTMLElement): { count: () => number } {
  const spy = mock.method(list, 'querySelectorAll')
  return {
    count: () => spy.mock.calls.filter((call) => call.arguments[0] === 'a[href]').length,
  }
}

describe('hydrateRemoteArtifactImages', () => {
  it('falls back to the agent linked elsewhere in the thread', () => {
    const list = listWithAgentLink('https://cursor.com/agents/bc-thread-1')
    const msg = appendMessage(list, '<img data-remote-artifact-path="out/shot.png">')
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(msg, api)

    assert.deepEqual(requests, [['bc-thread-1', 'out/shot.png']])
    assert.equal(qsRequired<HTMLImageElement>(msg, 'img').dataset['remoteArtifactState'], 'loading')
    list.remove()
  })

  it("prefers the image's own agent id and then skips the thread scan", () => {
    const list = listWithAgentLink('https://cursor.com/agents/bc-thread-1')
    const msg = appendMessage(
      list,
      '<img data-remote-artifact-path="a.png" data-remote-artifact-agent-id="bc-own">',
    )
    const scans = linkScans(list)
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(msg, api)

    assert.deepEqual(requests, [['bc-own', 'a.png']])
    assert.equal(scans.count(), 0)
    list.remove()
  })

  it('does not scan the thread for a message without artifact images', () => {
    const list = listWithAgentLink('https://cursor.com/agents/bc-thread-1')
    const msg = appendMessage(
      list,
      '<p>plain answer with <a href="https://example.com">a link</a></p>',
    )
    const scans = linkScans(list)
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(msg, api)

    assert.deepEqual(requests, [])
    assert.equal(scans.count(), 0)
    list.remove()
  })

  it('scans the thread once however many images lack an agent', () => {
    const list = listWithAgentLink(null)
    const msg = appendMessage(
      list,
      '<img data-remote-artifact-path="a.png"><img data-remote-artifact-path="b.png">',
    )
    const scans = linkScans(list)
    const { api, requests } = fakeApi()

    hydrateRemoteArtifactImages(msg, api)

    assert.deepEqual(requests, [])
    assert.equal(scans.count(), 1)
    for (const img of msg.querySelectorAll<HTMLImageElement>('img')) {
      assert.equal(img.dataset['remoteArtifactState'], 'missing-agent')
    }
    list.remove()
  })
})
