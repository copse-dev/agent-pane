// B4 (docs/plans/hooks-and-feature-packs.md, "Complete permission-hook I/O"):
//   - a hook `ask` **escalates to Copse's approval prompt** (never a silent
//     allow/deny) — approval lets the call proceed, a decline blocks it;
//   - a hook `deny` **surfaces its `agentMessage` to the agent** by throwing so
//     the reason reaches the model as the tool result (the existing
//     agent-visible deny path), while a bare deny stays a plain rejection.
// Driven end-to-end through `ensureToolPermitted` with a real user hook.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureToolPermitted } from './permission-gate.ts'
import { setPermissionGateForTests } from '../tool-registry.ts'
import { setApprovalHandler } from '../approval.ts'
import { setSetting } from '../storage/settings.ts'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
} from '../hooks/cursor-adapter.ts'

describe('permission gate — Cursor hook ask/deny surfacing (B4)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-gate-hooks-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    setPermissionGateForTests(null)
    await setSetting('cursorHooksEnabled', true)
  })

  afterEach(async () => {
    setApprovalHandler(null)
    await setSetting('cursorHooksEnabled', false)
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
  })

  /** Declare a user `beforeReadFile` hook that prints `responseJson`. */
  async function writeReadFileHook(responseJson: string): Promise<void> {
    const path = join(tempHome, 'gate.sh')
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${responseJson}'\n`)
    await chmod(path, 0o755)
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(
      userHooksConfigPath(),
      JSON.stringify({ hooks: { beforeReadFile: [{ command: path }] } }),
    )
  }

  const readFile = { toolName: 'read_file', args: { path: '/tmp/whatever.txt' } }

  it('ask escalates to an approval prompt — approval lets the call proceed', async () => {
    await writeReadFileHook('{"permission":"ask","agentMessage":"confirm this read"}')
    let prompts = 0
    let promptTitle = ''
    setApprovalHandler(async (req) => {
      prompts += 1
      promptTitle = req.title
      return { approved: true, remember: false }
    })
    const allowed = await ensureToolPermitted(readFile)
    assert.equal(allowed, true)
    assert.equal(prompts, 1, 'the hook ask must trigger exactly one approval prompt')
    assert.match(promptTitle, /Hook asks to confirm/)
  })

  it('ask escalates to an approval prompt — a decline blocks the call', async () => {
    await writeReadFileHook('{"permission":"ask"}')
    let prompts = 0
    setApprovalHandler(async () => {
      prompts += 1
      return { approved: false, remember: false }
    })
    const allowed = await ensureToolPermitted(readFile)
    assert.equal(allowed, false)
    assert.equal(prompts, 1)
  })

  it('deny with an agentMessage throws so the reason reaches the agent', async () => {
    await writeReadFileHook('{"permission":"deny","agentMessage":"blocked: reads sensitive file"}')
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await assert.rejects(ensureToolPermitted(readFile), /blocked: reads sensitive file/)
  })

  it('a bare deny (no message) is a plain rejection, not a throw', async () => {
    await writeReadFileHook('{"permission":"deny"}')
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    assert.equal(await ensureToolPermitted(readFile), false)
  })
})
