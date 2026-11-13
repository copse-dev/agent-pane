import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copseBeforeSubmitPromptHooks } from './copse-adapter.ts'
import { configureHooksDialects } from './environment.ts'
import { spawnHookProcess } from './hook-spawn.ts'

const CWD_SCRIPT =
  "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({note:process.cwd()})))"

describe('command hook working directories', () => {
  let fixture = ''
  let project = ''
  let checkout = ''
  let user = ''
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'copse-hook-cwd-runtime-'))
    project = join(fixture, 'project')
    checkout = join(fixture, 'checkout')
    user = join(fixture, 'user')
    for (const root of [project, checkout, user]) mkdirSync(root)
    configureHooksDialects({
      dataRoot: () => user,
      childEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    })
  })
  afterEach(() => {
    configureHooksDialects()
    rmSync(fixture, { recursive: true, force: true })
  })

  for (const useCheckout of [false, true]) {
    it(`runs the real project adapter from its ${useCheckout ? 'checkout' : 'shared'} root`, async () => {
      const root = useCheckout ? checkout : project
      mkdirSync(join(project, '.copse'))
      mkdirSync(join(root, 'scripts'))
      writeFileSync(join(root, 'scripts/cwd.cjs'), CWD_SCRIPT)
      writeFileSync(
        join(project, '.copse/hooks.json'),
        JSON.stringify({
          version: 1,
          hooks: { beforeSubmitPrompt: [{ command: 'node scripts/cwd.cjs', sandbox: false }] },
        }),
      )
      const hooks = await copseBeforeSubmitPromptHooks(
        { prompt: 'Controlled CWD check' },
        {
          workspaceRoot: project,
          executionRoot: root,
          projectTrusted: true,
        },
      )
      assert.equal(hooks.length, 1)
      const hook = hooks[0]
      assert.ok(hook?.cwd)
      assert.equal(hook.cwd, root)
      assert.equal(hook.executionRoot, root)
      assert.equal(hook.sandbox, false)
      const result = await spawnHookProcess(
        hook.command,
        {},
        { cwd: hook.cwd, sandbox: false, timeoutMs: 2_500 },
      )
      assert.equal(result.exitCode, 0, result.stderr)
      assert.equal(result.stdout.trim(), JSON.stringify({ note: realpathSync(root) }))
    })
  }

  it('retains user declaring-directory paths while a project checkout is active', async () => {
    writeFileSync(join(user, 'cwd.cjs'), CWD_SCRIPT)
    writeFileSync(
      join(user, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { beforeSubmitPrompt: [{ command: 'node cwd.cjs', sandbox: false }] },
      }),
    )
    const hooks = await copseBeforeSubmitPromptHooks(
      { prompt: 'Controlled user CWD check' },
      {
        workspaceRoot: project,
        executionRoot: checkout,
        projectTrusted: true,
      },
    )
    assert.equal(hooks.length, 1)
    const hook = hooks[0]
    assert.ok(hook?.cwd)
    assert.equal(hook.cwd, user)
    const result = await spawnHookProcess(
      hook.command,
      {},
      { cwd: hook.cwd, sandbox: false, timeoutMs: 2_500 },
    )
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), JSON.stringify({ note: realpathSync(user) }))
  })
})
