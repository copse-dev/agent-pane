import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { workspaceSandboxOverlay } from '../../project-sandbox/config.ts'
import { spawnBackgroundProcess } from '../../project-sandbox/spawn.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { ensureToolPermitted } from '../security/permission-gate.ts'
import { TRUSTED_COMMANDS_SETTING } from '../security/command-routing-config.ts'
import { clearReadOutsideProjectGrants } from '../security/read-outside-grant.ts'
import { copseToolPermissionId } from '../security/tool-permissions.ts'
import { setWorkspaceTrusted } from '../security/workspace-trust.ts'
import { setSetting } from '../storage/settings.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { saveProjectThread } from '../thread-store.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  startBackgroundProcess,
  stopAllBackgroundProcesses,
  type BackgroundProcessInfo,
} from './background-process.ts'

const OWNER = { projectId: 'background-routing', threadId: 'background-routing' }

describe('background commands honour shell approval routing', () => {
  let fixture: string
  let root: string
  let previousStore: string | undefined
  let restoreWorkspace: () => void
  let approve = true
  const prompts: ApprovalRequest[] = []
  const overlays: Array<Partial<SandboxRuntimeConfig> | undefined> = []

  before(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'copse-background-routing-')))
    root = join(fixture, 'project')
    await mkdir(root)
    previousStore = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = join(fixture, 'threads')
    await saveProjectThread(OWNER.projectId, {
      id: OWNER.threadId,
      title: 'Background command routing',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    })
    restoreWorkspace = setWorkspaceRootForTest(root)
    setWorkspaceTrusted(root, true)
  })

  after(async () => {
    restoreWorkspace()
    setWorkspaceTrusted(root, false)
    if (previousStore === undefined) Reflect.deleteProperty(process.env, 'COPSE_WORKSPACE_DIR')
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    await rm(fixture, { recursive: true, force: true })
  })

  beforeEach(async () => {
    approve = true
    prompts.length = 0
    overlays.length = 0
    clearReadOutsideProjectGrants()
    await setSetting('autoRunSandboxCommands', true)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    await setSetting('safetyClassifierEnabled', false)
    await setSetting(TRUSTED_COMMANDS_SETTING, [])
    await setSetting('toolPermissionOverrides', {})
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(
      SandboxManager,
      'wrapWithSandboxArgv',
      (...[_command, _shell, config]: Parameters<typeof SandboxManager.wrapWithSandboxArgv>) => {
        overlays.push(config)
        // Inject at the OS boundary: no network, real seatbelt, or host credential
        // access is needed to observe which profile the real runner selected.
        return Promise.resolve({ argv: ['/bin/sh', '-c', 'printf contained'], env: {} })
      },
    )
    setProjectSandboxEnabled(true)
    setApprovalHandler((request) => {
      prompts.push(request)
      return Promise.resolve({ approved: approve, remember: false })
    })
  })

  afterEach(async () => {
    stopAllBackgroundProcesses()
    setProjectSandboxEnabled(false)
    setApprovalHandler(null)
    clearReadOutsideProjectGrants()
    mock.restoreAll()
    await setSetting(TRUSTED_COMMANDS_SETTING, [])
    await setSetting('toolPermissionOverrides', {})
  })

  function inOwnerContext<T>(fn: () => T): T {
    return runWithActiveRunIdentity(OWNER.threadId, () =>
      runWithThreadExecutionContext(
        { ...OWNER, projectRoot: root, root, checkoutMode: 'shared', branch: null },
        fn,
      ),
    )
  }

  async function start(command: string): Promise<BackgroundProcessInfo | null> {
    return inOwnerContext(async () => {
      const permitted = await ensureToolPermitted({
        toolName: 'run_background',
        args: { action: 'start', command },
      })
      if (!permitted) return null
      return startBackgroundProcess({ command, cwd: root, owner: OWNER, waitMs: 100 })
    })
  }

  it('runs an approved outside write outside the sandbox without Guarded YOLO', async () => {
    const target = join(fixture, 'approved-output.txt')
    const command = `printf approved > '${target}'`
    const info = await start(command)
    assert.ok(info)
    assert.ok(prompts.some((prompt) => prompt.scope === 'external'))
    assert.equal(info.unsandboxed, true)
    assert.equal(await readFile(target, 'utf8'), 'approved')
    assert.equal(overlays.length, 0)
  })

  it('honours an existing trusted command route in a trusted project', async () => {
    await setSetting(TRUSTED_COMMANDS_SETTING, ['printf'])
    const info = await start('printf trusted')
    assert.ok(info)
    assert.equal(info.unsandboxed, true)
    assert.equal(info.exitCode, 0)
    assert.equal(prompts.length, 0)
    assert.equal(overlays.length, 0)
  })

  it('never starts a command whose outside approval was declined', async () => {
    approve = false
    const info = await start(`printf declined > '${join(fixture, 'declined-output.txt')}'`)
    assert.equal(info, null)
    assert.equal(prompts.length, 1)
    assert.equal(overlays.length, 0)
    await assert.rejects(readFile(join(fixture, 'declined-output.txt')), { code: 'ENOENT' })
  })

  it('keeps ordinary local work inside the sandbox', async () => {
    const info = await start('printf local')
    assert.ok(info)
    assert.equal(info.unsandboxed, false)
    assert.equal(prompts.length, 0)
    assert.equal(overlays.length, 1)
    assert.deepEqual(
      overlays[0],
      inOwnerContext(() => workspaceSandboxOverlay(root)),
    )
  })

  it('applies an outside read as a narrow read overlay rather than a full escape', async () => {
    const target = join(fixture, 'notes.txt')
    await writeFile(target, 'notes')
    const info = await start(`cat '${target}'`)
    assert.ok(info)
    assert.equal(info.unsandboxed, false)
    assert.equal(overlays.length, 1)
    const overlay = overlays[0]
    const base = inOwnerContext(() => workspaceSandboxOverlay(root))
    assert.ok(overlay)
    assert.ok(overlay.filesystem)
    assert.ok(overlay.filesystem.allowRead)
    assert.ok(overlay.filesystem.allowRead.includes(target))
    assert.deepEqual(overlay.filesystem.allowWrite, base.filesystem?.allowWrite)
    assert.deepEqual(overlay.filesystem.denyWrite, base.filesystem?.denyWrite)
    assert.deepEqual(overlay.network, base.network)
    assert.equal(overlay.filesystem.allowRead.includes(fixture), false)
    await start('printf local')
    assert.equal(overlays[1]?.filesystem?.allowRead?.includes(target), false)
  })

  it('combines a scoped read with separately approved loopback binding', async () => {
    const target = join(fixture, 'loopback-notes.txt')
    await writeFile(target, 'notes')
    const child = await inOwnerContext(() =>
      spawnBackgroundProcess('printf local', {
        cwd: root,
        allowPortBinding: true,
        readGrantTargets: [target],
      }),
    )
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => {
        resolve()
      })
    })
    const filesystem = overlays[0]?.filesystem
    const network = overlays[0]?.network
    assert.ok(filesystem)
    assert.ok(network)
    assert.ok(filesystem.allowRead?.includes(target))
    assert.equal(network.allowLocalBinding, true)
    assert.deepEqual(network.allowedDomains, ['localhost', '127.0.0.1', '::1'])
    assert.deepEqual(
      filesystem.allowWrite,
      inOwnerContext(() => workspaceSandboxOverlay(root).filesystem?.allowWrite),
    )
  })

  it('still asks when the OS sandbox is unavailable', async () => {
    setProjectSandboxEnabled(false)
    const info = await start('printf local')
    assert.ok(info)
    assert.equal(info.unsandboxed, true)
    assert.equal(prompts.length, 1)
    assert.equal(overlays.length, 0)
  })

  it('does not turn a credential read into a standing outside-read grant', async () => {
    const target = join(fixture, '.env')
    await writeFile(target, 'fixture-only')
    const info = await start(`cat '${target}'`)
    assert.ok(info)
    assert.equal(info.unsandboxed, true)
    assert.ok(prompts.some((prompt) => prompt.scope === 'external'))
    assert.equal(overlays.length, 0)
  })

  it('keeps a blocked background tool from reaching the runner', async () => {
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('run_background')]: 'block',
    })
    assert.equal(await start('printf blocked'), null)
    assert.equal(prompts.length, 0)
    assert.equal(overlays.length, 0)
  })

  it('keeps the contained boundary shown by Always ask even for a trusted binary', async () => {
    await setSetting(TRUSTED_COMMANDS_SETTING, ['printf'])
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('run_background')]: 'ask',
    })
    const info = await start('printf local')
    assert.ok(info)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.scope, 'sandbox')
    assert.equal(info.unsandboxed, false)
    assert.equal(overlays.length, 1)
  })
})
