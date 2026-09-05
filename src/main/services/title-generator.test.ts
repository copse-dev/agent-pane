import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { threadTitlePrompt } from './title-generator.ts'

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
