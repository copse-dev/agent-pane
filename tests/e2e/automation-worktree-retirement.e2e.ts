import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT = 'e2e-automation-worktree-retirement'
const SCHEDULE = 'finished-checks'
const CHAT = 'retirement-planning'
const RUNS = ['finished-check-latest', 'finished-check-previous']
const WHEN = 1_790_000_000_000
const DRAFT = 'Keep this unsent release note.'
const GROUP = `.automation-schedule-group[data-schedule-id="${SCHEDULE}"]`
const metaSchema = z.object({
  title: z.string(),
  draftPrompt: z.string().optional(),
  worktree: z.object({
    path: z.string(),
    branch: z.string(),
    baseBranch: z.string(),
    baseCommit: z.string(),
    createdAt: z.number(),
    seededFromDirtyProject: z.boolean(),
    retiredAt: z.number().optional(),
  }),
})

function git(cwd: string, args: string[]): string {
  // Only this private fixture invocation bypasses host commit signing.
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function meta(id: string): z.infer<typeof metaSchema> {
  const parsed = safeJsonParse(
    readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json'), 'utf8'),
    decodeWithSchema(metaSchema),
  )
  assert.ok(parsed, `invalid metadata for ${id}`)
  return parsed
}

describe('finished automation worktree retirement survives stale renderer metadata', function () {
  this.timeout(90_000)
  let projectRoot = ''
  const checkouts = new Map<string, string>()

  before(async () => {
    resetUserData()
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    projectRoot = join(dirname(worktrees), 'automation-retirement-project')
    removeE2eTree(projectRoot)
    removeE2eTree(join(worktrees, PROJECT))
    mkdirSync(projectRoot, { recursive: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    writeFileSync(join(projectRoot, 'README.md'), 'Finished checks.\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])
    const baseCommit = git(projectRoot, ['rev-parse', 'HEAD'])
    const runs = RUNS.map((id, index) => {
      const path = join(worktrees, PROJECT, id)
      const branch = `copse/${id}`
      mkdirSync(dirname(path), { recursive: true })
      git(projectRoot, ['worktree', 'add', '-q', '-b', branch, path, 'main'])
      checkouts.set(id, path)
      const triggeredAt = WHEN - index * 60_000
      return {
        id,
        title: 'Release check',
        status: 'idle',
        currentEpoch: `completed-${id}`,
        draftPrompt: '',
        automation: { scheduleId: SCHEDULE, scheduleName: 'Release check', triggeredAt },
        messages: [
          {
            id: `${id}-request`,
            role: 'user',
            content: 'Check the release.',
            createdAt: triggeredAt,
          },
          {
            id: `${id}-answer`,
            role: 'assistant',
            content: 'The release check finished. No changes were needed.',
            createdAt: triggeredAt + 1_000,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        worktreeChoice: 'worktree',
        gitBranch: branch,
        worktree: {
          path,
          branch,
          baseBranch: 'main',
          baseCommit,
          createdAt: triggeredAt,
          seededFromDirtyProject: false,
        },
        createdAt: triggeredAt,
        updatedAt: triggeredAt + 1_000,
      }
    })
    writeSettings({ autoArchiveAfterDays: 0 })
    writeSeedConfig({
      projects: [{ id: PROJECT, path: projectRoot, name: 'Release project' }],
      activeProjectId: PROJECT,
      expandedProjectId: PROJECT,
      activeThreadId: CHAT,
      [`threads:${PROJECT}`]: [
        {
          id: CHAT,
          title: 'Release planning',
          status: 'idle',
          draftPrompt: DRAFT,
          messages: [
            {
              id: 'planning-request',
              role: 'user',
              content: 'Keep the release notes ready while the checks finish.',
              createdAt: WHEN + 2_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: WHEN + 2_000,
          updatedAt: WHEN + 2_000,
        },
        ...runs,
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE,
                projectId: PROJECT,
                name: 'Release check',
                cron: '0 0 1 1 *',
                prompt: 'Check the release.',
                model: 'claude-sonnet-4-6',
                enabled: false,
                maxLiveWorktrees: 2,
                createdAt: WHEN,
                updatedAt: WHEN,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    for (const path of checkouts.values()) {
      if (!existsSync(path)) continue
      git(projectRoot, ['worktree', 'remove', '--force', path])
    }
    if (projectRoot) removeE2eTree(projectRoot)
  })

  it('keeps cleanup durable while its historical chat is selected, including passive Git reads and reload', async () => {
    await $('.automation-threads-toggle').click()
    await expect($(`${GROUP} .automation-schedule-held`)).toHaveText('2 held')
    await expect($('.prompt-input')).toHaveText(DRAFT)
    const stale = RUNS.map((id) => {
      const { retiredAt, ...worktree } = meta(id).worktree
      assert.equal(retiredAt, undefined)
      return { id, worktree }
    })
    const spine = RUNS.map((id) =>
      readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl'), 'utf8'),
    )
    await parkPointer()
    await saveAppScreenshot('automation-worktree-retirement-held.png')

    const selectedRun = RUNS[0]
    assert.ok(selectedRun)
    await $(`${GROUP} .automation-schedule-toggle`).click()
    await $(`.chat-row[data-thread-id="${selectedRun}"]`).click()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('The release check finished. No changes were needed.'),
    )

    await $(`${GROUP} .automation-schedule-toggle`).click({ button: 'right' })
    await $('.context-menu-item=Clean up finished runs…').click()
    await expect($('.toast')).toHaveText(expect.stringContaining('Freed 2 worktrees'))
    await expect($(`${GROUP} .automation-schedule-held`)).not.toExist()
    for (const id of RUNS) {
      assert.ok(meta(id).worktree.retiredAt)
      const path = checkouts.get(id)
      assert.ok(path)
      assert.equal(existsSync(path), false)
    }
    const passiveGit = await browser.execute(
      async (input) => {
        const [branch, status, branchStatus, available] = await Promise.all([
          window.api.git.currentBranch(input.projectId, input.threadId),
          window.api.git.status(input.projectId, input.threadId),
          window.api.git.branchStatus(input.projectId, input.threadId),
          window.api.git.isAvailable(input.projectId, input.threadId),
        ])
        return { branch, status, branchStatus, available }
      },
      { projectId: PROJECT, threadId: selectedRun },
    )
    assert.deepEqual(passiveGit, {
      branch: null,
      status: null,
      branchStatus: { currentBranch: null, pr: null },
      available: false,
    })
    const passiveReads = await browser.execute(
      async (input) => {
        const owner = { projectId: input.projectId, threadId: input.threadId }
        const errors: string[] = []
        for (const read of [
          (): Promise<unknown> => window.api.fs.listDir(owner.projectId, owner.threadId, ''),
          (): Promise<unknown> => window.api.fs.readdir(owner.projectId, owner.threadId, ''),
          (): Promise<unknown> =>
            window.api.fs.readFile(owner.projectId, owner.threadId, 'README.md'),
          (): Promise<unknown> =>
            window.api.fs.readImage(owner.projectId, owner.threadId, 'README.md'),
        ]) {
          try {
            await read()
            errors.push('unexpected success')
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
        }
        await window.api.fs.watch(owner.projectId, owner.threadId, 'README.md')
        await window.api.fs.unwatch(owner.projectId, owner.threadId, 'README.md')
        return {
          errors,
          links: await window.api.index.resolveFileReferences(['README.md'], owner),
        }
      },
      { projectId: PROJECT, threadId: selectedRun },
    )
    assert.equal(passiveReads.errors.length, 4)
    for (const error of passiveReads.errors) assert.match(error, /Checkout unavailable/)
    assert.deepEqual(passiveReads.links, [])
    await expect($(`.chat-row[data-thread-id="${selectedRun}"]`)).toHaveElementClass('selected')
    for (const id of RUNS) {
      assert.ok(meta(id).worktree.retiredAt)
      const path = checkouts.get(id)
      assert.ok(path)
      assert.equal(existsSync(path), false)
    }
    await parkPointer()
    await saveAppScreenshot('automation-worktree-retirement-freed.png')
    await $(`.chat-row[data-thread-id="${CHAT}"]`).click()
    await expect($('.prompt-input')).toHaveText(DRAFT)

    // Real IPC, not an alternate test option: this is the stale checkout field
    // emitted by the delayed renderer producer covered by the controller test.
    await browser.execute(
      async (input) => {
        for (const thread of input.stale) {
          await window.api.threads.updateMeta(input.project, thread.id, {
            title: 'Release check reviewed',
            worktree: thread.worktree,
          })
        }
      },
      { project: PROJECT, stale },
    )
    const after = RUNS.map((id, index) => {
      const current = meta(id)
      assert.ok(current.worktree.retiredAt)
      assert.equal(current.title, 'Release check reviewed')
      assert.equal(
        readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl'), 'utf8'),
        spine[index],
      )
      return { id, ...current }
    })
    const artifacts = join(process.cwd(), '.tmp', 'automation-retirement-native-artifacts')
    mkdirSync(artifacts, { recursive: true })
    const rawMetadata = RUNS.map((id) => ({
      id,
      text: readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json'), 'utf8'),
    }))
    writeFileSync(
      join(artifacts, 'retirement.json'),
      JSON.stringify(
        { selectedRun, passiveGit, passiveReads, stale, after, rawMetadata, spine },
        null,
        2,
      ),
    )

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const reloaded = await browser.execute(
      async (input) => ({
        navigation: await window.api.windowState.getNavigation(),
        planning: (await window.api.threads.loadProject(input.project)).find(
          (thread) => thread.id === input.chat,
        ),
      }),
      { project: PROJECT, chat: CHAT },
    )
    assert.equal(reloaded.planning?.draftPrompt, DRAFT)
    await $(`.chat-row[data-thread-id="${CHAT}"]`).click()
    await expect($('.prompt-input')).toHaveText(DRAFT)
    const toggle = $('.automation-threads-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect($(GROUP)).toBeDisplayed()
    await expect($(`${GROUP} .automation-schedule-held`)).not.toExist()
    for (const id of RUNS) {
      assert.ok(meta(id).worktree.retiredAt)
      const path = checkouts.get(id)
      assert.ok(path)
      assert.equal(existsSync(path), false)
    }
    const scheduleToggle = $(`${GROUP} .automation-schedule-toggle`)
    if ((await scheduleToggle.getAttribute('aria-expanded')) === 'false')
      await scheduleToggle.click()
    await $(`.chat-row[data-thread-id="${selectedRun}"]`).click()
    if (!(await $('#pane-files').isDisplayed())) {
      await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    }
    await expect($('#file-tree-host')).toBeDisplayed()
    await expect($('.file-tree .sidebar-empty')).toHaveText(
      'Checkout unavailable. Resume this chat to restore it.',
    )
    await expect($('.file-tree .tree-row')).not.toExist()
    await parkPointer()
    await saveAppScreenshot('automation-worktree-retirement-unavailable.png')
    await $(`.chat-row[data-thread-id="${CHAT}"]`).click()
    await expect($('.prompt-input')).toHaveText(DRAFT)
    const final = RUNS.map((id, index) => {
      assert.ok(meta(id).worktree.retiredAt)
      const path = checkouts.get(id)
      assert.ok(path)
      assert.equal(existsSync(path), false)
      assert.equal(
        readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl'), 'utf8'),
        spine[index],
      )
      return { id, text: readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json'), 'utf8') }
    })
    writeFileSync(
      join(artifacts, 'retirement.json'),
      JSON.stringify(
        {
          selectedRun,
          passiveGit,
          passiveReads,
          stale,
          after,
          rawMetadata,
          spine,
          reloaded,
          final,
        },
        null,
        2,
      ),
    )
  })
})
