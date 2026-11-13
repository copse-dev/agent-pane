import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { userSteeringReceiptSchema } from '../../packages/thread-store/src/user-steering.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT = 'e2e-native-steering'
const NOTE = 'Keep the existing public API and report both file reads.'
const LATER_NOTE = 'Keep this follow-up queued until the current task finishes.'
const STOP_NOTE = 'Leave this correction held if I stop the run.'
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
})
const metaSchema = z.object({
  currentEpoch: z.string(),
  continuationUsed: z.number().optional(),
  pendingMessages: z
    .array(z.object({ messageId: z.string(), autoDispatch: z.literal(false).optional() }))
    .optional(),
})

function send(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finish: string | null,
): void {
  if (!response.headersSent)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(
    `data: ${JSON.stringify({ id: 'steering-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
  )
  if (finish) response.end('data: [DONE]\n\n')
}

describe('native parent steering through the real provider and IPC', function () {
  this.timeout(120_000)
  let root = ''
  let previousMockBranch: string | undefined
  let pending: ServerResponse | undefined
  let calls = 0
  let activeThreadId: string | undefined
  const failures: string[] = []
  const requests: z.infer<typeof requestSchema>[] = []
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: [{ id: 'chat' }, { id: 'titles' }] }))
        return
      }
      assert.equal(request.url, '/v1/chat/completions')
      let body = ''
      request.setEncoding('utf8')
      for await (const part of request) {
        body += String(part)
        assert.ok(body.length < 2_000_000)
      }
      const parsed = safeJsonParse(body, decodeWithSchema(requestSchema))
      assert.ok(parsed)
      if (parsed.model === 'titles') {
        send(response, { content: 'Review API compatibility' }, 'stop')
        return
      }
      assert.equal(parsed.model, 'chat')
      requests.push(parsed)
      calls++
      if (calls === 1 || calls === 3 || calls === 4) {
        pending = response
        send(
          response,
          { content: 'I will read both project files before making changes.\n\n' },
          null,
        )
        return
      }
      assert.ok(calls === 2 || calls === 5, 'Steering must not dispatch another turn after Stop')
      assert.equal(parsed.messages.at(-1)?.role, 'user')
      assert.equal(parsed.messages.at(-1)?.content, NOTE)
      assert.equal(parsed.messages.filter((message) => message.role === 'tool').length, 2)
      assert.ok(!parsed.messages.some((message) => message.content === LATER_NOTE))
      if (calls === 5) pending = response
      send(
        response,
        { content: 'Both files were read. The existing public API stays unchanged.' },
        calls === 5 ? null : 'stop',
      )
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(400)
      response.end(JSON.stringify({ error: { message: failures.at(-1) } }))
    })
  })

  function directory(): string {
    const project = join(e2eWorkspaceDir(), PROJECT)
    if (activeThreadId) return join(project, activeThreadId)
    const threads = readdirSync(project, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    )
    assert.equal(threads.length, 1)
    const entry = threads[0]
    assert.ok(entry)
    return join(project, entry.name)
  }
  function meta(): z.infer<typeof metaSchema> {
    const parsed = safeJsonParse(
      readFileSync(join(directory(), 'meta.json'), 'utf8'),
      decodeWithSchema(metaSchema),
    )
    assert.ok(parsed)
    return parsed
  }
  function receipts(): z.infer<typeof userSteeringReceiptSchema>[] {
    return readFileSync(join(directory(), 'user-steering.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const receipt = safeJsonParse(line, decodeWithSchema(userSteeringReceiptSchema))
        assert.ok(receipt)
        return receipt
      })
  }
  async function queueNote(text: string): Promise<void> {
    await setComposerValue(text)
    await submitComposer()
    await $('.conversation-queued .queued-steer').waitForDisplayed({ timeout: 10_000 })
    await $('.queued-steer').click()
    await expect($('.steering-pending')).toHaveText('Waiting for the next agent step…')
    await browser.waitUntil(
      () => {
        try {
          return receipts().at(-1)?.state === 'accepted'
        } catch {
          return false
        }
      },
      {
        timeout: 10_000,
        timeoutMsg: 'Steering admission must be recorded before releasing the provider hold',
      },
    )
  }

  before(async () => {
    previousMockBranch = process.env['COPSE_PANEL_MOCK_BRANCH']
    root = mkdtempSync(join(tmpdir(), 'copse-steering-runtime-'))
    seedStableWorkspace({ root, files: { 'first.txt': 'First read', 'second.txt': 'Second read' } })
    const baseUrl = await new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        resolve(`http://127.0.0.1:${String(address.port)}/v1`)
      })
    })
    resetUserData()
    seedEmptyProject(root, PROJECT)
    // Like queued-message-delete: subsequent submissions must see the branch
    // the first real checkout prepared, rather than the global screenshot pin.
    writeE2eEnv({
      COPSE_PANEL_MOCK_LLM: '0',
      COPSE_PANEL_MOCK_BRANCH: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    })
    writeSettings({
      model: 'steering-fixture:chat',
      smallTasksModel: 'steering-fixture:titles',
      nextStepSuggestionEnabled: false,
      subagentsEnabled: false,
      extraProviders: [
        {
          slug: 'steering-fixture',
          label: 'Local test model',
          baseUrl,
          models: [{ id: 'chat' }, { id: 'titles' }],
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      }),
    )
    const evidence = join(process.cwd(), '.tmp', 'native-steering-evidence')
    mkdirSync(evidence, { recursive: true })
    writeFileSync(join(evidence, 'provider-requests.json'), JSON.stringify(requests, null, 2))
    for (const name of ['meta.json', 'agent-history.json', 'user-steering.jsonl', 'events.jsonl']) {
      const source = join(directory(), name)
      if (existsSync(source)) copyFileSync(source, join(evidence, name))
    }
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '1', COPSE_PANEL_MOCK_BRANCH: previousMockBranch })
    resetUserData()
    if (root) removeE2eTree(root)
  })

  it('adds the note after a complete tool batch, preserves its epoch, and survives reload', async () => {
    await setComposerValue('Read first.txt and second.txt, then report API compatibility.')
    await submitComposer()
    await browser.waitUntil(() => calls === 1, { timeout: 20_000 })
    await queueNote(NOTE)
    const before = meta()
    assert.equal(before.pendingMessages?.[0]?.autoDispatch, false)
    assert.equal(calls, 1)
    await parkPointer()
    await saveAppScreenshot('native-steering-pending.png')
    assert.ok(pending && !pending.destroyed)
    send(
      pending,
      {
        tool_calls: ['first.txt', 'second.txt'].map((path, index) => ({
          index,
          id: `read-${String(index)}`,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path }) },
        })),
      },
      'tool_calls',
    )
    pending = undefined
    await waitForAgentIdle(30_000)
    await expect($('.messages-list')).toHaveText(expect.stringContaining('Both files were read.'))
    await expect($('.conversation-queued .msg-queued')).not.toExist()
    assert.deepEqual(failures, [])
    assert.equal(calls, 2)
    assert.equal(meta().currentEpoch, before.currentEpoch)
    assert.equal(meta().continuationUsed ?? 0, before.continuationUsed ?? 0)
    assert.deepEqual(
      receipts().map((receipt) => receipt.state),
      ['accepted', 'applied'],
    )
    assert.ok(readFileSync(join(directory(), 'agent-history.json'), 'utf8').includes(NOTE))
    await browser.reloadSession()
    await expect($('.messages-list')).toHaveText(expect.stringContaining(NOTE))
    await expect($('.messages-list')).toHaveText(expect.stringContaining('Both files were read.'))
    await expect($('.conversation-queued .msg-queued')).not.toExist()
    const transcript = await $('.messages-list').getText()
    assert.ok(transcript.indexOf('I will read both project files') < transcript.indexOf(NOTE))
    assert.ok(transcript.indexOf(NOTE) < transcript.indexOf('Both files were read.'))
    assert.ok(!transcript.includes('Added your note to the running turn.'))
    await parkPointer()
    await saveAppScreenshot('native-steering-applied.png')
  })

  it('leaves an accepted note held after Stop and restart without another request', async () => {
    await setComposerValue('Read both files again before suggesting a follow-up.')
    await submitComposer()
    await browser.waitUntil(() => calls === 3, { timeout: 20_000 })
    await queueNote(STOP_NOTE)
    await $('.stop-btn').click()
    // waitForAgentIdle also requires an empty queue; this case must retain a held note.
    await expect($('.stop-btn')).not.toBeDisplayed({ wait: 30_000 })
    await expect($('.conversation-queued .queued-release')).toBeDisplayed()
    assert.equal(receipts().at(-1)?.state, 'held')
    assert.equal(meta().pendingMessages?.[0]?.autoDispatch, false)
    assert.equal(calls, 3)
    await browser.reloadSession()
    await expect($('.conversation-queued .message-text')).toHaveText(STOP_NOTE)
    await expect($('.conversation-queued .queued-release')).toBeDisplayed()
    assert.equal(calls, 3)
    assert.deepEqual(failures, [])
    await parkPointer()
    await saveAppScreenshot('native-steering-stopped.png')
  })

  it('places an applied note at its boundary while a later follow-up stays queued', async () => {
    const previousId = await $('.chat-row.selected').getAttribute('data-thread-id')
    await $('.project-new-thread-btn').click()
    await browser.waitUntil(
      async () => {
        const id = await $('.chat-row.selected').getAttribute('data-thread-id')
        if (!id || id === previousId) return false
        activeThreadId = id
        return true
      },
      { timeout: 10_000 },
    )
    await setComposerValue('Read first.txt and second.txt, then report API compatibility.')
    await submitComposer()
    await browser.waitUntil(() => calls === 4, { timeout: 20_000 })
    await queueNote(NOTE)
    await setComposerValue(LATER_NOTE)
    await submitComposer()
    await expect($('.conversation-queued')).toHaveText(expect.stringContaining(LATER_NOTE))
    await browser.waitUntil(() => meta().pendingMessages?.length === 2, { timeout: 10_000 })
    assert.ok(pending && !pending.destroyed)
    send(
      pending,
      {
        tool_calls: ['first.txt', 'second.txt'].map((path, index) => ({
          index,
          id: `later-read-${String(index)}`,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path }) },
        })),
      },
      'tool_calls',
    )
    pending = undefined
    await browser.waitUntil(() => calls === 5, { timeout: 20_000 })
    await expect($('.messages-list')).toHaveText(expect.stringContaining(NOTE))
    await expect($('.messages-list')).toHaveText(expect.stringContaining('Both files were read.'))
    await expect($('.messages-list')).not.toHaveText(expect.stringContaining(LATER_NOTE))
    await expect($('.conversation-queued .message-text')).toHaveText(LATER_NOTE)
    const transcript = await $('.messages-list').getText()
    assert.ok(transcript.indexOf('I will read both project files') < transcript.indexOf(NOTE))
    assert.ok(transcript.indexOf(NOTE) < transcript.indexOf('Both files were read.'))
    assert.equal(meta().pendingMessages?.length, 1)
    await parkPointer()
    await saveAppScreenshot('native-steering-applied-with-queued.png')
    // Hold the later note through the real Steer action before stopping the
    // response. It must remain undelivered instead of dispatching a new turn.
    await $('.conversation-queued .queued-steer').click()
    await expect($('.steering-pending')).toBeDisplayed()
    await browser.waitUntil(() => receipts().at(-1)?.state === 'accepted', { timeout: 10_000 })
    await $('.stop-btn').click()
    await expect($('.stop-btn')).not.toBeDisplayed({ wait: 30_000 })
    await expect($('.conversation-queued .queued-release')).toBeDisplayed()
    assert.deepEqual(
      receipts().map((receipt) => receipt.state),
      ['accepted', 'applied', 'accepted', 'held'],
    )
    assert.equal(calls, 5)
    await browser.reloadSession()
    await expect($('.messages-list')).toHaveText(expect.stringContaining(NOTE))
    await expect($('.conversation-queued .message-text')).toHaveText(LATER_NOTE)
    await expect($('.conversation-queued .queued-release')).toBeDisplayed()
    assert.ok(!readFileSync(join(directory(), 'agent-history.json'), 'utf8').includes(LATER_NOTE))
    assert.equal(calls, 5)
    assert.deepEqual(failures, [])
  })
})
