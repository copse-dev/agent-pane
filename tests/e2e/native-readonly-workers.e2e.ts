import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../src/shared/safe-json.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'native-readonly-workers'
const MODEL = 'scripted-readonly-workers'
const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
})

function answer(
  response: ServerResponse,
  text: string,
  tool?: { name: string; args: object },
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      }
    : { content: text }
  response.end(
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  )
}

describe('native supervised read-only workers', function () {
  this.timeout(120_000)
  let root = ''
  let parentCalls = 0
  let scenario: 'inspect' | 'cancel' | 'isolation' = 'inspect'
  const closedWorkers = new Set<string>()
  const held = new Map<string, ServerResponse>()
  const workerCalls = new Map<string, number>()
  const offeredTools = new Map<string, string[]>()
  const workerHistories = new Map<string, string>()
  const errors: string[] = []
  const trace: string[] = []
  const previousKey = process.env['LM_STUDIO_API_KEY']
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (part: Buffer) => {
      body += part.toString()
    })
    request.on('end', () => {
      if (request.url?.endsWith('/models')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify(
            request.url.includes('/api/')
              ? {
                  models: [
                    {
                      key: MODEL,
                      max_context_length: 128_000,
                      loaded_instances: [{ config: { context_length: 128_000 } }],
                    },
                  ],
                }
              : { data: [{ id: MODEL, context_length: 128_000 }] },
          ),
        )
        return
      }
      const parsed = safeJsonParse(body, decodeWithSchema(requestSchema))
      if (!parsed) {
        errors.push('Invalid provider request')
        response.writeHead(400).end()
        return
      }
      const messages = parsed.messages
      const requestSystem = messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n')
      trace.push(
        `${scenario}: ${requestSystem.includes('WORKER_ALPHA') ? 'alpha' : requestSystem.includes('WORKER_BETA') ? 'beta' : 'parent'} ${String(parentCalls)}`,
      )
      if (requestSystem.includes('WORKER_ISOLATED'))
        errors.push('Isolated provider unexpectedly started')
      if (scenario === 'isolation') {
        answer(
          response,
          'The isolated agent did not start because worktree isolation is unavailable.',
        )
        return
      }
      const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n')
      const name = system.includes('WORKER_ALPHA')
        ? 'alpha'
        : system.includes('WORKER_BETA')
          ? 'beta'
          : null
      if (name) {
        const calls = (workerCalls.get(name) ?? 0) + 1
        workerCalls.set(name, calls)
        workerHistories.set(name, JSON.stringify(messages))
        if (scenario === 'cancel') {
          held.set(name, response)
          response.on('close', () => {
            closedWorkers.add(name)
          })
          return
        }
        if (calls === 1) {
          offeredTools.set(
            name,
            (parsed.tools ?? []).map((tool) => tool.function.name),
          )
          held.set(name, response)
          // Both real HTTP requests must be outstanding before either worker proceeds.
          if (held.size === 2)
            for (const [worker, pending] of held)
              answer(pending, '', {
                name: 'write_file',
                args: { path: 'forbidden.txt', content: worker },
              })
        } else answer(response, `${name} inspection complete; the write was blocked.`)
        return
      }
      // Title/summary requests use the same endpoint but have no worker tool.
      if (!parsed.tools?.some((tool) => tool.function.name === 'run_readonly_workers')) {
        answer(response, 'Independent inspections')
        return
      }
      if (parentCalls++ === 0)
        answer(response, '', {
          name: 'run_readonly_workers',
          args: {
            workers: [
              { agent: 'alpha', prompt: 'Inspect alpha independently.' },
              { agent: 'beta', prompt: 'Inspect beta independently.' },
            ],
          },
        })
      else answer(response, 'Both named workers completed read-only inspections.')
    })
  })

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    root = join(mkdtempSync(join(tmpdir(), 'copse-readonly-worker-runtime-')), 'workspace')
    const agents = join(root, '.copse', 'agents')
    mkdirSync(agents, { recursive: true })
    for (const name of ['alpha', 'beta'])
      writeFileSync(
        join(agents, `${name}.md`),
        [
          '---',
          `name: ${name}`,
          `description: Inspect ${name}.`,
          'model: inherit',
          '---',
          `WORKER_${name.toUpperCase()}: Inspect and report.`,
        ].join('\n'),
      )
    writeFileSync(
      join(agents, 'isolated.md'),
      '---\nname: isolated\ndescription: Requires isolation\nisolation: worktree\n---\nWORKER_ISOLATED: Inspect and report.',
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    seedEmptyProject(root, PROJECT_ID, {
      model: `lmstudio:${MODEL}`,
      localDefaultModel: `lmstudio:${MODEL}`,
      localServerUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      worktreeMode: 'never',
      subagentsEnabled: false,
      nextStepSuggestionEnabled: false,
    })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: root, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      trustedWorkspaceRoots: [realpathSync(root)],
      [`threads:${PROJECT_ID}`]: [],
    })
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '0', LM_STUDIO_API_KEY: 'fixture-key' })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    for (const response of held.values()) if (!response.writableEnded) response.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
    writeE2eEnv({ LM_STUDIO_API_KEY: previousKey })
    resetUserData()
    if (root) removeE2eTree(dirname(root))
  })

  it('runs two named workers concurrently through real provider dispatch and blocks writes', async () => {
    await setComposerValue(
      'Run alpha and beta as read-only workers on their independent inspections.',
    )
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await $$('.tool-card-subagent')).length === 2, {
      timeout: 30_000,
    })
    await waitForAgentIdle()
    assert.deepEqual(errors, [])
    assert.equal(held.size, 2, 'both worker requests overlapped')
    assert.equal(existsSync(join(root, 'forbidden.txt')), false)
    for (const name of ['alpha', 'beta']) {
      assert.equal(workerCalls.get(name), 2)
      const tools = offeredTools.get(name) ?? []
      assert.ok(tools.includes('read_file'))
      for (const forbidden of [
        'write_file',
        'run_shell',
        'task',
        'run_readonly_workers',
        'update_thread_plan',
        'report_plan_completion',
      ])
        assert.ok(!tools.includes(forbidden), forbidden)
      assert.match(workerHistories.get(name) ?? '', /Tool not available to this agent: write_file/)
    }
    const cards = await $$('.tool-card-subagent')
    await expect(cards[0]).toHaveText(expect.stringContaining('alpha'))
    await expect(cards[1]).toHaveText(expect.stringContaining('beta'))
    await saveAppScreenshot('native-readonly-workers.png')
  })
  it('stops both owned provider requests and settles worker cards', async () => {
    scenario = 'cancel'
    parentCalls = 0
    held.clear()
    workerCalls.clear()
    await setComposerValue('Run alpha and beta as read-only workers, then wait for my stop.')
    await $('.submit-btn').click()
    await browser
      .waitUntil(() => held.size === 2, {
        timeout: 30_000,
        timeoutMsg: 'both owned providers should be running',
      })
      .catch(async (error: unknown) => {
        throw new Error(JSON.stringify({ trace, chat: await $('.messages-list').getText() }), {
          cause: error,
        })
      })
    await $('button[aria-label="Open terminal"]').click()
    await browser.waitUntil(async () => (await $$('.supervised-task-row')).length === 2, {
      timeout: 15_000,
    })
    const labels = await $$('.supervised-task-label').map((label) => label.getText())
    assert.deepEqual(labels.sort(), ['alpha (read-only)', 'beta (read-only)'])
    await saveAppScreenshot('native-readonly-workers-running.png')
    await $('.stop-btn').click()
    await browser.waitUntil(() => closedWorkers.size === 2, {
      timeout: 15_000,
      timeoutMsg: 'Stop should abort both provider HTTP requests',
    })
    await waitForAgentIdle()
    assert.equal((await $$('.tool-card-subagent[data-status=running]')).length, 0)
    assert.equal((await $$('.tool-card-subagent[data-status=error]')).length, 2)
    await saveAppScreenshot('native-readonly-workers-cancelled.png')
  })

  it('reports unavailable isolation before any worker inference', async () => {
    scenario = 'isolation'
    const before = new Map(workerCalls)
    await setComposerValue('/isolated Inspect the workspace.')
    await $('.submit-btn').click()
    await browser.waitUntil(
      async () =>
        (await $('.messages-list').getText()).includes('worktree isolation is unavailable'),
      { timeout: 15_000 },
    )
    await waitForAgentIdle()
    assert.deepEqual(workerCalls, before)
    assert.deepEqual(errors, [])
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('isolated agent did not start'),
    )
    await saveAppScreenshot('native-worker-isolation-unavailable.png')
  })
})
