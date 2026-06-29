import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import type { DetectedAcpAgent } from '@shared/acp-known-agents.ts'
import {
  detectedToConfig,
  formatArgsText,
  formatEnvText,
  parseArgsText,
  parseEnvText,
  removeAgent,
  slugify,
  upsertAgent,
  validateDraft,
} from './acp-agents-section.ts'

describe('env parse/format round-trip', () => {
  it('parses KEY=value lines and skips blanks and malformed lines', () => {
    const env = parseEnvText('GEMINI_API_KEY=abc\n\nFLAG = 1 \nnoequals\n=novalue')
    assert.deepEqual(env, { GEMINI_API_KEY: 'abc', FLAG: '1' })
  })

  it('formats an env record back to lines', () => {
    assert.equal(formatEnvText({ A: '1', B: '2' }), 'A=1\nB=2')
    assert.equal(formatEnvText(undefined), '')
  })
})

describe('args parse/format', () => {
  it('treats one argument per line, trimming and dropping blanks', () => {
    assert.deepEqual(parseArgsText(' --experimental-acp \n\n--foo\n'), [
      '--experimental-acp',
      '--foo',
    ])
    assert.equal(formatArgsText(['--a', '--b']), '--a\n--b')
    assert.equal(formatArgsText(undefined), '')
  })
})

describe('slugify', () => {
  it('lowercases and dash-joins, trimming stray dashes', () => {
    assert.equal(slugify('Gemini CLI'), 'gemini-cli')
    assert.equal(slugify('  Claude  Code!  '), 'claude-code')
  })
})

describe('upsertAgent / removeAgent', () => {
  const base: AcpAgentConfig[] = [
    { id: 'a', title: 'A', command: 'a', enabled: true },
    { id: 'b', title: 'B', command: 'b', enabled: true },
  ]

  it('replaces an existing agent by id without reordering', () => {
    const next = upsertAgent(base, { id: 'a', title: 'A2', command: 'a', enabled: false })
    assert.equal(next.length, 2)
    const first = next[0]
    assert.ok(first)
    assert.equal(first.title, 'A2')
    assert.equal(first.enabled, false)
  })

  it('appends a new agent', () => {
    const next = upsertAgent(base, { id: 'c', title: 'C', command: 'c', enabled: true })
    assert.deepEqual(
      next.map((a) => a.id),
      ['a', 'b', 'c'],
    )
  })

  it('removes by id', () => {
    assert.deepEqual(
      removeAgent(base, 'a').map((a) => a.id),
      ['b'],
    )
  })
})

describe('detectedToConfig', () => {
  it('blanks env-hint values and keeps args when present', () => {
    const detected: DetectedAcpAgent = {
      id: 'gemini-cli',
      title: 'Gemini CLI',
      command: 'gemini',
      args: ['--experimental-acp'],
      envHints: ['GEMINI_API_KEY'],
      installed: true,
      path: '/usr/bin/gemini',
      running: false,
    }
    assert.deepEqual(detectedToConfig(detected), {
      id: 'gemini-cli',
      title: 'Gemini CLI',
      command: 'gemini',
      args: ['--experimental-acp'],
      env: { GEMINI_API_KEY: '' },
      enabled: true,
    })
  })

  it('omits args and env when the agent has none', () => {
    const detected: DetectedAcpAgent = {
      id: 'bare',
      title: 'Bare',
      command: 'bare',
      args: [],
      installed: true,
      path: '/usr/bin/bare',
      running: true,
    }
    assert.deepEqual(detectedToConfig(detected), {
      id: 'bare',
      title: 'Bare',
      command: 'bare',
      enabled: true,
    })
  })
})

describe('validateDraft', () => {
  it('accepts a well-formed, unique draft', () => {
    assert.equal(validateDraft({ id: 'gemini-cli', title: 'Gemini', command: 'gemini' }, []), null)
  })

  it('rejects a bad slug, a duplicate id, and missing fields', () => {
    assert.match(validateDraft({ id: 'Bad Id', title: 'x', command: 'x' }, []) ?? '', /slug/)
    assert.match(validateDraft({ id: 'dup', title: 'x', command: 'x' }, ['dup']) ?? '', /already/)
    assert.match(validateDraft({ id: 'ok', title: ' ', command: 'x' }, []) ?? '', /Title/)
    assert.match(validateDraft({ id: 'ok', title: 'x', command: '' }, []) ?? '', /Command/)
  })
})
