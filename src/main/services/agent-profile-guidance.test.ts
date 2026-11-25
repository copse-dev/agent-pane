import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withProfileGuidance } from './agent-service.ts'

describe('withProfileGuidance', () => {
  const block = '## Profile instructions: Reviewer\n\nReview only.'

  it('appends the profile after Copse’s own guidance', async () => {
    const guidance = withProfileGuidance(async (tools) => `Copse tools: ${tools.join(',')}`, block)
    assert.equal(await guidance?.(['read_file']), `Copse tools: read_file\n\n${block}`)
  })

  it('sends the profile alone to an agent-managed turn that gets no Copse guidance', async () => {
    assert.equal(await withProfileGuidance(undefined, block)?.([]), block)
    assert.equal(await withProfileGuidance(async () => undefined, block)?.([]), block)
  })

  it('leaves the guidance untouched without profile instructions', () => {
    const copse = async (): Promise<string> => 'Copse'
    assert.equal(withProfileGuidance(copse, ''), copse)
    assert.equal(withProfileGuidance(undefined, ''), undefined)
  })
})
