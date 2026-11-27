import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  NO_CAPABILITIES,
  turnCannotRunOn,
  workerCapabilitiesSchema,
  type TurnNeeds,
  type WorkerCapabilities,
} from './worker-capabilities.ts'

const loopOnly: WorkerCapabilities = {
  roles: ['turns'],
  models: { chatgptPlan: false, externalAgents: false, remoteAgents: false },
  pluginRuntimes: false,
  sandbox: true,
}

const plain: TurnNeeds = { model: 'claude-sonnet-4-6', pluginRuntimes: false, sandbox: true }

describe('turnCannotRunOn', () => {
  it('lets a worker run a turn on Copse’s own loop', () => {
    assert.equal(turnCannotRunOn(loopOnly, plain), null)
    assert.equal(turnCannotRunOn(loopOnly, { ...plain, model: undefined }), null)
  })

  it('keeps a turn off a worker that lacks the kind of model it runs on', () => {
    for (const model of [
      'acp:codex',
      'remote-agent:openai',
      'chatgpt-plan:oaiapp_account#gpt-6.1-sol',
      'plugin-model:personal.plugin:judge',
    ]) {
      assert.notEqual(turnCannotRunOn(loopOnly, { ...plain, model }), null, model)
    }
    const everything: WorkerCapabilities = {
      ...loopOnly,
      models: { chatgptPlan: true, externalAgents: true, remoteAgents: true },
      pluginRuntimes: true,
    }
    assert.equal(turnCannotRunOn(everything, { ...plain, model: 'acp:codex' }), null)
  })

  it('keeps a turn that may call a plugin runtime, or must be confined, where it can be', () => {
    assert.match(
      turnCannotRunOn(loopOnly, { ...plain, pluginRuntimes: true }) ?? '',
      /plugin runtimes/,
    )
    assert.match(
      turnCannotRunOn({ ...loopOnly, sandbox: false }, plain) ?? '',
      /confines project commands/,
    )
    // A worker that confines commands may run a turn the app would not confine.
    assert.equal(turnCannotRunOn(loopOnly, { ...plain, sandbox: false }), null)
  })

  it('sends nothing to a worker that does not run turns or said nothing', () => {
    assert.notEqual(turnCannotRunOn({ ...loopOnly, roles: ['container-run'] }, plain), null)
    assert.notEqual(turnCannotRunOn(NO_CAPABILITIES, { ...plain, sandbox: false }), null)
  })
})

describe('workerCapabilitiesSchema', () => {
  it('reads what a worker says and rejects a role it does not know', () => {
    assert.deepEqual(workerCapabilitiesSchema.parse(loopOnly), loopOnly)
    assert.equal(
      workerCapabilitiesSchema.safeParse({ ...loopOnly, roles: ['mine'] }).success,
      false,
    )
  })
})
