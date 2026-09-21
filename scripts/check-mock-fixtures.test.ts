import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { glob, readFile } from 'node:fs/promises'
import { mockConversationLeaks } from '../tests/e2e/helpers/mock-content.ts'
import { isExecutableMockFixturePath, mockFixtureSourceLeaks } from './mock-fixture-source-guard.ts'

const EXECUTABLE_FIXTURE_SOURCES = [
  'tests/e2e/**/*.{ts,mts,cts,js,mjs,cjs,json}',
  'tests/demo/**/*.{ts,mts,cts,js,mjs,cjs,json}',
  'src/main/services/acp/**/*.test.ts',
  'benchmarks/**/*.json',
]

describe('natural conversation fixtures', () => {
  it('keeps transcript plumbing and retired bridge APIs out of executable fixtures', async () => {
    const offending = new Map<string, string[]>()
    for (const pattern of EXECUTABLE_FIXTURE_SOURCES) {
      for await (const file of glob(pattern)) {
        if (!isExecutableMockFixturePath(file)) continue
        const content = await readFile(file, 'utf8')
        const leaks = [...mockConversationLeaks([content]), ...mockFixtureSourceLeaks(content)]
        if (leaks.length > 0) offending.set(file, leaks)
      }
    }
    assert.deepEqual(
      [...offending],
      [],
      'Register a conversation scenario; keep both sides of the chat natural',
    )
  })

  it('allows ordinary tool names and documentation about mock providers', () => {
    assert.deepEqual(
      mockConversationLeaks([
        'Read packages/llm/src/mock-provider.ts and explain how MCP tools work.',
        'The checkup reports that the built-in mock LLM is enabled.',
        'Listed directory',
      ]),
      [],
    )
  })

  it('covers nested helpers, demo, ACP, and benchmark fixture paths', () => {
    for (const path of [
      'tests/e2e/nested/chat.e2e.ts',
      'tests/e2e/helpers/nested/fixture.ts',
      'tests/e2e/fixtures/model-server.mts',
      'tests/demo/helpers/conversation.js',
      'tests/demo/nested/chat.demo.ts',
      'src/main/services/acp/acp-app-entry.test.ts',
      'benchmarks/agent-packs/nested/conversation.json',
    ]) {
      assert.equal(isExecutableMockFixturePath(path), true, path)
    }
    assert.equal(isExecutableMockFixturePath('tests/e2e/helpers/mock-content.ts'), false)
    assert.equal(isExecutableMockFixturePath('src/shared/llm/mock-provider.ts'), false)
  })

  it('rejects legacy bridge calls, computed properties, and types without policing prose', () => {
    assert.deepEqual(
      mockFixtureSourceLeaks(`
        import { setMockScript, type MockScriptStep } from '@copse/llm'
        const script: MockScriptStep[] = []
        await bridge.setMockScript(script)
      `),
      ['setMockScript', 'MockScriptStep'],
    )
    assert.deepEqual(mockFixtureSourceLeaks("await bridge['setMockScript'](script)"), [
      'setMockScript',
    ])
    assert.deepEqual(mockFixtureSourceLeaks("await bridge['clearMockScript']()"), [
      'clearMockScript',
    ])
    assert.deepEqual(mockFixtureSourceLeaks('const label = `${bridge.setMockScript(script)}`'), [
      'setMockScript',
    ])
    assert.deepEqual(
      mockFixtureSourceLeaks(
        "const prompt = 'Can you explain setMockScript() and MockScriptStep?'",
      ),
      [],
    )
    assert.deepEqual(
      mockConversationLeaks(['Can you explain setMockScript and MockScriptStep?']),
      [],
    )
  })

  it('rejects control tokens and fallback replies, including partial streamed titles', () => {
    const leaked = [
      'Please inspect this [[mcp:list_dir {"path":"."}]]',
      'Continue [[mock:delay_ms 500]]',
      'Mock respons',
      'Demo response to: hello',
      'No conversation scenario is configured for this request.',
    ]
    assert.deepEqual(mockConversationLeaks(['List the workspace files.', ...leaked]), leaked)
  })
})
