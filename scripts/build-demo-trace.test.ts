import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

// Since #4125 the bridge is mounted as `copse-<nonce>`, so a Codex export
// records `mcp.copse-k3v9x2mq.write_file`. The importer must still replay it
// as Copse's native call, and still drop the audit those bridged writes once
// raised, as it does for the bare `mcp.copse.` of older exports.
describe('demo trace importer', () => {
  function importTrace(toolCalls: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'copse-demo-trace-'))
    try {
      const input = join(dir, 'thread.jsonl')
      const out = join(dir, 'trace.ts')
      const lines = [
        { type: 'thread', exportVersion: 5, id: 'thread-1', title: 'Bridged writes' },
        { type: 'message', id: 'm-1', role: 'user', content: 'write the plan' },
        { type: 'message', id: 'm-2', role: 'assistant', content: 'Done.', toolCalls },
      ]
      writeFileSync(input, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
      const run = spawnSync(
        process.execPath,
        [resolve('scripts/run-build-demo-trace.mts'), input, '--id', 'bridged', '--out', out],
        { encoding: 'utf8' },
      )
      assert.equal(run.status, 0, run.stderr)
      // The importer formats the module, so keys are bare and strings single-quoted.
      return readFileSync(out, 'utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const bridged = (server: string): unknown => ({
    id: 'tc-1',
    name: `mcp.${server}.write_file`,
    args: { server, tool: 'write_file', arguments: { path: 'plan.md', content: 'plan' } },
    status: 'done',
    result: 'ok',
  })
  const audit = {
    id: 'tc-2',
    name: 'workspace_edit_audit',
    args: { files: ['plan.md'] },
    status: 'done',
    result: 'Warning: these files changed on disk',
  }

  for (const server of ['copse', 'copse-k3v9x2mq']) {
    it(`replays a ${server} bridge call as the native tool`, () => {
      const trace = importTrace([bridged(server), audit])
      assert.match(trace, /name: 'write_file'/)
      assert.match(trace, /path: 'plan\.md'/)
      assert.doesNotMatch(trace, /mcp\.copse|server:|workspace_edit_audit/)
    })
  }

  it('leaves another server named like the bridge alone', () => {
    const trace = importTrace([bridged('copse-other')])
    assert.match(trace, /name: 'mcp\.copse-other\.write_file'/)
  })
})
