import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedRemoteAgentModelsFixture,
  writeSeedConfig,
} from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-remote-models-project'
const THREAD_ID = 'imported-cursor-run'
const AGENT_ID = 'cursor-agent-e2e'
const RUN_ID = 'cursor-run-e2e'
const RESULT_ID = `remote-cursor-run-${createHash('sha256')
  .update(`${AGENT_ID}\u0000${RUN_ID}`, 'utf8')
  .digest('hex')}`

async function startCursorRunServer(): Promise<{
  apiBase: string
  requestCount: () => number
  close: () => Promise<void>
}> {
  let requests = 0
  const server: Server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items: [] }))
      return
    }
    if (request.method === 'GET' && request.url === `/v1/agents/${AGENT_ID}/runs/${RUN_ID}`) {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: RUN_ID,
          status: 'FINISHED',
          result: 'Completed the requested refactor.',
          git: {
            branches: [
              {
                repoUrl: 'github.com/acme/project',
                branch: 'cursor/refresh-result',
                prUrl: 'https://github.com/acme/project/pull/42',
              },
            ],
          },
        }),
      )
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
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

describe('imported Cursor agent result refresh', () => {
  let fixture: Awaited<ReturnType<typeof startCursorRunServer>> | null = null

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    fixture = await startCursorRunServer()
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
          title: 'Refresh cloud review',
          model: 'remote-agent:cursor',
          status: 'idle',
          messages: [
            {
              id: 'import-notice',
              role: 'assistant',
              content:
                '_Imported Cursor cloud agent — [Refresh cloud review](https://cursor.com). ' +
                'Send a message here to continue that run from Copse._',
              toolCalls: [],
              createdAt: now - 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          remoteAgentLink: {
            provider: 'cursor',
            agentId: AGENT_ID,
            runId: RUN_ID,
            imported: true,
            createdAt: now - 1,
          },
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

  it('fetches, persists, and shows one final cloud result when the imported stub is reopened', async () => {
    const result = await $(`[data-message-id="${RESULT_ID}"] .message-text`)
    await result.waitForExist({ timeout: 30_000 })
    await expect(result).toHaveText(expect.stringContaining('Completed the requested refactor.'))
    await expect(result).toHaveText(expect.stringContaining('Pushed branch cursor/refresh-result'))
    await expect(result.$('a')).toHaveAttribute('href', 'https://github.com/acme/project/pull/42')
    await browser.waitUntil(() => fixture?.requestCount() === 1, {
      timeout: 10_000,
      timeoutMsg: 'expected one completed-run snapshot request for the imported stub',
    })

    // The result is written through the production thread store. A fresh app
    // session reopens the persisted turn without another provider request.
    await browser.reloadSession()
    await $(`[data-message-id="${RESULT_ID}"] .message-text`).waitForExist({ timeout: 30_000 })
    await browser.pause(500)
    assert.equal(fixture?.requestCount(), 1)
    await expect($$(`[data-message-id="${RESULT_ID}"]`)).toBeElementsArrayOfSize(1)

    await saveAppScreenshot('imported-cursor-agent-refresh.png')
  })
})
