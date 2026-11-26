import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  MAX_SANDBOX_READ_FOLDERS_PER_PROJECT,
  SANDBOX_READ_APPROVED_FOLDERS_SETTING,
  SANDBOX_READ_PROJECT_FOLDERS_SETTING,
  SANDBOX_READ_WORKSPACE_ONLY_SETTING,
} from '@shared/sandbox-read-access.ts'
import { deleteSetting, setSetting } from '../storage/settings.ts'
import {
  projectReadFolderOffer,
  projectReadFolders,
  projectReadFoldersCover,
  rememberProjectReadFolders,
  revokeProjectReadFolder,
  storedProjectReadFolders,
} from './project-read-grants.ts'

let scratch = ''
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'project-read-grants-')))
})
afterEach(async () => {
  rmSync(scratch, { recursive: true, force: true })
  await deleteSetting(SANDBOX_READ_PROJECT_FOLDERS_SETTING)
  await deleteSetting(SANDBOX_READ_APPROVED_FOLDERS_SETTING)
  await deleteSetting(SANDBOX_READ_WORKSPACE_ONLY_SETTING)
})

function folder(name: string): string {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

describe('project read folders', () => {
  it('belong to one project, and revoking one keeps the rest', async () => {
    const a = folder('a')
    const b = folder('b')
    assert.deepEqual(await rememberProjectReadFolders('/project/one', [a, b, a]), [a, b])
    assert.deepEqual(await rememberProjectReadFolders('/project/one', [a]), [], 'no duplicate')
    assert.deepEqual(projectReadFolders('/project/one'), [a, b])
    assert.deepEqual(projectReadFolders('/project/two'), [])
    await revokeProjectReadFolder('/project/one', a)
    assert.deepEqual(projectReadFolders('/project/one'), [b])
    await revokeProjectReadFolder('/project/one', b)
    assert.deepEqual(storedProjectReadFolders('/project/one'), [])
  })

  it('stops granting a folder that was replaced by a link elsewhere', async () => {
    const real = folder('real')
    await rememberProjectReadFolders('/project/one', [real])
    rmSync(real, { recursive: true })
    symlinkSync(folder('elsewhere'), real)
    assert.deepEqual(storedProjectReadFolders('/project/one'), [real])
    assert.deepEqual(projectReadFolders('/project/one'), [], 'never re-resolved to a new target')
  })

  it('covers literal descendants only, and only while the group is on', async () => {
    const sibling = folder('sibling')
    writeFileSync(join(sibling, 'a.txt'), 'x')
    await rememberProjectReadFolders('/project/one', [sibling])
    const file = join(sibling, 'a.txt')
    assert.equal(projectReadFoldersCover('/project/one', [file], [file]), true)
    const expanded = `${sibling}/{..,x}/a.txt`
    assert.equal(projectReadFoldersCover('/project/one', [expanded], [expanded]), false)
    assert.equal(projectReadFoldersCover('/project/two', [file], [file]), false)
    await setSetting(SANDBOX_READ_WORKSPACE_ONLY_SETTING, true)
    assert.equal(projectReadFoldersCover('/project/one', [file], [file]), false)
  })
})

describe('projectReadFolderOffer', () => {
  it('offers existing ordinary folders and nothing else', () => {
    const sibling = folder('sibling')
    const file = join(scratch, 'note.txt')
    writeFileSync(file, 'x')
    assert.deepEqual(projectReadFolderOffer('/project/one', [sibling]), [sibling])
    assert.equal(projectReadFolderOffer('/project/one', [sibling, file]), null, 'a file')
    assert.equal(projectReadFolderOffer('/project/one', [join(scratch, 'missing')]), null)
    assert.equal(projectReadFolderOffer(null, [sibling]), null, 'no project')
    assert.equal(projectReadFolderOffer('/project/one', [homedir()]), null, 'home itself')
    const holdsKeys = folder('holds-keys')
    mkdirSync(join(holdsKeys, '.ssh'))
    assert.equal(
      projectReadFolderOffer('/project/one', [join(holdsKeys, '.ssh')]),
      null,
      'a credential folder',
    )
  })

  it('offers nothing when the group is off or the project is full', async () => {
    const sibling = folder('sibling')
    await setSetting(SANDBOX_READ_APPROVED_FOLDERS_SETTING, false)
    assert.equal(projectReadFolderOffer('/project/one', [sibling]), null)
    await setSetting(SANDBOX_READ_APPROVED_FOLDERS_SETTING, true)
    const many = Array.from({ length: MAX_SANDBOX_READ_FOLDERS_PER_PROJECT }, (_, i) =>
      folder(`f${String(i)}`),
    )
    await rememberProjectReadFolders('/project/one', many)
    assert.equal(projectReadFolderOffer('/project/one', [sibling]), null)
  })
})
