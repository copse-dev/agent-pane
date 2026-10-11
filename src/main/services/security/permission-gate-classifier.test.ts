import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setPermissionGateForTests } from '../tool-registry.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { ensureToolPermitted } from './permission-gate.ts'
import { copseToolPermissionId } from './tool-permissions.ts'

const ARGS = { classifier: 'kev', text: 'private text', type: 'boolean', question: 'Is it?' }

async function configure(...ids: string[]): Promise<void> {
  const profiles = CLASSIFIER_PRESETS.filter((profile) => ids.includes(profile.id))
  await setSetting('classifierProviders', { version: 1, profiles })
}

describe('classify_text permission', () => {
  let prompts: ApprovalRequest[] = []

  beforeEach(async () => {
    setPermissionGateForTests(null)
    prompts = []
    await setSetting('toolPermissionOverrides', {})
    setApprovalHandler(async (request) => {
      prompts.push(request)
      return { approved: true, remember: false }
    })
  })

  afterEach(async () => {
    setApprovalHandler(null)
    await setSetting('toolPermissionOverrides', {})
    await setSetting('classifierProviders', { version: 1, profiles: [] })
  })

  it('runs a loopback classifier without a prompt: the text stays on this machine', async () => {
    await configure('kev')
    assert.equal(await ensureToolPermitted({ toolName: 'classify_text', args: ARGS }), true)
    assert.deepEqual(prompts, [])
  })

  it('asks before text goes to a classifier that leaves the machine, and shows what is sent', async () => {
    await configure('typesafe')
    const args = { ...ARGS, classifier: 'typesafe' }
    assert.equal(await ensureToolPermitted({ toolName: 'classify_text', args }), true)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]?.body ?? '', /private text/)
    assert.match(prompts[0]?.subject ?? '', /classify_text/)
  })

  it('does not run when the person declines the prompt', async () => {
    await configure('typesafe')
    setApprovalHandler(async () => ({ approved: false, remember: false }))
    const args = { ...ARGS, classifier: 'typesafe' }
    assert.equal(await ensureToolPermitted({ toolName: 'classify_text', args }), false)
  })

  it('does not treat an unknown classifier as an off-machine call', async () => {
    await configure()
    assert.equal(
      await ensureToolPermitted({ toolName: 'classify_text', args: { ...ARGS, classifier: 'zz' } }),
      true,
    )
    assert.deepEqual(prompts, [])
  })

  it('honours an explicit override: ask prompts even for loopback, allow skips the prompt', async () => {
    await configure('kev', 'typesafe')
    const id = copseToolPermissionId('classify_text')
    await setSetting('toolPermissionOverrides', { [id]: 'ask' })
    assert.equal(await ensureToolPermitted({ toolName: 'classify_text', args: ARGS }), true)
    assert.equal(prompts.length, 1)

    prompts = []
    await setSetting('toolPermissionOverrides', { [id]: 'allow' })
    const remote = { ...ARGS, classifier: 'typesafe' }
    assert.equal(await ensureToolPermitted({ toolName: 'classify_text', args: remote }), true)
    assert.deepEqual(prompts, [])
  })

  it('refuses when the person blocked the tool', async () => {
    await configure('kev')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('classify_text')]: 'block',
    })
    assert.equal(await ensureToolPermitted({ toolName: 'classify_text', args: ARGS }), false)
    assert.deepEqual(prompts, [])
  })
})
