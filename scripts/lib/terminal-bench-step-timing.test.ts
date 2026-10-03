import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import {
  appendStepTimingSink,
  parseStepTimingLines,
  StepTimingRecorder,
  summarizeStepTiming,
  stepTimingEndOffset,
  type StepTimingRecord,
} from './terminal-bench-step-timing.mts'

function harness(): {
  recorder: StepTimingRecorder
  records: StepTimingRecord[]
  advance: (ms: number) => void
} {
  let clock = 1_000_000
  const records: StepTimingRecord[] = []
  const recorder = new StepTimingRecorder({
    sink: (record): void => {
      records.push(record)
    },
    now: (): number => clock,
  })
  return {
    recorder,
    records,
    advance: (ms): void => {
      clock += ms
    },
  }
}

function reasoning(text: string): AgentStreamChunk {
  return { type: 'reasoning', text }
}

function usage(inputTokens: number, outputTokens: number): AgentStreamChunk {
  return { type: 'usage', model: 'lmstudio:test', inputTokens, outputTokens }
}

describe('StepTimingRecorder', () => {
  it('splits a step into prefill, generation and tool time', () => {
    const { recorder, records, advance } = harness()
    recorder.stepStarted(1)
    advance(100)
    recorder.chunk({ type: 'prompt_progress', fraction: 0.5 })
    advance(200)
    recorder.chunk(reasoning('think'))
    advance(1_000)
    recorder.chunk({
      type: 'tool_call',
      toolCall: { id: 'c1', name: 'run_shell', args: { command: 'ls' } },
    })
    advance(10)
    recorder.chunk(usage(900, 120))
    advance(5)
    recorder.toolStarted('c1', 'run_shell')
    advance(2_500)
    recorder.toolFinished('c1', false)

    const streamEnd = records.find((record) => record.type === 'stream_end')
    assert.ok(streamEnd?.type === 'stream_end')
    assert.equal(streamEnd.step, 1)
    assert.equal(streamEnd.prefillMs, 300)
    assert.equal(streamEnd.generationMs, 1_000)
    assert.equal(streamEnd.modelMs, 1_310)
    assert.equal(streamEnd.maxChunkGapMs, 1_000)
    assert.equal(streamEnd.inputTokens, 900)
    assert.equal(streamEnd.outputTokens, 120)
    assert.equal(streamEnd.reasoningChars, 5)
    assert.deepEqual(streamEnd.toolCalls, ['run_shell'])

    const toolEnd = records.find((record) => record.type === 'tool_end')
    assert.ok(toolEnd?.type === 'tool_end')
    assert.equal(toolEnd.durationMs, 2_500)
    assert.equal(toolEnd.step, 1)
    assert.equal(toolEnd.failed, false)
  })

  it('closes a cut stream, which never reports usage, with its cut reason', () => {
    const { recorder, records, advance } = harness()
    recorder.stepStarted(4)
    advance(50)
    recorder.chunk(reasoning('abc'))
    advance(40_000)
    recorder.chunk(reasoning('def'))
    recorder.streamCut('reasoning_runaway_cap')
    recorder.finish()

    const ends = records.filter((record) => record.type === 'stream_end')
    assert.equal(ends.length, 1)
    const end = ends[0]
    assert.ok(end?.type === 'stream_end')
    assert.equal(end.cutReason, 'reasoning_runaway_cap')
    assert.equal(end.outputTokens, null)
    assert.equal(end.generationMs, 40_000)
    assert.equal(end.reasoningChars, 6)
  })

  it('ignores chunks that arrive after the stream has ended', () => {
    const { recorder, records, advance } = harness()
    recorder.stepStarted(1)
    recorder.chunk(usage(1, 1))
    advance(10)
    recorder.chunk(reasoning('late'))
    recorder.finish()
    assert.equal(records.filter((record) => record.type === 'stream_end').length, 1)
  })

  it('marks a tool that failed to return as failed', () => {
    const { recorder, records } = harness()
    recorder.stepStarted(1)
    recorder.toolStarted('c1', 'run_shell')
    recorder.toolFinished('c1', true)
    const end = records.find((record) => record.type === 'tool_end')
    assert.ok(end?.type === 'tool_end')
    assert.equal(end.failed, true)
  })
})

