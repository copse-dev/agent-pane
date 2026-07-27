import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { at } from '../../src/shared/array-utils.ts'
import { foldThread } from '../../src/shared/threads/fold.ts'
import { parseSpine, type ThreadMeta } from '../../src/shared/threads/spine-schema.ts'
import type { StreamCutRecord } from '../../packages/agent/src/stream-cut-record.ts'
import type { ReasoningCheckpointRecord } from '../../packages/agent/src/reasoning-circle-detector.ts'
import { BenchTranscript } from './bench-transcript.mts'

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8').trim()) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value))
  return value
}

const root = mkdtempSync(join(tmpdir(), 'copse-terminal-transcript-'))
after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('terminal benchmark transcript', () => {
  it('writes the normal thread-store layout and portable export', () => {
    let nextId = 0
    const directory = join(root, 'thread')
    const transcript = new BenchTranscript(directory, 'Solve the task', 'local/model', {
      now: 100,
      idFactory: (): string => `id-${String(++nextId)}`,
    })
    transcript.record({ type: 'reasoning', text: 'Inspect first.' })
    transcript.record({
      type: 'tool_call',
      toolCall: { id: 'tool-1', name: 'run_shell', args: { command: 'pwd' } },
    })
    transcript.record({
      type: 'tool_result',
      toolCallId: 'tool-1',
      result: 'exit=0\nstdout:\n/app',
      isError: false,
    })
    transcript.record({ type: 'reasoning', text: 'Now finish.' })
    transcript.record({ type: 'text', text: 'Completed.' })
    transcript.record({
      type: 'usage',
      model: 'local/model',
      inputTokens: 12,
      outputTokens: 4,
    })
    transcript.record({ type: 'done', stopReason: 'stop' })
    const cut: StreamCutRecord = {
      step: 2,
      cutReason: 'reasoning_runaway_cap',
      streamOutputChars: 16_000,
      streamReasoningChars: 12_000,
      reasoningText: 'Repeated planning.',
      reasoningTextTruncated: false,
      hasToolCalls: false,
      toolCallCount: 0,
      stopReason: 'max_tokens',
      streamCappedAsRunaway: true,
      reasoningRunawayStreak: 0,
      willInjectReasoningRunawayNudge: true,
    }
    transcript.recordStreamCut(cut)
    const checkpoint: ReasoningCheckpointRecord = {
      step: 2,
      checkpointTokens: 2_048,
      hardMaxTokens: 32_000,
      streamOutputChars: 8_192,
      streamReasoningChars: 8_192,
      visibleTextChars: 0,
      decision: 'continue',
      signals: [],
    }
    transcript.recordReasoningCheckpoint(checkpoint)
    transcript.recordHookRun({
      event: 'stepBoundary',
      hookId: 'reasoning-runaway',
      startedAt: 200,
      durationMs: 1,
      outcome: { injectContext: 'Use a tool now.' },
    })
    transcript.recordAppliedNudge({
      step: 2,
      hookId: 'reasoning-runaway',
      mechanism: 'tool-enabled-message',
      text: 'Use a tool now.',
    })
    transcript.write()

    const meta = asRecord(readJson(join(directory, 'meta.json'))) as ThreadMeta
    const spine = parseSpine(readFileSync(join(directory, 'events.jsonl'), 'utf8'))
    const hash = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')
    const folded = foldThread(meta, spine, (ref) => readFileSync(join(directory, ref), 'utf8'), {
      hash,
    })

    assert.equal(folded.status, 'idle')
    assert.equal(folded.messages.length, 3)
    assert.equal(at(folded.messages, 0).content, 'Solve the task')
    assert.equal(at(folded.messages, 1).reasoning, 'Inspect first.')
    assert.equal(at(at(folded.messages, 1).toolCalls, 0).result, 'exit=0\nstdout:\n/app')
    assert.equal(at(folded.messages, 2).reasoning, 'Now finish.')
    assert.equal(at(folded.messages, 2).content, 'Completed.')
    assert.deepEqual(folded.usage.byModel?.['local/model'], {
      inputTokens: 12,
      outputTokens: 4,
    })

    const exported = readFileSync(join(directory, 'thread.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line) as unknown) as { type: string; content?: string })
    assert.equal(exported[0]?.type, 'thread')
    assert.equal(exported.at(-1)?.content, 'Completed.')

    const streamStat = asRecord(readJson(join(root, 'stream-stats.jsonl')))
    assert.equal(streamStat['schemaVersion'], 1)
    assert.equal(streamStat['threadId'], 'id-1')
    assert.equal(streamStat['turnId'], 'id-2')
    assert.equal(streamStat['model'], 'local/model')
    assert.equal(streamStat['totalTokensEstimate'], 4_000)
    assert.equal(streamStat['reasoningTokensEstimate'], 3_000)
    assert.equal(streamStat['reasoningText'], 'Repeated planning.')

    const reasoningCheckpoint = asRecord(readJson(join(root, 'reasoning-checkpoints.jsonl')))
    assert.equal(reasoningCheckpoint['threadId'], 'id-1')
    assert.equal(reasoningCheckpoint['checkpointTokens'], 2_048)
    assert.equal(reasoningCheckpoint['hardMaxTokens'], 32_000)
    assert.equal(reasoningCheckpoint['decision'], 'continue')

    const hookRun = asRecord(readJson(join(root, 'hook-runs.jsonl')))
    assert.equal(hookRun['schemaVersion'], 1)
    assert.equal(hookRun['threadId'], 'id-1')
    assert.equal(hookRun['hookId'], 'reasoning-runaway')
    assert.deepEqual(hookRun['outcome'], { injectContext: 'Use a tool now.' })

    const appliedNudge = asRecord(readJson(join(root, 'applied-nudges.jsonl')))
    assert.equal(appliedNudge['schemaVersion'], 1)
    assert.equal(appliedNudge['threadId'], 'id-1')
    assert.equal(appliedNudge['mechanism'], 'tool-enabled-message')
    assert.equal(appliedNudge['text'], 'Use a tool now.')
  })
})
