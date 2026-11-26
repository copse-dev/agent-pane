// Contract tests for the Copse dialect's per-hook `matcher` at the discovery
// seam: the number of hooks a discovery function returns is whether the matcher
// matched. The matcher comes from a hooks.json the user or a trusted repository
// wrote and is evaluated on the main process for every gated call, so it runs
// under the same wall-clock bound as the Cursor and Claude matchers.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { copseSubagentStartHooks, copseToolGateHooks } from './copse-adapter.ts'

const discover = { workspaceRoot: null, projectTrusted: false }

describe('Copse matcher semantics', () => {
  let dataRoot = ''
  let originalDataRoot: string | undefined

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'copse-native-matcher-'))
    originalDataRoot = process.env['COPSE_DIR']
    process.env['COPSE_DIR'] = dataRoot
  })

  afterEach(async () => {
    if (originalDataRoot === undefined) delete process.env['COPSE_DIR']
    else process.env['COPSE_DIR'] = originalDataRoot
    await rm(dataRoot, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await writeFile(join(dataRoot, 'hooks.json'), JSON.stringify(config), 'utf-8')
  }

  it('fires only for a tool name the matcher covers, and skips a malformed one', async () => {
    await writeUserHooks({
      hooks: {
        toolGate: [
          { command: './shell.sh', matcher: '^run_shell$' },
          { command: './broken.sh', matcher: '(' },
        ],
        subagentStart: [{ command: './explore.sh', matcher: '^explore$' }],
      },
    })
    const shell = await copseToolGateHooks({ toolName: 'run_shell', input: {} }, discover)
    assert.deepEqual(
      shell.map((hook) => hook.command),
      ['./shell.sh'],
    )
    assert.equal(
      (await copseToolGateHooks({ toolName: 'read_file', input: {} }, discover)).length,
      0,
    )
    assert.equal((await copseSubagentStartHooks({ subagentType: 'explore' }, discover)).length, 1)
  })

  // An MCP server chooses its tool names, so `(a+)+$` against a long one would
  // otherwise freeze the main process on every call to that tool.
  it('treats a backtracking matcher as a match instead of hanging', async () => {
    await writeUserHooks({ hooks: { toolGate: [{ command: './gate.sh', matcher: '(a+)+$' }] } })
    const toolName = `mcp__srv__${'a'.repeat(40)}!`
    const started = Date.now()
    const hooks = await copseToolGateHooks({ toolName, input: {} }, discover)
    assert.ok(Date.now() - started < 5_000, 'the matcher is time-bounded')
    assert.equal(hooks.length, 1)
  })
})
