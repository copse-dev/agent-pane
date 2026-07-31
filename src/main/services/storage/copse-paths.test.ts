import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  copseDataRoot,
  copseUserDataDir,
  copseWorkspaceDir,
  copseWorktreesDir,
} from './copse-paths.ts'

describe('Copse profile paths', () => {
  it('keeps existing defaults when COPSE_DIR is unset', () => {
    const env: NodeJS.ProcessEnv = {}

    assert.equal(copseDataRoot(env), join(homedir(), '.copse'))
    assert.equal(copseUserDataDir('/legacy/user-data', env), '/legacy/user-data')
    assert.equal(copseWorkspaceDir(env), join(homedir(), '.copse', 'workspace'))
    assert.equal(copseWorktreesDir(env), join(homedir(), '.copse', 'worktrees'))
  })

  it('derives the complete profile layout from COPSE_DIR', () => {
    const env = { COPSE_DIR: ' /profiles/secondary ' }

    assert.equal(copseDataRoot(env), '/profiles/secondary')
    assert.equal(copseUserDataDir('/legacy/user-data', env), '/profiles/secondary/user-data')
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

    assert.equal(copseUserDataDir('/legacy/user-data', env), '/custom/user-data')
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

    assert.equal(copseUserDataDir('/legacy/user-data', env), '/profiles/secondary/user-data')
    assert.equal(copseWorkspaceDir(env), '/profiles/secondary/workspace')
    assert.equal(copseWorktreesDir(env), '/profiles/secondary/worktrees')
  })
})
