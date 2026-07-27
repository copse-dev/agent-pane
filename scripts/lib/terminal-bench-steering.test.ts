import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { LLMProvider } from '../../packages/llm/src/wire-types.ts'
import { recordTerminalBenchProviderRequests } from './terminal-bench-provider-recorder.mts'
import {
  loadTerminalBenchSteering,
  parseTerminalBenchSteering,
  terminalBenchSteeringPrompt,
} from './terminal-bench-steering.mts'
import { expectRecord } from '../../src/shared/unknown-value.mts'

const root = mkdtempSync(join(tmpdir(), 'copse-terminal-steering-'))
after(() => {
  rmSync(root, { recursive: true, force: true })
})

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return expectRecord(value)[key]
}

const validSteering = {
  schema_version: 1,
  parent_trial_id: 'trial-parent',
  diagnosis: ['The first attempt repeated a failed assumption.'],
  prompt_patch: 'Validate the input format before implementing.',
  nudges: [{ trigger: 'after_tool_errors:2', message: 'Reassess the assumption.' }],
  recommended_step_budget: 90,
  confidence: 0.8,
}

describe('terminal benchmark steering', () => {
  it('validates, fingerprints, and formats an analyst intervention', () => {
    const path = join(root, 'steering.json')
    writeFileSync(path, `${JSON.stringify(validSteering)}\n`)
    const first = loadTerminalBenchSteering(path)
    const second = loadTerminalBenchSteering(path)

    assert.deepEqual(first.steering, validSteering)
    assert.equal(first.interventionId, second.interventionId)
    assert.match(first.interventionId, /^[a-f0-9]{24}$/)
    assert.match(terminalBenchSteeringPrompt(first.steering), /fallible guidance/)
    assert.match(terminalBenchSteeringPrompt(first.steering), /Validate the input format/)
  })

  it('rejects unbounded or incomplete steering', () => {
    assert.throws(
      () => parseTerminalBenchSteering({ ...validSteering, prompt_patch: '' }),
      /prompt_patch must be a non-empty string/,
    )
    assert.throws(
      () => parseTerminalBenchSteering({ ...validSteering, confidence: 2 }),
      /confidence must be a number from 0 through 1/,
    )
  })

  it('records the exact normalized request before forwarding the provider stream', async () => {
    const path = join(root, 'provider-requests.jsonl')
    const provider: LLMProvider = {
      async *stream() {
        yield { type: 'text', text: 'done' }
        yield { type: 'done', stopReason: 'stop' }
      },
    }
    const recorded = recordTerminalBenchProviderRequests(provider, path)
    const messages = [{ role: 'user' as const, content: 'solve this' }]
    const tools = [
      {
        name: 'run_shell',
        description: 'Run a command',
        parameters: { type: 'object' },
      },
    ]
    const chunks = []
    for await (const chunk of recorded.stream(messages, tools)) chunks.push(chunk)

    assert.deepEqual(chunks, [
      { type: 'text', text: 'done' },
      { type: 'done', stopReason: 'stop' },
    ])
    const line: unknown = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(field(line, 'type'), 'request')
    assert.deepEqual(field(line, 'messages'), messages)
    assert.deepEqual(field(line, 'tools'), tools)
  })
})
