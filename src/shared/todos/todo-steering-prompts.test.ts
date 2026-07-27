import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldSteerTodos } from './todo-logic.ts'
import { z } from 'zod'

interface PromptFixture {
  id: string
  prompt: string
  category?: string | undefined
}

interface SteeringFixtures {
  mustSteerTodos: PromptFixture[]
  mustNotSteerTodos: PromptFixture[]
}

const fixturesPath = join(process.cwd(), 'tests/fixtures/todo-steering-prompts.json')
const fixturesSchema: z.ZodType<SteeringFixtures> = z.object({
  mustSteerTodos: z.array(
    z.object({ id: z.string(), prompt: z.string(), category: z.string().optional() }),
  ),
  mustNotSteerTodos: z.array(
    z.object({ id: z.string(), prompt: z.string(), category: z.string().optional() }),
  ),
})
const fixtures = fixturesSchema.parse(JSON.parse(readFileSync(fixturesPath, 'utf8')) as unknown)

describe('todo steering prompt matrix', () => {
  for (const { id, prompt } of fixtures.mustSteerTodos) {
    it(`must steer: ${id}`, () => {
      assert.equal(
        shouldSteerTodos(prompt),
        true,
        `expected steering for (${String(prompt.length)} chars): ${prompt.slice(0, 80)}`,
      )
    })
  }

  for (const { id, prompt } of fixtures.mustNotSteerTodos) {
    it(`must not steer: ${id}`, () => {
      assert.equal(shouldSteerTodos(prompt), false, `expected no steering for: ${prompt}`)
    })
  }
})
