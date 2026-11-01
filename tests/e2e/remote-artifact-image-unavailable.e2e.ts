import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedRemoteAgentModelsFixture,
  writeSeedConfig,
} from './helpers/seed-config.ts'

/**
 * Automatic remote-artifact image hydration through the real IPC and main
 * process (docs/plans/sandboxed-artifact-image-downloads.md). The Cursor API is
 * a local fixture; nothing here reaches a download host. It proves the
 * unavailable states: a transient metadata failure offers Retry, a retry reruns
 * authorization and meets the download-origin policy, and an image naming an
 * agent the thread is not linked to is refused before any network request.
 */

const PROJECT_ID = 'e2e-remote-models-project'
const THREAD_ID = 'remote-artifact-image-thread'
const LINKED_AGENT = 'bc-e2e-linked-artifacts'
const SPOOFED_AGENT = 'bc-e2e-spoofed'

async function startCursorArtifactServer(): Promise<{
  apiBase: string
  artifactRequests: () => string[]
  /** From now on, answer with a signed URL instead of a transient failure. */
  recover: () => void
  close: () => Promise<void>
}> {
  const artifactRequests: string[] = []
  let recovered = false
  const server: Server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items: [] }))
      return
    }
    if (request.url?.includes('/artifacts/download')) {
      artifactRequests.push(request.url)
      // Until the test recovers it, a transient provider failure. A re-render
      // may hydrate again, so this does not depend on the request count.
      if (!recovered) {
        response.writeHead(503, { 'content-type': 'text/plain' })
        response.end('try again')
        return
      }
      // After recovery: a signed URL on a host no provider policy approves.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ url: 'https://downloads.evil.example/shot.png?sig=1' }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  const apiBase = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Cursor fixture did not expose a TCP port'))
        return
      }
      resolve(`http://127.0.0.1:${String(address.port)}`)
    })
  })
  return {
    apiBase,
    artifactRequests: () => [...artifactRequests],
    recover: (): void => {
      recovered = true
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}

describe('remote artifact image unavailable states', () => {
  let fixture: Awaited<ReturnType<typeof startCursorArtifactServer>> | null = null

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    fixture = await startCursorArtifactServer()
    resetUserData()
    const now = Date.now()
    seedRemoteAgentModelsFixture(process.cwd(), { apiBase: fixture.apiBase })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Cloud agent screenshots',
          model: 'remote-agent:cursor',
          status: 'idle',
          messages: [
            {
              id: 'msg-artifact-images',
              role: 'assistant',
              content: [
                'Here is the login page after the fix:',
                '',
                '<img alt="Login page after the fix" src="artifacts/screenshots/login.png" />',
                '',
                'And one the transcript claims came from another agent:',
                '',
                `<img alt="Settings page" src="https://api.cursor.com/v1/agents/${SPOOFED_AGENT}/artifacts/download?path=artifacts/settings.png" />`,
              ].join('\n'),
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          remoteAgentLink: { provider: 'cursor', agentId: LINKED_AGENT, createdAt: now - 1 },
          createdAt: now - 1,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (fixture) await fixture.close()
  })

  it('offers Retry for a transient failure, then shows the origin denial without one', async () => {
    const message = '[data-message-id="msg-artifact-images"]'
    const linked = `${message} img[data-remote-artifact-path="artifacts/screenshots/login.png"]`
    const spoofed = `${message} img[data-remote-artifact-agent-id="${SPOOFED_AGENT}"]`

    await $(`${linked}[data-remote-artifact-error="metadata-failed"]`).waitForExist({
      timeout: 30_000,
    })
    await $(`${spoofed}[data-remote-artifact-error="unlinked-agent"]`).waitForExist({
      timeout: 10_000,
    })

    const notices = $(message).$$('.remote-artifact-unavailable')
    await expect(notices).toBeElementsArrayOfSize(2)
    const [transient, denied] = await notices.getElements()
    if (!transient || !denied) throw new Error('expected two unavailable notices')
    await expect(transient).toHaveText(expect.stringContaining('Image could not be loaded.'))
    await expect(transient).toHaveText(expect.stringContaining('Login page after the fix'))
    await expect(transient.$('.remote-artifact-retry')).toBeDisplayed()
    await expect(denied).toHaveText(expect.stringContaining('not linked to the agent that made it'))
    await expect(denied.$('.remote-artifact-retry')).not.toBeExisting()
    // The spoofed agent never reached the provider: identity comes from the thread.
    expect(fixture?.artifactRequests().some((url) => url.includes(SPOOFED_AGENT))).toBe(false)
    await saveElementScreenshot(message, 'remote-artifact-image-unavailable-retry.png')

    const beforeRetry = fixture?.artifactRequests().length ?? 0
    fixture?.recover()
    await $(`${message} .remote-artifact-retry`).click()
    await $(`${linked}[data-remote-artifact-error="origin-denied"]`).waitForExist({
      timeout: 15_000,
    })
    const afterRetry = await $(message).$$('.remote-artifact-unavailable').getElements()
    const [originNotice] = afterRetry
    if (!originNotice) throw new Error('expected the linked image notice after retry')
    await expect(originNotice).toHaveText(
      expect.stringContaining('hosted somewhere Copse does not download from'),
    )
    await expect(originNotice.$('.remote-artifact-retry')).not.toBeExisting()
    // Retry asked the provider again rather than replaying anything cached.
    expect((fixture?.artifactRequests().length ?? 0) > beforeRetry).toBe(true)
    expect(
      fixture?.artifactRequests().every((url) => url.includes(`/v1/agents/${LINKED_AGENT}/`)),
    ).toBe(true)
    // Park the pointer off the message so its hover-only actions stay hidden.
    await browser.action('pointer').move({ x: 4, y: 4, origin: 'viewport' }).perform()
    await saveElementScreenshot(message, 'remote-artifact-image-origin-denied.png')
  })
})
