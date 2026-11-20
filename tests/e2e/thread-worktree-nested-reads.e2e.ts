import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { e2eWorkspaceDir, resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT = 'e2e-nested-read-project'
const THREAD = 'nested-app-review'
const BRANCH = 'copse/nested-app-review'
const metaSchema = z.object({
  worktree: z.object({
    path: z.string(),
    branch: z.string(),
    baseBranch: z.string(),
    baseCommit: z.string(),
    createdAt: z.number(),
    seededFromDirtyProject: z.boolean(),
  }),
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

describe('passive reads for a project inside an isolated monorepo checkout', function () {
  this.timeout(90_000)
  let repository = ''
  let checkout = ''
  let oldLink = ''

  before(async () => {
    resetUserData()
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    repository = join(dirname(worktrees), 'nested-read-repository')
    const projectRoot = join(repository, 'packages', 'app')
    mkdirSync(projectRoot, { recursive: true })
    git(repository, ['init', '-q', '-b', 'main'])
    git(repository, ['config', 'user.name', 'Copse E2E'])
    git(repository, ['config', 'user.email', 'e2e@example.invalid'])
    writeFileSync(join(repository, 'README.md'), '# Repository root\n')
    writeFileSync(join(repository, 'root-only.md'), '# Outside the app\n')
    writeFileSync(join(projectRoot, 'README.md'), '# Shared app\n')
    writeFileSync(join(projectRoot, 'app-only.md'), '# Application files\n')
    git(repository, ['add', '.'])
    git(repository, ['commit', '-qm', 'nested app'])
    const baseCommit = git(repository, ['rev-parse', 'HEAD'])
    checkout = join(worktrees, PROJECT, THREAD)
    mkdirSync(dirname(checkout), { recursive: true })
    git(repository, ['worktree', 'add', '-q', '-b', BRANCH, checkout, 'main'])
    writeFileSync(
      join(checkout, 'packages', 'app', 'README.md'),
      '# Isolated app\n\nThese notes belong to this app checkout.\n',
    )
    oldLink = join(worktrees, PROJECT, 'earlier-run', 'packages', 'app', 'README.md')
    const now = 1_790_000_000_000
    writeSeedConfig({
      projects: [{ id: PROJECT, path: projectRoot, name: 'Application project' }],
      activeProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Review the application',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          draftPrompt: 'Keep this app review unsent.',
          messages: [
            {
              id: 'nested-notes',
              role: 'assistant',
              content: `Review [the application notes](${oldLink}).`,
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          gitBranch: BRANCH,
          worktreeChoice: 'worktree',
          worktree: {
            path: checkout,
            branch: BRANCH,
            baseBranch: 'main',
            baseCommit,
            createdAt: now,
            seededFromDirtyProject: false,
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($(`.chat-row[data-thread-id="${THREAD}"]`)).toHaveElementClass('selected')
  })

  after(() => {
    resetUserData()
    if (repository) {
      if (checkout && existsSync(join(checkout, '.git'))) {
        git(repository, ['worktree', 'remove', '--force', checkout])
      }
      removeE2eTree(repository)
    }
  })

  it('lists, links and previews only the nested project in its active checkout', async () => {
    const threadRoot = join(e2eWorkspaceDir(), PROJECT, THREAD)
    const before = readFileSync(join(threadRoot, 'meta.json'), 'utf8')
    const spine = readFileSync(join(threadRoot, 'events.jsonl'), 'utf8')
    if (!(await $('#pane-files').isDisplayed()))
      await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    await expect($('.file-tree .tree-row[title="app-only.md"]')).toBeDisplayed()
    await expect($('.file-tree .tree-row[title="root-only.md"]')).not.toExist()
    await expect($('.file-tree .tree-row[title="packages"]')).not.toExist()
    const links = await browser.execute(
      async (input) =>
        window.api.index.resolveFileReferences([input.oldLink], {
          projectId: input.project,
          threadId: input.thread,
        }),
      { project: PROJECT, thread: THREAD, oldLink },
    )
    assert.deepEqual(links, [{ candidate: oldLink, path: 'README.md', kind: 'file' }])
    await $('.file-tree .tree-row[title="README.md"]').click()
    await expect($('.markdown-file-preview')).toHaveText(expect.stringContaining('Isolated app'))
    await expect($('.markdown-file-preview')).toHaveText(
      expect.stringContaining('These notes belong to this app checkout.'),
    )
    await expect($('.markdown-file-preview')).not.toHaveText(
      expect.stringContaining('Repository root'),
    )
    await expect($('.markdown-file-preview')).not.toHaveText(expect.stringContaining('Shared app'))
    await expect($('.prompt-input')).toHaveText('Keep this app review unsent.')
    await browser.execute(
      async (input) => window.api.fs.watch(input.project, input.thread, 'README.md'),
      { project: PROJECT, thread: THREAD },
    )
    writeFileSync(
      join(checkout, 'packages', 'app', 'README.md'),
      '# Isolated app\n\nThe app file changed in the same checkout.\n',
    )
    await expect($('.markdown-file-preview')).toHaveText(
      expect.stringContaining('The app file changed in the same checkout.'),
    )
    const after = readFileSync(join(threadRoot, 'meta.json'), 'utf8')
    const initial = safeJsonParse(before, decodeWithSchema(metaSchema))
    const current = safeJsonParse(after, decodeWithSchema(metaSchema))
    assert.ok(initial && current)
    assert.deepEqual(current.worktree, initial.worktree)
    assert.equal(readFileSync(join(threadRoot, 'events.jsonl'), 'utf8'), spine)
    const artifacts = join(process.cwd(), '.tmp', 'nested-read-native-artifacts')
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify({ before, after, spine, links }, null, 2),
    )
    await parkPointer()
    await saveAppScreenshot('thread-worktree-nested-read-root.png')
  })
})
