import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createEvalProject,
  evalMayChangeCheckout,
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

/** Prompt text of every scenario prompt and prompt variant. */
function promptTexts(scenario: EvalScenario): string[] {
  return [
    ...(scenario.prompts ?? []).map((prompt) =>
      typeof prompt === 'string' ? prompt : prompt.text,
    ),
    ...(scenario.promptVariants ?? []),
  ]
}

/** Seed a scenario into a throwaway directory and hand back a git runner for it. */
function withSeededWorkspace(
  scenario: EvalScenario,
  check: (baseline: string | null, git: (...args: string[]) => string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'copse-eval-seed-test-'))
  try {
    const baseline = seedEvalWorkspace(root, scenario)
    check(baseline, (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('eval workspaces that judge git history', () => {
  // A sandboxed shell cannot create `.git`: the sandbox denies creating any
  // ancestor of the protected `.git/hooks`. A scenario that scores commits must
  // therefore start from a repository the harness prepares, the way Copse's New
  // project flow does, and must not ask the agent to make one.
  const gitScenarios = scenarioFiles()
    .map((name) => ({ name, scenario: loadEvalScenario(join(SCENARIO_DIR, name)) }))
    .filter(({ scenario }) => scenario.assertWorkspace?.git !== undefined)

  it('covers the scenarios that score commits', () => {
    assert.deepEqual(
      gitScenarios.map(({ name }) => name),
      ['git-commit-tool-eval.json', 'restaurant-website-eval.json'],
    )
  })

  it('starts each from a committed seed baseline with a clean tree', () => {
    for (const { name, scenario } of gitScenarios) {
      withSeededWorkspace(scenario, (baseline, git) => {
        assert.ok(baseline, `${name}: commitSeedFiles must report the baseline commit`)
        assert.equal(git('rev-parse', 'HEAD'), baseline, name)
        assert.equal(git('rev-list', '--count', 'HEAD'), '1', name)
        assert.equal(git('status', '--porcelain'), '', name)
        // The scaffold's identity: the agent's commits are judged after this one.
        assert.equal(
          git('log', '-1', '--format=%an <%ae>|%s'),
          'Copse <copse@copse.invalid>|Initial commit',
          name,
        )
      })
    }
  })

  it('commits exactly the seed files', () => {
    const seededFiles = (name: string): string[] => {
      let files: string[] = []
      withSeededWorkspace(loadEvalScenario(join(SCENARIO_DIR, name)), (_baseline, git) => {
        files = git('ls-files').split('\n')
      })
      return files
    }
    assert.deepEqual(seededFiles('git-commit-tool-eval.json'), ['CHANGELOG.md', 'README.md'])
    assert.deepEqual(seededFiles('restaurant-website-eval.json'), ['README.md'])
  })
})

describe('agent-eval prompts', () => {
  it('never ask the agent to initialise a git repository', () => {
    for (const name of scenarioFiles()) {
      for (const text of promptTexts(loadEvalScenario(join(SCENARIO_DIR, name)))) {
        assert.doesNotMatch(text, /initiali[sz]e\b[^.]*\b(?:git|repo)|git init\b/i, name)
      }
    }
  })
})

describe('commitSeedFiles', () => {
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

describe('evalMayChangeCheckout', () => {
  it("never lets the driver switch or force-send in the operator's own checkout unasked", () => {
    const previous = process.env['COPSE_EVAL_ALLOW_CURRENT_CHECKOUT']
    const scenarios = scenarioFiles().map((name) => loadEvalScenario(join(SCENARIO_DIR, name)))
    try {
      delete process.env['COPSE_EVAL_ALLOW_CURRENT_CHECKOUT']
      let ownCheckout = 0
      for (const scenario of scenarios) {
        const project = createEvalProject(scenario)
        try {
          // The eval runs in the operator's checkout exactly when the project is the cwd.
          const own = project.root === process.cwd()
          if (own) ownCheckout++
          assert.equal(evalMayChangeCheckout(scenario), !own, scenario.id)
        } finally {
          project.cleanup()
        }
      }
      assert.ok(ownCheckout > 0, 'expected scenarios that run in the current checkout')
      process.env['COPSE_EVAL_ALLOW_CURRENT_CHECKOUT'] = 'true'
      assert.ok(scenarios.some((scenario) => !evalMayChangeCheckout(scenario)))
      process.env['COPSE_EVAL_ALLOW_CURRENT_CHECKOUT'] = '1'
      assert.ok(scenarios.every((scenario) => evalMayChangeCheckout(scenario)))
    } finally {
      if (previous === undefined) delete process.env['COPSE_EVAL_ALLOW_CURRENT_CHECKOUT']
      else process.env['COPSE_EVAL_ALLOW_CURRENT_CHECKOUT'] = previous
    }
  })
})