describe('stepTimingEndOffset', () => {
  it('excludes startup time before the recorder from the trailing gap', () => {
    const record: StepTimingRecord = {
      schemaVersion: 1,
      type: 'step_start',
      step: 1,
      tMs: 250,
      at: new Date(5250).toISOString(),
    }
    const offset = stepTimingEndOffset([record], new Date(7000).toISOString())
    assert.equal(offset, 2000)
    assert.equal(summarizeStepTiming([record], offset).trailingMs, 1750)
  })

  it('does not invent a trailing gap without a valid wall-clock anchor', () => {
    assert.equal(stepTimingEndOffset([], new Date(7000).toISOString()), undefined)
    const record: StepTimingRecord = {
      schemaVersion: 1,
      type: 'step_start',
      step: 1,
      tMs: 0,
      at: 'invalid',
    }
    assert.equal(stepTimingEndOffset([record], new Date(7000).toISOString()), undefined)
    assert.equal(stepTimingEndOffset([record], 'invalid'), undefined)
  })
})

describe('summarizeStepTiming', () => {
  it('attributes inter-step overhead and the trailing gap of a run killed mid-stream', () => {
    const { recorder, records, advance } = harness()
    recorder.stepStarted(1)
    advance(1_000)
    recorder.chunk(reasoning('x'))
    recorder.chunk(usage(10, 10))
    recorder.toolStarted('c1', 'run_shell')
    advance(2_000)
    recorder.toolFinished('c1', false)
    advance(300)
    recorder.stepStarted(2)
    advance(5_000)
    recorder.chunk(reasoning('y'))
    // Run killed here: step 2 never ends and nothing more is written.

    const summary = summarizeStepTiming(records, 600_000)
    assert.equal(summary.steps, 1)
    assert.equal(summary.modelMs, 1_000)
    assert.equal(summary.toolMs, 2_000)
    assert.equal(summary.overheadMs, 300)
    assert.equal(summary.openStep, 2)
    assert.equal(summary.trailingMs, 600_000 - 3_300)
  })

  it('reports no open step and no trailing gap for a clean run', () => {
    const { recorder, records, advance } = harness()
    recorder.stepStarted(1)
    advance(500)
    recorder.chunk(usage(1, 1))
    recorder.finish()
    const summary = summarizeStepTiming(records)
    assert.equal(summary.openStep, null)
    assert.equal(summary.trailingMs, null)
  })

  it('flags a tool that started and never finished as the open step', () => {
    const { recorder, records, advance } = harness()
    recorder.stepStarted(1)
    recorder.chunk(usage(1, 1))
    recorder.toolStarted('c1', 'run_shell')
    advance(10)
    assert.equal(summarizeStepTiming(records).openStep, 1)
  })
})

describe('appendStepTimingSink', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-step-timing-'))
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('appends one JSON line per record so a killed run keeps what was written', () => {
    const path = join(root, 'agent', 'step-timing.jsonl')
    const recorder = new StepTimingRecorder({ sink: appendStepTimingSink(path) })
    recorder.stepStarted(1)
    recorder.stepStarted(2)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    assert.deepEqual(
      parseStepTimingLines(lines.join('\n')).map((record) => record.type),
      ['step_start', 'stream_end', 'step_start'],
    )
  })
})

describe('parseStepTimingLines', () => {
  it('round-trips records and skips truncated or foreign lines', () => {
    const { recorder, records, advance } = harness()
    recorder.stepStarted(1)
    advance(10)
    recorder.chunk(usage(1, 2))
    const text = [
      ...records.map((record) => JSON.stringify(record)),
      '{"type":"step_st',
      '{"x":1}',
      '',
    ].join('\n')
    assert.deepEqual(parseStepTimingLines(text), records)
  })
})
