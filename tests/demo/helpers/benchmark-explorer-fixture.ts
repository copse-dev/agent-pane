import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BenchTranscript } from '../../../scripts/lib/bench-transcript.mts'
import { buildBenchmarkSite } from '../../../scripts/lib/benchmark-catalog.mts'

interface FixtureTrial {
  attempt: number
  inputTokens: number
  outputTokens: number
  profile: 'skills-none@1' | 'skills-product@1'
  reward: number
  runId: string
  toolCalls: number
}

function writeTrial(root: string, fixture: FixtureTrial): void {
  const task = 'court-form-filling'
  const id = `${task}__${fixture.profile.replace('@', '-')}__attempt-${String(fixture.attempt)}`
  const capsule = join(root, id)
  const threadDirectory = join(capsule, 'thread')
  mkdirSync(capsule, { recursive: true })
  let sequence = 0
  const transcript = new BenchTranscript(
    threadDirectory,
    'Complete the supplied court form, preserve every existing field, and save the result.',
    'gpt-5.4',
    {
      now: 1_777_000_000_000,
      idFactory: (): string => `${id}-${String(++sequence)}`,
      projectId: 'skillsbench',
    },
  )
  transcript.record({
    type: 'reasoning',
    text:
      fixture.profile === 'skills-product@1'
        ? 'The product skill says to inspect the form structure before editing it.'
        : 'I will inspect the supplied files and fill the form directly.',
  })
  transcript.record({
    type: 'tool_call',
    toolCall: {
      id: `${id}-shell`,
      name: 'run_shell',
      args: {
        command: 'find . -maxdepth 2 -type f -print',
        untrusted_note: '</pre><img src=x onerror="document.body.dataset.injected=1">',
      },
    },
  })
  transcript.record({
    type: 'tool_result',
    toolCallId: `${id}-shell`,
    result: './intake/form.docx\n./intake/client.json',
    isError: false,
  })
  transcript.record({
    type: 'text',
    text:
      fixture.reward >= 0.99
        ? 'The completed form is saved at output/completed-form.docx.'
        : 'I inspected the intake directory but did not finish the form.',
  })
  transcript.record({
    type: 'usage',
    model: 'gpt-5.4',
    inputTokens: fixture.inputTokens,
    outputTokens: fixture.outputTokens,
  })
  transcript.record({ type: 'done', stopReason: 'end_turn' })
  transcript.write()
  writeFileSync(
    join(capsule, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      benchmark: { id: 'skillsbench', version: '1.1' },
      task: { name: task },
      profile: { id: fixture.profile },
      runId: fixture.runId,
      createdAt: '2026-08-26T20:00:00.000Z',
      sourceCommit: '5a71c0de',
      model: 'gpt-5.4',
      attempt: fixture.attempt,
      elapsedSeconds: fixture.reward >= 0.99 ? 187.4 : 98.6,
      officialReward: fixture.reward,
      result: {
        n_tool_calls: fixture.toolCalls,
        n_skill_invocations: fixture.profile === 'skills-product@1' ? 1 : 0,
        n_input_tokens: fixture.inputTokens,
        n_output_tokens: fixture.outputTokens,
        error: null,
        verifier_error: null,
        partial_trajectory: false,
      },
    })}\n`,
  )
}

function writeTerminalTrial(root: string): void {
  const task = 'regex-log'
  const id = `${task}__main-3__attempt-1`
  const trial = join(root, id)
  const threadDirectory = join(trial, 'agent', 'thread')
  mkdirSync(trial, { recursive: true })
  let sequence = 0
  const transcript = new BenchTranscript(
    threadDirectory,
    'Repair the log parser and validate it against the supplied fixtures.',
    'gpt-5.4',
    {
      now: 1_777_050_000_000,
      idFactory: (): string => `${id}-${String(++sequence)}`,
      projectId: 'terminal-bench',
    },
  )
  transcript.record({ type: 'reasoning', text: 'I will reproduce the parser failure first.' })
  transcript.record({
    type: 'tool_call',
    toolCall: { id: `${id}-shell`, name: 'run_shell', args: { command: 'pytest -q' } },
  })
  transcript.record({
    type: 'tool_result',
    toolCallId: `${id}-shell`,
    result: '12 passed',
    isError: false,
  })
  transcript.record({ type: 'text', text: 'The parser now handles the malformed prefix.' })
  transcript.record({ type: 'done', stopReason: 'end_turn' })
  transcript.write()
  writeFileSync(
    join(trial, 'run-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      trialId: id,
      suiteRunId: 'terminal-nightly-7',
      createdAt: '2026-08-27T00:30:00.000Z',
      task: {
        name: task,
        attemptIndex: 1,
        startedAt: '2026-08-27T00:15:00.000Z',
        finishedAt: '2026-08-27T00:30:00.000Z',
        reward: 1,
        exception: null,
      },
      model: 'gpt-5.4',
      dataset: { id: 'terminal-bench', version: '2.1' },
      profile: { id: 'main', versionedId: 'main@3' },
      source: { commit: '7e2b91af' },
      metrics: {
        elapsedSeconds: 900,
        inputTokens: 9_200,
        outputTokens: 1_100,
        toolCalls: 8,
      },
    })}\n`,
  )
}

export async function prepareBenchmarkExplorerFixture(): Promise<void> {
  const fixtureRoot = resolve('dist/demo-benchmark-artifacts')
  const terminalRoot = resolve('dist/demo-terminal-benchmark-artifacts')
  const outputRoot = resolve('dist/demo/benchmarks')
  rmSync(fixtureRoot, { recursive: true, force: true })
  rmSync(terminalRoot, { recursive: true, force: true })
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(fixtureRoot, { recursive: true })
  mkdirSync(terminalRoot, { recursive: true })
  for (const fixture of [
    {
      attempt: 1,
      inputTokens: 982,
      outputTokens: 273,
      profile: 'skills-product@1',
      reward: 0,
      runId: 'skills-study-a-shard-0',
      toolCalls: 2,
    },
    {
      attempt: 2,
      inputTokens: 17_824,
      outputTokens: 1_619,
      profile: 'skills-product@1',
      reward: 0.83,
      runId: 'skills-study-a-shard-0',
      toolCalls: 14,
    },
    {
      attempt: 1,
      inputTokens: 15_601,
      outputTokens: 1_202,
      profile: 'skills-none@1',
      reward: 1,
      runId: 'skills-study-a-shard-0',
      toolCalls: 11,
    },
    {
      attempt: 2,
      inputTokens: 16_240,
      outputTokens: 1_410,
      profile: 'skills-none@1',
      reward: 1,
      runId: 'skills-study-a-shard-0',
      toolCalls: 12,
    },
  ] satisfies FixtureTrial[]) {
    writeTrial(fixtureRoot, fixture)
  }
  writeTerminalTrial(terminalRoot)
  await buildBenchmarkSite({
    artifactRoots: [fixtureRoot, terminalRoot],
    outputDir: outputRoot,
    generatedAt: new Date('2026-08-27T01:00:00.000Z'),
  })
}
