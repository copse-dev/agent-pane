import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToolExecuteResult } from '@shared/types'
import { proposeThreadTool } from './propose-thread-tool.ts'

const signal = new AbortController().signal

/** The text the model actually receives back from the tool. */
async function resultText(args: Parameters<typeof proposeThreadTool.execute>[0]): Promise<string> {
  return normalizeToolExecuteResult(await proposeThreadTool.execute(args, signal)).result
}

const args = {
  title: 'Migrate the settings store to Zod',
  summary: 'Replace the hand-rolled settings parsing with a Zod schema.',
  prompt: 'Replace the hand-rolled parsing in src/main/services/storage/settings.ts with Zod.',
}

describe('proposeThreadTool', () => {
  it('declares propose_thread with a title/summary/prompt schema', () => {
    assert.equal(proposeThreadTool.name, 'propose_thread')
    assert.equal(proposeThreadTool.parameters.safeParse(args).success, true)
    assert.equal(
      proposeThreadTool.parameters.safeParse({ ...args, files: ['a.ts'], rationale: 'why' })
        .success,
      true,
    )
    for (const missing of ['title', 'summary', 'prompt'] as const) {
      const partial = Object.fromEntries(Object.entries(args).filter(([key]) => key !== missing))
      assert.equal(proposeThreadTool.parameters.safeParse(partial).success, false, missing)
    }
    assert.equal(proposeThreadTool.parameters.safeParse({ ...args, title: '' }).success, false)
  })

  it('returns immediately, telling the agent the offer stands on its own', async () => {
    const result = await resultText(args)
    assert.match(result, /Migrate the settings store to Zod/)
    assert.match(result, /Nothing has run/)
    assert.match(result, /do not wait for an answer/)
  })

  it('does not resolve to anything the model could read as work done', async () => {
    assert.doesNotMatch(await resultText(args), /\b(created|started|queued|scheduled)\b/i)
  })

  it('reports a proposal the card could not be drawn from as not offered', async () => {
    const result = await resultText({ ...args, summary: '   ' })
    assert.match(result, /Not offered/)
    assert.match(result, /Nothing was shown to the user/)
  })
})
