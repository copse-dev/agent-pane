import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'

it('decodes persisted fixture messages and rejects invalid seed fields in an isolated profile', () => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
  const root = mkdtempSync(join(process.cwd(), '.tmp', 'seed-boundaries-'))
  const seedModule = join(root, 'seed-config.mjs')
  try {
    buildSync({
      entryPoints: ['tests/e2e/helpers/seed-config.ts'],
      outfile: seedModule,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
    })
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { readFileSync } from 'node:fs'
      import { join } from 'node:path'
      const seed = await import(process.argv[1])
      const root = process.argv[2]
      for (const name of [
        'seedAcpAuthErrorFixture', 'seedCodeBlockCopyFixture', 'seedMermaidDiagramFixture',
        'seedCalloutSurfacesFixture', 'seedConversationVisualHierarchyFixture',
        'seedStickyUserPromptFixture', 'seedBrowserCursorAgentThreadFixture', 'seedCiInvestigatorFixture',
      ]) seed[name](root)
      const message = { id: 'message', role: 'assistant', content: 'Fixture reply', createdAt: 1,
        toolCalls: [{ id: 'tool', name: 'read_file', status: 'done', args: { path: 'README.md' } }] }
      seed.writeSeedConfig({ 'threads:boundary': [{ id: 'thread', messages: [message] }] })
      const thread = join(seed.e2eWorkspaceDir(), 'boundary', 'thread')
      assert.ok(readFileSync(join(thread, 'events.jsonl'), 'utf8').length > 0)
      assert.deepEqual(JSON.parse(readFileSync(join(thread, 'meta.json'), 'utf8')).usage,
        { inputTokens: 0, outputTokens: 0 })
      const child = { ...message, id: 'nested-message', toolCalls: [] }
      const delegated = { ...message, toolCalls: [{ ...message.toolCalls[0],
        subagent: { id: 'child', kind: 'explore', status: 'done', messages: [child] } }] }
      seed.writeSeedConfig({ 'threads:boundary': [{ id: 'delegated', messages: [delegated] }] })
      const { createdAt, ...missingChildTimestamp } = child
      assert.throws(() => seed.writeSeedConfig({ 'threads:boundary': [{ id: 'invalid-nested',
        messages: [{ ...delegated, toolCalls: [{ ...delegated.toolCalls[0],
          subagent: { ...delegated.toolCalls[0].subagent, messages: [missingChildTimestamp] } }] }] }] }),
        /Seeded message has invalid persisted fields/)
      for (const malformed of [null, { ...message, role: 'invalid' },
        { ...message, toolCalls: [{ id: 'tool', name: 'read_file', status: 'invalid' }] }]) {
        assert.throws(() => seed.writeSeedConfig({ 'threads:boundary': [{ id: 'invalid', messages: [malformed] }] }),
          /Seeded message/)
      }
    `,
        seedModule,
        root,
      ],
      {
        env: {
          ...process.env,
          COPSE_DIR: root,
          COPSE_PANEL_USER_DATA: join(root, 'user-data'),
          COPSE_WORKSPACE_DIR: join(root, 'workspace'),
        },
        timeout: 30_000,
        stdio: 'pipe',
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
