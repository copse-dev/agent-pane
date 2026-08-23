import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  loadEvalScenario,
  type EvalScenario,
  type PromptAttachment,
} from '../../tests/e2e/helpers/agent-eval-scenario.ts'

/**
 * The per-PR half of the agent-eval lane.
 *
 * A real-model scenario run needs Electron, a display, and a model, so it lives
 * in a nightly job — which means a typo in a `fixture` path or a schema mistake
 * surfaces forty minutes into that run rather than here. These two checks are
 * everything about a scenario that can be verified without a model, so they run
 * in `npm test` where the cost is milliseconds.
 */
const SCENARIO_DIR = 'tests/e2e/scenarios'

function scenarioFiles(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

/** Every attachment a scenario names, seeded files and prompt attachments alike. */
function attachments(scenario: EvalScenario): PromptAttachment[] {
  const prompts = scenario.prompts ?? []
  return [
    ...(scenario.workspace?.seedFiles ?? []),
    ...prompts.flatMap((prompt) => (typeof prompt === 'string' ? [] : (prompt.attachments ?? []))),
  ]
}

describe('agent-eval scenarios', () => {
  it('has scenarios to check', () => {
    // Guards the two loops below against a moved directory quietly passing.
    assert.ok(scenarioFiles().length > 0, `no scenarios found in ${SCENARIO_DIR}`)
  })

  it('parses every scenario against the schema the harness loads', () => {
    for (const name of scenarioFiles()) {
      assert.doesNotThrow(() => loadEvalScenario(join(SCENARIO_DIR, name)), name)
    }
  })

  it('resolves every fixture a scenario seeds or attaches', () => {
    for (const name of scenarioFiles()) {
      const scenario = loadEvalScenario(join(SCENARIO_DIR, name))
      for (const attachment of attachments(scenario)) {
        if (attachment.fixture === undefined) continue
        assert.ok(
          existsSync(resolve(attachment.fixture)),
          `${name}: missing fixture ${attachment.fixture}`,
        )
      }
    }
  })
})
