import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  loadEvalScenario,
  seedEvalWorkspace,
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

describe('git-commit-tool-eval workspace', () => {
  it('starts from a committed seed baseline with a clean tree', () => {
    const scenario = loadEvalScenario(join(SCENARIO_DIR, 'git-commit-tool-eval.json'))
    const root = mkdtempSync(join(tmpdir(), 'copse-eval-seed-test-'))
    try {
      const baseline = seedEvalWorkspace(root, scenario)
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
      assert.ok(baseline, 'commitSeedFiles must report the baseline commit')
      assert.equal(git('rev-parse', 'HEAD'), baseline)
      assert.equal(git('rev-list', '--count', 'HEAD'), '1')
      assert.equal(git('status', '--porcelain'), '')
      assert.deepEqual(git('ls-files').split('\n'), ['CHANGELOG.md', 'README.md'])
      // The scaffold's identity: the agent's commits are judged after this one.
      assert.equal(
        git('log', '-1', '--format=%an <%ae>|%s'),
        'Copse <copse@copse.invalid>|Initial commit',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('no longer asks the agent to initialise a repository', () => {
    // A sandboxed shell cannot create `.git` (it is an ancestor of the protected
    // `.git/hooks`), so a prompt asking for `git init` can only fail.
    const scenario = loadEvalScenario(join(SCENARIO_DIR, 'git-commit-tool-eval.json'))
    for (const prompt of scenario.prompts ?? []) {
      const text = typeof prompt === 'string' ? prompt : prompt.text
      assert.doesNotMatch(text, /initiali[sz]e|git init/i)
    }
  })

  it('rejects commitSeedFiles without initializeGit', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-eval-seed-test-'))
    try {
      assert.throws(
        () =>
          seedEvalWorkspace(root, {
            id: 'bad',
            workspace: { type: 'tempProject', commitSeedFiles: true },
          }),
        /commitSeedFiles requires initializeGit/,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
