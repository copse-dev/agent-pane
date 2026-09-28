import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

  it('returns an existing checkout to the exact pinned revision before setup', () => {
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

    const spec: ServerSpec = {
      repository,
      revision: pinned,
      setup: () => [],
      serve: () => [],
      port: 1,
    }
    prepareClassifierCache('fixture', spec)
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), pinned)
  })
})
