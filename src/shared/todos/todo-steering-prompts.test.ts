import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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

/**
 * Anti-drift guard between the agent-eval scenarios and the matcher they
 * declare expectations against.
 *
 * `analyze-thread-jsonl.mts` turns `expect.shouldSteerTodos` into a hard
 * violation, so a scenario whose prompt does not actually produce the declared
 * value can never pass — it just reports the same violation on every run. The
 * agent evals are not in CI, so nothing else would surface that.
 */
describe('agent-eval scenarios agree with shouldSteerTodos', () => {
  const scenarioDir = join(process.cwd(), 'tests/e2e/scenarios')
  const scenarioSchema = z.object({
    prompts: z.array(z.union([z.string(), z.object({ text: z.string() })])).optional(),
    promptVariants: z.array(z.string()).optional(),
    expect: z.object({ shouldSteerTodos: z.boolean().optional() }).optional(),
  })

  for (const file of readdirSync(scenarioDir).filter((name) => name.endsWith('.json'))) {
    const parsed = scenarioSchema.parse(
      JSON.parse(readFileSync(join(scenarioDir, file), 'utf8')) as unknown,
    )
    const declared = parsed.expect?.shouldSteerTodos
    if (declared === undefined) continue
    const first = parsed.prompts?.[0] ?? parsed.promptVariants?.[0]
    const text = typeof first === 'string' ? first : first?.text
    if (text === undefined) continue

    it(`${file} declares shouldSteerTodos=${String(declared)} and means it`, () => {
      assert.equal(
        shouldSteerTodos(text),
        declared,
        `${file} expects shouldSteerTodos=${String(declared)} but the matcher disagrees for its first prompt`,
      )
    })
  }
})
