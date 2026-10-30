import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { $, $$, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../src/shared/safe-json.ts'
import {
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  e2eWorkspaceDir,
} from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot, pinTextForCapture } from './helpers/screenshot.ts'

const PROJECT_ID = 'native-isolated-workers'
const MODEL = 'scripted-isolated-workers'
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

describe('native isolated writable workers', function () {
  this.timeout(120_000)
  let root = ''
  let worktrees = ''
  let parentCalls = 0
  let scenario: 'write' | 'cancel-clean' | 'cancel-dirty' | 'prepare-cancel' = 'write'
  const held = new Map<string, ServerResponse>()
  const closedWorkers = new Set<string>()
  const workerCalls = new Map<string, number>()
  const checkouts = new Map<string, string>()
  const capturePaths = new Map<string, string>()
  const offeredTools = new Map<string, string[]>()
  const histories = new Map<string, string>()
  const errors: string[] = []
  const previousKey = process.env['LM_STUDIO_API_KEY']
  const previousWorktrees = process.env['COPSE_WORKTREES_DIR']
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
        errors.push('invalid provider request')
        response.writeHead(400).end()
        return
      }
      const system = parsed.messages
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
        histories.set(name, JSON.stringify(parsed.messages))
        const brief = parsed.messages
          .filter((message) => message.role === 'user')
          .map((message) => String(message.content))
          .join('\n')
        const checkout = /Workspace: ([^\n]+)/.exec(brief)?.[1]
        if (checkout) {
          checkouts.set(name, checkout)
          capturePaths.set(checkout, name)
        }
        if (calls === 1)
          offeredTools.set(
            name,
            (parsed.tools ?? []).map((tool) => tool.function.name),
          )
        if (scenario === 'cancel-clean' || (scenario === 'cancel-dirty' && calls === 2)) {
          held.set(name, response)
          response.on('close', () => {
            closedWorkers.add(name)
          })
          return
        }
        if (scenario === 'prepare-cancel') {
          if (calls === 1) answer(response, '', { name: 'preflight_worktree', args: {} })
          else if (calls === 2) {
            const fingerprint = /Plan fingerprint: ([a-f0-9]{64})/.exec(
              JSON.stringify(parsed.messages),
            )?.[1]
            if (!fingerprint) {
              errors.push(JSON.stringify(parsed.messages))
              answer(response, 'preflight failed')
              return
            }
            answer(response, '', {
              name: 'prepare_worktree',
              args: { planFingerprint: fingerprint, offline: true },
            })
          } else answer(response, 'Preparation ended')
          return
        }
        if (calls === 1) {
          held.set(name, response)
          if (held.size === 2)
            for (const [worker, pending] of held)
              answer(pending, '', {
                name: 'write_file',
                args: { path: 'same.txt', content: worker },
              })
        } else if (calls === 2) {
          const sibling = checkouts.get(name === 'alpha' ? 'beta' : 'alpha')
          assert.ok(sibling)
          answer(response, '', {
            name: 'write_file',
            args: { path: join(sibling, 'same.txt'), content: 'clobber' },
          })
        } else answer(response, `${name} wrote its own same.txt; sibling access was blocked.`)
        return
      }
      if (!parsed.tools?.some((tool) => tool.function.name === 'run_isolated_workers')) {
        answer(response, 'Independent changes')
        return
      }
      if (parentCalls++ === 0)
        answer(response, '', {
          name: 'run_isolated_workers',
          args: {
            workers: [
              { agent: 'alpha', prompt: 'Edit same.txt in your own checkout.' },
              ...(scenario === 'prepare-cancel'
                ? []
                : [{ agent: 'beta', prompt: 'Edit same.txt in your own checkout.' }]),
            ],
          },
        })
      else
        answer(
          response,
          'Both named workers completed in separate checkouts. Their edits are retained for review.',
        )
    })
  })
  /**
   * Creating each worker checkout runs a write-sandboxed Git command in the
   * parent checkout, and bubblewrap briefly leaves empty mount-point stubs
   * (`.bashrc`, `.vscode`, ...) there. A sidebar read in that window caches
   * "Uncommitted changes" until a later read clears it, so some captures showed
   * the glyph. The seeded parent checkout is clean: wait until Git agrees and
   * the row has dropped any glyph from a transient read.
   */
  async function settleSidebarChanges(): Promise<void> {
    const threadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(threadId)
    await browser.waitUntil(
      async () =>
        isDeepStrictEqual(
          await browser.execute(
            (projectId, threadId) =>
              window.api.git.threadChangeSummary([{ projectId, threadId }], { fresh: true }),
            PROJECT_ID,
            threadId,
          ),
          [{ dirty: false }],
        ),
      { timeout: 15_000, timeoutMsg: 'The parent checkout should read clean' },
    )
    // The sidebar keeps a read for 30s unless a working-tree event refreshes it.
    await $(`.chat-row[data-thread-id="${threadId}"] .chat-changes-status`).waitForExist({
      timeout: 40_000,
      reverse: true,
      timeoutMsg: 'The sidebar should drop a stale changes glyph for the clean checkout',
    })
  }
  async function saveWorkerScreenshot(filename: string): Promise<void> {
    await settleSidebarChanges()
    // Real ownership/path assertions precede capture. These main-generated UUIDs
    // and the host's Node location cannot be seeded through product inputs.
    const text = await $('#body').getText()
    const restores: Array<() => Promise<void>> = []
    const pin = async (path: string, replacement: string): Promise<void> => {
      if (!text.includes(path)) return
      const pattern = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      restores.push(await pinTextForCapture('#body', pattern, replacement))
    }
    try {
      for (const [path, name] of capturePaths)
        await pin(path, `/workspace/worktrees/${PROJECT_ID}/${name}`)
      await pin(process.execPath, '/usr/bin/node')
      await saveAppScreenshot(filename)
    } finally {
      for (const restore of restores.reverse()) await restore()
    }
  }
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const temp = mkdtempSync(join(tmpdir(), 'copse-writable-workers-'))
    root = join(temp, 'repo')
    worktrees = join(temp, 'worktrees')
    mkdirSync(join(root, '.copse', 'agents'), { recursive: true })
    for (const name of ['alpha', 'beta'])
      writeFileSync(
        join(root, '.copse', 'agents', `${name}.md`),
        `---\nname: ${name}\nisolation: worktree\nmodel: inherit\n---\nWORKER_${name.toUpperCase()}: Edit and report.`,
      )
    writeFileSync(join(root, 'same.txt'), 'parent')
    writeFileSync(
      join(root, '.copse', 'worktree-preparation.json'),
      JSON.stringify({
        version: 1,
        prepare: [
          {
            command: process.execPath,
            args: [
              '-e',
              'const fs=require("node:fs");fs.writeFileSync("preparing.txt","started");setTimeout(()=>fs.writeFileSync("finished.txt","late"),10000)',
            ],
          },
        ],
        checks: [],
      }),
    )
    const git = (args: string[]): void => {
      execFileSync('git', args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
        },
      })
    }
    git(['init', '-q', '-b', 'main'])
    git(['config', 'commit.gpgsign', 'false'])
    git(['add', '.'])
    git(['commit', '-qm', 'initial'])
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
    writeE2eEnv({
      COPSE_PANEL_MOCK_LLM: '0',
      LM_STUDIO_API_KEY: 'fixture-key',
      COPSE_WORKTREES_DIR: worktrees,
      COPSE_PANEL_MOCK_BRANCH: '',
    })
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
    writeE2eEnv({
      LM_STUDIO_API_KEY: previousKey,
      COPSE_WORKTREES_DIR: previousWorktrees,
      COPSE_PANEL_MOCK_BRANCH: 'work',
    })
    removeE2eTree(dirname(root))
  })
  it('writes the same path independently, rejects sibling writes and returns checkout attribution', async () => {
    await setComposerValue(
      'Run alpha and beta as isolated writable workers. Each should edit same.txt independently.',
    )
    await $('.submit-btn').click()
    await browser.waitUntil(() => workerCalls.get('alpha') === 3 && workerCalls.get('beta') === 3, {
      timeout: 30_000,
      timeoutMsg: 'Both isolated workers should finish real native edits',
    })
    await waitForAgentIdle()
    assert.deepEqual(errors, [])
    assert.equal(held.size, 2)
    assert.equal(new Set(checkouts.values()).size, 2)
    for (const name of ['alpha', 'beta']) {
      const checkout = checkouts.get(name)
      assert.ok(checkout && checkout !== root)
      assert.equal(readFileSync(join(checkout, 'same.txt'), 'utf8'), name)
      const tools = offeredTools.get(name) ?? []
      for (const allowed of ['write_file', 'preflight_worktree', 'prepare_worktree'])
        assert.ok(tools.includes(allowed), allowed)
      for (const forbidden of [
        'run_shell',
        'task',
        'run_readonly_workers',
        'run_isolated_workers',
        'update_thread_plan',
        'report_plan_completion',
      ])
        assert.ok(!tools.includes(forbidden), forbidden)
      assert.match(histories.get(name) ?? '', /outside|not allowed|escape|within/i)
    }
    assert.equal(readFileSync(join(root, 'same.txt'), 'utf8'), 'parent')
    const cards = await $$('.tool-card-subagent')
    assert.equal(cards.length, 2)
    await expect(cards[0]).toHaveText(expect.stringContaining('alpha'))
    await expect(cards[1]).toHaveText(expect.stringContaining('beta'))
    await expect($('.messages-list')).toHaveText(expect.stringContaining('retained'))
    await saveWorkerScreenshot('native-isolated-workers.png')
  })
  for (const dirty of [false, true])
    it(`cancels both workers and ${dirty ? 'retains edits' : 'removes clean checkouts'} safely`, async () => {
      scenario = dirty ? 'cancel-dirty' : 'cancel-clean'
      parentCalls = 0
      held.clear()
      workerCalls.clear()
      closedWorkers.clear()
      checkouts.clear()
      await setComposerValue(
        'Run alpha and beta as isolated writable workers and wait for my stop.',
      )
      await $('.submit-btn').click()
      await browser.waitUntil(
        () =>
          held.size === 2 &&
          (dirty ? workerCalls.get('alpha') === 2 && workerCalls.get('beta') === 2 : true),
        { timeout: 30_000 },
      )
      if (!dirty) {
        await $('button[aria-label="Open terminal"]').click()
        await browser.waitUntil(async () => (await $$('.supervised-task-row')).length === 2, {
          timeout: 15_000,
        })
        assert.deepEqual(
          (await $$('.supervised-task-label').map((label) => label.getText())).sort(),
          ['alpha (isolated)', 'beta (isolated)'],
        )
        await saveWorkerScreenshot('native-isolated-workers-running.png')
      }
      await $('.stop-btn').click()
      await browser.waitUntil(() => closedWorkers.size === 2, { timeout: 15_000 })
      await waitForAgentIdle()
      await browser.waitUntil(
        () =>
          [...checkouts.values()].every((checkout) =>
            dirty ? existsSync(join(checkout, 'same.txt')) : !existsSync(checkout),
          ),
        { timeout: 15_000 },
      )
      assert.equal((await $$('.tool-card-subagent[data-status=running]')).length, 0)
      assert.equal((await $$('.tool-card-subagent[data-status=error]')).length, dirty ? 4 : 2)
      if (dirty)
        for (const [name, checkout] of checkouts)
          assert.equal(readFileSync(join(checkout, 'same.txt'), 'utf8'), name)
      assert.equal(readFileSync(join(root, 'same.txt'), 'utf8'), 'parent')
      await saveWorkerScreenshot(
        dirty
          ? 'native-isolated-workers-cancelled-dirty.png'
          : 'native-isolated-workers-cancelled-clean.png',
      )
    })
  it('cancels approved preparation in the worker checkout and retains partial setup safely', async () => {
    scenario = 'prepare-cancel'
    parentCalls = 0
    held.clear()
    workerCalls.clear()
    checkouts.clear()
    await setComposerValue(
      'Run alpha in an isolated worker and prepare its worktree; wait for my stop.',
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Prepare this worktree?')
    const checkout = checkouts.get('alpha')
    assert.ok(checkout)
    await expect(dialog.$('.approval-footer')).toHaveText(expect.stringContaining(checkout))
    await saveWorkerScreenshot('native-isolated-worker-preparation.png')
    await dialog.$('.approval-approve').click()
    await browser.waitUntil(() => existsSync(join(checkout, 'preparing.txt')), { timeout: 20_000 })
    await $('.stop-btn').click()
    await waitForAgentIdle()
    const metaPath = join(e2eWorkspaceDir(), PROJECT_ID, basename(checkout), 'meta.json')
    await browser.waitUntil(
      () => {
        if (!existsSync(metaPath)) return false
        const meta = safeJsonParse(
          readFileSync(metaPath, 'utf8'),
          decodeWithSchema(z.object({ status: z.string() })),
        )
        return meta?.status === 'error'
      },
      {
        timeout: 15_000,
        timeoutMsg: 'Preparation must stop and settle its cleanup before retaining the checkout',
      },
    )
    assert.equal(existsSync(join(checkout, 'preparing.txt')), true)
    assert.equal(existsSync(join(checkout, 'finished.txt')), false)
    assert.equal(existsSync(join(root, 'preparing.txt')), false)
    assert.equal(workerCalls.get('alpha'), 2)
    assert.deepEqual(errors, [])
  })
})
