import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { loadProjectThreads } from '../../src/main/services/thread-store.ts'
import { startConversationServer } from './helpers/conversation-server.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  resetUserMcpConfig,
  seedE2eViewport,
  seedUserMcpConfig,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { parkPointer, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'
import { observeAutomationGitCapture } from './helpers/automation-git-capture-observation.ts'

const A = 'e2e-mcp-project-a'
const B = 'e2e-mcp-project-b'
const TOOL = 'mcp__owned__report_workspace'
const PROMPT_A = 'Verify project A twice using its own workspace.'
const PROMPT_B = 'Verify project B using its own workspace.'
const FINAL_A = 'Project A was verified twice using its original connection.'
const FINAL_B = 'Project B was verified using its own connection.'
const SEEDED_AT = Date.parse('2026-11-06T12:00:00Z')
const metaSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  automation: z.object({ scheduleId: z.string() }).optional(),
  worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
})
const eventSchema = z.object({
  type: z.string(),
  pid: z.number(),
  workspace: z.string(),
  call: z.number().optional(),
})

function metadata(projectId: string, id: string): z.infer<typeof metaSchema> {
  const value = safeJsonParse(
    readFileSync(join(e2eWorkspaceDir(), projectId, id, 'meta.json'), 'utf8'),
    decodeWithSchema(metaSchema),
  )
  assert.ok(value)
  return value
}
function runIds(projectId: string): string[] {
  const directory = join(e2eWorkspaceDir(), projectId)
  return existsSync(directory)
    ? readdirSync(directory).filter(
        (id) =>
          existsSync(join(directory, id, 'meta.json')) &&
          metadata(projectId, id).automation !== undefined,
      )
    : []
}
async function runNow(projectId: string, name: string): Promise<void> {
  await $(`.project-entry[data-project-id="${projectId}"] .project-menu-btn`).click()
  await $('.context-menu-item=Automations').click()
  await $('#automation-dialog .automation-run-btn').click()
  await expect($('#automation-dialog .automation-status')).toHaveText(`Started “${name}”.`)
  await $('#automation-dialog [aria-label="Close automations"]').click()
}
async function openRun(projectId: string, id: string): Promise<void> {
  // A run's workspace-level Automation row selects its owning project/thread.
  // A separate project activation here needlessly races the final sidebar update.
  // Automations are a workspace-level section; one run is a flat row rather
  // than a schedule group. Open only the real folds that this layout has.
  const automations = $('.automation-threads-toggle')
  await automations.waitForExist({ timeout: 10_000 })
  if ((await automations.getAttribute('aria-expanded')) === 'false') await automations.click()
  const scheduleId = projectId === A ? 'check-a' : 'check-b'
  const schedule = $(
    `.automation-schedule-group[data-schedule-id="${scheduleId}"] .automation-schedule-toggle`,
  )
  if ((await schedule.isExisting()) && (await schedule.getAttribute('aria-expanded')) === 'false')
    await schedule.click()
  const selector = `.chat-row[data-thread-id="${id}"]`
  const title = projectId === A ? 'Check project A' : 'Check project B'
  await $(selector).waitForExist({ timeout: 10_000 })
  await expect($(`${selector} .chat-title`)).toHaveText(title)
  // Sidebar updates replace rows. Resolve and activate the current row in one
  // browser task, through its existing project/thread-selection handler.
  await browser.execute(
    (target, expectedTitle) => {
      const row = document.querySelector(target)
      if (!(row instanceof HTMLElement) || !row.isConnected)
        throw new Error('The current Automation row is missing')
      if (row.querySelector('.chat-title')?.textContent !== expectedTitle)
        throw new Error('The current Automation row has the wrong title')
      row.click()
    },
    selector,
    title,
  )
}

