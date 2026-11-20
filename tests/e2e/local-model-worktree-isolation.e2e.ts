import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import {
  startScriptedModelServer,
  type ScriptedModelServer,
} from '../../src/main/services/container-runtime/scripted-model-server.ts'
import { loadProjectThreads } from '../../src/main/services/thread-store.ts'
import { getCopseUserDataDir, waitForAgentIdle } from './helpers.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply } from './helpers/mock-scenario.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT_ID = 'e2e-local-model-worktree-isolation'
const MODEL_ID = 'scripted-local'
const THREAD_ID = 'local-isolation-fixture'
const TITLE = 'Isolated fixture write'
const FINAL_RESPONSE = 'Created local-provider-output.txt in the task checkout.'
const OUTPUT_FILE = 'local-provider-output.txt'
const OUTPUT = 'written through the isolated thread\n'
const previousLmStudioApiKey = process.env['LM_STUDIO_API_KEY']

function readConfig(): Record<string, unknown> {
  const config = safeJsonParse(
    readFileSync(join(getCopseUserDataDir(), 'config.json'), 'utf8'),
    decodeWithSchema(z.record(z.string(), z.unknown())),
  )
  assert.ok(config)
  return config
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('local provider default worktree isolation', () => {
  let projectRoot = ''
  let allocatedWorktree = ''
  let model: ScriptedModelServer | null = null

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = join(mkdtempSync(join(tmpdir(), 'copse-local-model-worktree-')), 'workspace')
    mkdirSync(projectRoot)
    git(projectRoot, ['init', '-q', '--initial-branch=main'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'commit.gpgsign', 'false'])
    git(projectRoot, ['config', 'init.defaultBranch', 'main'])
    writeFileSync(join(projectRoot, 'README.md'), '# Local model isolation fixture\n', 'utf8')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed default branch'])
    assert.equal(
      realpathSync(git(projectRoot, ['rev-parse', '--show-toplevel'])),
      realpathSync(projectRoot),
      'fixture must remain an unrelated repository',
    )

    model = await startScriptedModelServer(
      [
        { kind: 'tool', name: 'write_file', args: { path: OUTPUT_FILE, content: OUTPUT } },
        { kind: 'text', text: FINAL_RESPONSE },
      ],
      { modelId: MODEL_ID, textOnlyResponse: TITLE },
    )
    seedEmptyProject(projectRoot, PROJECT_ID, {
      worktreeMode: 'default',
      model: `lmstudio:${MODEL_ID}`,
      localDefaultModel: `lmstudio:${MODEL_ID}`,
      localServerUrl: `http://127.0.0.1:${String(model.port)}/v1`,
      subagentsEnabled: false,
      nextStepSuggestionEnabled: false,
    })
    // Seed the empty thread id, not a worktree: the real default allocator still
    // creates it on send, while the eventual titled branch has a stable suffix.
    writeSeedConfig(
      {
        ...readConfig(),
        activeThreadId: THREAD_ID,
        [`threads:${PROJECT_ID}`]: [
          {
            id: THREAD_ID,
            title: 'New Thread',
            status: 'idle',
            messages: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      { preserveProductWorktreeDefault: true },
    )
    writeE2eEnv({
      COPSE_PANEL_MOCK_LLM: '0',
      LM_STUDIO_API_KEY: 'e2e-local-provider-key',
    })
    await browser.reloadSession()
  })

  after(async () => {
    writeE2eEnv({ LM_STUDIO_API_KEY: previousLmStudioApiKey })
    resetUserData()
    if (allocatedWorktree && existsSync(projectRoot)) {
      try {
        git(projectRoot, ['worktree', 'remove', '--force', allocatedWorktree])
      } catch {
        // The e2e profile cleanup may already have removed the linked checkout.
      }
    }
    if (model) await model.stop()
    if (projectRoot) removeE2eTree(dirname(projectRoot))
  })

  it('routes a real local-provider tool write into a default isolated worktree', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const projects = readConfig()['projects']
    assert.ok(Array.isArray(projects))
    const project = projects[0] as unknown
    assert.ok(project && typeof project === 'object')
    assert.equal(
      Object.hasOwn(project, 'worktreeMode'),
      false,
      'fixture must exercise the product default rather than opt into isolation',
    )

    const initialHead = git(projectRoot, ['rev-parse', 'HEAD'])
    const initialStatus = git(projectRoot, ['status', '--porcelain=v1'])
    const initialTrackedStatus = git(projectRoot, [
      'status',
      '--porcelain=v1',
      '--untracked-files=no',
    ])
    assert.equal(git(projectRoot, ['branch', '--show-current']), 'main')
    assert.equal(initialStatus, '')

    await setComposerValue('Create the requested fixture file in this task checkout.')
    await $('.submit-btn').click()
    await browser.waitUntil(
      async () => {
        const stop = $('.stop-btn')
        const stopVisible = (await stop.isExisting()) && (await stop.getProperty('hidden')) !== true
        const checkoutError = $('.composer-checkout-error')
        const checkoutErrorVisible =
          (await checkoutError.isExisting()) && (await checkoutError.isDisplayed())
        return (
          stopVisible ||
          checkoutErrorVisible ||
          (await $('.tool-card, .msg-assistant').isExisting())
        )
      },
      { timeout: 30_000, timeoutMsg: 'expected the local-provider turn to start' },
    )
    const checkoutError = $('.composer-checkout-error')
    assert.equal(
      (await checkoutError.isExisting()) && (await checkoutError.isDisplayed()),
      false,
      (await checkoutError.isExisting()) && (await checkoutError.isDisplayed())
        ? await checkoutError.getText()
        : '',
    )
    await waitForAgentIdle(60_000)
    await expectAssistantReply(FINAL_RESPONSE)
    await expect($('.chat-row.selected .chat-title')).toHaveText(TITLE)
    await expect($('.branch-picker-label')).toHaveText('copse/isolated-fixture-write-ixture')

    const toolNames = await $$('.tool-card .tool-name').map((element) => element.getText())
    const assistantTexts = await $$('.msg-assistant').map((element) => element.getText())
    assert.ok(
      toolNames.some((name) => name.includes(OUTPUT_FILE)),
      `expected write_file result, got ${toolNames.join()}; assistant=${assistantTexts.join(' | ')}; requests=${String(model?.requests ?? 0)}`,
    )
    await expect($('.tool-card[data-status="done"]')).toExist()

    const threads = await loadProjectThreads(PROJECT_ID)
    assert.equal(threads.length, 1)
    const thread = threads[0]
    assert.ok(thread)
    assert.equal(thread.worktreeChoice, 'automatic')
    assert.ok(thread.worktree, 'default policy should allocate a linked worktree')
    allocatedWorktree = thread.worktree.path
    assert.notEqual(allocatedWorktree, projectRoot)
    assert.notEqual(thread.worktree.branch, 'main')
    assert.equal(thread.worktree.baseBranch, 'main')
    assert.match(
      git(projectRoot, ['worktree', 'list', '--porcelain']),
      new RegExp(`worktree ${allocatedWorktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )

    assert.equal(readFileSync(join(allocatedWorktree, OUTPUT_FILE), 'utf8'), OUTPUT)
    assert.equal(existsSync(join(projectRoot, OUTPUT_FILE)), false)
    assert.equal(git(projectRoot, ['branch', '--show-current']), 'main')
    assert.equal(git(projectRoot, ['rev-parse', 'HEAD']), initialHead)
    // Linux bubblewrap can leave its empty protected-config mount points visible
    // until every concurrent sandbox lease is released. The deterministic model
    // writes only OUTPUT_FILE, whose source-checkout absence is asserted above;
    // compare tracked state here so those ASRT placeholders cannot obscure a
    // real modification to the original checkout.
    assert.equal(
      git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=no']),
      initialTrackedStatus,
    )
    assert.ok(model)
    assert.equal(model.scriptedRequests, 2, 'both scripted agent steps must be served')
    assert.ok(model.completionRequests > 2, 'the title helper must use the HTTP fixture')
    await assertNoErrorToasts('local-provider isolated tool write')
    // The composer's Changes bubble lands a status round trip after the turn
    // settles; without this wait some runs capture the composer before it.
    await $('.follow-up-bubble-changes').waitForDisplayed({ timeout: 15_000 })
    await expect($('.follow-up-bubble-changes .follow-up-stat-add')).toHaveText('+1')
    // The sidebar summary has its own status refresh, independent of the
    // composer's round trip. Capture only once both report this unlanded write.
    await $('.chat-row.selected .chat-changes-status').waitForDisplayed({ timeout: 40_000 })
    await saveAppScreenshot('local-model-worktree-isolation.png')
  })
})
