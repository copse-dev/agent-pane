import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STARTER_AGENT_MD, scaffoldProject } from './project-scaffold.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('scaffoldProject', () => {
  let temp = ''

  beforeEach(async () => {
    temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-scaffold-')))
  })

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  it('commits the starter files so a new project has a clean tree', async () => {
    const project = join(temp, 'demo')
    await mkdir(project)

    await scaffoldProject(project, 'demo', true)

    assert.equal(await readFile(join(project, 'AGENT.md'), 'utf8'), STARTER_AGENT_MD)
    assert.equal(await readFile(join(project, 'README.md'), 'utf8'), '# demo\n\n')
    assert.equal(git(project, ['branch', '--show-current']), 'main')
    assert.equal(git(project, ['rev-list', '--count', 'HEAD']), '1')
    assert.equal(git(project, ['log', '-1', '--format=%s']), 'Initial commit')
    assert.deepEqual(git(project, ['ls-files']).split('\n'), ['AGENT.md', 'README.md'])
    // The first-send "uncommitted changes" banner keys off this being empty.
    assert.equal(git(project, ['status', '--porcelain']), '')
  })

  it('commits the starter files even when global excludes ignore them', async () => {
    const xdg = join(temp, 'xdg')
    await mkdir(join(xdg, 'git'), { recursive: true })
    await writeFile(join(xdg, 'git', 'ignore'), 'AGENT.md\nREADME.md\n')
    const saved = { home: process.env['HOME'], xdg: process.env['XDG_CONFIG_HOME'] }
    process.env['HOME'] = temp
    process.env['XDG_CONFIG_HOME'] = xdg
    try {
      const project = join(temp, 'ignored')
      await mkdir(project)
      await scaffoldProject(project, 'ignored', true)
      assert.deepEqual(git(project, ['ls-files']).split('\n'), ['AGENT.md', 'README.md'])
    } finally {
      for (const [key, value] of [
        ['HOME', saved.home],
        ['XDG_CONFIG_HOME', saved.xdg],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