describe('MCP project navigation during automation', function () {
  this.timeout(120_000)
  let rootA = ''
  let rootB = ''
  let trace = ''
  let conversationA: Awaited<ReturnType<typeof startConversationServer>> | undefined
  let conversationB: Awaited<ReturnType<typeof startConversationServer>> | undefined

  function events(): z.infer<typeof eventSchema>[] {
    return readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const value = safeJsonParse(line, decodeWithSchema(eventSchema))
        assert.ok(value)
        return value
      })
  }
  async function settled(project: string, count: number): Promise<string> {
    let id = ''
    await browser.waitUntil(
      async () => {
        const ids = runIds(project)
        assert.ok(ids.length <= 1, 'An automation must not be replayed')
        const candidate = ids[0]
        if (!candidate || metadata(project, candidate).status !== 'idle') return false
        const thread = (await loadProjectThreads(project)).find((entry) => entry.id === candidate)
        const tools = thread?.messages.flatMap((message) => message.toolCalls) ?? []
        if (
          tools.length !== count ||
          tools.some((tool) => tool.status !== 'done' || tool.result === null)
        )
          return false
        id = candidate
        return true
      },
      { timeout: 30_000, timeoutMsg: 'The original MCP automation did not complete successfully' },
    )
    return id
  }

  before(async () => {
    resetUserData()
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    const base = dirname(worktrees)
    rootA = join(base, 'mcp-project-a')
    rootB = join(base, 'mcp-project-b')
    trace = join(base, 'mcp-navigation-trace.jsonl')
    writeFileSync(trace, '')
    for (const root of [rootA, rootB]) {
      mkdirSync(root, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      writeFileSync(join(root, 'README.md'), 'Verify this workspace before reporting success.\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync(
        'git',
        [
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Copse E2E',
          '-c',
          'user.email=e2e@example.invalid',
          'commit',
          '-qm',
          'seed',
        ],
        { cwd: root },
      )
    }
    conversationA = await startConversationServer({ title: 'Report workspace' })
    conversationB = await startConversationServer({ title: 'Report workspace' })
    conversationA.enqueue(
      { user: PROMPT_A, text: '', toolCalls: [{ name: TOOL, args: { hold: true } }] },
      {
        user: PROMPT_A,
        toolResults: [{ name: TOOL, includes: rootA }],
        text: '',
        toolCalls: [{ name: TOOL, args: {} }],
      },
      { user: PROMPT_A, toolResults: [{ name: TOOL, includes: rootA }], text: FINAL_A },
    )
    conversationB.enqueue(
      { user: PROMPT_B, text: '', toolCalls: [{ name: TOOL, args: {} }] },
      { user: PROMPT_B, toolResults: [{ name: TOOL, includes: rootB }], text: FINAL_B },
    )
    conversationA.configureEnvironment({ COPSE_E2E_SECRET_STORAGE: 'unavailable' })
    seedUserMcpConfig({
      owned: {
        command: process.execPath,
        args: [join(process.cwd(), 'tests/fixtures/mcp-owned-workspace.mjs')],
        env: { MCP_LIFETIME_TRACE: trace },
      },
    })
    const modelA = 'navigation-a:chat'
    const modelB = 'navigation-b:chat'
    const schedules = [
      { id: 'check-a', projectId: A, name: 'Check project A', prompt: PROMPT_A, model: modelA },
      { id: 'check-b', projectId: B, name: 'Check project B', prompt: PROMPT_B, model: modelB },
    ].map((schedule) => ({
      ...schedule,
      cron: '* * * * *',
      enabled: false,
      permissions: [{ kind: 'mcp-tool', toolName: TOOL }],
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    }))
    writeSeedConfig({
      projects: [
        { id: A, path: rootA, name: 'Project A' },
        { id: B, path: rootB, name: 'Project B' },
      ],
      activeProjectId: A,
      activeThreadId: 'notes-a',
      [`threads:${A}`]: [
        {
          id: 'notes-a',
          title: 'Project notes',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        },
      ],
      [`threads:${B}`]: [
        {
          id: 'notes-b',
          title: 'Project notes',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        },
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: { copse: { automations: { storage: schedules } } },
    })
    seedE2eViewport(
      { width: 1280, height: 800 },
      {
        ...conversationA.settings,
        model: modelA,
        smallTasksModel: 'navigation-a:titles',
        extraProviders: [
          ...conversationA.settings.extraProviders.map((provider) => ({
            ...provider,
            slug: 'navigation-a',
          })),
          ...conversationB.settings.extraProviders.map((provider) => ({
            ...provider,
            slug: 'navigation-b',
          })),
        ],
      },
    )
    await browser.reloadSession()
  })

  after(async () => {
    if (rootA && existsSync(rootA)) writeFileSync(join(rootA, 'mcp.release'), '')
    await conversationB?.close()
    await conversationA?.close()
    resetUserMcpConfig()
    resetUserData()
  })

  it('preserves both A calls across the real project switch and uses B for its next run', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.api.mcp.list())).some(
          (server) => server.name === 'owned' && server.state === 'connected',
        ),
      { timeout: 30_000 },
    )
    await runNow(A, 'Check project A')
    await browser.waitUntil(
      () => events().some((event) => event.type === 'entered' && event.workspace === rootA),
      { timeout: 30_000 },
    )
    const first = events().find((event) => event.type === 'entered')
    assert.ok(first)
    assert.equal(first.workspace, rootA)
    assert.equal(first.call, 1)
    assert.equal(existsSync(join(rootA, 'mcp.release')), false)
    await $(`.project-entry[data-project-id="${B}"] .project-row`).click()
    await browser.waitUntil(
      () => events().some((event) => event.type === 'started' && event.workspace === rootB),
      { timeout: 15_000 },
    )
    // The actual registered workspace handler has loaded B. A's original child
    // is still alive and has not produced a response or replayed its call.
    process.kill(first.pid, 0)
    assert.equal(events().filter((event) => event.type === 'entered').length, 1)
    writeFileSync(join(rootA, 'mcp.release'), '')
    const idA = await settled(A, 2)
    assert.ok(conversationA)
    conversationA.assertComplete()
    await runNow(B, 'Check project B')
    const idB = await settled(B, 1)
    assert.ok(conversationB)
    conversationB.assertComplete()
    const calls = events().filter((event) => event.type === 'entered')
    assert.deepEqual(
      calls.map((event) => event.workspace),
      [rootA, rootA, rootB],
    )
    assert.equal(calls[0]?.pid, calls[1]?.pid, 'Both A calls use the original protocol session')
    assert.notEqual(calls[0]?.pid, calls[2]?.pid)
    assert.deepEqual(
      calls.map((event) => event.call),
      [1, 2, 1],
    )
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/mcp-project-navigation')
    mkdirSync(artifacts, { recursive: true })
    const spines: Array<{ project: string; id: string; sha256: string; directory: string }> = []
    const files: Array<{ path: string; sha256?: string; bytes?: number; symlink?: string }> = []
    function inventory(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          files.push({ path: relative(artifacts, path), symlink: readlinkSync(path) })
        } else if (entry.isDirectory()) {
          inventory(path)
        } else if (entry.isFile()) {
          const bytes = readFileSync(path)
          files.push({
            path: relative(artifacts, path),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
          })
        } else {
          assert.fail(`Unexpected owned thread entry: ${entry.name}`)
        }
      }
    }
    const receipt = {
      idA,
      idB,
      rootA,
      rootB,
      firstPidSurvivedNavigation: true,
      events: events(),
      spines,
      files,
    }
    // Preserve the complete owning proof before navigation/capture readiness.
    // A later layout failure must not discard either successful tool history.
    for (const [project, id] of [
      [A, idA],
      [B, idB],
    ] as const) {
      const threadRoot = join(e2eWorkspaceDir(), project, id)
      const directory = join('threads', project, id)
      const exported = join(artifacts, directory)
      cpSync(threadRoot, exported, { recursive: true, dereference: false, verbatimSymlinks: true })
      inventory(exported)
      const spine = readFileSync(join(threadRoot, 'events.jsonl'))
      writeFileSync(join(artifacts, `${project}-events.jsonl`), spine)
      writeFileSync(
        join(artifacts, `${project}-meta.json`),
        readFileSync(join(threadRoot, 'meta.json')),
      )
      receipt.spines.push({
        project,
        id,
        sha256: createHash('sha256').update(spine).digest('hex'),
        directory,
      })
    }
    writeFileSync(join(artifacts, 'trace.jsonl'), readFileSync(trace))
    writeFileSync(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    for (const [project, id, expectedText, count, shot] of [
      [A, idA, FINAL_A, 2, 'mcp-navigation-original-project.png'],
      [B, idB, FINAL_B, 1, 'mcp-navigation-selected-project.png'],
    ] as const) {
      const branchPrefix = project === A ? 'copse/check-project-a-' : 'copse/check-project-b-'
      await browser.waitUntil(
        () => metadata(project, id).worktree?.branch.startsWith(branchPrefix) === true,
        { timeout: 15_000 },
      )
      await openRun(project, id)
      await browser.waitUntil(
        async () => {
          const navigation = await browser.execute(() => window.api.windowState.getNavigation())
          return navigation.activeProjectId === project && navigation.activeThreadId === id
        },
        { timeout: 10_000, timeoutMsg: 'The run did not select its owning project and thread' },
      )
      assert.equal(
        await browser.execute(() => window.api.workspace.get()),
        project === A ? rootA : rootB,
      )
      await expect($(`.chat-row[data-thread-id="${id}"]`)).toHaveElementClass('selected')
      await expect($('.messages-list')).toHaveText(expect.stringContaining(expectedText))
      await $('.stop-btn').waitForDisplayed({ reverse: true, timeout: 10_000 })
      assert.equal((await $$('.messages-list [data-tool-id][data-status="done"]')).length, count)
      assert.equal((await $$('.messages-list [data-tool-id][data-status="error"]')).length, 0)
      const rollup = $('.messages-list .tool-card-rollup')
      if (await rollup.isExisting()) {
        await expect(rollup.$('.tool-card-header .tool-name')).toHaveText('Report workspace')
      }
      for (const selector of ['.tool-card-rollup', '.tool-card-group']) {
        for (const details of await $$(`.messages-list ${selector}`)) {
          if ((await details.getAttribute('open')) === null) await details.$('summary').click()
        }
      }
      const branch = metadata(project, id).worktree?.branch
      assert.ok(branch)
      await expect($(`.chat-row[data-thread-id="${id}"] .chat-title`)).toHaveText(
        project === A ? 'Check project A' : 'Check project B',
      )
      await expect($('.footer-branch-label')).toHaveText(branch)
      const restoreBranch = await pinTextForCapture(
        '.footer-branch-label',
        /^copse\/[a-z0-9-]+-[a-f0-9]+$/,
        branch.replace(/-[^-]+$/, '-000001'),
      )
      await $('.toast').waitForExist({ reverse: true, timeout: 10_000 })
      await parkPointer()
      await observeAutomationGitCapture(
        'before-capture',
        shot,
        'tests/e2e/mcp-project-navigation.e2e.ts',
        [
          { projectId: A, threadId: idA },
          { projectId: B, threadId: idB },
        ],
      )
      await saveAppScreenshot(shot)
      await observeAutomationGitCapture(
        'after-capture',
        shot,
        'tests/e2e/mcp-project-navigation.e2e.ts',
        [
          { projectId: A, threadId: idA },
          { projectId: B, threadId: idB },
        ],
      )
      await restoreBranch()
    }
  })
})
