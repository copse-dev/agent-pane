import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ORCHESTRATION_WORKER_TOOL_NAMES,
  buildStepObservation,
  buildWorkerTask,
  validateOrchestrationPair,
} from './orchestration-strategy.ts'

describe('buildWorkerTask', () => {
  it('formats step, context, workspace and closing instruction deterministically', () => {
    const task = buildWorkerTask({
      step: 'Add a --verbose flag to the CLI',
      context: 'Flags are parsed in src/cli.ts using parseArgs; follow the --quiet flag pattern.',
      workspace: '/repo',
    })
    assert.equal(
      task,
      [
        '# Delegated step\nAdd a --verbose flag to the CLI',
        '# Context from the orchestrator\nFlags are parsed in src/cli.ts using parseArgs; follow the --quiet flag pattern.',
        'Workspace: /repo',
        'Implement this step now, then finish with your report for the orchestrator.',
      ].join('\n\n'),
    )
  })

  it('includes the expected outcome section only when provided and non-blank', () => {
    const withOutcome = buildWorkerTask({
      step: 's',
      context: 'c',
      expectedOutcome: 'npm test passes',
      workspace: '/repo',
    })
    assert.ok(withOutcome.includes('# Expected outcome\nnpm test passes'))

    const blankOutcome = buildWorkerTask({
      step: 's',
      context: 'c',
      expectedOutcome: '   ',
      workspace: '/repo',
    })
    assert.ok(!blankOutcome.includes('# Expected outcome'))
  })

  it('never includes a conversation transcript — the brief is the worker’s whole world', () => {
    const task = buildWorkerTask({ step: 's', context: 'c', workspace: '/repo' })
    assert.ok(!task.includes('## User'))
    assert.ok(!task.includes('## Assistant'))
  })
})

describe('buildStepObservation', () => {
  it('appends the working-tree snapshot after the worker report', () => {
    const observation = buildStepObservation({
      report: 'Added the flag; npm test passes.',
      workingTree: 'M src/cli.ts\n?? src/cli.test.ts',
    })
    assert.equal(
      observation,
      'Added the flag; npm test passes.\n\n---\nWorking tree after this step (git status --short):\nM src/cli.ts\n?? src/cli.test.ts',
    )
  })

  it('returns just the report when the tree snapshot is empty', () => {
    assert.equal(buildStepObservation({ report: 'done', workingTree: '  ' }), 'done')
  })

  it('substitutes a placeholder when the worker returned no report', () => {
    const observation = buildStepObservation({ report: '  ', workingTree: 'M a.ts' })
    assert.ok(observation.startsWith('Worker returned no report.'))
  })
})

describe('validateOrchestrationPair', () => {
  it('refuses delegating to the same model', () => {
    const a = validateOrchestrationPair('claude-haiku-4-5', 'claude-haiku-4-5')
    assert.equal(a.ok, false)
    assert.match(a.reason, /same model/i)
  })

  it('endorses a cheaper worker under a stronger orchestrator', () => {
    const a = validateOrchestrationPair('claude-opus-4-8', 'claude-haiku-4-5')
    assert.equal(a.ok, true)
    assert.match(a.reason, /cheaper worker/i)
  })

  it('allows but flags a worker that is not cheaper than the orchestrator', () => {
    const a = validateOrchestrationPair('claude-haiku-4-5', 'claude-opus-4-8')
    assert.equal(a.ok, true)
    assert.match(a.reason, /not cheaper/i)
  })

  it('assumes unknown (e.g. local) workers are cheaper and allows them', () => {
    const a = validateOrchestrationPair('claude-opus-4-8', 'lmstudio:qwen-coder')
    assert.equal(a.ok, true)
    assert.match(a.reason, /cheaper worker/i)
  })
})

describe('ORCHESTRATION_WORKER_TOOL_NAMES', () => {
  it('grants implementation tools (reads, edits, shell, git inspection)', () => {
    for (const name of ['read_file', 'write_file', 'str_replace', 'run_shell', 'git_diff']) {
      assert.ok(
        (ORCHESTRATION_WORKER_TOOL_NAMES as readonly string[]).includes(name),
        `expected worker tool ${name}`,
      )
    }
  })

  it('withholds integration, nesting, and user-facing tools from the worker', () => {
    for (const name of ['git_commit', 'explore', 'investigate_ci', 'ask_user', 'delegate_step']) {
      assert.ok(
        !(ORCHESTRATION_WORKER_TOOL_NAMES as readonly string[]).includes(name),
        `worker must not get ${name}`,
      )
    }
  })
})
