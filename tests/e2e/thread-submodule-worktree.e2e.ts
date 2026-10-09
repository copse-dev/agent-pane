import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'

const PROJECT = 'e2e-submodule-worktree'
const THREAD = 'e2e-submodule-worktree-thread'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'Copse E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
    },
  }).trim()
}

function commit(repo: string, path: string, content: string, message: string): void {
  writeFileSync(join(repo, path), content)
  git(repo, ['add', '.'])
  git(repo, ['-c', 'commit.gpgSign=false', 'commit', '-qm', message])
}

/**
 * A project that declares a submodule used to be refused an isolated worktree
 * ("submodules unsupported") and silently fell back to the shared checkout.
 * It now gets one, with the submodule the project has initialised checked out.
 */
describe('thread worktree with submodules', () => {
  let fixtureRoot = ''
  let root = ''
  let worktree = ''

  before(async function () {
    this.timeout(120_000)
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktreesRoot, 'native fixture requires the isolated worktree root')
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'copse-submodule-worktree-')))
    const upstream = join(fixtureRoot, 'lib')
    root = join(fixtureRoot, 'submodule-project')
    mkdirSync(upstream)
    mkdirSync(root)
    worktree = join(worktreesRoot, PROJECT, THREAD)
    rmSync(worktree, { recursive: true, force: true })
    git(upstream, ['init', '-q', '-b', 'main'])
    commit(upstream, 'lib.txt', 'Vendored library fixture\n', 'library')
    git(root, ['init', '-q', '-b', 'main'])
    commit(root, 'README.md', 'Submodule project fixture\n', 'initial')
    git(root, ['submodule', 'add', '-q', upstream, 'vendor/lib'])
    git(root, ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'add submodule'])
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'Submodule project', worktreeMode: 'always' }],
      activeProjectId: PROJECT,
      expandedProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'New chat',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    // Real Git and real checkout IPC; only inference and GitHub are fixture dependencies.
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
    if (root && existsSync(worktree)) git(root, ['worktree', 'remove', '--force', worktree])
    if (fixtureRoot)
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('previews and allocates an isolated worktree with the submodule checked out', async function () {
    this.timeout(120_000)
    // The automatic policy is previewed before the first send. A repository
    // with submodules previously previewed (and got) the shared checkout.
    await expect($('.footer-checkout-btn')).toHaveText('Isolated worktree', { wait: 15_000 })
    await saveAppScreenshot('thread-submodule-worktree-composer.png')

    const reply = 'The vendored library is checked out in this thread.'
    const scenario = await prepareMockToolTurn(
      'Read the vendored library.',
      { name: 'read_file', args: { path: 'vendor/lib/lib.txt' } },
      reply,
    )
    await $('.submit-btn').click()
    await expectAssistantReply(reply)
    await scenario.assertComplete()

    assert.equal(
      readFileSync(join(worktree, 'vendor', 'lib', 'lib.txt'), 'utf8'),
      'Vendored library fixture\n',
    )
    assert.match(readFileSync(join(worktree, 'vendor', 'lib', '.git'), 'utf8'), /worktrees/)
    assert.equal(git(root, ['branch', '--show-current']), 'main', 'project checkout untouched')
    await saveAppScreenshot('thread-submodule-worktree-sent.png')
  })
})
