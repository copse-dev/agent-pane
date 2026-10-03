import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { prepareClassifierCache, type ServerSpec } from './serve-local-classifier.mts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('persistent classifier cache', () => {
  const roots: string[] = []
  const originalCache = process.env['COPSE_CLASSIFIER_CACHE']

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    if (originalCache === undefined) delete process.env['COPSE_CLASSIFIER_CACHE']
    else process.env['COPSE_CLASSIFIER_CACHE'] = originalCache
  })

  it('returns an existing checkout to the exact pinned revision before setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-classifier-cache-'))
    roots.push(root)
    const repository = join(root, 'repository')
    mkdirSync(repository)
    git(repository, 'init', '--initial-branch=main')
    git(repository, 'config', 'user.email', 'test@example.com')
    git(repository, 'config', 'user.name', 'Test')
    writeFileSync(join(repository, 'version.txt'), 'pinned\n')
    git(repository, 'add', 'version.txt')
    git(repository, 'commit', '-m', 'pinned')
    const pinned = git(repository, 'rev-parse', 'HEAD')
    writeFileSync(join(repository, 'version.txt'), 'new default\n')
    git(repository, 'commit', '-am', 'new default')
    const latest = git(repository, 'rev-parse', 'HEAD')

    process.env['COPSE_CLASSIFIER_CACHE'] = join(root, 'cache')
    const checkout = join(root, 'cache', 'fixture', pinned)
    mkdirSync(join(root, 'cache', 'fixture'), { recursive: true })
    git(join(root, 'cache', 'fixture'), 'clone', '--quiet', repository, checkout)
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), latest)
    const marker = join(checkout, '.copse-setup-complete')
    writeFileSync(marker, 'legacy marker from the wrong revision\n')

    const spec: ServerSpec = {
      repository,
      revision: pinned,
      setup: () => [],
      serve: () => [],
      port: 1,
    }
    await prepareClassifierCache('fixture', spec)
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), pinned)
    assert.equal(
      readFileSync(marker, 'utf8'),
      `${JSON.stringify({ version: 1, repository, revision: pinned })}\n`,
    )
  })

  it('refuses tracked modifications in a managed checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-classifier-cache-'))
    roots.push(root)
    const repository = join(root, 'repository')
    mkdirSync(repository)
    git(repository, 'init', '--initial-branch=main')
    git(repository, 'config', 'user.email', 'test@example.com')
    git(repository, 'config', 'user.name', 'Test')
    writeFileSync(join(repository, 'server.ts'), 'export const pinned = true\n')
    git(repository, 'add', 'server.ts')
    git(repository, 'commit', '-m', 'pinned')
    const pinned = git(repository, 'rev-parse', 'HEAD')

    process.env['COPSE_CLASSIFIER_CACHE'] = join(root, 'cache')
    const checkout = join(root, 'cache', 'fixture', pinned)
    mkdirSync(join(root, 'cache', 'fixture'), { recursive: true })
    git(join(root, 'cache', 'fixture'), 'clone', '--quiet', repository, checkout)
    writeFileSync(join(checkout, 'server.ts'), 'export const pinned = false\n')

    const spec: ServerSpec = {
      repository,
      revision: pinned,
      setup: () => [],
      serve: () => [],
      port: 1,
    }
    await assert.rejects(
      prepareClassifierCache('fixture', spec),
      /tracked modifications; refusing to run unpinned code/u,
    )
  })
})
