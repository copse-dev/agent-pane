import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { roadmapTitlePrompt, threadTitlePrompt } from './title-generator.ts'

describe('threadTitlePrompt', () => {
  it('tells the model a multi-message input is one conversation to title by its goal', () => {
    const prompt = threadTitlePrompt('Add a login button\n\nNow the signup form')
    assert.match(prompt, /several messages are shown, they are one conversation/)
    assert.match(prompt, /overall goal, not just the latest message/)
    assert.ok(prompt.endsWith('Request:\nAdd a login button\n\nNow the signup form'))
  })

  it('caps the input at 1500 characters so a re-title fits several messages', () => {
    const input = 'x'.repeat(2000)
    const prompt = threadTitlePrompt(input)
    const sent = prompt.slice(prompt.indexOf('Request:\n') + 'Request:\n'.length)
    assert.equal(sent.length, 1500)
    assert.equal(threadTitlePrompt('short').endsWith('Request:\nshort'), true)
  })
})

describe('roadmapTitlePrompt', () => {
  it('asks for a short Title Case name for a roadmap item prompt (issue #2472)', () => {
    const prompt = roadmapTitlePrompt('Refactor the settings dialog into separate panels')
    assert.match(prompt, /3-6 word title in Title Case/)
    assert.match(prompt, /future-work prompt from a project roadmap/)
    assert.ok(
      prompt.endsWith('Prompt:\nRefactor the settings dialog into separate panels'),
      'the roadmap prompt itself is appended last',
    )
  })

  it('caps the input at 2000 characters, matching the complexity/category classifiers', () => {
    const input = 'x'.repeat(3000)
    const prompt = roadmapTitlePrompt(input)
    const sent = prompt.slice(prompt.indexOf('Prompt:\n') + 'Prompt:\n'.length)
    assert.equal(sent.length, 2000)
    assert.equal(roadmapTitlePrompt('short').endsWith('Prompt:\nshort'), true)
  })
})
