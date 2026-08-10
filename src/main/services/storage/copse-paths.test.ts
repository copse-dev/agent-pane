import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  copseDataRoot,
  copseUserDataDir,
  copseWorkspaceDir,
  copseWorktreesDir,
  projectStoreDir,
} from './copse-paths.ts'

describe('Copse profile paths', () => {
  it('keeps the whole profile under ~/.copse when nothing is overridden', () => {
    const env: NodeJS.ProcessEnv = {}
    const root = join(homedir(), '.copse')

    assert.equal(copseDataRoot(env), root)
    assert.equal(copseUserDataDir(env), join(root, 'user-data'))
    assert.equal(copseWorkspaceDir(env), join(root, 'workspace'))
    assert.equal(copseWorktreesDir(env), join(root, 'worktrees'))
  })

  it('derives the complete profile layout from COPSE_DIR', () => {
    const env = { COPSE_DIR: ' /profiles/secondary ' }

    assert.equal(copseDataRoot(env), '/profiles/secondary')
    assert.equal(copseUserDataDir(env), '/profiles/secondary/user-data')
    assert.equal(copseWorkspaceDir(env), '/profiles/secondary/workspace')
    assert.equal(copseWorktreesDir(env), '/profiles/secondary/worktrees')
  })

  it('lets granular legacy overrides take precedence over COPSE_DIR', () => {
    const env = {
      COPSE_DIR: '/profiles/secondary',
      COPSE_PANEL_USER_DATA: '/custom/user-data',
      COPSE_WORKSPACE_DIR: '/custom/workspace',
      COPSE_WORKTREES_DIR: '/custom/worktrees',
    }

    assert.equal(copseUserDataDir(env), '/custom/user-data')
    assert.equal(copseWorkspaceDir(env), '/custom/workspace')
    assert.equal(copseWorktreesDir(env), '/custom/worktrees')
  })

  it('ignores blank overrides', () => {
    const env = {
      COPSE_DIR: ' /profiles/secondary ',
      COPSE_PANEL_USER_DATA: ' ',
      COPSE_WORKSPACE_DIR: '',
      COPSE_WORKTREES_DIR: '   ',
    }

    assert.equal(copseUserDataDir(env), '/profiles/secondary/user-data')
    assert.equal(copseWorkspaceDir(env), '/profiles/secondary/workspace')
    assert.equal(copseWorktreesDir(env), '/profiles/secondary/worktrees')
  })

  // The chat store used to resolve through its own `chatStoreDir` that ignored
  // COPSE_DIR while `projectStoreDir` honoured it, so a COPSE_DIR profile wrote
  // threads to one root and authorised reads against another.
  it('keeps the workspace store and its project dirs on one root under COPSE_DIR', () => {
    const env = { COPSE_DIR: '/profiles/secondary' }

    assert.equal(copseWorkspaceDir(env), '/profiles/secondary/workspace')
    assert.equal(projectStoreDir('project-1', env), '/profiles/secondary/workspace/project-1')
  })
})

describe('projectStoreDir', () => {
  const env = { COPSE_WORKSPACE_DIR: '/custom/workspace' }

  it('resolves a project beneath the configured workspace store', () => {
    assert.equal(projectStoreDir('project-1', env), resolve('/custom/workspace', 'project-1'))
  })

  it('rejects traversal, absolute, and empty project ids', () => {
    for (const projectId of ['../target', '/outside', '']) {
      assert.throws(() => projectStoreDir(projectId, env), /outside the workspace store/)
    }
  })
})
