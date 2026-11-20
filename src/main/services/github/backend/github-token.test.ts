import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { resetGitHubApiTokenCacheForTest, resolveGitHubComToken } from './github-token.ts'

const TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
const SAVED_KEYS = [...TOKEN_KEYS, 'GH_HOST', 'PATH', 'COPSE_PRESERVE_PATH']

/**
 * The container runs' GitHub capability always sends its token to github.com
 * (A24). A fake `gh` on PATH records the environment and arguments it was
 * asked with, so a lookup that could answer for another server shows.
 */
describe('resolveGitHubComToken', { skip: process.platform === 'win32' }, () => {
  let bin = ''
  const saved: Record<string, string | undefined> = {}

  const calls = async (): Promise<string[]> => {
    const text = await readFile(join(bin, 'calls.log'), 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean)
  }

  before(async () => {
    bin = await realpath(await mkdtemp(join(tmpdir(), 'copse-gh-com-token-')))
    await writeFile(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `echo "GH_HOST=$GH_HOST GH_ENTERPRISE_TOKEN=$GH_ENTERPRISE_TOKEN $*" >> '${join(bin, 'calls.log')}'`,
        'echo "gh-token-for-${GH_HOST:-default}"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    for (const key of SAVED_KEYS) saved[key] = process.env[key]
    // Put the fake ahead of any real `gh` (the probe PATH otherwise leads with /usr/bin).
    process.env['COPSE_PRESERVE_PATH'] = '1'
    process.env['PATH'] = `${bin}:${saved['PATH'] ?? '/usr/bin:/bin'}`
  })

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    resetGitHubApiTokenCacheForTest()
    await rm(bin, { recursive: true, force: true })
  })

  beforeEach(async () => {
    for (const key of [...TOKEN_KEYS, 'GH_HOST']) Reflect.deleteProperty(process.env, key)
    resetGitHubApiTokenCacheForTest()
    await rm(join(bin, 'calls.log'), { force: true })
  })

  it('asks gh for github.com by name, never with an enterprise token or GH_HOST', async () => {
    process.env['GH_ENTERPRISE_TOKEN'] = 'enterprise-token'
    process.env['GITHUB_ENTERPRISE_TOKEN'] = 'enterprise-token'
    process.env['GH_HOST'] = 'ghe.example.test'
    assert.equal(await resolveGitHubComToken(), 'gh-token-for-default')
    assert.deepEqual(await calls(), [
      'GH_HOST= GH_ENTERPRISE_TOKEN= auth token --hostname github.com',
    ])
    // Cached after a successful lookup.
    assert.equal(await resolveGitHubComToken(), 'gh-token-for-default')
    assert.equal((await calls()).length, 1)
  })

  it('takes a github.com env token first, and no enterprise one', async () => {
    process.env['GH_ENTERPRISE_TOKEN'] = 'enterprise-token'
    process.env['GITHUB_TOKEN'] = 'github-com-token'
    assert.equal(await resolveGitHubComToken(), 'github-com-token')
    assert.deepEqual(await calls(), [])
  })
})
