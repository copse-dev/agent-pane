import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { initProjectSandbox, isProjectSandboxEnabled } from './index.ts'
import { setProjectSandboxEnabled } from './enabled.ts'
import {
  isProjectSandboxActive,
  isProjectSandboxPlatform,
  projectSandboxInitFailure,
  setProjectSandboxInitFailure,
} from './state.ts'

describe('project sandbox initialization', () => {
  afterEach(() => {
    mock.restoreAll()
    setProjectSandboxEnabled(false)
    setProjectSandboxInitFailure(undefined)
  })

  it('records an init failure when ASRT resolves without enabling protection', async (t) => {
    if (!isProjectSandboxPlatform()) {
      t.skip('project sandbox is unavailable on this platform')
      return
    }
    const initialize = mock.method(SandboxManager, 'initialize', async () => {})
    mock.method(SandboxManager, 'isSandboxingEnabled', () => false)
    const reset = mock.method(SandboxManager, 'reset', async () => {})
    mock.method(console, 'warn', () => {})

    await initProjectSandbox()

    assert.equal(initialize.mock.callCount(), 1)
    assert.equal(reset.mock.callCount(), 1)
    assert.equal(isProjectSandboxActive(), false)
    assert.equal(isProjectSandboxEnabled(), false)
    assert.match(projectSandboxInitFailure() ?? '', /Workspace protection did not start/)
  })
})
