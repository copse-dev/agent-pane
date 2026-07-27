import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { offerAcpClaudeFallback } from './acp-billing-fallback.ts'
import { setAskUserHandler, type AskUserRequest } from '../ask-user.ts'
import { setSetting } from '../storage/settings.ts'

const CLAUDE_ACP = {
  id: 'claude-agent-acp',
  title: 'Claude',
  command: 'claude-agent-acp',
  enabled: true,
  // Present so the offer never shells out to the Keychain during tests.
  env: { ANTHROPIC_API_KEY: 'sk-ant-api03-agent' },
}

/** Record what the user was asked, and answer with `reply`. */
function stubAsk(reply: string): { asked: AskUserRequest[] } {
  const asked: AskUserRequest[] = []
  setAskUserHandler((req) => {
    asked.push(req)
    return Promise.resolve({ answers: req.questions.map(() => reply) })
  })
  return { asked }
}

/** Text of the single question the offer asked, or '' when it never asked. */
function askedQuestion(asked: AskUserRequest[]): string {
  const [first] = asked
  if (!first) return ''
  const [question] = first.questions
  return question?.question ?? ''
}

describe('offerAcpClaudeFallback', () => {
  beforeEach(async () => {
    await setSetting('preferAcpOverCloudAgent', true)
    await setSetting('registeredAcpAgents', [CLAUDE_ACP])
  })

  afterEach(() => {
    setAskUserHandler(null)
  })

  it('switches when the user picks the offered option', async () => {
    const { asked } = stubAsk('Switch to Claude')

    const choice = await offerAcpClaudeFallback({ provider: 'anthropic', reason: 'credit' })
    assert.ok(choice)
    assert.equal(choice.agentId, 'claude-agent-acp')
    assert.equal(choice.modelValue, 'acp:claude-agent-acp')
    assert.equal(asked.length, 1)
    assert.match(askedQuestion(asked), /out of credit/)
  })

  it('accepts a typed yes', async () => {
    stubAsk('yes')
    const choice = await offerAcpClaudeFallback({ provider: 'anthropic', reason: 'auth' })
    assert.equal(choice?.agentId, 'claude-agent-acp')
  })

  it('stays on the Cloud Agent when the user declines', async () => {
    stubAsk('Stay on Claude Cloud Agent')
    assert.equal(await offerAcpClaudeFallback({ provider: 'anthropic', reason: 'no-key' }), null)
  })

  // A blank answer is what an unanswered ask resolves to (window closed, ask
  // timed out, headless host). Switching billing paths on silence would be the
  // wrong default.
  it('treats a blank answer as a decline', async () => {
    stubAsk('')
    assert.equal(await offerAcpClaudeFallback({ provider: 'anthropic', reason: 'auth' }), null)
  })

  it('does not offer for a non-Anthropic remote agent', async () => {
    const { asked } = stubAsk('yes')
    assert.equal(await offerAcpClaudeFallback({ provider: 'cursor', reason: 'auth' }), null)
    assert.equal(asked.length, 0)
  })

  it('does not offer when the setting is off', async () => {
    await setSetting('preferAcpOverCloudAgent', false)
    const { asked } = stubAsk('yes')
    assert.equal(await offerAcpClaudeFallback({ provider: 'anthropic', reason: 'auth' }), null)
    assert.equal(asked.length, 0)
  })

  it('does not offer when no Claude ACP agent is enabled', async () => {
    await setSetting('registeredAcpAgents', [{ ...CLAUDE_ACP, enabled: false }])
    const { asked } = stubAsk('yes')
    assert.equal(await offerAcpClaudeFallback({ provider: 'anthropic', reason: 'auth' }), null)
    assert.equal(asked.length, 0)
  })

  it('warns when the agent has no discoverable Claude login', async () => {
    await setSetting('registeredAcpAgents', [{ ...CLAUDE_ACP, env: {} }])
    const { asked } = stubAsk('Stay on Claude Cloud Agent')
    await offerAcpClaudeFallback({ provider: 'anthropic', reason: 'auth' })
    // Only assert the warning when discovery actually found nothing — a dev
    // machine running the suite may have a real `claude` login on disk.
    const question = askedQuestion(asked)
    if (question.includes('No local')) assert.match(question, /claude setup-token/)
  })

  // The Cloud Agent picker pins upstream Anthropic ids; an ACP model is that
  // agent's own config-option value. Carrying one across only works when the
  // agent advertises it.
  it('carries the pinned model over only when the ACP agent offers it', async () => {
    stubAsk('yes')
    const notOffered = await offerAcpClaudeFallback({
      provider: 'anthropic',
      reason: 'auth',
      model: 'claude-opus-4-8',
    })
    assert.equal(notOffered?.modelValue, 'acp:claude-agent-acp')

    await setSetting('registeredAcpAgents', [
      { ...CLAUDE_ACP, availableModels: [{ value: 'claude-opus-4-8', label: 'Opus 4.8' }] },
    ])
    const offered = await offerAcpClaudeFallback({
      provider: 'anthropic',
      reason: 'auth',
      model: 'claude-opus-4-8',
    })
    assert.equal(offered?.modelValue, 'acp:claude-agent-acp#claude-opus-4-8')
  })
})
