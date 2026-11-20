import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localPromptCommitIds } from './pii-git-references.ts'
import {
  redactUserContent,
  setRampartLoaderForTest,
  type PiiGuard,
  type RampartModule,
} from './pii-redactor.ts'
import {
  getDefaultPluginRegistry,
  setDefaultPluginRegistry,
} from '@copse/agent/plugins/default-plugin-registry.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { gitShowTool } from '../../tools/git-tools.ts'
import { runWithWorkspaceRoot } from '../workspace.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  setRampartLoaderForTest(null)
  setDefaultPluginRegistry(null)
  setGitAvailableForTest(null)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('keeps only full SHAs that resolve to local commits', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-pii-git-ref-')))
  cleanups.push(async () => rm(repo, { recursive: true, force: true }))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Copse Test')
  git('config', 'user.email', 'copse@example.invalid')
  git('config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'note.txt'), 'first\n')
  git('add', 'note.txt')
  git('commit', '-qm', 'first')
  const target = git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'note.txt'), 'second\n')
  git('commit', '-qam', 'second')

  const unknown = 'a'.repeat(40)
  assert.deepEqual(
    await localPromptCommitIds(
      `Inspect ${target}; ignore ${unknown}, ${target.slice(0, 12)}, and ${target}@example.invalid.`,
      repo,
    ),
    [target],
  )
  assert.deepEqual(await localPromptCommitIds(`Contact ${target}@example.invalid.`, repo), [])

  const prompt = `Inspect commit ${target}.`
  const preserved = await localPromptCommitIds(prompt, repo)
  assert.deepEqual(preserved, [target])

  const token = '[DRIVERS_LICENSE_TEST_1]'
  const guard: PiiGuard = {
    protect: (text) =>
      Promise.resolve({
        text: text.split(target).join(token),
        placeholders: text.includes(target) ? [token] : [],
      }),
    reveal: (text) => text.split(token).join(target),
  }
  const module: RampartModule = {
    createGuard: () => Promise.resolve(guard),
    detectHeuristics: () => [],
  }
  setRampartLoaderForTest(() => Promise.resolve(module))
  setDefaultPluginRegistry(createFirstPartyPluginRegistry())
  assert.equal(getDefaultPluginRegistry().isEnabled('copse.pii-redaction'), true)
  const redacted = await redactUserContent('git-revision-thread', prompt, {
    preserveExact: preserved,
  })
  assert.equal(redacted.content, prompt)
  setGitAvailableForTest(true)
  const shown = await runWithWorkspaceRoot(repo, () =>
    gitShowTool.execute({ ref: target }, new AbortController().signal),
  )
  if (typeof shown !== 'string') assert.fail('git_show returned a non-text result')
  assert.match(shown, /first/)
})

it('rejects replacement objects and 40-hex refs that are not the named commit object', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-pii-git-object-')))
  cleanups.push(async () => rm(repo, { recursive: true, force: true }))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Copse Test')
  git('config', 'user.email', 'copse@example.invalid')
  git('config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'note.txt'), 'commit\n')
  git('add', 'note.txt')
  git('commit', '-qm', 'commit')
  const commit = git('rev-parse', 'HEAD')
  const blob = git('hash-object', 'note.txt')
  git('update-ref', `refs/replace/${blob}`, commit)
  const alias = 'b'.repeat(40)
  git('update-ref', `refs/heads/${alias}`, commit)

  assert.deepEqual(await localPromptCommitIds(`Inspect ${blob} and ${alias}.`, repo), [])
})

it('does not follow inherited repository or object-store redirects', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-pii-git-root-')))
  const other = await realpath(await mkdtemp(join(tmpdir(), 'copse-pii-git-other-')))
  cleanups.push(async () => rm(repo, { recursive: true, force: true }))
  cleanups.push(async () => rm(other, { recursive: true, force: true }))
  const init = async (root: string, text: string): Promise<string> => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse Test')
    git('config', 'user.email', 'copse@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    await writeFile(join(root, 'note.txt'), text)
    git('add', 'note.txt')
    git('commit', '-qm', text)
    return git('rev-parse', 'HEAD')
  }
  await init(repo, 'local')
  const otherCommit = await init(other, 'other')
  const previous = {
    GIT_DIR: process.env['GIT_DIR'],
    GIT_WORK_TREE: process.env['GIT_WORK_TREE'],
    GIT_NAMESPACE: process.env['GIT_NAMESPACE'],
    GIT_OBJECT_DIRECTORY: process.env['GIT_OBJECT_DIRECTORY'],
    GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'],
    GIT_CONFIG_COUNT: process.env['GIT_CONFIG_COUNT'],
    GIT_CONFIG_KEY_0: process.env['GIT_CONFIG_KEY_0'],
    GIT_CONFIG_VALUE_0: process.env['GIT_CONFIG_VALUE_0'],
  }
  cleanups.push(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })
  process.env['GIT_DIR'] = join(other, '.git')
  process.env['GIT_WORK_TREE'] = other
  process.env['GIT_NAMESPACE'] = 'redirected'
  process.env['GIT_OBJECT_DIRECTORY'] = join(other, '.git', 'objects')
  process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = join(other, '.git', 'objects')
  process.env['GIT_CONFIG_COUNT'] = '1'
  process.env['GIT_CONFIG_KEY_0'] = 'core.worktree'
  process.env['GIT_CONFIG_VALUE_0'] = other

  assert.deepEqual(await localPromptCommitIds(`Inspect ${otherCommit}.`, repo), [])
})

it('does not lazily fetch a missing commit from a promisor remote', async () => {
  const origin = await realpath(await mkdtemp(join(tmpdir(), 'copse-pii-git-origin-')))
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-pii-git-promisor-')))
  cleanups.push(async () => rm(origin, { recursive: true, force: true }))
  cleanups.push(async () => rm(repo, { recursive: true, force: true }))
  const git = (root: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.name', 'Copse Test')
  git(origin, 'config', 'user.email', 'copse@example.invalid')
  git(origin, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(origin, 'note.txt'), 'remote-only\n')
  git(origin, 'add', 'note.txt')
  git(origin, 'commit', '-qm', 'remote-only')
  const remoteCommit = git(origin, 'rev-parse', 'HEAD')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'remote.origin.url', `file://${origin}`)
  git(repo, 'config', 'remote.origin.promisor', 'true')
  git(repo, 'config', 'remote.origin.partialclonefilter', 'blob:none')
  git(repo, 'config', 'extensions.partialClone', 'origin')

  assert.deepEqual(await localPromptCommitIds(`Inspect ${remoteCommit}.`, repo), [])
  assert.throws(() =>
    execFileSync('git', ['cat-file', '-e', remoteCommit], {
      cwd: repo,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      stdio: 'ignore',
    }),
  )
})

it('does not probe without an active repository root', async () => {
  assert.deepEqual(await localPromptCommitIds(`Inspect ${'b'.repeat(40)}.`, null), [])
})
