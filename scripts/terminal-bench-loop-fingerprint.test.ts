import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'
import {
  terminalBenchLoopOptions,
  terminalBenchRuntimeConfiguration,
} from './terminal-bench-agent-lib.mts'

/**
 * Behavioural fingerprint of product-aligned@4.
 *
 * A profile's hash covers the settings the host passes to `runAgentLoop`, but
 * not the loop code that interprets them. #1242 and #1413 changed that code and
 * silently changed what product-aligned@3 did. These scripted streams exercise
 * every mechanism v4 relies on, through exactly the options the Terminal-Bench
 * host builds, and pin the decisions the loop makes.
 *
 * If this test fails, the product loop now treats v4 runs differently. Do not
 * update the expectation in place: retire product-aligned@4, add a new version
 * whose fingerprint is the new behaviour, and record why in
 * docs/spikes/terminal-bench-2.1-profile-ablation.md.
 */

const CHARS_PER_CHECKPOINT = 2_048 * 4

interface Fingerprint {
  streams: number
  checkpoints: string[]
  cuts: string[]
  nudges: string[]
}

/** Collapse consecutive repeats so a long recovery loop stays readable. */
function runs(values: readonly string[]): string[] {
  const collapsed: Array<{ value: string; count: number }> = []
  for (const value of values) {
    const last = collapsed.at(-1)
    if (last?.value === value) last.count++
    else collapsed.push({ value, count: 1 })
  }
  return collapsed.map(({ value, count }) => (count > 1 ? `${value} x${String(count)}` : value))
}

function distinctReasoning(chars: number, label: string): ProviderStreamChunk[] {
  const chunks: ProviderStreamChunk[] = []
  let length = 0
  for (let index = 0; length < chars; index++) {
    const text = `Consider ${label} detail ${String(index)} with offset ${String(index * 37)}. `
    chunks.push({ type: 'reasoning', text })
    length += text.length
  }
  return chunks
}

function repeated(type: 'reasoning' | 'text', unit: string, chars: number): ProviderStreamChunk[] {
  return Array.from({ length: Math.ceil(chars / unit.length) }, () => ({ type, text: unit }))
}

async function fingerprint(
  streams: (call: number) => ProviderStreamChunk[],
  toolOutput = 'total 0',
): Promise<Fingerprint> {
  const profile = terminalBenchProfile('product-aligned@4')
  let streamCount = 0
  const checkpoints: string[] = []
  const cuts: string[] = []
  const nudges: string[] = []
  const provider: LLMProvider = {
    async *stream(): AsyncGenerator<ProviderStreamChunk> {
      streamCount++
      for (const chunk of streams(streamCount)) yield chunk
    },
  }
  await runAgentLoop({
    provider,
    messages: [{ role: 'user', content: 'Write /app/answer.txt' }],
    tools: [{ name: 'run_shell', description: 'run', parameters: { type: 'object' } }],
    // Real defaults, with a smaller step budget so a recovery loop ends quickly.
    ...terminalBenchLoopOptions(
      profile,
      { ...terminalBenchRuntimeConfiguration(profile, {}), maxSteps: 12, maxLlmCalls: 15 },
      'Write /app/answer.txt',
    ),
    onChunk: () => {},
    executeTool: async () => toolOutput,
    recordReasoningCheckpoint: (record) =>
      checkpoints.push(
        `${record.decision}@${String(record.checkpointTokens)} [${record.signals.join(',')}]`,
      ),
    recordStreamCut: (record) =>
      cuts.push(`${record.cutReason}@${String(record.streamOutputTokenLimit)}`),
    recordAppliedNudge: (record) => nudges.push(`${record.hookId}/${record.mechanism}`),
  })
  return {
    streams: streamCount,
    checkpoints: runs(checkpoints),
    cuts: runs(cuts),
    nudges: runs(nudges),
  }
}

const ANSWER =
  'The answer has been written to /app/answer.txt and the focused check passes. ' +
  'It contains the reconstructed configuration with every requested key present, ' +
  'the values validated against the schema, and the original inputs left untouched. ' +
  'No further edits are required for the requested deliverable at this point.'

