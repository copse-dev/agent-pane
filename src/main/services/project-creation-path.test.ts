import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProjectCreation } from './project-creation-path.ts'

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch(() => false)
}

describe('project creation path', () => {
  let temp = ''

  beforeEach(async () => {
    temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-project-path-')))
  })

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  it('creates a missing parent only after confirmation', async () => {
    const parentDir = join(temp, 'missing', 'nested')
    const result = await prepareProjectCreation({
      parentDir,
      name: 'demo',
      confirm: async (projectPath) => {
        assert.equal(projectPath, join(parentDir, 'demo'))
        assert.equal(await pathExists(parentDir), false)
        return true
      },
    })

    assert.deepEqual(result, { projectPath: join(parentDir, 'demo'), projectMissing: true })
    assert.equal((await lstat(result.projectPath)).isDirectory(), true)
  })

  it('creates nothing when confirmation is cancelled', async () => {
    const parentDir = join(temp, 'cancelled', 'nested')
    await assert.rejects(
      prepareProjectCreation({
        parentDir,
        name: 'demo',
        confirm: async () => false,
      }),
      /not confirmed/,
    )
    assert.equal(await pathExists(join(temp, 'cancelled')), false)
  })

  it('rejects a project name that escapes the reviewed parent', async () => {
    let confirmed = false
    await assert.rejects(
      prepareProjectCreation({
        parentDir: temp,
        name: '../outside',
        confirm: async () => {
          confirmed = true
          return true
        },
      }),
      /Invalid project name/,
    )
    assert.equal(confirmed, false)
  })

  it('rejects a missing parent retargeted during confirmation', async () => {
    const parentDir = join(temp, 'pivot', 'nested')
    const outside = join(temp, 'outside')
    await mkdir(outside)

    await assert.rejects(
      prepareProjectCreation({
        parentDir,
        name: 'demo',
        confirm: async () => {
          await symlink(outside, join(temp, 'pivot'), 'dir')
          return true
        },
      }),
      /changed after confirmation/,
    )
    assert.deepEqual(await readdir(outside), [])
  })

  it('rejects an existing target symlink before writing through it', async () => {
    const outside = join(temp, 'outside')
    await mkdir(outside)
    await symlink(outside, join(temp, 'demo'), 'dir')

    await assert.rejects(
      prepareProjectCreation({
        parentDir: temp,
        name: 'demo',
        confirm: async () => true,
      }),
      /symbolic link/,
    )
    assert.deepEqual(await readdir(outside), [])
  })
})
