import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldSteerTodos } from './todo-logic.ts'

interface PromptFixture {
  id: string
  prompt: string
  category?: string
}

interface SteeringFixtures {
  mustSteerTodos: PromptFixture[]
  mustNotSteerTodos: PromptFixture[]
}

const fixturesPath = join(process.cwd(), 'tests/fixtures/todo-steering-prompts.json')
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as SteeringFixtures

describe('todo steering prompt matrix', () => {
  for (const { id, prompt } of fixtures.mustSteerTodos) {
    it(`must steer: ${id}`, () => {
      assert.equal(
        shouldSteerTodos(prompt),
        true,
        `expected steering for (${prompt.length} chars): ${prompt.slice(0, 80)}`,
      )
    })
  }

  for (const { id, prompt } of fixtures.mustNotSteerTodos) {
    it(`must not steer: ${id}`, () => {
      assert.equal(shouldSteerTodos(prompt), false, `expected no steering for: ${prompt}`)
    })
  }
})
