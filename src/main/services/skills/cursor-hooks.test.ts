import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listCursorHooks,
  runPermissionHooks,
  userHooksConfigPath,
  projectHooksConfigPath,
} from './cursor-hooks.ts'

describe('cursor-hooks', () => {
  let tempHome = ''
  let tempProject = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-cursor-hooks-home-'))
    tempProject = await mkdtemp(join(tmpdir(), 'copse-cursor-hooks-proj-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
    await rm(tempProject, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    const path = userHooksConfigPath()
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(path, JSON.stringify(config), 'utf-8')
  }

  async function writeProjectHooks(config: unknown): Promise<void> {
    await mkdir(join(tempProject, '.cursor'), { recursive: true })
    await writeFile(projectHooksConfigPath(tempProject), JSON.stringify(config), 'utf-8')
  }

  /** Write an executable shell script that prints `responseJson` on stdout. */
  async function writeHookScript(name: string, responseJson: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${responseJson}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  it('lists user hooks and skips unknown events', async () => {
    await writeUserHooks({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: './audit.sh' }],
        notARealEvent: [{ command: './nope.sh' }],
      },
    })

    const hooks = await listCursorHooks({ workspaceRoot: null, projectTrusted: false })
    assert.equal(hooks.length, 1)
    const [hook] = hooks
    assert.ok(hook)
    assert.equal(hook.event, 'beforeShellExecution')
    assert.equal(hook.command, './audit.sh')
    assert.equal(hook.scope, 'user')
  })

  it('discovers project hooks only when the workspace is trusted', async () => {
    await writeProjectHooks({ hooks: { beforeShellExecution: [{ command: './p.sh' }] } })

    const untrusted = await listCursorHooks({
      workspaceRoot: tempProject,
      projectTrusted: false,
    })
    assert.equal(untrusted.length, 0)

    const trusted = await listCursorHooks({ workspaceRoot: tempProject, projectTrusted: true })
    assert.equal(trusted.length, 1)
    const [projectHook] = trusted
    assert.ok(projectHook)
    assert.equal(projectHook.scope, 'project')
  })

  it('returns allow when no hooks are registered', async () => {
    const decision = await runPermissionHooks(
      'beforeShellExecution',
      { command: 'ls' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'allow')
  })

  it('denies when a hook returns permission deny', async () => {
    const script = await writeHookScript(
      'deny.sh',
      '{"permission":"deny","agentMessage":"blocked by policy"}',
    )
    await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

    const decision = await runPermissionHooks(
      'beforeShellExecution',
      { command: 'rm -rf /' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'deny')
    assert.equal(decision.agentMessage, 'blocked by policy')
  })

  it('deny wins over allow when multiple hooks disagree', async () => {
    const allow = await writeHookScript('allow.sh', '{"permission":"allow"}')
    const deny = await writeHookScript('deny2.sh', '{"permission":"deny"}')
    await writeUserHooks({
      hooks: { beforeMCPExecution: [{ command: allow }, { command: deny }] },
    })

    const decision = await runPermissionHooks(
      'beforeMCPExecution',
      { tool_name: 'mcp__x__y', tool_input: {} },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'deny')
  })

  it('fails open to allow when a hook prints no usable JSON', async () => {
    const script = await writeHookScript('garbage.sh', 'not json at all')
    await writeUserHooks({ hooks: { beforeReadFile: [{ command: script }] } })

    const decision = await runPermissionHooks(
      'beforeReadFile',
      { file_path: 'secret.txt', content: '' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'allow')
  })

  it('ignores a malformed hooks.json without throwing', async () => {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), '{ this is not json', 'utf-8')

    const hooks = await listCursorHooks({ workspaceRoot: null, projectTrusted: false })
    assert.deepEqual(hooks, [])
  })
})
