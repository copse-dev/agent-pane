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

describe('ask_classifier permission', () => {
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
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args: ARGS }), true)
    assert.deepEqual(prompts, [])
  })

  it('uses a saved hosted classifier without a tool prompt by default', async () => {
    await configure('typesafe')
    const args = { ...ARGS, classifier: 'typesafe' }
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args }), true)
    assert.deepEqual(prompts, [])
  })

  it('asks for each question when Always ask is selected', async () => {
    await configure('typesafe')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('ask_classifier')]: 'ask',
    })
    const args = { ...ARGS, classifier: 'typesafe' }
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args }), true)
    assert.equal(
      await ensureToolPermitted({
        toolName: 'ask_classifier',
        args: { ...args, text: 'different private text', question: 'Another question?' },
      }),
      true,
    )
    assert.equal(prompts.length, 2)
    const prompt = prompts[0]
    assert.ok(prompt)
    assert.equal(prompt.title, 'Allow this classifier question?')
    assert.equal(prompt.collapseDetails, true)
    assert.equal(prompt.approveLabel, 'Allow once')
    assert.match(prompt.body, /private text/)
    assert.equal(prompt.allowRemember, undefined)
  })

  it('does not replace a block set while approval is pending', async () => {
    await configure('typesafe')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('ask_classifier')]: 'ask',
    })
    let answer: ((value: { approved: boolean; remember: boolean }) => void) | undefined
    setApprovalHandler(
      async () =>
        await new Promise((resolve) => {
          answer = resolve
        }),
    )
    const pending = ensureToolPermitted({
      toolName: 'ask_classifier',
      args: { ...ARGS, classifier: 'typesafe' },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('ask_classifier')]: 'block',
    })
    answer?.({ approved: true, remember: true })
    assert.equal(await pending, false)
    assert.deepEqual(prompts, [])
  })

  it('does not run when the person declines the prompt', async () => {
    await configure('typesafe')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('ask_classifier')]: 'ask',
    })
    setApprovalHandler(async () => ({ approved: false, remember: false }))
    const args = { ...ARGS, classifier: 'typesafe' }
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args }), false)
  })

  it('does not treat an unknown classifier as an off-machine call', async () => {
    await configure()
    assert.equal(
      await ensureToolPermitted({
        toolName: 'ask_classifier',
        args: { ...ARGS, classifier: 'zz' },
      }),
      true,
    )
    assert.deepEqual(prompts, [])
  })

  it('honours an explicit override: ask prompts even for loopback, allow skips the prompt', async () => {
    await configure('kev', 'typesafe')
    const id = copseToolPermissionId('ask_classifier')
    await setSetting('toolPermissionOverrides', { [id]: 'ask' })
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args: ARGS }), true)
    assert.equal(prompts.length, 1)
    const prompt = prompts[0]
    assert.ok(prompt)
    assert.equal(prompt.approveLabel, 'Allow once')

    prompts = []
    await setSetting('toolPermissionOverrides', { [id]: 'allow' })
    const remote = { ...ARGS, classifier: 'typesafe' }
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args: remote }), true)
    assert.deepEqual(prompts, [])
  })

  it('refuses when the person blocked the tool', async () => {
    await configure('kev')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('ask_classifier')]: 'block',
    })
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args: ARGS }), false)
    assert.deepEqual(prompts, [])
  })

  it('shows structured state before sending it to a remote classifier', async () => {
    await configure('typesafe')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('ask_classifier')]: 'ask',
    })
    const args = {
      classifier: 'typesafe',
      state: { task: 'private task' },
      type: 'boolean',
      question: 'Is it urgent?',
    }
    assert.equal(await ensureToolPermitted({ toolName: 'ask_classifier', args }), true)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]?.body ?? '', /private task/)
  })
})