describe('product-aligned@4 loop fingerprint', () => {
  it('expands clean reasoning checkpoint by checkpoint', async () => {
    const actual = await fingerprint((call) =>
      call === 1
        ? [
            ...distinctReasoning(CHARS_PER_CHECKPOINT * 2.5, 'clean'),
            { type: 'tool_call', toolCall: { id: 'a', name: 'run_shell', args: {} } },
            { type: 'done' },
          ]
        : [{ type: 'text', text: 'Done.' }, { type: 'done' }],
    )
    assert.deepEqual(actual, {
      streams: 2,
      checkpoints: ['continue@2048 []', 'continue@4096 []'],
      cuts: [],
      nudges: [],
    })
  })

  it('cuts self-reported circling into one bounded recovery stream', async () => {
    const actual = await fingerprint((call) =>
      call === 1
        ? [
            { type: 'reasoning', text: "I think I'm overcomplicating this. " },
            ...distinctReasoning(CHARS_PER_CHECKPOINT * 2, 'circling'),
            { type: 'done' },
          ]
        : [{ type: 'text', text: 'Recovered.' }, { type: 'done' }],
    )
    assert.deepEqual(actual, {
      streams: 2,
      checkpoints: ['cut@2048 [self_reported_circle]'],
      cuts: ['reasoning_circle_detected@2048'],
      nudges: ['reasoning-runaway/tool-enabled-message'],
    })
  })

  it('ends a post-answer reasoning loop on the 2K visible ceiling, not #1242’s trailing budget', async () => {
    // The trailing-reasoning budget only counts reasoning after an answer
    // longer than the 256-char preamble tolerance, and such a stream is
    // already held to the profile's 2K maxNonReasoningTokens — so in this
    // profile the ordinary cap always fires first and the loop re-primes.
    const actual = await fingerprint(() => [
      { type: 'text', text: ANSWER },
      ...repeated(
        'reasoning',
        'I should double-check that the configuration file has every requested key present. ',
        CHARS_PER_CHECKPOINT * 3,
      ),
      { type: 'done' },
    ])
    assert.deepEqual(actual, {
      streams: 15,
      checkpoints: [],
      cuts: ['reasoning_runaway_cap@2048 x12'],
      nudges: ['truncation-continue/tool-enabled-message x12', 'finalize-nudge/tool-enabled-turn'],
    })
  })

  it('caps repeated visible text at the 2K ceiling before #1413’s text-repeat check', async () => {
    const actual = await fingerprint((call) =>
      call === 1
        ? [
            ...repeated(
              'text',
              'The configuration now includes every requested key and passes validation. ',
              CHARS_PER_CHECKPOINT * 2,
            ),
            { type: 'done' },
          ]
        : [{ type: 'text', text: 'Done.' }, { type: 'done' }],
    )
    assert.deepEqual(actual, {
      streams: 2,
      checkpoints: [],
      cuts: ['reasoning_runaway_cap@2048'],
      nudges: ['truncation-continue/tool-enabled-message'],
    })
  })

  it('cuts the same short reasoning turn repeated across calls (#1413)', async () => {
    const actual = await fingerprint(() => [
      { type: 'reasoning', text: 'Let me look at the configuration file again.' },
      { type: 'done' },
    ])
    assert.deepEqual(actual, {
      streams: 4,
      checkpoints: [],
      cuts: ['reasoning_circle_detected@2048 x2'],
      nudges: ['reasoning-runaway/tool-enabled-message'],
    })
  })

  it('nudges prolonged inspection toward an edit instead of forcing a text answer', async () => {
    let call = 0
    const actual = await fingerprint(
      () => {
        call++
        return [
          {
            type: 'tool_call',
            toolCall: { id: `ls-${String(call)}`, name: 'run_shell', args: { command: 'ls' } },
          },
          { type: 'done' },
        ]
      },
      // Large enough to build the conversation pressure that selects the
      // stuck-finalize nudge within the step budget.
      'drwxr-xr-x 2 root root 4096 config.d\n'.repeat(400),
    )
    assert.deepEqual(actual, {
      streams: 15,
      checkpoints: [],
      cuts: [],
      nudges: [
        'loop-nudge/tool-enabled-message',
        // allowForcedTextEscalation: false keeps tools available here.
        'stuck-finalize-nudge/tool-enabled-message',
        'finalize-nudge/tool-enabled-turn x3',
      ],
    })
  })
})
